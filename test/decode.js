/* global describe it */
import fs from 'fs'
import chai from 'chai'

import {
  constants,
  decode_vote,
  verify_vote,
  decode_state_block,
  verify_state_block,
  get_state_block_signer,
  decode_telemetry,
  decode_keepalive,
  decode_confirm_req,
  encode_confirm_req,
  get_block_type,
  get_item_count,
  get_is_rebroadcast,
  encode_ipv6,
  encode_message
} from '#common'
import NanoStream from '#common/stream.js'
import {
  encode_vote,
  random_hash,
  vote_timestamp,
  FINAL_VOTE_TIMESTAMP,
  TEST_NETWORK
} from '#test/utils.js'

const { expect } = chai

const fixtures = JSON.parse(
  fs.readFileSync(new URL('./fixtures/mainnet-messages.json', import.meta.url))
)
const to_message = ({ extensions, body }) => ({
  extensions,
  body: Buffer.from(body, 'hex')
})

describe('Decode', () => {
  describe('mainnet votes', () => {
    const shapes = [
      'single_hash_final',
      'single_hash_non_final',
      'single_hash_non_final_rebroadcast',
      'two_hash'
    ]

    for (const shape of shapes) {
      it(`${shape} decodes with a valid signature`, () => {
        for (const sample of fixtures.vote[shape]) {
          const message = to_message(sample)
          const vote = decode_vote(message)

          expect(vote).to.not.equal(null)
          expect(verify_vote(vote)).to.equal(true)
          expect(vote.block_hashes).to.have.length(
            get_item_count(message.extensions)
          )
          expect(vote.is_rebroadcast).to.equal((message.extensions & 0x4) !== 0)
          expect(vote.is_final).to.equal(shape === 'single_hash_final')
        }
      })
    }

    it('decodes a non-final timestamp little-endian, close to capture time', () => {
      const [sample] = fixtures.vote.single_hash_non_final
      const vote = decode_vote(to_message(sample))
      const capture_day_ms = Date.parse('2026-11-11T00:00:00Z')

      expect(Math.abs(vote.vote_timestamp_ms - capture_day_ms)).to.be.below(
        2 * 24 * 3600 * 1000
      )
      expect(vote.vote_duration_ms).to.be.at.least(16)
    })

    it('decodes a final vote with null timestamp and duration', () => {
      const [sample] = fixtures.vote.single_hash_final
      const vote = decode_vote(to_message(sample))

      expect(vote.vote_timestamp_ms).to.equal(null)
      expect(vote.vote_duration_ms).to.equal(null)
    })

    it('returns null for a mis-framed block-type-0 capture missing its hash', () => {
      for (const sample of fixtures.vote.block_type_zero_misframed) {
        const message = to_message(sample)
        expect(get_block_type(message.extensions)).to.equal(0)
        expect(message.body.length).to.equal(104)
        expect(decode_vote(message)).to.equal(null)
      }
    })
  })

  describe('encoded votes', () => {
    it('a block-type-0 vote frames by count and verifies', async () => {
      const block_hashes = [random_hash()]
      const vote_message = encode_vote({
        block_hashes,
        block_type: constants.BLOCK_TYPE.INVALID
      })

      const stream = new NanoStream(TEST_NETWORK.ID)
      const framed = []
      stream.on('message', (message) => framed.push(message))
      stream.push(encode_message({ ...vote_message, network: TEST_NETWORK.ID }))

      expect(framed).to.have.length(1)
      const vote = decode_vote(framed[0])
      expect(vote.block_hashes[0]).to.deep.equal(block_hashes[0])
      expect(verify_vote(vote)).to.equal(true)
    })

    it('a multi-hash vote with a version 2 count decodes and verifies', () => {
      const block_hashes = Array.from({ length: 23 }, random_hash)
      const { message, extensions } = encode_vote({
        block_hashes,
        timestamp: FINAL_VOTE_TIMESTAMP
      })

      expect(extensions & 0x1).to.equal(1)
      const vote = decode_vote({ body: message, extensions })
      expect(vote.block_hashes).to.have.length(23)
      expect(vote.is_final).to.equal(true)
      expect(verify_vote(vote)).to.equal(true)
    })

    it('decodes the duration exponent from the low timestamp bits', () => {
      const timestamp_ms = Math.floor(Date.now() / 16) * 16
      const { message, extensions } = encode_vote({
        block_hashes: [random_hash()],
        timestamp: vote_timestamp({ timestamp_ms, duration_bits: 6 })
      })
      const vote = decode_vote({ body: message, extensions })

      expect(vote.vote_timestamp_ms).to.equal(timestamp_ms)
      expect(vote.vote_duration_ms).to.equal(2 ** 10)
    })

    it('returns null for a short vote body', () => {
      const { message, extensions } = encode_vote({
        block_hashes: [random_hash(), random_hash()]
      })
      expect(
        decode_vote({ body: message.subarray(0, 136), extensions })
      ).to.equal(null)
    })
  })

  describe('mainnet publishes', () => {
    it('decode with the captured hash, a root and a valid signature', () => {
      for (const sample of fixtures.publish) {
        const message = to_message(sample)
        expect(get_block_type(message.extensions)).to.equal(
          constants.BLOCK_TYPE.STATE
        )
        const block = decode_state_block(message.body)

        expect(block.block_hash.toString('hex')).to.equal(sample.hash)
        const is_open = block.previous.every((byte) => byte === 0)
        expect(block.root).to.deep.equal(
          is_open ? block.account : block.previous
        )
        expect(verify_state_block({ block, signer: block.account })).to.equal(
          true
        )
      }
    })

    it('verify an epoch v2 block against the epoch signer, not the account', () => {
      const block = decode_state_block(
        Buffer.from(fixtures.epoch_publish.body, 'hex')
      )
      const signer = get_state_block_signer({
        block,
        network: constants.NETWORK.LIVE
      })

      expect(signer).to.not.equal(block.account)
      expect(verify_state_block({ block, signer })).to.equal(true)
      expect(verify_state_block({ block, signer: block.account })).to.equal(
        false
      )
    })

    it('returns null for a body that is not a state block length', () => {
      const body = Buffer.from(fixtures.publish[0].body, 'hex')
      expect(decode_state_block(body.subarray(0, 200))).to.equal(null)
    })
  })

  describe('mainnet telemetry', () => {
    for (const size of [202, 216]) {
      it(`${size}-byte telemetry decodes with a valid signature`, () => {
        const samples = fixtures.telemetry.filter(
          (sample) => sample.extensions === size
        )
        expect(samples).to.not.have.length(0)

        for (const sample of samples) {
          const telemetry = decode_telemetry(Buffer.from(sample.body, 'hex'))

          expect(telemetry.is_signature_valid).to.equal(true)
          expect(
            telemetry.genesis_block.toString('hex').toUpperCase()
          ).to.equal(constants.NETWORK.LIVE.GENESIS_BLOCK)
          expect(telemetry.protocol_version).to.be.within(0x14, 0x16)
          expect(telemetry.block_count).to.be.at.least(1)
          expect(telemetry.cemented_count).to.be.at.most(telemetry.block_count)
          expect(telemetry.major_version).to.be.at.least(25)
        }
      })
    }

    it('returns null below 202 bytes', () => {
      const body = Buffer.from(fixtures.telemetry[0].body, 'hex')
      expect(decode_telemetry(body.subarray(0, 201))).to.equal(null)
    })
  })

  describe('keepalive', () => {
    it('decodes IPv4-mapped and native IPv6 entries to one canonical key each', () => {
      const entry = (address_hex, port) => {
        const raw = Buffer.alloc(18)
        Buffer.from(address_hex, 'hex').copy(raw)
        raw.writeUInt16LE(port, 16)
        return raw
      }
      const body = Buffer.concat(
        [
          entry('00000000000000000000ffff5db8d7b4', 7075),
          entry('2a0104f8000000000000000000000001', 7075),
          entry('00000000000000000000000000000000', 0)
        ],
        144
      )

      expect(decode_keepalive(body)).to.deep.equal([
        { address: '::ffff:93.184.215.180', port: 7075 },
        { address: '2a01:4f8::1', port: 7075 }
      ])
    })

    it('treats ffff in group 5 as IPv4-mapped only when groups 0 to 4 are zero', () => {
      const raw = Buffer.from('00010000000000000000ffff01020304', 'hex')
      expect(encode_ipv6(raw)).to.equal('1::ffff:102:304')
    })
  })

  describe('confirm_req', () => {
    it('round-trips through the encoder, framing and the decoder', () => {
      const hash_root_pairs = Array.from({ length: 20 }, () => ({
        block_hash: random_hash(),
        root: random_hash()
      }))
      const { message, extensions } = encode_confirm_req(hash_root_pairs)

      const stream = new NanoStream(TEST_NETWORK.ID)
      const framed = []
      stream.on('message', (framed_message) => framed.push(framed_message))
      stream.push(
        encode_message({
          message,
          extensions,
          message_type: constants.MESSAGE_TYPE.CONFIRM_REQ,
          network: TEST_NETWORK.ID
        })
      )

      expect(framed).to.have.length(1)
      expect(get_is_rebroadcast(framed[0].extensions)).to.equal(false)
      expect(decode_confirm_req(framed[0])).to.deep.equal(hash_root_pairs)
    })
  })
})
