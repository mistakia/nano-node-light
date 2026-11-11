/* global describe it */
import chai from 'chai'
import bytes from 'chai-bytes'

import NanoStream from '#common/stream.js'
import * as constants from '#common/constants.js'
import { encode_message } from '#common'
import { encode_vote, random_hash, TEST_NETWORK } from '#test/utils.js'

chai.use(bytes)
const { expect } = chai

const wait_for_message = ({ stream, count = 1 }) =>
  new Promise((resolve, reject) => {
    const msgs = []
    stream.on('message', (msg) => {
      msgs.push(msg)
      if (msgs.length === count) {
        resolve(msgs)
      }
    })
  })

describe('Nano Stream', function () {
  it('process handshake message, one chunk', async () => {
    const stream = new NanoStream(constants.NETWORK.BETA.ID)

    const msgs_p = wait_for_message({ stream })

    const header = '52421414140a0700'
    const body =
      'c73848b9227ff859b7a6c793685558d9d5b14f487b7302bfc7bd6e187f8950285ae7ed78c5e75f96e08cd5bb22ecdd09cab40332901a41ef7877ba0cf823fc3be8f67856d89165840280e71b10e62facdbddff161ac86fa47cd59dc7c2ced033d0f55584443914b9cf74ce6de9af04cd215c95046a7a450d3403fb263c11140100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'

    stream.push(Buffer.from(header + body, 'hex'))

    const msgs = await msgs_p
    const msg = msgs[0]

    expect(msg.message_type).to.equal(constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE)
    expect(msg.remote_version).to.equal(20)
    expect(msg.extensions).to.equal(7)
    expect(msg.body).to.equalBytes(Buffer.from(body, 'hex'))
  })

  it('process handshake message, two random chunks', async () => {
    const stream = new NanoStream(constants.NETWORK.BETA.ID)

    const msgs_p = wait_for_message({ stream })

    const header = '52421414140a0700'
    const body =
      'c73848b9227ff859b7a6c793685558d9d5b14f487b7302bfc7bd6e187f8950285ae7ed78c5e75f96e08cd5bb22ecdd09cab40332901a41ef7877ba0cf823fc3be8f67856d89165840280e71b10e62facdbddff161ac86fa47cd59dc7c2ced033d0f55584443914b9cf74ce6de9af04cd215c95046a7a450d3403fb263c11140100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'

    const full = header + body
    const chunks = []
    const range = full.length - 6
    const index = Math.floor((Math.random() * range) / 2) * 2
    chunks.push(full.substring(0, index))
    chunks.push(full.substring(index))
    for (const chunk of chunks) {
      stream.push(Buffer.from(chunk, 'hex'))
    }

    const msgs = await msgs_p
    const msg = msgs[0]

    expect(msg.message_type).to.equal(constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE)
    expect(msg.remote_version).to.equal(20)
    expect(msg.extensions).to.equal(7)
    expect(msg.body).to.equalBytes(Buffer.from(body, 'hex'))
  })

  it('process handshake message, three chunks', async () => {
    const stream = new NanoStream(constants.NETWORK.BETA.ID)

    const msgs_p = wait_for_message({ stream })

    const body =
      'c73848b9227ff859b7a6c793685558d9d5b14f487b7302bfc7bd6e187f8950285ae7ed78c5e75f96e08cd5bb22ecdd09cab40332901a41ef7877ba0cf823fc3be8f67856d89165840280e71b10e62facdbddff161ac86fa47cd59dc7c2ced033d0f55584443914b9cf74ce6de9af04cd215c95046a7a450d3403fb263c11140100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'

    stream.push(Buffer.from('52421414', 'hex'))
    stream.push(
      Buffer.from(
        '140a0700c73848b9227ff859b7a6c793685558d9d5b14f487b7302bfc7bd6e187f895028',
        'hex'
      )
    )
    stream.push(
      Buffer.from(
        '5ae7ed78c5e75f96e08cd5bb22ecdd09cab40332901a41ef7877ba0cf823fc3be8f67856d89165840280e71b10e62facdbddff161ac86fa47cd59dc7c2ced033d0f55584443914b9cf74ce6de9af04cd215c95046a7a450d3403fb263c11140100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        'hex'
      )
    )

    const msgs = await msgs_p
    const msg = msgs[0]

    expect(msg.message_type).to.equal(constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE)
    expect(msg.remote_version).to.equal(20)
    expect(msg.extensions).to.equal(7)
    expect(msg.body).to.equalBytes(Buffer.from(body, 'hex'))
  })

  it('process multiple handshake messages', async () => {
    const stream = new NanoStream(constants.NETWORK.BETA.ID)

    const msgs_p = wait_for_message({ stream })

    const body =
      'c73848b9227ff859b7a6c793685558d9d5b14f487b7302bfc7bd6e187f8950285ae7ed78c5e75f96e08cd5bb22ecdd09cab40332901a41ef7877ba0cf823fc3be8f67856d89165840280e71b10e62facdbddff161ac86fa47cd59dc7c2ced033d0f55584443914b9cf74ce6de9af04cd215c95046a7a450d3403fb263c11140100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'

    stream.push(Buffer.from('52421414', 'hex'))
    stream.push(
      Buffer.from(
        '140a0700c73848b9227ff859b7a6c793685558d9d5b14f487b7302bfc7bd6e187f895028',
        'hex'
      )
    )
    stream.push(
      Buffer.from(
        '5ae7ed78c5e75f96e08cd5bb22ecdd09cab40332901a41ef7877ba0cf823fc3be8f67856d89165840280e71b10e62facdbddff161ac86fa47cd59dc7c2ced033d0f55584443914b9cf74ce6de9af04cd215c95046a7a450d3403fb263c1114010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000052421414',
        'hex'
      )
    )
    stream.push(
      Buffer.from(
        '140a0700c73848b9227ff859b7a6c793685558d9d5b14f487b7302bfc7bd6e187f8950285ae7ed78c5e75f96e08cd5bb22ecdd09cab40332901a41ef7877ba0cf823fc3be8f67856d89165840280e71b10e62facdbddff161ac86fa47cd59dc7c2ced033d0f55584443914b9cf74ce6de9af04cd215c95046a7a450d3403fb263c11140100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        'hex'
      )
    )

    const msgs = await msgs_p
    const msg_a = msgs[0]

    expect(msg_a.message_type).to.equal(
      constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE
    )
    expect(msg_a.remote_version).to.equal(20)
    expect(msg_a.extensions).to.equal(7)
    expect(msg_a.body).to.equalBytes(Buffer.from(body, 'hex'))

    const msg_b = msgs[1]

    expect(msg_b.message_type).to.equal(
      constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE
    )
    expect(msg_b.remote_version).to.equal(20)
    expect(msg_b.extensions).to.equal(7)
    expect(msg_b.body).to.equalBytes(Buffer.from(body, 'hex'))
  })

  describe('error isolation', () => {
    const frame = (message) =>
      encode_message({ ...message, network: TEST_NETWORK.ID })

    it('frames a block-type-0 confirm_ack followed by a keepalive in one buffer', () => {
      const stream = new NanoStream(TEST_NETWORK.ID)
      const messages = []
      stream.on('message', (message) => messages.push(message))

      const vote = encode_vote({
        block_hashes: [random_hash()],
        block_type: constants.BLOCK_TYPE.INVALID
      })
      const keepalive = {
        message_type: constants.MESSAGE_TYPE.KEEPALIVE,
        message: Buffer.alloc(144),
        extensions: 0
      }
      stream.push(Buffer.concat([frame(vote), frame(keepalive)]))

      expect(messages.map((message) => message.message_type)).to.deep.equal([
        constants.MESSAGE_TYPE.CONFIRM_ACK,
        constants.MESSAGE_TYPE.KEEPALIVE
      ])
      expect(messages[0].body.length).to.equal(136)
    })

    it('emits one stream_error for an unknown type and stops queueing', () => {
      const stream = new NanoStream(TEST_NETWORK.ID)
      const errors = []
      stream.on('stream_error', (error) => errors.push(error))

      const unknown_type = frame({
        message_type: 0x10,
        message: Buffer.alloc(0),
        extensions: 0
      })
      stream.push(unknown_type)
      stream.push(unknown_type)
      stream.push(Buffer.alloc(1000))

      expect(errors).to.have.length(1)
      expect(errors[0].code).to.equal('INVALID_OP_CODE')
      expect(stream.queue).to.have.length(0)
    })

    it('emits a throwing message listener as handler_error and keeps framing', () => {
      const stream = new NanoStream(TEST_NETWORK.ID)
      const handler_errors = []
      const messages = []
      stream.on('handler_error', (error) => handler_errors.push(error))
      stream.on('message', (message) => {
        messages.push(message)
        if (messages.length === 1) throw new Error('listener failure')
      })

      const keepalive = frame({
        message_type: constants.MESSAGE_TYPE.KEEPALIVE,
        message: Buffer.alloc(144),
        extensions: 0
      })
      stream.push(keepalive)
      stream.push(keepalive)

      expect(handler_errors).to.have.length(1)
      expect(messages).to.have.length(2)
    })

    it('treats a publish with an unknown block type as a framing error', () => {
      const stream = new NanoStream(TEST_NETWORK.ID)
      const errors = []
      stream.on('stream_error', (error) => errors.push(error))

      stream.push(
        frame({
          message_type: constants.MESSAGE_TYPE.PUBLISH,
          message: Buffer.alloc(0),
          extensions: 0x0900
        })
      )

      expect(errors.map((error) => error.code)).to.deep.equal([
        'INVALID_BLOCK_TYPE'
      ])
    })

    it('requires a network', () => {
      expect(() => new NanoStream()).to.throw('network is required')
    })
  })

  it('sizes a v1 handshake response at 96 bytes', () => {
    const stream = new NanoStream(TEST_NETWORK.ID)
    const messages = []
    stream.on('message', (message) => messages.push(message))

    const v1_response = encode_message({
      message_type: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
      message: Buffer.alloc(96),
      extensions: 0x2,
      network: TEST_NETWORK.ID
    })
    stream.push(Buffer.concat([v1_response, v1_response]))

    expect(messages.map((message) => message.body.length)).to.deep.equal([
      96, 96
    ])
  })
})
