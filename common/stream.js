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

const ERRORS = {
  UNSUPPORTED_NETWORK: new StreamError('UNSUPPORTED_NETWORK'),
  PAYLOAD_EXCEEDS_LIMIT: new StreamError('PAYLOAD_EXCEEDS_LIMIT'),
  UNSUPPORTED_VERSION: new StreamError('UNSUPPORTED_VERSION'),
  INVALID_OP_CODE: new StreamError('INVALID_OP_CODE') // Message Type
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

function get_size_origin(header) {
  switch (header.message_type) {
    case constants.MESSAGE_TYPE.KEEPALIVE: {
      return 144
    }
    case constants.MESSAGE_TYPE.PUBLISH: {
      const block_type = (header.extensions & 0x0f00) >> 8
      const block_size = constants.BLOCK_SIZES[block_type]

      if (block_size) return block_size
      return 0
    }
    case constants.MESSAGE_TYPE.CONFIRM_REQ: {
      const block_type = (header.extensions & 0x0f00) >> 8
      const is_v2 = (header.extensions & 0x01) !== 0
      let block_count

      if (is_v2) {
        const left = (header.extensions & 0xf000) >> 12
        const right = (header.extensions & 0x00f0) >> 4
        block_count = (left << 4) | right
      } else {
        block_count = (header.extensions & 0xf000) >> 12
      }

      if (block_type !== 0 && block_type !== 1) {
        const block_size = constants.BLOCK_SIZES[block_type]
        if (block_size) return block_size
      } else if (block_type === 1) {
        return block_count * 64
      }

      return 0
    }
    case constants.MESSAGE_TYPE.CONFIRM_ACK: {
      const block_type = (header.extensions & 0x0f00) >> 8
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

      if (block_type !== 0 && block_type !== 1) {
        const block_size = constants.BLOCK_SIZES[block_type]
        if (block_size) {
          size = block_size
        }
      } else if (block_type === 1) {
        size = block_count * 32
      }

      return 104 + size
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
      const response_length = header.extensions & 0x2 && 160

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

function get_size_light(header) {
  return null
}

function get_size(header, mode) {
  if (mode === 1) {
    return get_size_light(header)
  } else {
    return get_size_origin(header)
  }
}

function process_stream(data) {
  if (!this.active) return

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

        this.emit('message', {
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
          throw ERRORS.UNSUPPORTED_NETWORK
        if (this.state.header[1] !== this.network)
          throw ERRORS.UNSUPPORTED_NETWORK
        if (this.state.header[3] < constants.MINIMUM_PROTOCOL_VERSION)
          throw ERRORS.UNSUPPORTED_VERSION
        if (this.state.header[4] > constants.MAXIMUM_PROTOCOL_VERSION)
          throw ERRORS.UNSUPPORTED_VERSION

        this.state.version = this.state.header[3]
        this.state.message_type = this.state.header[5]
        this.state.extensions =
          (this.state.header[7] << 8) + this.state.header[6]
        const body_size = get_size(this.state, this.stream_mode)

        if (body_size == null) throw ERRORS.INVALID_OP_CODE
        if (body_size > MAX_PACKET_LENGTH) throw ERRORS.PAYLOAD_EXCEEDS_LIMIT

        this.state.expected_body_size = body_size

        next_data = next_data.subarray(header_ptr)
        if (next_data.length > 0) continue
      }
    }

    break
  }
}

class NanoStream extends EventEmitter {
  constructor(network = constants.NETWORK.BETA.ID) {
    super()

    this.network = network
    this.state = get_default()
    this.is_busy = false
    this.queue = []

    this.stream_mode = 0

    this.active = true
  }

  process(packet) {
    this.is_busy = true

    let next_packet = packet

    while (next_packet) {
      try {
        process_stream.call(this, next_packet)

        next_packet = this.queue.shift()
      } catch (e) {
        this.destroy(e)

        return
      }
    }

    this.is_busy = false
  }

  destroy(e) {
    this.active = false
    this.queue = []
    this.is_busy = true
    delete this.state

    this.emit('stream_error', e) // Emitting error causes a Uncaught Exception
  }

  push(packet) {
    if (this.is_busy) {
      this.queue.push(packet)
    } else {
      this.process(packet)
    }
  }
}

export default NanoStream
