/*
  Nano Writable Stream
*/

import * as constants from './constants.js'
import EventEmitter from 'events'

class StreamError {
  constructor(code) {
    this.code = code
  }
}

const Errors = {
  UnsupportedNetwork: new StreamError('UNSUPPORTED_NETWORK'),
  PayloadExceedsLimit: new StreamError('PAYLOAD_EXCEEDS_LIMIT'),
  UnsupportedVersion: new StreamError('UNSUPPORTED_VERSION'),
  InvalidOpCode: new StreamError('INVALID_OP_CODE') // Message Type
}

const MAX_PACKET_LENGTH = 1024

function getDefault() {
  return {
    header: Buffer.alloc(8),
    headerLength: 0,

    message_type: null,
    version: null,
    extensions: null,

    bodySize: 0,
    expectedBodySize: null,
    body: Buffer.alloc(MAX_PACKET_LENGTH)
  }
}

function setDefaultState(state) {
  state.headerLength = 0

  state.message_type = null
  state.version = null
  state.extensions = null

  state.bodySize = 0
  state.expectedBodySize = null
}

const blockSizes = {
  0x00: 0, // Invalid
  0x01: 0, // Not A Block (NaB)
  0x02: 152, // Send (Legacy)
  0x03: 136, // Receive (Legacy)
  0x04: 168, // Open (Legacy)
  0x05: 136, // Change (Legacy)
  0x06: 216 // State
}

function getSize_Origin(header) {
  switch (header.message_type) {
    case constants.MESSAGE_TYPE.KEEPALIVE: {
      return 144
    }
    case constants.MESSAGE_TYPE.PUBLISH: {
      const blockType = (header.extensions & 0x0f00) >> 8
      const blockSize = blockSizes[blockType]

      if (blockSize) return blockSize
      return 0
    }
    case constants.MESSAGE_TYPE.CONFIRM_REQ: {
      const blockType = (header.extensions & 0x0f00) >> 8
      const is_v2 = (header.extensions & 0x01) !== 0
      let block_count

      if (is_v2) {
        const left = (header.extensions & 0xf000) >> 12
        const right = (header.extensions & 0x00f0) >> 4
        block_count = (left << 4) | right
      } else {
        block_count = (header.extensions & 0xf000) >> 12
      }

      if (blockType !== 0 && blockType !== 1) {
        const blockSize = blockSizes[blockType]
        if (blockSize) return blockSize
      } else if (blockType === 1) {
        return block_count * 64
      }

      return 0
    }
    case constants.MESSAGE_TYPE.CONFIRM_ACK: {
      const blockType = (header.extensions & 0x0f00) >> 8
      const is_v2 = (header.extensions & 0x01) !== 0
      let block_count

      if (is_v2) {
        const left = (header.extensions & 0xf000) >> 12
        const right = (header.extensions & 0x00f0) >> 4
        block_count = (left << 4) | right
      } else {
        block_count = (header.extensions & 0xf000) >> 12
      }

      let size = 0

      if (blockType !== 0 && blockType !== 1) {
        const blockSize = blockSizes[blockType]
        if (blockSize) {
          size = blockSize
        }
      } else if (blockType === 1) {
        size = block_count * 32
      }

      return 104 + size
    }
    case constants.MESSAGE_TYPE.BULK_PULL: {
      const extendedLength = header.extensions & 0x1 && 8

      return 64 + extendedLength
    }
    case constants.MESSAGE_TYPE.FRONTIER_REQ: {
      return 40
    }
    case constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE: {
      const queryLength = header.extensions & 0x1 && 32
      const responseLength = header.extensions & 0x2 && 96

      return queryLength + responseLength
    }
    case constants.MESSAGE_TYPE.BULK_PULL_ACCOUNT: {
      return 49
    }
    case constants.MESSAGE_TYPE.TELEMETRY_REQ: {
      return 0
    }
    case constants.MESSAGE_TYPE.TELEMETRY_ACK: {
      const telemetryLength = header.extensions & 0x3ff

      return telemetryLength
    }
    case constants.MESSAGE_TYPE.ASC_PULL_REQ: {
      return 9 + header.extensions
    }
    case constants.MESSAGE_TYPE.ASC_PULL_ACK: {
      return 9 + header.extensions
    }
    case constants.MESSAGE_TYPE.PROTOCOL_UPGRADE: {
      return 0
    }
  }

  return null
}

function getSize_Light(header) {
  return null
}

function getSize(header, mode) {
  if (mode === 1) {
    return getSize_Light(header)
  } else {
    return getSize_Origin(header)
  }
}

function processStream(data) {
  if (!this.active) return

  let nextData = data

  for (;;) {
    if (this.state.headerLength === 8) {
      const bodyPtr = this.state.expectedBodySize - this.state.bodySize
      const body = nextData.subarray(0, bodyPtr)
      this.state.body.set(body, this.state.bodySize)
      this.state.bodySize += body.length

      if (this.state.bodySize === this.state.expectedBodySize) {
        // Copy Message Body as it will be reused for next message.
        const messageBody = Buffer.alloc(this.state.expectedBodySize)
        this.state.body.copy(messageBody)

        this.emit('message', {
          body: messageBody,
          extensions: this.state.extensions,
          message_type: this.state.message_type,
          remote_version: this.state.version
        })

        setDefaultState(this.state)

        nextData = nextData.subarray(bodyPtr)
        if (nextData.length > 0) continue
      }
    } else {
      const headerPtr = 8 - this.state.headerLength
      const header = nextData.subarray(0, headerPtr)
      this.state.header.set(header, this.state.headerLength)
      this.state.headerLength += header.length

      if (this.state.headerLength === 8) {
        if (this.state.header[0] !== constants.MAGIC_NUMBER)
          throw Errors.UnsupportedNetwork
        if (this.state.header[1] !== this.network)
          throw Errors.UnsupportedNetwork
        if (this.state.header[3] < 0x12) throw Errors.UnsupportedVersion
        if (this.state.header[4] > 0x13) throw Errors.UnsupportedVersion

        this.state.version = this.state.header[3]
        this.state.message_type = this.state.header[5]
        this.state.extensions =
          (this.state.header[7] << 8) + this.state.header[6]
        const bodySize = getSize(this.state, this.streamMode)

        if (bodySize == null) throw Errors.InvalidOpCode
        if (bodySize > MAX_PACKET_LENGTH) throw Errors.PayloadExceedsLimit

        this.state.expectedBodySize = bodySize

        nextData = nextData.subarray(headerPtr)
        if (nextData.length > 0) continue
      }
    }

    break
  }
}

class NanoStream extends EventEmitter {
  constructor(network = constants.NETWORK.BETA.ID) {
    super()

    this.network = network
    this.state = getDefault()
    this.isBusy = false
    this.queue = []

    this.streamMode = 0

    this.active = true
  }

  process(packet) {
    this.isBusy = true

    let nextPacket = packet

    while (nextPacket) {
      try {
        processStream.call(this, nextPacket)

        nextPacket = this.queue.shift()
      } catch (e) {
        this.destroy(e)

        return
      }
    }

    this.isBusy = false
  }

  destroy(e) {
    this.active = false
    this.queue = []
    this.isBusy = true
    delete this.state

    this.emit('streamError', e) // Emitting error causes a Uncaught Exception
  }

  push(packet) {
    if (this.isBusy) {
      this.queue.push(packet)
    } else {
      this.process(packet)
    }
  }
}

export default NanoStream
