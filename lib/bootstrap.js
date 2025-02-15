import net from 'net'
import EventEmitter from 'events'
import debug from 'debug'

import { encode_message, constants, decode_block } from '#common'

const log = debug('bootstrap')

const NULL_FRONTIER = Buffer.alloc(64, 0)

const BULK_PULL_ACCOUNT_FLAGS = {
  0x00: {
    ENTRY_SIZE: 48,
    NULL_ENTRY: Buffer.alloc(48, 0),
    HAS_HASH: true,
    HAS_SOURCE: false
  },
  0x01: {
    ENTRY_SIZE: 32,
    NULL_ENTRY: Buffer.alloc(32, 0),
    HAS_HASH: false,
    HAS_SOURCE: true
  },
  0x02: {
    ENTRY_SIZE: 80,
    NULL_ENTRY: Buffer.alloc(80, 0),
    HAS_HASH: true,
    HAS_SOURCE: true
  }
}

// Add enum for pull types to match Rust implementation
const ASC_PULL_TYPE = {
  BLOCKS: 0x1,
  ACCOUNT_INFO: 0x2,
  FRONTIERS: 0x3
}

// Add enum for hash types
const HASH_TYPE = {
  ACCOUNT: 0x0,
  BLOCK: 0x1
}

export class BulkPull extends EventEmitter {
  constructor({
    host,
    port,
    experimental = false,
    network = constants.NETWORK.BETA.ID
  }) {
    super()

    this.experimental = experimental
    this.network = network
    this.destroyed = false

    this.state = {
      block: null,
      block_type: null,
      expected_size: null,
      size: 0,
      add_ptr: null
    }

    this.socket = net.createConnection(
      {
        host,
        port
      },
      () => {
        this.emit('open')
      }
    )
    this.socket.on('error', (error) => {
      this.emit('error', error)
    })
    this.socket.on('close', () => {
      this.emit('close')
    })
    this.socket.on('data', (data) => {
      this.handle_msg(data)
    })
  }

  default_state() {
    this.state.block = null
    this.state.block_type = null
    this.state.expected_size = null
    this.state.add_ptr = null
    this.state.size = 0
  }

  close() {
    this.client.destroy()
    this.destroyed = true
  }

  request({ start, end = Buffer.alloc(32), count, ascending = false }) {
    if (ascending && !this.experimental)
      throw new TypeError(
        "To use the 'ascending' flag, you must enable experimental mode."
      )
    const has_count = count !== undefined
    const message = Buffer.alloc(64 + (has_count && 8))
    message.set(start)
    message.set(end, 32)
    if (has_count) {
      message.writeUInt32LE(count, 65)
    }

    this.socket.write(
      encode_message({
        message,
        message_type: constants.MESSAGE_TYPE.BULK_PULL,
        extensions: (has_count && 1) | (ascending && 2),
        network: this.network.ID
      })
    )
  }

  handle_msg(data) {
    if (this.destroyed) return
    const state = this.state

    let ptr = 0
    const length = data.length
    for (;;) {
      if (state.block_type) {
        if (!state.add_ptr) {
          state.add_ptr = true
          ptr++
        }

        const body_ptr = ptr + state.expected_size - state.size
        const body = data.subarray(ptr, body_ptr)
        state.block.set(body, state.size)
        state.size += body.length

        if (state.size === state.expected_size) {
          const msg_info = Object.assign({}, state)
          delete msg_info.size
          delete msg_info.expected_size
          delete msg_info.add_ptr

          if (msg_info.block_type === 1) {
            this.emit('end')
          } else {
            const block_info = decode_block(state)
            this.emit('block', block_info)
          }

          this.default_state()
        }

        ptr += body.length
      } else {
        const block_type = data[ptr]
        state.block_type = block_type
        const block_size = constants.BLOCK_SIZES[block_type]
        if (block_type === undefined) {
          this.close()
          break
        }
        state.expected_size = block_size
        state.block = Buffer.alloc(block_size)
        state.add_ptr = false
      }
      if (ptr >= length) break
    }
  }
}

