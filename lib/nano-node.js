import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'
import dns from 'dns'

import {
  constants,
  ed25519,
  encodeAddress,
  encodeConnectionInfo,
  wait
} from '#common'

import NanoSocket from './nano-socket.js'

const log = debug('node')

class NanoRepresentative {
  constructor(representative_public_key) {
    this.representative_public_key = representative_public_key
    this.votes = 0
    this.last_vote = null
    this.voting_weight = 0n
    this.voting_weight_confirmed = 0n // TODO needs to be updated
    this.delegators = new Map()
  }

  add_delegator({ account, balance = 0n, confirmed = false }) {
    this.delegators.set(account, { balance, confirmed })
    this.calculate_voting_weight()
  }

  calculate_voting_weight() {
    let voting_weight = 0n
    let voting_weight_confirmed = 0n
    for (const delegator of this.delegators.values()) {
      voting_weight += delegator.balance
      if (delegator.confirmed) {
        voting_weight_confirmed += delegator.balance
      }
    }

    this.voting_weight = voting_weight
    this.voting_weight_confirmed = voting_weight_confirmed
  }
}

class NanoPeer {
  constructor({ peerAddress, nanoSocket }) {
    this.nodeId = null
    this.address = peerAddress
    this.messages = 0
    this.last_message = null
    this.nanoSocket = nanoSocket
    this.telemetry = null
    this.last_telemetry_req = null
  }
}

class NanoFrontier {
  constructor({
    block_hash,
    account,
    balance = 0n,
    representative_public_key = null,
    previous_block_hash_buffer = Buffer.alloc(0)
  }) {
    this.block_hash = block_hash
    this.previous_block_hash_buffer = previous_block_hash_buffer
    this.account = account
    this.balance = balance
    this.representative_public_key = representative_public_key
    this.confirmed = false
    this.vote_weight_total = 0n
    this.voters = new Map()
  }

  add_voter({ representative_public_key, voting_weight }) {
    this.voters.set(representative_public_key, voting_weight)
    this.vote_weight_total += voting_weight

    if (this.vote_weight_total >= constants.QUORUM_THRESHOLD) {
      this.confirmed = true
      log(`${this.block_hash} has been confirmed`)
    }
  }
}

const defaultConfig = {
  discover: true,
  requestTelemetry: false,
  maxPeers: Infinity // TODO : currently unused
}

export default class NanoNode extends EventEmitter {
  constructor({ network = constants.NETWORK.BETA, ...config } = {}) {
    super()

    this.network = network
    this.config = Object.assign(defaultConfig, config)

    const NodeSecret = crypto.randomBytes(32)
    const NodePublic = ed25519.publicKey(NodeSecret)
    this.nodeKey = {
      secret: NodeSecret,
      public: NodePublic
    }
    this.NodeID = encodeAddress({ publicKey: NodePublic, prefix: 'node_' })

    log(`Node Secret: ${NodeSecret.toString('hex')}`)
    log(`Node Public: ${Buffer.from(NodePublic).toString('hex')}`)
    log(`Node ID: ${this.NodeID}`)

    this.peers = new Map()
    this.representatives = new Map()
    this.frontiers = new Map()

    // [BlockHash]: { voters: [ Voting Account(s) ], votingWeight: Total Voting Weight, state: 0 (Passive) 1 (Active) 2 (Requesting) 3 (Broadcasting), requestCount: Amount of times Node has requested vote for this Election, started: Time Election Started }
    this.elections = {}

    // [BlockHash]: { voters: [ Voting Account(s) ], votingWeight: Total Voting Weight }
    this.inactiveElections = {}

    if (this.config.requestTelemetry) {
      this._telemetryInterval = setInterval(
        this.telemetryLoop.bind(this),
        // convert nanoseconds to milliseconds
        network.TELEMETRY_CACHE_CUTOFF / 1e6
      )
    }
  }

  set_representative({ representative_public_key }) {
    const existing_rep = this.representatives.get(representative_public_key)
    if (existing_rep) {
      return existing_rep
    }

    const rep = new NanoRepresentative(representative_public_key)
    this.representatives.set(representative_public_key, rep)
    return rep
  }

