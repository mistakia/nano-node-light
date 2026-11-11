import ed25519 from '@trashman/ed25519-blake2b'
import ip6addr from 'ip6addr'

import { encodeNanoBase32, decodeNanoBase32 } from './nano-base32.js'
import * as constants from './constants.js'

export { constants, ed25519, encodeNanoBase32, decodeNanoBase32 }

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ab2hex = (buf) => {
  return Array.prototype.map
    .call(new Uint8Array(buf), (x) => ('00' + x.toString(16)).slice(-2))
    .join('')
}

export function format_block(block_info) {
  const formatted_block = {}
  for (const key in block_info) {
    if (key === 'balance') {
      formatted_block[key] = BigInt(`0x${block_info[key].toString('hex')}`)
    } else {
      formatted_block[key] = block_info[key].toString('hex')
    }
  }
  return formatted_block
}

function decode_send_block(data) {
  return {
    previous_hash: data.slice(0, 32),
    destination_account: data.slice(32, 64),
    balance: data.slice(64, 80),
    signature: data.slice(80, 144),
    work: data.slice(144, 152)
  }
}

function decode_receive_block(data) {
  return {
    previous_hash: data.slice(0, 32),
    source_hash: data.slice(32, 64),
    signature: data.slice(64, 128),
    work: data.slice(128, 136)
  }
}

function decode_open_block(data) {
  return {
    source_hash: data.slice(0, 32),
    representative_account: data.slice(32, 64),
    account_address: data.slice(64, 96),
    signature: data.slice(96, 160),
    work: data.slice(160, 168)
  }
}

function decode_change_block(data) {
  return {
    previous_hash: data.slice(0, 32),
    representative_account: data.slice(32, 64),
    signature: data.slice(64, 128),
    work: data.slice(128, 136)
  }
}

function decode_bulk_state_block(data) {
  return {
    account_address: data.slice(0, 32),
    previous_hash: data.slice(32, 64),
    representative_account: data.slice(64, 96),
    balance: data.slice(96, 112),
    link: data.slice(112, 144),
    signature: data.slice(144, 208),
    work: data.slice(208, 216)
  }
}

export function decode_block({ block, block_type }) {
  switch (block_type) {
    case 2: // send
      return decode_send_block(block)
    case 3: // receive
      return decode_receive_block(block)
    case 4: // open
      return decode_open_block(block)
    case 5: // change
      return decode_change_block(block)
    case 6: // state
      return decode_bulk_state_block(block)
  }
}

export function encode_message({ message, message_type, extensions, network }) {
  if (network == null) throw new Error('network is required')
  const messageLength = message.length
  const packet = Buffer.alloc(8 + messageLength)
  packet[0] = constants.MAGIC_NUMBER
  packet[1] = network
  packet[2] = constants.MAXIMUM_PROTOCOL_VERSION
  packet[3] = constants.CURRENT_PROTOCOL_VERSION
  packet[4] = constants.MINIMUM_PROTOCOL_VERSION
  packet[5] = message_type
  packet.writeUInt16LE(extensions, 6)
  packet.set(message, 8)
  return packet
}

export function decode_connection_info(raw) {
  // Convert binary string to Buffer if needed
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'binary') : raw
  const address = encode_ipv6(buf.subarray(0, 16))
  const port = buf.readUInt16LE(16)
  return {
    address,
    port
  }
}

export function encode_connection_info({ address, port }) {
  const raw = Buffer.alloc(18)
  raw.set(ip6addr.parse(address).toBuffer())
  raw.writeUInt16LE(port, 16)
  return raw
}

export function decode_address({ address }) {
  const cleaned_address = address.replace('nano_', '').replace('xrb_', '')
  const decoded = decodeNanoBase32(cleaned_address)
  const public_key = ab2hex(decoded.subarray(0, 32))
  const checksum = ab2hex(decoded.subarray(32, 32 + 5))
  return {
    public_key,
    checksum
  }
}

export function encode_address({ public_key_buf, prefix = 'nano_' }) {
  const encoded_public_key = encodeNanoBase32(public_key_buf)
  const checksum = ed25519.hash(public_key_buf, 5).reverse()
  const encoded_checksum = encodeNanoBase32(checksum)
  return prefix + encoded_public_key + encoded_checksum
}

export function encode_ipv4(raw) {
  return `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`
}

