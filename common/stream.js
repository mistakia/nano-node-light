/*
  Nano Writable Stream
*/

import * as constants from './constants.js'
import { get_block_type, get_item_count } from './index.js'
import EventEmitter from 'events'

class StreamError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const ERROR_CODE = {
  UNSUPPORTED_NETWORK: 'UNSUPPORTED_NETWORK',
  PAYLOAD_EXCEEDS_LIMIT: 'PAYLOAD_EXCEEDS_LIMIT',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  INVALID_OP_CODE: 'INVALID_OP_CODE', // Message Type
  INVALID_BLOCK_TYPE: 'INVALID_BLOCK_TYPE'
}

const MAX_PACKET_LENGTH = 1024 * 65

function get_default() {
  return {
    header: Buffer.alloc(8),
    header_length: 0,

    message_type: null,
    version: null,
    extensions: null,

    body_size: 0,
    expected_body_size: null,
    body: Buffer.alloc(MAX_PACKET_LENGTH)
  }
}

function set_default_state(state) {
  state.header_length = 0

  state.message_type = null
  state.version = null
  state.extensions = null

  state.body_size = 0
  state.expected_body_size = null
}

// Body size from the header, sized as nano-node does. Returns null for an
// unknown message type and throws for a publish of an unknown block type.
function get_size(header) {
  switch (header.message_type) {
    case constants.MESSAGE_TYPE.KEEPALIVE: {
      return 144
    }
    case constants.MESSAGE_TYPE.PUBLISH: {
      const block_size =
        constants.BLOCK_SIZES[get_block_type(header.extensions)]
      if (!block_size) throw new StreamError(ERROR_CODE.INVALID_BLOCK_TYPE)
      return block_size
    }
    case constants.MESSAGE_TYPE.CONFIRM_REQ: {
      return get_item_count(header.extensions) * 64
    }
    case constants.MESSAGE_TYPE.CONFIRM_ACK: {
      return 104 + get_item_count(header.extensions) * 32
    }
    case constants.MESSAGE_TYPE.BULK_PULL: {
      const extended_length = header.extensions & 0x1 && 8

      return 64 + extended_length
    }
    case constants.MESSAGE_TYPE.FRONTIER_REQ: {
      return 40
    }
    case constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE: {
      const query_length = header.extensions & 0x1 && 32
      // A v2 response carries a salt and genesis hash: 160 bytes, else 96.
      const response_length =
        header.extensions & 0x2 ? (header.extensions & 0x4 ? 160 : 96) : 0

      return query_length + response_length
    }
    case constants.MESSAGE_TYPE.BULK_PULL_ACCOUNT: {
      return 49
    }
    case constants.MESSAGE_TYPE.TELEMETRY_REQ: {
      return 0
    }
    case constants.MESSAGE_TYPE.TELEMETRY_ACK: {
      const telemetry_length = header.extensions & 0x3ff

      return telemetry_length
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

// Frames data into messages, appending each to `messages`. Throws a
// StreamError on a framing error.
function frame(data, messages) {
  let next_data = data

  for (;;) {
    if (this.state.header_length === 8) {
      const body_ptr = this.state.expected_body_size - this.state.body_size
      const body = next_data.subarray(0, body_ptr)
      this.state.body.set(body, this.state.body_size)
      this.state.body_size += body.length

      if (this.state.body_size === this.state.expected_body_size) {
        // Copy Message Body as it will be reused for next message.
        const message_body = Buffer.alloc(this.state.expected_body_size)
        this.state.body.copy(message_body)

        messages.push({
          body: message_body,
          extensions: this.state.extensions,
          message_type: this.state.message_type,
          remote_version: this.state.version
        })

        set_default_state(this.state)

        next_data = next_data.subarray(body_ptr)
        if (next_data.length > 0) continue
      }
    } else {
      const header_ptr = 8 - this.state.header_length
      const header = next_data.subarray(0, header_ptr)
      this.state.header.set(header, this.state.header_length)
      this.state.header_length += header.length

      if (this.state.header_length === 8) {
        if (this.state.header[0] !== constants.MAGIC_NUMBER)
          throw new StreamError(ERROR_CODE.UNSUPPORTED_NETWORK)
        if (this.state.header[1] !== this.network)
          throw new StreamError(ERROR_CODE.UNSUPPORTED_NETWORK)
        if (this.state.header[3] < constants.MINIMUM_PROTOCOL_VERSION)
          throw new StreamError(ERROR_CODE.UNSUPPORTED_VERSION)
        if (this.state.header[4] > constants.MAXIMUM_PROTOCOL_VERSION)
          throw new StreamError(ERROR_CODE.UNSUPPORTED_VERSION)

        this.state.version = this.state.header[3]
        this.state.message_type = this.state.header[5]
        this.state.extensions =
          (this.state.header[7] << 8) + this.state.header[6]
        const body_size = get_size(this.state)

        if (body_size == null) throw new StreamError(ERROR_CODE.INVALID_OP_CODE)
        if (body_size > MAX_PACKET_LENGTH)
          throw new StreamError(ERROR_CODE.PAYLOAD_EXCEEDS_LIMIT)

        this.state.expected_body_size = body_size

        // An empty body completes the message without waiting for more data.
        next_data = next_data.subarray(header_ptr)
        if (next_data.length > 0 || body_size === 0) continue
      }
    }

    break
  }
}

// Emits `message` per framed message. A framing error emits `stream_error`
// once and ends the stream; an exception thrown by a `message` listener is
// emitted as `handler_error` and framing continues.
class NanoStream extends EventEmitter {
  constructor(network) {
    super()

    if (network == null) throw new Error('network is required')

    this.network = network
    this.state = get_default()
    this.is_busy = false
    this.queue = []
    this.active = true
  }

  push(packet) {
    if (!this.active) return

    this.queue.push(packet)
    if (this.is_busy) return

    this.is_busy = true
    while (this.active && this.queue.length) {
      const messages = []
      let framing_error = null
      try {
        frame.call(this, this.queue.shift(), messages)
      } catch (error) {
        framing_error = error
      }

      for (const message of messages) {
        if (!this.active) break
        try {
          this.emit('message', message)
        } catch (error) {
          this.emit('handler_error', error)
        }
      }

      if (framing_error) this.destroy(framing_error)
    }
    this.is_busy = false
  }

  destroy(error) {
    if (!this.active) return

    this.stop()
    this.emit('stream_error', error)
  }

  // Ends framing without an error, for a connection that closed.
  stop() {
    this.active = false
    this.queue = []
  }
}

export default NanoStream
