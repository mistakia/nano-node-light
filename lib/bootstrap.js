import net from 'net'
import EventEmitter from 'events'

import { encodeMessage, constants } from '#common'

const blockSizes = {
  0x00: 0, // Invalid
  0x01: 0, // Not A Block (NaB)
  0x02: 152, // Send (Legacy)
  0x03: 136, // Receive (Legacy)
  0x04: 168, // Open (Legacy)
  0x05: 136, // Change (Legacy)
  0x06: 216 // State
}

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
      blockType: null,
      expectedSize: null,
      size: 0,
      addPtr: null
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
      this.handleMsg(data)
    })
  }

  defaultState() {
    this.state.block = null
    this.state.blockType = null
    this.state.expectedSize = null
    this.state.addPtr = null
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
    const hasCount = count !== undefined
    const message = Buffer.alloc(64 + (hasCount && 8))
    message.set(start)
    message.set(end, 32)
    if (hasCount) {
      message.writeUInt32LE(count, 65)
    }

    this.socket.write(
      encodeMessage({
        message,
        messageType: constants.MESSAGE_TYPE.BULK_PULL,
        extensions: (hasCount && 1) | (ascending && 2),
        network: this.network.ID
      })
    )
  }

  handleMsg(data) {
    if (this.destroyed) return
    const state = this.state

    let ptr = 0
    const length = data.length
    for (;;) {
      if (state.blockType) {
        if (!state.addPtr) {
          state.addPtr = true
          ptr++
        }

        const bodyPtr = ptr + state.expectedSize - state.size
        const body = data.subarray(ptr, bodyPtr)
        state.block.set(body, state.size)
        state.size += body.length

        if (state.size === state.expectedSize) {
          const msgInfo = Object.assign({}, state)
          delete msgInfo.size
          delete msgInfo.expectedSize
          delete msgInfo.addPtr

          if (msgInfo.blockType === 1) {
            this.emit('end')
          } else {
            this.emit('block', msgInfo)
          }

          this.defaultState()
        }

        ptr += body.length
      } else {
        const blockType = data[ptr]
        state.blockType = blockType
        const blockSize = blockSizes[blockType]
        if (blockType === undefined) {
          this.close()
          break
        }
        state.expectedSize = blockSize
        state.block = Buffer.alloc(blockSize)
        state.addPtr = false
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
      this.emit('close')
    })
    this.socket.on('close', () => {
      this.emit('close')
    })
    this.socket.on('data', (data) => {
      this.handleMsg(data)
    })
  }

  defaultState() {
    this.state.size = 0
  }

  close() {
    this.client.destroy()
  }

  request({
    start,
    age = 0xffffffff,
    count = 0xffffffff,
    confirmedOnly = false
  }) {
    const message = Buffer.alloc(40)
    message.set(start)
    message.writeUInt32LE(age, 32)
    message.writeUInt32LE(count, 36)

    this.socket.write(
      encodeMessage({
        message,
        messageType: constants.MESSAGE_TYPE.FRONTIER_REQ,
        extensions: confirmedOnly && 2,
        network: this.network.ID
      })
    )
  }

  handleMsg(data) {
    if (this.destroyed) return
    const state = this.state

    let ptr = 0
    const length = data.length
    for (;;) {
      const bodyPtr = ptr + 64 - state.size
      const body = data.subarray(ptr, bodyPtr)
      state.current.set(body, state.size)
      state.size += body.length

      if (state.size === 64) {
        if (state.current.equals(NULL_FRONTIER)) {
          this.emit('end')
        } else {
          const Account = Buffer.alloc(32)
          const Frontier = Buffer.alloc(32)

          state.current.copy(Account, 0, 0)
          state.current.copy(Frontier, 0, 32)

          this.emit('frontier', {
            Account,
            Frontier
          })
        }

        this.defaultState()
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
    this.entryFlag = null

    this.state = {
      frontierEntry: Buffer.alloc(48),
      frontierSize: 0,
      bulkEntry: null,
      bulkSize: 0
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
      this.handleMsg(data)
    })
  }

  defaultState() {
    this.state.frontierSize = 0
    this.state.bulkSize = 0
    this.state.bulkEntry = null
  }

  close() {
    this.client.destroy()
    this.destroyed = true
  }

  request({ account, minimumAmount = 0n, flags = 0x00 }) {
    if (!BULK_PULL_ACCOUNT_FLAGS[flags]) throw new TypeError('Flag is invalid')

    const message = Buffer.alloc(49)
    message.set(account)
    message.writeBigUInt64BE(minimumAmount >> 64n, 32)
    message.writeBigUInt64BE(minimumAmount & 0xffffffffffffffffn, 40)
    message[48] = flags

    this.entryFlag = BULK_PULL_ACCOUNT_FLAGS[flags]

    this.socket.write(
      encodeMessage({
        message,
        messageType: constants.MESSAGE_TYPE.BULK_PULL_ACCOUNT,
        extensions: 0,
        network: this.network.ID
      })
    )
  }

  handleMsg(data) {
    if (this.destroyed) return
    const state = this.state

    let ptr = 0
    const length = data.length
    for (;;) {
      if (state.bulkEntry) {
        const bodyPtr = ptr + this.entryFlag.ENTRY_SIZE - state.bulkSize
        const body = data.subarray(ptr, bodyPtr)
        state.bulkEntry.set(body, state.bulkSize)
        state.bulkSize += body.length

        if (state.bulkSize === this.entryFlag.ENTRY_SIZE) {
          if (state.bulkEntry.equals(this.entryFlag.NULL_ENTRY)) {
            this.defaultState()
            this.emit('end')
          } else {
            const Entry = {}
            if (this.entryFlag.HAS_HASH) {
              const Hash = Buffer.alloc(32)
              state.bulkEntry.copy(Hash, 0, 0)
              Entry.Hash = Hash

              const SegmentOne = state.bulkEntry.readBigUInt64BE(32)
              const SegmentTwo = state.bulkEntry.readBigUInt64BE(40)
              Entry.Amount = (SegmentOne << 64n) + SegmentTwo
            }
            if (this.entryFlag.HAS_SOURCE) {
              const offset = this.entryFlag.HAS_HASH && 48

              const Source = Buffer.alloc(32)
              state.bulkEntry.copy(Source, 0, offset)

              Entry.Source = Source
            }
            this.emit('entry', Entry)
          }
          state.bulkSize = 0
        }

        ptr += body.length
      } else {
        const bodyPtr = ptr + 48 - state.frontierSize
        const body = data.subarray(ptr, bodyPtr)
        state.frontierEntry.set(body, state.frontierSize)
        state.frontierSize += body.length

        if (state.frontierSize === 48) {
          const Frontier = Buffer.alloc(32)
          state.frontierEntry.copy(Frontier, 0, 0)

          const SegmentOne = state.frontierEntry.readBigUInt64BE(32)
          const SegmentTwo = state.frontierEntry.readBigUInt64BE(40)
          const Balance = (SegmentOne << 64n) + SegmentTwo

          this.emit('frontier', { Frontier, Balance })
          state.bulkEntry = Buffer.alloc(this.entryFlag.ENTRY_SIZE)
        }

        ptr += body.length
      }
      if (ptr >= length) break
    }
  }
}