// Canonical text form of a 16-byte address, so one IP has one key. An address
// is IPv4-mapped only when groups 0 to 4 are zero and group 5 is ffff.
export function encode_ipv6(raw) {
  const is_ipv4_mapped =
    raw.subarray(0, 10).every((byte) => byte === 0) &&
    raw[10] === 0xff &&
    raw[11] === 0xff
  if (is_ipv4_mapped) return '::ffff:' + encode_ipv4(raw.subarray(12, 16))

  const groups = raw.toString('hex').match(/.{4}/g).join(':')
  return ip6addr.parse(groups).toString({ format: 'v6' })
}

// Canonical form of any textual IPv4 or IPv6 address, or null when invalid.
export function canonicalize_address(address) {
  try {
    return encode_ipv6(ip6addr.parse(address).toBuffer())
  } catch (error) {
    return null
  }
}

export function decode_node_handshake({ packet, extensions }) {
  // Check flags using constants
  const has_query = !!(extensions & (1 << constants.QUERY_FLAG))
  const has_response = !!(extensions & (1 << constants.RESPONSE_FLAG))
  const is_v2 = !!(extensions & (1 << constants.V2_FLAG))

  let query
  let response
  let packet_offset = 0

  // Handle query (32 bytes cookie)
  if (has_query) {
    query = packet.subarray(0, 32)
    packet_offset = 32
  }

  // Handle response
  if (has_response) {
    if (is_v2) {
      // V2 response format:
      // - account (32 bytes)
      // - salt (32 bytes)
      // - genesis (32 bytes)
      // - signature (64 bytes)
      const responseData = packet.subarray(packet_offset)

      // The signature is the last 64 bytes
      const account = responseData.subarray(0, 32)
      const salt = responseData.subarray(32, 64)
      const genesis = responseData.subarray(64, 96)
      const signature = responseData.subarray(96)

      response = {
        account,
        salt,
        genesis,
        signature
      }
    } else {
      // Legacy v1 response format:
      // - account (32 bytes)
      // - signature (64 bytes)
      const responseData = packet.subarray(packet_offset)

      const account = responseData.subarray(0, 32)
      const signature = responseData.subarray(32)

      response = {
        account,
        signature
      }
    }
  }

  return {
    query,
    response
  }
}

export function get_block_type(extensions) {
  return (extensions & 0x0f00) >> 8
}

export function get_is_rebroadcast(extensions) {
  return (extensions & constants.REBROADCAST_FLAG) !== 0
}

// confirm_ack and confirm_req item count: version 1 uses bits 12-15; version 2
// (bit 0 set) puts the high nibble in bits 12-15 and the low in bits 4-7.
export function get_item_count(extensions) {
  const high = (extensions & 0xf000) >> 12
  if (extensions & 0x1) return (high << 4) | ((extensions & 0x00f0) >> 4)
  return high
}

export function encode_item_count(count) {
  if (!Number.isInteger(count) || count < 1 || count > 255) {
    throw new Error(`item count ${count} is outside 1 to 255`)
  }
  if (count <= 15) return count << 12
  return 0x1 | ((count >> 4) << 12) | ((count & 0x0f) << 4)
}

export function encode_confirm_req(hash_root_pairs) {
  return {
    message: Buffer.concat(
      hash_root_pairs.flatMap(({ block_hash, root }) => [block_hash, root])
    ),
    extensions:
      (constants.BLOCK_TYPE.NOT_A_BLOCK << 8) |
      encode_item_count(hash_root_pairs.length)
  }
}

export function decode_confirm_req({ body, extensions }) {
  const count = get_item_count(extensions)
  if (count === 0 || body.length !== count * 64) return null

  const hash_root_pairs = []
  for (let i = 0; i < count; i++) {
    hash_root_pairs.push({
      block_hash: body.subarray(i * 64, i * 64 + 32),
      root: body.subarray(i * 64 + 32, i * 64 + 64)
    })
  }
  return hash_root_pairs
}

const VOTE_PREFIX = Buffer.from('vote ')
const FINAL_VOTE_TIMESTAMP = 0xffffffffffffffffn

export function get_vote_hash({ block_hashes, timestamp_raw }) {
  return ed25519.hash(
    Buffer.concat([VOTE_PREFIX, ...block_hashes, timestamp_raw])
  )
}