export class FrontierReq extends EventEmitter {
  constructor({ host, port, network = constants.NETWORK.BETA.ID }) {
    super()

    this.network = network
    this.state = {
      current: Buffer.alloc(64),
      size: 0
    }

    this.socket = net.createConnection(
      {
        host,
        port
      },
      () => {
        this.emit('open')
      }
    )
    this.socket.on('error', () => {
      log('FrontierReq error')
      this.emit('close')
    })
    this.socket.on('close', () => {
      log('FrontierReq closed')
      this.emit('close')
    })
    this.socket.on('data', (data) => {
      log('FrontierReq data')
      this.handle_msg(data)
    })
  }

  default_state() {
    this.state.size = 0
  }

  close() {
    this.client.destroy()
  }

  request({
    start,
    age = 0xffffffff,
    count = 0xffffffff,
    confirmed_only = false
  }) {
    const message = Buffer.alloc(40)
    message.set(start)
    message.writeUInt32LE(age, 32)
    message.writeUInt32LE(count, 36)

    log(message)

    this.socket.write(
      encode_message({
        message,
        message_type: constants.MESSAGE_TYPE.FRONTIER_REQ,
        extensions: confirmed_only && 2,
        network: this.network.ID
      })
    )
  }

  handle_msg(data) {
    log(data)
    if (this.destroyed) return
    const state = this.state

    let ptr = 0
    const length = data.length
    for (;;) {
      const body_ptr = ptr + 64 - state.size
      const body = data.subarray(ptr, body_ptr)
      state.current.set(body, state.size)
      state.size += body.length

      if (state.size === 64) {
        if (state.current.equals(NULL_FRONTIER)) {
          this.emit('end')
        } else {
          const account_public_key_buf = Buffer.alloc(32)
          const frontier_hash_buf = Buffer.alloc(32)

          state.current.copy(account_public_key_buf, 0, 0)
          state.current.copy(frontier_hash_buf, 0, 32)

          this.emit('frontier', {
            account_public_key_buf,
            frontier_hash_buf
          })
        }

        this.default_state()
      }

      ptr += body.length

      if (ptr >= length) break
    }
  }
}

export class BulkPullAccount extends EventEmitter {
  constructor({ host, port, network = constants.NETWORK.BETA.ID }) {
    super()

    this.network = network
    this.destroyed = false
    this.entry_flag = null

    this.state = {
      frontier_entry: Buffer.alloc(48),
      frontier_size: 0,
      bulk_entry: null,
      bulk_size: 0
    }

    this.socket = net.createConnection(
      {
        host,
        port
      },
      () => {
        this.emit('open')
      }
    )
    this.socket.on('error', (error) => {
      this.emit('error', error)
    })
    this.socket.on('close', () => {
      this.emit('close')
    })
    this.socket.on('data', (data) => {
      this.handle_msg(data)
    })
  }

  default_state() {
    this.state.frontier_size = 0
    this.state.bulk_size = 0
    this.state.bulk_entry = null
  }

  close() {
    this.client.destroy()
    this.destroyed = true
  }

  request({ account, minimum_amount = 0n, flags = 0x00 }) {
    if (!BULK_PULL_ACCOUNT_FLAGS[flags]) throw new TypeError('Flag is invalid')

    const message = Buffer.alloc(49)
    message.set(account)
    message.writeBigUInt64BE(minimum_amount >> 64n, 32)
    message.writeBigUInt64BE(minimum_amount & 0xffffffffffffffffn, 40)
    message[48] = flags

    this.entry_flag = BULK_PULL_ACCOUNT_FLAGS[flags]

    this.socket.write(
      encode_message({
        message,
        message_type: constants.MESSAGE_TYPE.BULK_PULL_ACCOUNT,
        extensions: 0,
        network: this.network.ID
      })
    )
  }

