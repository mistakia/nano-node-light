import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'

import {
  encodeMessage,
  decodeMessage,
  encodeAddress,
  constants,
  decodeNodeHandshake,
  ed25519
} from '#common'

const log = debug('socket')

export default class NanoSocket extends EventEmitter {
  constructor({ address, port, nodeKey }) {
    super()

    this.address = address
    this.port = port
    this.nodeKey = nodeKey
    this.cookie = crypto.randomBytes(32)
    this.connectedNodeId = null

    this.socket = net.createConnection(
      {
        host: address,
        port: port
      },
      this.onConnection
    )

    this.socket.on('data', (data) => this.handleMessage(data))
    this.socket.on('close', () => {
      this.emit('close')
      this.socket.removeAllListeners('data')
      this.socket.removeAllListeners('close')
    })
    this.socket.on('error', (error) => {
      this.emit('error', error)
    })
  }

  onConnection = () => {
    const NodeIDMessage = encodeMessage({
      message: this.cookie,
      messageType: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
      extensions: 1
    })

    this.socket.write(NodeIDMessage)
  }

  sendMessage = ({ messageType, message, extensions }) => {
    log(
      `sending ${constants.MESSAGE_TYPE_NAME[messageType]} to ${this.address}:${this.port}`
    )
    this.socket.write(encodeMessage({ message, messageType, extensions }))
  }

  close = () => this.socket.destroy()

  keepalive = (peerList) => {
    this.sendMessage({
      messageType: constants.MESSAGE_TYPE.KEEPALIVE,
      message: Buffer.concat(peerList, 144),
      extensions: 0
    })
  }

  handleHandshake = (packetInfo) => {
    const { data, extensions } = packetInfo
    const handshake = decodeNodeHandshake({ packet: data, extensions })
    let responseData = Buffer.from([])
    let queryData = Buffer.from([])
    let ext = 0

    if (handshake.query && !this.handshakeResponded) {
      this.handshakeResponded = true
      const Signature = ed25519.sign(handshake.query, this.nodeKey.secret)
      responseData = Buffer.concat([this.nodeKey.public, Signature])
      ext |= 2
    }

    if (handshake.response && !this.connectedNodeId) {
      const { account, signature } = handshake.response
      const validation = ed25519.verify(signature, this.cookie, account)
      if (!validation) {
        // log invalid handshake signature
        return
      }

      this.connectedNodeId = encodeAddress({
        publicKey: account,
        prefix: 'node_'
      })
    } else if (!this.connectedNodeId) {
      ext |= 1
      queryData = this.cookie
    }

    if (ext !== 0) {
      this.sendMessage({
        messageType: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
        message: Buffer.concat([queryData, responseData]),
        extensions: ext
      })
    }
  }

  handleMessage = (packet) => {
    const packetInfo = decodeMessage({ packet })
    if (packetInfo == null) return

    log(
      `Received ${constants.MESSAGE_TYPE_NAME[packetInfo.messageType]} from ${
        this.address
      }:${this.port}`
    )

    switch (packetInfo.messageType) {
      case constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE: {
        this.handleHandshake(packetInfo)
        break
      }

      default: {
        // log warning
      }
    }
  }
}