  async bootstrap_quorum_weights_from_frontiers({ frontiers }) {
    for (const frontier_data of frontiers) {
      const frontier = new NanoFrontier(frontier_data)
      this.frontiers.set(frontier.block_hash, frontier)
      const rep = this.set_representative({
        representative_public_key: frontier.representative_public_key
      })
      rep.add_delegator(frontier)
    }

    await this.request_votes_for_quorum_frontiers()
    this.emit('frontiers_confirmed')
  }

  is_frontiers_confirmed() {
    for (const frontier of this.frontiers.values()) {
      if (!frontier.confirmed) {
        return false
      }
    }
    return true
  }

  request_votes_for_quorum_frontiers = async () => {
    if (this.is_frontiers_confirmed()) {
      log('All frontiers are confirmed')
      return
    }

    this.is_requesting_quorum_frontier_votes = true

    const MAX_CHUNK_SIZE = 255
    const frontiers = Array.from(this.frontiers.values())
    const chunked_frontiers = []

    for (let i = 0, j = 0; i < frontiers.length; i += MAX_CHUNK_SIZE, j++) {
      const chunk = frontiers.slice(i, i + MAX_CHUNK_SIZE)
      chunked_frontiers[j] = chunk
    }

    for (const chunk of chunked_frontiers) {
      const block_hash_pairs = chunk.map((frontier) => {
        const key_buffer = Buffer.from(frontier.block_hash, 'hex')
        return Buffer.concat([key_buffer, frontier.previous_block_hash_buffer])
      })
      log(`Requesting votes for ${block_hash_pairs.length} frontiers`)
      this.request_votes(block_hash_pairs)

      await wait(1500)
    }

    return this.request_votes_for_quorum_frontiers()
  }

  stop() {
    if (this._telemetryInterval) {
      clearInterval(this._telemetryInterval)
    }

    if (this.server) {
      this.server.close()
    }

    for (const peer of this.peers.values()) {
      peer.nanoSocket.close()
    }
  }

  telemetryLoop() {
    for (const peer of this.peers.values()) {
      peer.last_telemetry_req = process.hrtime.bigint()
      peer.nanoSocket.sendMessage({
        messageType: constants.MESSAGE_TYPE.TELEMETRY_REQ,
        message: Buffer.from([]),
        extensions: 0
      })
    }
  }

  _getRepresentative({ representative_public_key, peerAddress }) {
    const foundRep = this.representatives.get(representative_public_key)
    if (foundRep) {
      return foundRep
    }

    log(
      `found new representative ${representative_public_key}, at ${peerAddress}`
    )
    const rep = new NanoRepresentative(representative_public_key)
    this.representatives.set(representative_public_key, rep)
    return rep
  }

  handleKeepalive = (body) => {
    for (let i = 0; i < 8; i++) {
      const peerPtr = i * 18
      const peer = body.subarray(peerPtr, peerPtr + 18)
      const address = peer.subarray(0, 16)
      if (this.peers.has(peer.toString('binary'))) continue
      if (address.equals(constants.SELF_ADDRESS)) continue
      this.connect(peer)
    }
  }

  request_votes = (block_hash_pairs) => {
    for (const peer of this.peers.values()) {
      // skip peers that haven't completed handshake
      if (!peer.nanoSocket.handshake_completed) {
        continue
      }

      peer.nanoSocket.send_confirm_req(block_hash_pairs)
    }
  }

  onVote({ vote, peerAddress }) {
    const representative_public_key = vote.account.toString('hex')

    if (!vote.isValid) {
      log(
        `invalid vote received from ${peerAddress}, rep: ${representative_public_key}`
      )

      return
    }

    const representative = this._getRepresentative({
      representative_public_key,
      peerAddress
    })

    representative.votes += 1
    representative.last_vote = process.hrtime.bigint()

    for (const block_hash_buffer of vote.hashList) {
      const block_hash = block_hash_buffer.toString('hex')
      const frontier = this.frontiers.get(block_hash)
      if (frontier) {
        frontier.add_voter(representative)
      }
    }
  }

