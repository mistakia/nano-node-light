import EventEmitter from 'events'
import crypto from 'crypto'
import debug from 'debug'

import { constants, ed25519, encodeAddress } from '#common'

import NanoSocket from './nano-socket.js'

const log = debug('node')

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

    this.sockets = []
  }

  connect({ address, port }) {
    const socket = new NanoSocket({
      address,
      port,
      nodeKey: this.nodeKey,
      network: this.network
    })

    socket.on('error', (error) => {
      this.emit('error', error)
    })

    socket.on('message', (message) => {
      this.emit('message', message)
    })

    this.sockets.push(socket)
  }
}
