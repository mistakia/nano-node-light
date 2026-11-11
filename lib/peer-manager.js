import dns from 'dns'
import ip6addr from 'ip6addr'
import debug from 'debug'

import { constants, canonicalize_address } from '#common'

const log = debug('peer-manager')

const ENTRY_STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected'
}

// IPv4 ranges that are never dialed from a keepalive: [first octets, prefix length].
const RESERVED_IPV4_RANGES = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224], 3] // multicast, reserved and broadcast
]

// IPv6 ranges that are never dialed: [first bytes, prefix length].
const RESERVED_IPV6_RANGES = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96], // unspecified, loopback, IPv4-compatible
  [[0xfc], 7], // unique local
  [[0xfe, 0x80], 10], // link local
  [[0xff], 8], // multicast
  [[0x20, 0x01, 0x0d, 0xb8], 32] // documentation
]

function matches_prefix(bytes, [prefix, prefix_length]) {
  for (let bit = 0; bit < prefix_length; bit++) {
    const byte_index = Math.floor(bit / 8)
    const mask = 0x80 >> (bit % 8)
    if ((bytes[byte_index] & mask) !== ((prefix[byte_index] || 0) & mask)) {
      return false
    }
  }
  return true
}

// True for a canonical address outside loopback, private and reserved ranges.
export function is_public_address(address) {
  const bytes = ip6addr.parse(address).toBuffer()
  const is_ipv4_mapped =
    bytes.subarray(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  if (is_ipv4_mapped) {
    const ipv4 = bytes.subarray(12, 16)
    return !RESERVED_IPV4_RANGES.some((range) => matches_prefix(ipv4, range))
  }
  return !RESERVED_IPV6_RANGES.some((range) => matches_prefix(bytes, range))
}

// Parses `host:port` or `[address]:port`.
export function parse_bootstrap_peer(value) {
  const match =
    /^\[([^\]]+)\]:(\d+)$/.exec(value) || /^([^:[\]\s]+):(\d+)$/.exec(value)
  const port = match && Number(match[2])
  if (!match || !(port > 0 && port < 65536)) {
    throw new Error(
      `invalid bootstrap peer "${value}": expected host:port or [address]:port`
    )
  }
  return { host: match[1], port }
}

const BOOTSTRAP_RESOLUTION_TIMEOUT_MS = 5000