  publish(block, peerCount = 8) {
    const shuffled = Array.from(this.peers.values())
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
    const size = Math.max(peerCount, shuffled.length)
    const selected = shuffled.slice(0, size)

    for (const peer of selected) {
      peer.nanoSocket.sendMessage({
        messageType: constants.MESSAGE_TYPE.PUBLISH,
        message: block,
        extensions: 0x600
      })
    }
  }

  onTelemetry({ telemetry, peerAddress, addr }) {
    const result = {
      isPeer: true,
      isRejected: false,
      isLate: false,
      isUnsolicited: false
    }

    const peer = this.peers.get(peerAddress)
    const telemetryNodeId = encodeAddress({
      publicKey: telemetry.node_id,
      prefix: 'node_'
    })

    if (!telemetryNodeId === peer.nanoSocket.connectedNodeId) {
      result.isRejected = true
      result.isPeer = false
      log(`mismatched telemetry & socket node_id (${addr})`)
    }

    if (!peer.last_telemetry_req) {
      result.isRejected = true
      result.isUnsolicited = true
      log(`unsolicited telemetry_ack (${addr})`)
    } else if (process.hrtime.bigint() - peer.last_telemetry_req > 1e10) {
      result.isRejected = true
      result.isLate = true
      log(`late telemetry_ack (${addr})`)
    }

    this.emit('telemetry', { ...telemetry, ...result })

    if (result.isRejected) {
      return
    }

    peer.telemetry = telemetry
    peer.last_telemetry_req = null
  }

  onConnection = (socket) => {
    const nanoSocket = new NanoSocket({ socket, node: this })
    this.setupNanoSocket(nanoSocket)
  }

  listen({ address = '::0', port = this.network.PORT } = {}) {
    this.server = net.createServer(null, this.onConnection)
    this.server.listen(port, address, () => {
      log(`Node Address: ${address}:${port}`)
      this.emit('listening')
    })
  }

  connect(connectionInfo) {
    this.peers.set(connectionInfo.toString('binary'), null)
    log(
      `opening connection to ${connectionInfo.toString('hex')} (current: ${
        this.peers.size
      })`
    )
    const nanoSocket = new NanoSocket({
      connectionInfo,
      node: this
    })
    this.setupNanoSocket(nanoSocket)
  }

  connectAddress({ address = '127.0.0.1', port = this.network.PORT } = {}) {
    const connectionInfo = encodeConnectionInfo({ address: address, port })
    this.connect(connectionInfo)
  }

  connectDomain({
    host = this.network.ADDRESS,
    port = this.network.PORT
  } = {}) {
    log(`Resolving ${host}`)
    dns.resolve4(host, (err, addresses) => {
      if (err) return err

      addresses.forEach((address) => {
        this.connectAddress({ address: '::ffff:' + address, port })
      })
    })
  }

  setupNanoSocket = (nanoSocket) => {
    const { peerAddress } = nanoSocket
    const peer = new NanoPeer({ peerAddress, nanoSocket })

    nanoSocket.on('error', (error) => {
      this.emit('error', error)
    })

    nanoSocket.on('handshake', ({ nodeId }) => {
      this.emit('handshake', {
        nodeId,
        peerAddress: nanoSocket.readableAddress
      })
    })

    nanoSocket.on('message', (message) => {
      peer.messages += 1
      this.emit('message', message)
    })

    nanoSocket.on('vote', (vote) => {
      this.emit('vote', vote)
      this.onVote({ vote, peerAddress: nanoSocket.readableAddress })
    })

    nanoSocket.on('telemetry', (telemetry) => {
      this.onTelemetry({
        telemetry,
        peerAddress,
        addr: nanoSocket.readableAddress
      })
    })

    nanoSocket.on('represenative', (representative) => {})

    nanoSocket.on('close', () => {
      this.peers.delete(peerAddress)
      log(
        `closed connection to ${nanoSocket.readableAddress} (current: ${this.peers.size})`
      )
      nanoSocket.removeAllListeners()
      this.emit('close', peerAddress)
    })

    this.peers.set(peerAddress, peer)
  }
}

export { constants as NanoConstants }
export { BulkPull, FrontierReq, BulkPullAccount } from './bootstrap.js'
