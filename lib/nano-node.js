import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'
import dns from 'dns'

import {
  constants,
  ed25519,
  encode_address,
  encode_connection_info,
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
  constructor({ peer_address, nano_socket }) {
    this.node_id = null
    this.address = peer_address
    this.messages = 0
    this.last_message = null
    this.nano_socket = nano_socket
    this.telemetry = null
    this.last_telemetry_req = null
  }
}

class NanoBlock extends EventEmitter {
  constructor({
    block_hash,
    account,
    balance = 0n,
    representative_public_key = null,
    previous_block_hash_buffer = Buffer.alloc(0)
  }) {
    super()
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
      this.emit('confirmed', this.block_hash)
    }
  }

  toJSON() {
    return {
      block_hash: this.block_hash,
      block_account: this.account,
      balance: this.balance,
      representative_public_key: this.representative_public_key,
      confirmed: this.confirmed,
      previous: this.previous_block_hash_buffer.toString('hex')
    }
  }
}

const defaultConfig = {
  discover: true,
  request_telemetry: false,
  maxPeers: Infinity // TODO : currently unused
}

export default class NanoNode extends EventEmitter {
  constructor({ network = constants.NETWORK.BETA, ...config } = {}) {
    super()

    this.network = network
    this.config = Object.assign(defaultConfig, config)

    const node_secret_buf = crypto.randomBytes(32)
    const node_public_buf = ed25519.publicKey(node_secret_buf)
    this.node_key = {
      secret_key_buf: node_secret_buf,
      public_key_buf: node_public_buf
    }
    this.node_id = encode_address({
      public_key_buf: node_public_buf,
      prefix: 'node_'
    })

    log(`Node Secret: ${node_secret_buf.toString('hex')}`)
    log(`Node Public: ${Buffer.from(node_public_buf).toString('hex')}`)
    log(`Node ID: ${this.node_id}`)

    this.peers = new Map()
    this.representatives = new Map()
    this.blocks = new Map()
    this.quorum_frontier_hashes = new Set()

    if (this.config.request_telemetry) {
      this._telemetry_interval = setInterval(
        this.telemetry_loop.bind(this),
        // convert nanoseconds to milliseconds
        network.TELEMETRY_CACHE_CUTOFF / 1e6
      )
    }

    this._keepalive_interval = setInterval(
      this.keepalive_loop.bind(this),
      constants.KEEPALIVE_INTERVAL
    )
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
      const frontier = new NanoBlock(frontier_data)
      this.blocks.set(frontier.block_hash, frontier)
      this.quorum_frontier_hashes.add(frontier.block_hash)
      const rep = this.set_representative({
        representative_public_key: frontier.representative_public_key
      })
      rep.add_delegator(frontier)
    }

