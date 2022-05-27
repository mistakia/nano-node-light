import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'

import {
  encodeMessage,
  constants,
  decodeNodeHandshake,
  decodeVote,
  ed25519,
  decodeTelemetry,
  encodeConnectionInfo,
  decodeConnectionInfo
} from '#common'

import NanoStream from '#common/stream.js'

const log = debug('socket')

export default class NanoSocket extends EventEmitter {
  constructor({ connectionInfo, node, socket }) {
    super()

    this.isIncoming = Boolean(socket)
    this.node = node
    this.cookie = crypto.randomBytes(32)
    this.connectedNodeId = null
    this.handshake_completed = false

    if (this.isIncoming) {
      log(`Incoming socket status: ${socket.readyState}`)
      this.socket = socket
      const { remoteAddress, remotePort } = socket
      this.peerAddress = encodeConnectionInfo({
        address: remoteAddress,
        port: remotePort
      }).toString('binary')

      this.readableAddress = `[${remoteAddress}]:${remotePort}`
    } else {
      this.peerAddress = connectionInfo.toString('binary')
      const connection = decodeConnectionInfo(connectionInfo)
      const options = {
        host: connection.address,
        port: connection.port
      }
      this.readableAddress = `[${connection.address}]:${connection.port}`
      this.socket = net.createConnection(options, this.onConnection)
    }

    const stream = (this.stream = new NanoStream(this.node.network.ID))

    this.socket.on('data', (data) => stream.push(data))
    stream.on('message', (msg) => {
      this.emit('message', msg)
      this.handleMessage(msg)
    })

    this.socket.on('close', () => {
      this.emit('close')
      this.socket.removeAllListeners()
    })

    this.socket.on('error', (error) => {
      this.emit('error', error)
    })
  }

  onConnection = () => {
    const nodeIDMessage = encodeMessage({
      message: this.cookie,
      messageType: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
      extensions: 1,
      network: this.node.network.ID
    })

    this.socket.write(nodeIDMessage)
  }

  send_confirm_req = (block_hash_pairs) => {
    if (!this.handshake_completed) {
      log('ignoring send_confirm_req because handshake not completed')
      return
    }

    const block_count = block_hash_pairs.length
    let extensions = 0

    // Set block type to 'not_a_block' (value 1) in the extensions (bits 8-15)
    extensions |= 1 << 8

    if (block_count > 15) {
      // Confirm V2 flag must be set for version 2
      extensions |= 1 << 0 // Set the V2 flag (bit 0)

      // Version 2: Use bits 12-15 for the high part and bits 4-7 for the low part of the count
      const high_part = (block_count >> 4) & 0x0f // High part of the count
      const low_part = block_count & 0x0f // Low part of the count
      extensions |= high_part << 12
      extensions |= low_part << 4
    } else {
      // Version 1: Use bits 12-15 for the count
      extensions |= block_count << 12
    }

    this.sendMessage({
      messageType: constants.MESSAGE_TYPE.CONFIRM_REQ,
      message: Buffer.concat(block_hash_pairs),
      extensions
    })
  }

  sendMessage = ({ messageType, message, extensions, onSent }) => {
    log(
      `sending ${constants.MESSAGE_TYPE_NAME[messageType]} to ${this.readableAddress}`
    )
    const encoded = encodeMessage({
      message,
      messageType,
      extensions,
      network: this.node.network.ID
    })

    if (messageType === constants.MESSAGE_TYPE.CONFIRM_REQ) {
      log(encoded)
    }
    return this.socket.write(encoded, null, onSent)
  }

  close = () => this.socket.destroy()

  keepalive = (peerList) => {
    this.sendMessage({
      messageType: constants.MESSAGE_TYPE.KEEPALIVE,
      message: Buffer.concat(peerList, 144),
      extensions: 0
    })
  }

  handleHandshake = ({ body, extensions }) => {
    const handshake = decodeNodeHandshake({ packet: body, extensions })
    let responseData = Buffer.from([])
    let queryData = Buffer.from([])
    let ext = 0

    if (handshake.query && !this.handshakeResponded) {
      this.handshakeResponded = true
      const Signature = ed25519.sign(
        handshake.query,
        this.node.nodeKey.secret,
        this.node.nodeKey.public
      )
      responseData = Buffer.concat([this.node.nodeKey.public, Signature])
      ext |= 2
    }

    if (handshake.response && !this.connectedNodeId) {
      const { account, signature } = handshake.response
      const validation = ed25519.verify(signature, this.cookie, account)
      if (!validation) {
        log(`received invalid handshake signature from ${this.readableAddress}`)
        return
      }

      this.connectedNodeId = account
      this.handshake_completed = true
      this.emit('handshake', { nodeId: account })
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

  handleKeepalive = (body) => {
    const peer_count = Math.floor(body.length / 18)
    const peers = []
    for (let i = 0; i < peer_count; i++) {
      const peerPtr = i * 18
      const peer = body.subarray(peerPtr, peerPtr + 18)
      const address = peer.subarray(0, 16)
      if (!address.equals(constants.SELF_ADDRESS)) {
        peers.push(peer)
      }
    }
    this.emit('peers', peers)
  }

  handleVote = ({ body, extensions }) => {
    const voteInfo = decodeVote({ body, extensions })
    if (voteInfo.isValid !== true) return
    this.emit('vote', voteInfo)
  }

  handleTelemetry = ({ body, extensions }) => {
    if (body.length < 194) return
    const telemetryInfo = decodeTelemetry({ body, extensions })
    this.emit('telemetry', {
      ...telemetryInfo,
      address: this.socket.remoteAddress,
      port: this.socket.remotePort
    })
  }

  handleMessage = (msgInfo) => {
    const { body, extensions, message_type } = msgInfo

    log(
      `Received ${constants.MESSAGE_TYPE_NAME[message_type]} from ${this.readableAddress}`
    )

    switch (message_type) {
      case constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE: {
        this.handleHandshake({ body, extensions })
        break
      }

      case constants.MESSAGE_TYPE.KEEPALIVE: {
        this.node.handleKeepalive(body)
        break
      }

      case constants.MESSAGE_TYPE.CONFIRM_ACK: {
        this.handleVote({ body, extensions })
        break
      }

      case constants.MESSAGE_TYPE.TELEMETRY_REQ: {
        this.sendMessage({
          message: Buffer.alloc(0),
          messageType: constants.MESSAGE_TYPE.TELEMETRY_ACK,
          extensions: 0
        })
        break
      }

      case constants.MESSAGE_TYPE.TELEMETRY_ACK: {
        this.handleTelemetry({ body, extensions })
        break
      }

      default: {
        // log warning
      }
    }
  }
}