// Decodes a confirm_ack body without verifying it. Returns null when the body
// length does not match the header's hash count.
export function decode_vote({ body, extensions }) {
  const count = get_item_count(extensions)
  if (count === 0 || body.length !== 104 + 32 * count) return null

  const account = body.subarray(0, 32)
  const signature = body.subarray(32, 96)
  const timestamp_raw = body.subarray(96, 104)
  const block_hashes = []
  for (let i = 0; i < count; i++) {
    block_hashes.push(body.subarray(104 + 32 * i, 136 + 32 * i))
  }

  // The low 4 bits of the timestamp are the duration exponent; a final vote
  // sets every bit.
  const timestamp = timestamp_raw.readBigUInt64LE(0)
  const is_final = timestamp === FINAL_VOTE_TIMESTAMP

  return {
    account,
    signature,
    block_hashes,
    vote_hash: get_vote_hash({ block_hashes, timestamp_raw }),
    is_final,
    vote_timestamp_ms: is_final ? null : Number(timestamp & ~0xfn),
    vote_duration_ms: is_final ? null : 2 ** (Number(timestamp & 0xfn) + 4),
    is_rebroadcast: get_is_rebroadcast(extensions)
  }
}

export function verify_vote({ signature, vote_hash, account }) {
  return ed25519.verify(signature, vote_hash, account)
}

const STATE_BLOCK_SIZE = constants.BLOCK_SIZES[constants.BLOCK_TYPE.STATE]
const STATE_BLOCK_PREAMBLE = Buffer.alloc(32)
STATE_BLOCK_PREAMBLE[31] = constants.BLOCK_TYPE.STATE

// Decodes a state block and computes its hash and root, without verifying
// it. Returns null when the body is not a state block's length.
export function decode_state_block(body) {
  if (body.length !== STATE_BLOCK_SIZE) return null

  const account = body.subarray(0, 32)
  const previous = body.subarray(32, 64)
  const is_open = previous.every((byte) => byte === 0)

  return {
    block_hash: ed25519.hash(
      Buffer.concat([STATE_BLOCK_PREAMBLE, body.subarray(0, 144)])
    ),
    root: is_open ? account : previous,
    account,
    previous,
    representative: body.subarray(64, 96),
    balance: BigInt('0x' + body.subarray(96, 112).toString('hex')),
    link: body.subarray(112, 144),
    signature: body.subarray(144, 208),
    work: body.subarray(208, 216)
  }
}

// The key that signs a state block: the network's epoch signer for an epoch
// link, otherwise the account.
export function get_state_block_signer({ block, network }) {
  const epoch_signer =
    network.EPOCH_SIGNER_BY_LINK?.[block.link.toString('hex')]
  return epoch_signer ? Buffer.from(epoch_signer, 'hex') : block.account
}

export function verify_state_block({ block, signer }) {
  return ed25519.verify(block.signature, block.block_hash, signer)
}

export const TELEMETRY_MINIMUM_SIZE = 202

// Decodes the protocol 21 telemetry fields and verifies the signature over the
// full body, so a longer V29 body still verifies. Returns null when short.
export function decode_telemetry(body) {
  if (body.length < TELEMETRY_MINIMUM_SIZE) return null

  const signature = body.subarray(0, 64)
  const node_id = body.subarray(64, 96)

  return {
    signature,
    node_id,
    is_signature_valid: ed25519.verify(signature, body.subarray(64), node_id),
    block_count: Number(body.readBigUInt64BE(96)),
    cemented_count: Number(body.readBigUInt64BE(104)),
    unchecked_count: Number(body.readBigUInt64BE(112)),
    account_count: Number(body.readBigUInt64BE(120)),
    bandwidth_cap: Number(body.readBigUInt64BE(128)),
    peer_count: body.readUInt32BE(136),
    protocol_version: body[140],
    uptime_seconds: Number(body.readBigUInt64BE(141)),
    genesis_block: body.subarray(149, 181),
    major_version: body[181],
    minor_version: body[182],
    patch_version: body[183],
    pre_release_version: body[184],
    maker: body[185],
    timestamp_ms: Number(body.readBigUInt64BE(186)),
    active_difficulty: body.subarray(194, 202)
  }
}

export function decode_keepalive(body) {
  const peers = []
  for (let offset = 0; offset + 18 <= body.length; offset += 18) {
    const address_raw = body.subarray(offset, offset + 16)
    const port = body.readUInt16LE(offset + 16)
    if (address_raw.equals(constants.SELF_ADDRESS)) continue
    peers.push({ address: encode_ipv6(address_raw), port })
  }
  return peers
}
