import blake2 from 'blake2'
import ip6addr from 'ip6addr'

import { encodeNanoBase32, decodeNanoBase32 } from './nano-base32.js'
import * as constants from './constants.js'
import * as ed25519 from './ed25519.js'

export { constants, ed25519, encodeNanoBase32, decodeNanoBase32 }

export function encodeMessage({
  message,
  messageType,
  extensions,
  network = constants.NETWORK.BETA
}) {
  const messageLength = message.length
  const packet = Buffer.alloc(8 + messageLength)
  packet[0] = constants.MAGIC_NUMBER
  packet[1] = network
  packet[2] = 0x12
  packet[3] = 0x12
  packet[4] = 0x12
  packet[5] = messageType
  packet.writeUInt16LE(extensions, 6)
  packet.set(message, 8)
  return packet
}

export function decodeMessage({ packet, network = constants.NETWORK.BETA }) {
  if (packet[0] !== constants.MAGIC_NUMBER) return null
  if (packet[1] !== network) return null
  if (packet[3] !== 0x12) return null
  // if (packet.length < 9) return null;
  const messageType = packet[5]
  const extensions = packet.readUInt16LE(6)
  const data = packet.slice(8)
  return {
    messageType,
    extensions,
    data
  }
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

export function encodeAddress({ publicKey, prefix = 'nano_' }) {
  const encodedPublicKey = encodeNanoBase32(publicKey)
  const blake2b = blake2.createHash('blake2b', { digestLength: 5 })
  blake2b.update(publicKey)
  const checksum = blake2b.digest().reverse()
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
  const hasQuery = !!(extensions & 0x0001)
  const hasResponse = !!(extensions & 0x0002)
  const correctLength = (hasQuery && 32) + (hasResponse && 96)
  if (packet.length !== correctLength) {
    return {}
  }

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