    await this.request_votes_for_quorum_frontiers()
    this.emit('frontiers_confirmed')
  }

  is_frontiers_confirmed() {
    for (const frontier_hash of this.quorum_frontier_hashes) {
      const frontier = this.blocks.get(frontier_hash)
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
    const frontier_hashes = Array.from(this.quorum_frontier_hashes)
    const frontiers = frontier_hashes.map((frontier_hash) =>
      this.blocks.get(frontier_hash)
    )
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
    if (this._telemetry_interval) {
      clearInterval(this._telemetry_interval)
    }

    if (this._keepalive_interval) {
      clearInterval(this._keepalive_interval)
    }

    if (this.server) {
      this.server.close()
    }

    for (const peer of this.peers.values()) {
      peer.nano_socket.close()
    }
  }

  telemetry_loop() {
    for (const peer of this.peers.values()) {
      peer.last_telemetry_req = process.hrtime.bigint()
      peer.nano_socket.send_message({
        message_type: constants.MESSAGE_TYPE.TELEMETRY_REQ,
        message: Buffer.from([]),
        extensions: 0
      })
    }
  }

  keepalive_loop() {
    const peer_list = Array.from(this.peers.values())
      .filter((p) => Boolean(p)) // remove non-connected peers
      .sort(() => 0.5 - Math.random())
      .slice(0, 8)
      .map((p) => Buffer.from(p.address, 'binary')) // Convert address strings to Buffers

    for (const peer of this.peers.values()) {
      // Skip peers that haven't completed handshake
      if (!peer.nano_socket.handshake_completed) {
        continue
      }

      // skip peers that have completed handshake less than 15 seconds ago
      if (
        process.hrtime.bigint() - peer.nano_socket.handshake_completed <
        BigInt(15 * 1000 * 1000000)
      ) {
        continue
      }

      peer.nano_socket.send_keepalive(peer_list)
    }
  }

  _get_representative({ representative_public_key, peer_readable_address }) {
    const foundRep = this.representatives.get(representative_public_key)
    if (foundRep) {
      return foundRep
    }

    log(
      `found new representative ${representative_public_key}, at ${peer_readable_address}`
    )
    const rep = new NanoRepresentative(representative_public_key)
    this.representatives.set(representative_public_key, rep)
    return rep
  }

  handle_keepalive = (body) => {
    for (let i = 0; i < 8; i++) {
      const peerPtr = i * 18
      const peer = body.subarray(peerPtr, peerPtr + 18)
      const peer_address = peer.subarray(0, 16)
      if (this.peers.has(peer.toString('binary'))) continue
      if (peer_address.equals(constants.SELF_ADDRESS)) continue
      this.connect(peer)
    }
  }

  async confirm_block({
    block_hash,
    account_address,
    balance,
    representative_public_key,
    previous_block_hash_buffer
  }) {
    block_hash = block_hash.toLowerCase()

    const new_block = new NanoBlock({
      block_hash: block_hash,
      account: account_address,
      balance,
      representative_public_key,
      previous_block_hash_buffer
    })

    this.blocks.set(block_hash, new_block)

    const block_hash_pairs = []
    const election_pair = Buffer.concat([
      Buffer.from(block_hash, 'hex'),
      new_block.previous_block_hash_buffer
    ])
    block_hash_pairs.push(election_pair)

    this.request_votes(block_hash_pairs)

    // TODO not sure what the right interval is
    // should probably have a limit in case the block is not confirmable
    const confirmation_interval = setInterval(() => {
      if (!new_block.confirmed) {
        this.request_votes(block_hash_pairs)
      } else {
        clearInterval(confirmation_interval)
      }
    }, 5000)

    return new Promise((resolve) => {
      new_block.once('confirmed', () => {
        resolve(new_block)
      })
    })
  }

  request_votes = (block_hash_pairs) => {
    for (const peer of this.peers.values()) {
      // skip peers that haven't completed handshake
      if (!peer.nano_socket.handshake_completed) {
        continue
      }

      peer.nano_socket.send_confirm_req(block_hash_pairs)
    }
  }

  on_vote({ vote, peer_readable_address }) {
    const representative_public_key = vote.account.toString('hex')

    if (!vote.isValid) {
      log(
        `invalid vote received from ${peer_readable_address}, rep: ${representative_public_key}`
      )

      return
    }

    // TODO fix: simply receiving a vote from a peer doesn't mean they are a representative
    const representative = this._get_representative({
      representative_public_key,
      peer_readable_address
    })

    representative.votes += 1
    representative.last_vote = process.hrtime.bigint()

    for (const block_hash_buffer of vote.hashList) {
      const block_hash = block_hash_buffer.toString('hex')
      const block = this.blocks.get(block_hash)
      if (block) {
        block.add_voter(representative)
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
      peer.nano_socket.send_message({
        message_type: constants.MESSAGE_TYPE.PUBLISH,
        message: block,
        extensions: 0x600
      })
    }
  }

  on_telemetry({ telemetry, peer_address, peer_readable_address }) {
    const result = {
      is_peer: true,
      is_rejected: false,
      is_late: false,
      is_unsolicited: false
    }

    const peer = this.peers.get(peer_address)
    const telemetry_node_id = encode_address({
      public_key_buf: telemetry.node_id,
      prefix: 'node_'
    })

    if (!telemetry_node_id === peer.nano_socket.connected_node_id) {
      result.is_rejected = true
      result.is_peer = false
      log(`mismatched telemetry & socket node_id (${peer_readable_address})`)
    }

    if (!peer.last_telemetry_req) {
      result.is_rejected = true
      result.is_unsolicited = true
      log(`unsolicited telemetry_ack (${peer_readable_address})`)
    } else if (process.hrtime.bigint() - peer.last_telemetry_req > 1e10) {
      result.is_rejected = true
      result.is_late = true
      log(`late telemetry_ack (${peer_readable_address})`)
    }

    this.emit('telemetry', { ...telemetry, ...result })

    if (result.is_rejected) {
      return
    }

    peer.telemetry = telemetry
    peer.last_telemetry_req = null
  }

  on_connection = (socket) => {
    const nano_socket = new NanoSocket({ socket, node: this })
    this.setup_nano_socket(nano_socket)
  }

  listen({ address = '::0', port = this.network.PORT } = {}) {
    this.server = net.createServer(null, this.on_connection)
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
    const nano_socket = new NanoSocket({
      connectionInfo,
      node: this
    })
    this.setup_nano_socket(nano_socket)
  }

  connect_address({ address = '127.0.0.1', port = this.network.PORT } = {}) {
    const connection_info = encode_connection_info({ address: address, port })
    this.connect(connection_info)
  }

  connect_domain({
    host = this.network.ADDRESS,
    port = this.network.PORT
  } = {}) {
    log(`Resolving ${host}`)
    dns.resolve4(host, (err, addresses) => {
      if (err) return err

      addresses.forEach((address) => {
        this.connect_address({ address: '::ffff:' + address, port })
      })
    })
  }

  setup_nano_socket = (nano_socket) => {
    const { peer_address } = nano_socket
    const peer = new NanoPeer({ peer_address, nano_socket })

    nano_socket.on('error', (error) => {
      this.emit('error', error)
    })

    nano_socket.on('handshake', ({ node_id }) => {
      this.emit('handshake', {
        node_id,
        peer_address,
        peer_readable_address: nano_socket.readable_address
      })
    })

    nano_socket.on('message', (message) => {
      peer.messages += 1
      this.emit('message', message)
    })

    nano_socket.on('vote', (vote) => {
      this.emit('vote', vote)
      this.on_vote({
        vote,
        peer_readable_address: nano_socket.readable_address
      })
    })

    nano_socket.on('telemetry', (telemetry) => {
      this.on_telemetry({
        telemetry,
        peer_address,
        peer_readable_address: nano_socket.readable_address
      })
    })

    nano_socket.on('close', () => {
      this.peers.delete(peer_address)
      log(
        `closed connection to ${nano_socket.readable_address} (current: ${this.peers.size})`
      )
      nano_socket.removeAllListeners()
      this.emit('close', peer_address)
    })

    this.peers.set(peer_address, peer)
  }
}

export { constants as NanoConstants }
export { BulkPull, FrontierReq, BulkPullAccount } from './bootstrap.js'