  handle_msg(data) {
    if (this.destroyed) return
    const state = this.state

    let ptr = 0
    const length = data.length
    for (;;) {
      if (state.bulk_entry) {
        const body_ptr = ptr + this.entry_flag.ENTRY_SIZE - state.bulk_size
        const body = data.subarray(ptr, body_ptr)
        state.bulk_entry.set(body, state.bulk_size)
        state.bulk_size += body.length

        if (state.bulk_size === this.entry_flag.ENTRY_SIZE) {
          if (state.bulk_entry.equals(this.entry_flag.NULL_ENTRY)) {
            this.default_state()
            this.emit('end')
          } else {
            const entry = {}
            if (this.entry_flag.HAS_HASH) {
              const block_hash_buf = Buffer.alloc(32)
              state.bulk_entry.copy(block_hash_buf, 0, 0)
              entry.block_hash_buf = block_hash_buf

              const segment_one = state.bulk_entry.readBigUInt64BE(32)
              const segment_two = state.bulk_entry.readBigUInt64BE(40)
              entry.amount_buf = (segment_one << 64n) + segment_two
            }
            if (this.entry_flag.HAS_SOURCE) {
              const offset = this.entry_flag.HAS_HASH && 48

              const source_public_key_buf = Buffer.alloc(32)
              state.bulk_entry.copy(source_public_key_buf, 0, offset)

              entry.source_public_key_buf = source_public_key_buf
            }
            this.emit('entry', entry)
          }
          state.bulk_size = 0
        }

        ptr += body.length
      } else {
        const body_ptr = ptr + 48 - state.frontier_size
        const body = data.subarray(ptr, body_ptr)
        state.frontier_entry.set(body, state.frontier_size)
        state.frontier_size += body.length

        if (state.frontier_size === 48) {
          const frontier_hash_buf = Buffer.alloc(32)
          state.frontier_entry.copy(frontier_hash_buf, 0, 0)

          const segment_one = state.frontier_entry.readBigUInt64BE(32)
          const segment_two = state.frontier_entry.readBigUInt64BE(40)
          const balance_buf = (segment_one << 64n) + segment_two

          this.emit('frontier', { frontier_hash_buf, balance_buf })
          state.bulk_entry = Buffer.alloc(this.entry_flag.ENTRY_SIZE)
        }

        ptr += body.length
      }
      if (ptr >= length) break
    }
  }
}

export class AscPull extends EventEmitter {
  constructor({
    host,
    port,
    network = constants.NETWORK.BETA.ID
  }) {
    super()

    this.network = network
    this.destroyed = false
    this.request_id = 0n

    this.state = {
      type: null,
      id: null,
      payload: null,
      payload_size: 0,
      expected_size: null
    }

    this.socket = net.createConnection(
      {
        host,
        port
      },
      () => {
        this.emit('open')
      }
    )
    this.socket.on('error', (error) => {
      this.emit('error', error)
    })
    this.socket.on('close', () => {
      this.emit('close')
    })
    this.socket.on('data', (data) => {
      this.handle_msg(data)
    })
  }

  default_state() {
    this.state.type = null
    this.state.id = null
    this.state.payload = null
    this.state.payload_size = 0
    this.state.expected_size = null
  }

  close() {
    this.socket.destroy()
    this.destroyed = true
  }

  request_blocks({ start, count = 0xff, start_type = HASH_TYPE.ACCOUNT }) {
    const message = Buffer.alloc(34) // 32 + 1 + 1
    message.set(start)
    message.writeUInt8(count, 32)
    message.writeUInt8(start_type, 33)

    // Extensions: payload size (34)
    const payload_size = 34 - 1 - 8 // Subtract type and id bytes
    const extensions = payload_size & 0xffff

    this.socket.write(
      encode_message({
        message,
        message_type: constants.MESSAGE_TYPE.ASC_PULL_REQ,
        extensions,
        network: this.network.ID
      })
    )
    return this.request_id++
  }

  request_account_info({ target, target_type = HASH_TYPE.ACCOUNT }) {
    const message = Buffer.alloc(33) // 32 + 1
    message.set(target)
    message.writeUInt8(target_type, 32)

    // Extensions: payload size (33)
    const payload_size = 33 - 1 - 8 // Subtract type and id bytes
    const extensions = payload_size & 0xffff

    this.socket.write(
      encode_message({
        message,
        message_type: constants.MESSAGE_TYPE.ASC_PULL_REQ,
        extensions,
        network: this.network.ID
      })
    )
    return this.request_id++
  }

