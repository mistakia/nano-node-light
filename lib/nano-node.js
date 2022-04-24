import EventEmitter from 'events'
import crypto from 'crypto'
import debug from 'debug'

import {
  constants,
  ed25519,
  encodeAddress,
  decodeConnectionInfo
} from '#common'

import NanoSocket from './nano-socket.js'

const log = debug('node')

class NanoRepresentative {
  constructor(account) {
    this.account = account
    this.votes = 0
    this.last_vote = null
  }
}

class NanoPeer {
  constructor({ peerAddress, socket }) {
    this.nodeId = null
    this.address = peerAddress
    this.messages = 0
    this.last_message = null
    this.socket = socket
  }
}

export default class NanoNode extends EventEmitter {
  constructor({ address, port, network = constants.NETWORK.BETA }) {
    super()

    this.network = network

    const NodeSecret = crypto.randomBytes(32)
    const NodePublic = ed25519.getPublicKey(NodeSecret)
    this.nodeKey = {
      secret: NodeSecret,
      public: NodePublic
    }
    this.NodeID = encodeAddress({ publicKey: NodePublic, prefix: 'node_' })

    log(`Node Address: ${address}:${port}`)
    log(`Node Secret: ${NodeSecret.toString('hex')}`)
    log(`Node Public: ${Buffer.from(NodePublic).toString('hex')}`)
    log(`Node ID: ${this.NodeID}`)

    this.peers = new Map()
    this.representatives = new Map()
  }

  _getRepresentative({ account, peerAddress }) {
    const foundRep = this.representatives.get(account)
    if (foundRep) {
      return foundRep
    }

    log(`found new representative ${account}, at ${peerAddress}`)
    const rep = new NanoRepresentative(account)
    this.representatives.set(account, rep)
    return rep
  }

  onPeers(peers) {
    for (const peer of peers) {
      const { address, port } = decodeConnectionInfo(peer)
      if (this.peers.has(`${address}:${peer}`)) continue
      this.connect({ address, port })
    }
  }

  onVote({ vote, peerAddress }) {
    const repAddress = vote.account.toString('hex')
    const representative = this._getRepresentative({
      account: repAddress,
      peerAddress
    })

    if (vote.isValid) {
      representative.votes += 1
      representative.last_vote = process.hrtime.bigint()
    } else {
      log(`invalid vote received from ${peerAddress}, rep: ${repAddress}`)
    }
  }

  publish(block) {
    for (const peer of this.peers.values()) {
      peer.socket.sendMessage({
        messageType: constants.MESSAGE_TYPE.PUBLISH,
        message: block,
        extensions: 0x600
      })
    }
  }

  connect({ address, port }) {
    const peerAddress = `${address}:${port}`
    log(`opening connection to ${peerAddress} (current: ${this.peers.size})`)
    const socket = new NanoSocket({
      address,
      port,
      nodeKey: this.nodeKey,
      network: this.network
    })
    const peer = new NanoPeer({ peerAddress, socket })

    socket.on('error', (error) => {
      this.emit('error', error)
    })

    socket.on('message', (message) => {
      peer.messages += 1
      this.emit('message', message)
    })

    socket.on('peers', (peers) => {
      this.onPeers(peers)
    })

    socket.on('vote', (vote) => {
      this.emit('vote', vote)
      this.onVote({ vote, peerAddress })
    })

    socket.on('represenative', (representative) => {})

    socket.on('close', () => {
      this.peers.delete(peerAddress)
      log(`closed connection to ${peerAddress} (current: ${this.peers.size})`)
    })

    this.peers.set(peerAddress, peer)
  }
}
