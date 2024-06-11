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

function decode_state_block(data) {
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

export function decodeBlock({ block, blockType }) {
  switch (blockType) {
    case 2: // send
      return decode_send_block(block)
    case 3: // receive
      return decode_receive_block(block)
    case 4: // open
      return decode_open_block(block)
    case 5: // change
      return decode_change_block(block)
    case 6: // state
      return decode_state_block(block)
  }
}

export function encodeMessage({
  message,
  messageType,
  extensions,
  network = constants.NETWORK.BETA.ID
}) {
  const messageLength = message.length
  const packet = Buffer.alloc(8 + messageLength)
  packet[0] = constants.MAGIC_NUMBER
  packet[1] = network
  packet[2] = 0x13
  packet[3] = 0x13
  packet[4] = 0x12
  packet[5] = messageType
  packet.writeUInt16LE(extensions, 6)
  packet.set(message, 8)
  return packet
}

export function decodeConnectionInfo(raw) {
  const address = encodeIPv6(raw.subarray(0, 16))
  const port = raw.readUInt16LE(16)
  return {
    address,
    port
  }
}

export function encodeConnectionInfo({ address, port }) {
  const raw = Buffer.alloc(18)
  raw.set(ip6addr.parse(address).toBuffer())
  raw.writeUInt16LE(port, 16)
  return raw
}

export function decodeAddress({ address }) {
  const cleaned_address = address.replace('nano_', '').replace('xrb_', '')
  const decoded = decodeNanoBase32(cleaned_address)
  const publicKey = ab2hex(decoded.subarray(0, 32))
  const checksum = ab2hex(decoded.subarray(32, 32 + 5))
  return {
    publicKey,
    checksum
  }
}

export function encodeAddress({ publicKey, prefix = 'nano_' }) {
  const encodedPublicKey = encodeNanoBase32(publicKey)
  const checksum = ed25519.hash(publicKey, 5).reverse()
  const encodedChecksum = encodeNanoBase32(checksum)
  return prefix + encodedPublicKey + encodedChecksum
}

export function encodeIPv4(raw) {
  return `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`
}

export function encodeIPv6(raw) {
  const hex = raw.toString('hex')
  const hexParts = hex.match(/.{1,4}/g)
  const subnet = hexParts[5]
  let formattedAddress
  if (subnet === 'ffff') {
    formattedAddress = '::ffff:' + encodeIPv4(raw.slice(-4))
  } else {
    formattedAddress = hexParts.join(':')
  }
  return formattedAddress
}

export function decodeNodeHandshake({ packet, extensions }) {
  const hasQuery = !!(extensions & 1)
  const hasResponse = !!(extensions & 2)

  let query
  let response
  let extraPtr = 0
  if (hasQuery) {
    query = packet.subarray(0, 32)
    extraPtr = 32
  }
  if (hasResponse) {
    const responseX = packet.subarray(extraPtr, 96 + extraPtr)
    const account = responseX.subarray(0, 32)
    const signature = responseX.subarray(32, 96)
    response = {
      account,
      signature
    }
  }
  return {
    query,
    response
  }
}

const votePrefix = Buffer.from('vote ')

export function decodeVote({ body, extensions }) {
  // Determine version based on the presence of the flag in the extensions
  const is_v2 = (extensions & 0x1) !== 0 // Assuming bit 0 is the v2 flag
  const vote_count = is_v2
    ? ((extensions & 0xf0) >> 4) + ((extensions & 0xf000) >> 12) * 16 // v2 uses bits 4-7 and 12-15
    : (extensions & 0xf000) >> 12 // v1 uses bits 12-15

  const account = body.subarray(0, 32)
  const signature = body.subarray(32, 96)
  const timestamp = body.subarray(96, 104)

  const hashItemPtr = 104 + 32 * vote_count
  if (body.length < hashItemPtr) return null

  const hashItems = body.subarray(104, hashItemPtr)
  const hashList = []

  for (let i = 0; i < vote_count; i++) {
    const hashPtr = 32 * i
    hashList.push(hashItems.subarray(hashPtr, hashPtr + 32))
  }

  const voteHash = ed25519.hash(
    Buffer.concat([votePrefix, hashItems, timestamp])
  )
  const isValid = ed25519.verify(signature, voteHash, account)

  return {
    account,
    signature,
    timestamp,
    hashList,
    isValid
  }
}

export function decodeTelemetry({ body, extensions }) {
  const signature = body.subarray(0, 64)
  const node_id = body.subarray(64, 96)
  const block_count = body.readBigUInt64BE(96)
  const cemented_count = body.readBigUInt64BE(104)
  const unchecked_count = body.readBigUInt64BE(112)
  const account_count = body.readBigUInt64BE(120)
  const bandwidth_cap = body.readBigUInt64BE(128)
  const peer_count = body.readUInt32BE(136)
  const protocol_version = body[140]
  const uptime = body.readBigUInt64BE(141)
  const genesis_block = body.subarray(149, 181)
  const major_version = body[181]
  const minor_version = body[182]
  const patch_version = body[183]
  const pre_release_version = body[184]
  const maker = body[185]
  const timestamp = body.readBigUInt64BE(186)
  const active_difficulty = body.readBigUInt64BE(194)
  const unknown_data = body.length > 202 ? body.readBigUInt64BE(202) : null

  const versionList = [major_version, minor_version, patch_version]
  const full_version = versionList.join('.')

  const isValid = ed25519.verify(signature, body.subarray(64), node_id)

  return {
    isValid,
    full_version,

    block_count,
    cemented_count,
    unchecked_count,
    account_count,
    bandwidth_cap,
    peer_count,
    protocol_version,
    uptime,
    genesis_block,
    major_version,
    minor_version,
    patch_version,
    pre_release_version,
    maker,
    timestamp,
    active_difficulty,
    node_id,
    signature,

    unknown_data
  }
}