  request_frontiers({ start, count }) {
    if (count > 1000n) {
        count = 1000n // Enforce max frontiers limit
    }

    const message = Buffer.alloc(40) // 32 + 8
    message.set(start)
    message.writeBigUInt64BE(BigInt(count), 32)

    // Extensions: payload size (40)
    const payload_size = 40 - 1 - 8 // Subtract type and id bytes
    const extensions = payload_size & 0xffff

    log({ message, extensions })

    this.socket.write(
      encode_message({
        message,
        message_type: constants.MESSAGE_TYPE.ASC_PULL_REQ,
        extensions,
        network: this.network.ID
      })
    )
    return this.request_id++
  }

  handle_msg(data) {
    log(data)
    if (this.destroyed) return
    const state = this.state

    let ptr = 0
    const length = data.length

    while (ptr < length) {
      if (!state.type) {
        // Read message header
        state.type = data[ptr++]
        state.id = data.readBigUInt64BE(ptr)
        ptr += 8

        // Read payload size from extensions field
        const extensions = data.readUInt16BE(ptr)
        ptr += 2
        // Calculate payload size by adding back type and id bytes
        state.expected_size = (extensions & 0xffff) + 1 + 8

        state.payload = Buffer.alloc(state.expected_size)
      }

      const remaining = state.expected_size - state.payload_size
      const chunk_size = Math.min(remaining, length - ptr)
      data.copy(state.payload, state.payload_size, ptr, ptr + chunk_size)
      state.payload_size += chunk_size
      ptr += chunk_size

      if (state.payload_size === state.expected_size) {
        this.handle_payload()
        this.default_state()
      }
    }
  }

  handle_payload() {
    const { type, id, payload } = this.state

    switch (type) {
      case constants.ASC_PULL_TYPE.BLOCKS:
        this.emit('blocks', {
          id,
          blocks: this.decode_blocks(payload)
        })
        break

      case constants.ASC_PULL_TYPE.ACCOUNT_INFO:
        this.emit('account_info', {
          id,
          info: this.decode_account_info(payload)
        })
        break

      case constants.ASC_PULL_TYPE.FRONTIERS:
        this.emit('frontiers', {
          id,
          frontiers: this.decode_frontiers(payload)
        })
        break
    }
  }

  // Helper methods to decode different payload types
  decode_blocks(payload) {
    const blocks = []
    let ptr = 0

    // Max 128 blocks as per C++ implementation
    while (ptr < payload.length && blocks.length < 128) {
      const block_type = payload[ptr]

      // Check for terminator (not_a_block)
      if (block_type === constants.BLOCK_TYPE.NOT_A_BLOCK) {
        break
      }

      const block = decode_block({
        block: payload.subarray(ptr),
        block_type
      })
      blocks.push(block)
      ptr += block.size
    }

    return blocks
  }

  decode_account_info(payload) {
    let ptr = 0

    // Match C++ struct layout exactly
    const account = payload.subarray(ptr, ptr + 32)
    ptr += 32

    const account_open = payload.subarray(ptr, ptr + 32)
    ptr += 32

    const account_head = payload.subarray(ptr, ptr + 32)
    ptr += 32

    const account_block_count = payload.readBigUInt64BE(ptr)
    ptr += 8

    const account_conf_frontier = payload.subarray(ptr, ptr + 32)
    ptr += 32

    const account_conf_height = payload.readBigUInt64BE(ptr)

    return {
        account,
        account_open,
        account_head,
        account_block_count,
        account_conf_frontier,
        account_conf_height
    }
  }

  decode_frontiers(payload) {
    const frontiers = []
    let ptr = 0

    // Max 1000 frontiers as per C++ implementation
    while (ptr < payload.length && frontiers.length < 1000) {
      const account = payload.subarray(ptr, ptr + 32)
      ptr += 32

      const hash = payload.subarray(ptr, ptr + 32)
      ptr += 32

      // Check for null terminator
      if (account.equals(Buffer.alloc(32, 0)) &&
          hash.equals(Buffer.alloc(32, 0))) {
        break
      }

      frontiers.push({
        account,
        hash
      })
    }

    return frontiers
  }
}