function with_timeout(promise, timeout_ms) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeout_ms} ms`)),
      timeout_ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function resolve_host(host) {
  const results = await dns.promises.lookup(host, { all: true })
  return results.map(({ address }) => address)
}

// Bounded table of known peer addresses, one entry per IP, that keeps the node
// dialed up to maximum_peer_count with per-address backoff.
export default class PeerManager {
  constructor({
    bootstrap_peers,
    maximum_peer_count,
    reconnect_delay_ms,
    dial,
    get_peer_count,
    resolve = resolve_host,
    now = Date.now
  }) {
    this.bootstrap_peers = bootstrap_peers.map(parse_bootstrap_peer)
    this.maximum_peer_count = maximum_peer_count
    this.reconnect_delay_ms = reconnect_delay_ms
    this.dial = dial
    this.get_peer_count = get_peer_count
    this.resolve = resolve
    this.now = now

    this.addresses = new Map()
    this.excluded_addresses = new Set()
    this.connection_key_by_node_id = new Map()
    this.bootstrap_resolution_error_count = 0
    this.is_refilling = false
    this.is_stopped = false
    this.refill_timer = null
  }

  start() {
    const refill = () =>
      this.refill().catch((error) => log(`refill failed: ${error.stack}`))
    this.refill_timer = setInterval(refill, constants.PEER_REFILL_INTERVAL_MS)
    refill()
  }

  stop() {
    this.is_stopped = true
    clearInterval(this.refill_timer)
    this.refill_timer = null
  }

  // Bootstrap peers are caller-supplied, so they skip the reserved-range
  // filter that applies to addresses learned from keepalives.
  add_address({ address, port, is_bootstrap = false }) {
    const canonical_address = canonicalize_address(address)
    if (!canonical_address || !port) return false
    if (this.excluded_addresses.has(canonical_address)) return false
    if (!is_bootstrap && !is_public_address(canonical_address)) return false

    const existing_entry = this.addresses.get(canonical_address)
    if (existing_entry) {
      if (is_bootstrap) existing_entry.is_bootstrap = true
      if (existing_entry.state === ENTRY_STATE.IDLE) existing_entry.port = port
      return true
    }

    if (
      this.addresses.size >= constants.ADDRESS_TABLE_MAXIMUM_ENTRY_COUNT &&
      !this.evict_oldest_idle_entry()
    ) {
      return false
    }

    this.addresses.set(canonical_address, {
      address: canonical_address,
      port,
      is_bootstrap,
      state: ENTRY_STATE.IDLE,
      failure_count: 0,
      next_attempt_at_ms: 0,
      connected_at_ms: null
    })
    return true
  }

  // Evicts the oldest idle entry, preferring one not waiting out a backoff, so
  // a failing address re-learned from a keepalive is not redialed early.
  evict_oldest_idle_entry() {
    const now = this.now()
    const is_evictable = (entry) =>
      entry.state === ENTRY_STATE.IDLE && !entry.is_bootstrap
    for (const require_elapsed_backoff of [true, false]) {
      for (const [address, entry] of this.addresses) {
        if (!is_evictable(entry)) continue
        if (require_elapsed_backoff && entry.next_attempt_at_ms > now) continue
        this.addresses.delete(address)
        return true
      }
    }
    return false
  }

  async resolve_bootstrap_peers() {
    await Promise.all(
      this.bootstrap_peers.map(async ({ host, port }) => {
        let addresses = []
        try {
          addresses = await with_timeout(
            this.resolve(host),
            BOOTSTRAP_RESOLUTION_TIMEOUT_MS
          )
        } catch (error) {
          log(`failed to resolve ${host}: ${error.message}`)
        }

        if (!addresses.length) {
          this.bootstrap_resolution_error_count += 1
          return
        }

        for (const address of addresses) {
          this.add_address({ address, port, is_bootstrap: true })
        }
      })
    )
  }

  async refill() {
    if (this.is_refilling) return
    this.is_refilling = true

    try {
      await this.resolve_bootstrap_peers()
      if (this.is_stopped) return

      const now = this.now()
      for (const entry of this.addresses.values()) {
        if (this.get_peer_count() >= this.maximum_peer_count) break
        if (entry.state !== ENTRY_STATE.IDLE) continue
        if (entry.next_attempt_at_ms > now) continue

        entry.state = ENTRY_STATE.CONNECTING
        try {
          this.dial({ address: entry.address, port: entry.port })
        } catch (error) {
          log(`dial [${entry.address}]:${entry.port} failed: ${error.message}`)
          this.on_disconnected({ address: entry.address })
        }
      }
    } finally {
      this.is_refilling = false
    }
  }

  on_connected({ address }) {
    const entry = this.addresses.get(address)
    if (!entry) return

    entry.state = ENTRY_STATE.CONNECTED
    entry.connected_at_ms = this.now()
  }

  // Backoff doubles from reconnect_delay_ms up to the maximum, and resets only
  // after a connection that stayed up for the reset period.
  // A duplicate node id (one node reachable at two addresses) holds the
  // address for the maximum delay without counting it as a failure.
  on_disconnected({ address, is_duplicate_node_id = false }) {
    const entry = this.addresses.get(address)
    if (!entry) return

    const now = this.now()
    if (is_duplicate_node_id) {
      entry.next_attempt_at_ms = now + constants.MAXIMUM_RECONNECT_DELAY_MS
      entry.state = ENTRY_STATE.IDLE
      entry.connected_at_ms = null
      return
    }

    const connected_duration_ms =
      entry.connected_at_ms === null ? 0 : now - entry.connected_at_ms
    if (connected_duration_ms >= constants.BACKOFF_RESET_CONNECTED_MS) {
      entry.failure_count = 0
    }

    const delay_ms = Math.min(
      this.reconnect_delay_ms * 2 ** entry.failure_count,
      constants.MAXIMUM_RECONNECT_DELAY_MS
    )
    entry.failure_count += 1
    entry.next_attempt_at_ms = now + delay_ms
    entry.state = ENTRY_STATE.IDLE
    entry.connected_at_ms = null
  }

  exclude_address({ address }) {
    this.excluded_addresses.add(address)
    this.addresses.delete(address)
  }

  // Returns false when another connection already holds peer_node_id.
  register_node_id({ peer_node_id, connection_key }) {
    const existing_key = this.connection_key_by_node_id.get(peer_node_id)
    if (existing_key && existing_key !== connection_key) return false

    this.connection_key_by_node_id.set(peer_node_id, connection_key)
    return true
  }

  release_node_id({ peer_node_id, connection_key }) {
    if (this.connection_key_by_node_id.get(peer_node_id) === connection_key) {
      this.connection_key_by_node_id.delete(peer_node_id)
    }
  }
}
