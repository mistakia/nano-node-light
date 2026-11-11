/* global describe it */
import chai from 'chai'

import { constants } from '#common'
import PeerManager, { parse_bootstrap_peer } from '#lib/peer-manager.js'

const { expect } = chai

// A peer manager with a stub dialer and a manual clock. Dialed addresses are
// recorded; `connected` holds the addresses currently counted as peers.
function create_peer_manager({
  maximum_peer_count = 200,
  bootstrap_peers = [],
  resolve = async (host) => [host]
} = {}) {
  const clock = { now_ms: 1e12 }
  const dialed = []
  const connected = new Set()
  const peer_manager = new PeerManager({
    bootstrap_peers,
    maximum_peer_count,
    reconnect_delay_ms: constants.DEFAULT_CONFIG.reconnect_delay_ms,
    dial: ({ address }) => {
      dialed.push(address)
      connected.add(address)
    },
    get_peer_count: () => connected.size,
    resolve,
    now: () => clock.now_ms
  })
  return { peer_manager, clock, dialed, connected }
}

const public_ipv4 = (index) =>
  `::ffff:5.${(index >> 16) & 0xff}.${(index >> 8) & 0xff}.${index & 0xff}`

describe('Peer Manager', () => {
  it('never exceeds the maximum peer count when keepalives advertise 500 addresses', async () => {
    const { peer_manager, connected } = create_peer_manager({
      maximum_peer_count: 50
    })
    for (let i = 1; i <= 500; i++) {
      peer_manager.add_address({ address: public_ipv4(i), port: 7075 })
    }

    await peer_manager.refill()
    await peer_manager.refill()

    expect(connected.size).to.equal(50)
  })

  it('bounds the address table', () => {
    const { peer_manager } = create_peer_manager()
    const maximum = constants.ADDRESS_TABLE_MAXIMUM_ENTRY_COUNT
    for (let i = 1; i <= maximum + 100; i++) {
      peer_manager.add_address({ address: public_ipv4(i), port: 7075 })
    }

    expect(peer_manager.addresses.size).to.equal(maximum)
    expect(peer_manager.addresses.has(public_ipv4(1))).to.equal(false)
    expect(peer_manager.addresses.has(public_ipv4(maximum + 100))).to.equal(
      true
    )
  })

  it('gives one slot to an IP written compressed and uncompressed', async () => {
    const { peer_manager, dialed } = create_peer_manager()
    peer_manager.add_address({ address: '2a01:4f8::1', port: 7075 })
    peer_manager.add_address({ address: '2a01:04f8:0:0:0:0:0:1', port: 7075 })
    peer_manager.add_address({ address: '5.9.1.2', port: 7075 })
    peer_manager.add_address({ address: '::ffff:5.9.1.2', port: 7075 })

    await peer_manager.refill()

    expect(dialed).to.deep.equal(['2a01:4f8::1', '::ffff:5.9.1.2'])
  })

  it('never dials loopback, private ranges or port 0', async () => {
    const { peer_manager, dialed } = create_peer_manager()
    for (const address of [
      '127.0.0.1',
      '::1',
      '10.1.2.3',
      '192.168.1.1',
      'fe80::1'
    ]) {
      peer_manager.add_address({ address, port: 7075 })
    }
    peer_manager.add_address({ address: '5.9.1.2', port: 0 })

    await peer_manager.refill()

    expect(dialed).to.deep.equal([])
  })

  it('does not redial a failed address before its backoff elapses', async () => {
    const { peer_manager, clock, dialed, connected } = create_peer_manager()
    const address = '::ffff:5.9.1.2'
    peer_manager.add_address({ address, port: 7075 })

    await peer_manager.refill()
    connected.delete(address)
    peer_manager.on_disconnected({ address })

    clock.now_ms += constants.DEFAULT_CONFIG.reconnect_delay_ms - 1
    await peer_manager.refill()
    expect(dialed).to.have.length(1)

    clock.now_ms += 1
    await peer_manager.refill()
    expect(dialed).to.have.length(2)
  })

  it('keeps backing off a peer that handshakes and drops within a minute', async () => {
    const { peer_manager, clock, connected } = create_peer_manager()
    const address = '::ffff:5.9.1.2'
    peer_manager.add_address({ address, port: 7075 })
    const delays = []

    for (let attempt = 0; attempt < 3; attempt++) {
      await peer_manager.refill()
      peer_manager.on_connected({ address })
      clock.now_ms += 30 * 1000
      connected.delete(address)
      peer_manager.on_disconnected({ address })
      const entry = peer_manager.addresses.get(address)
      delays.push(entry.next_attempt_at_ms - clock.now_ms)
      clock.now_ms = entry.next_attempt_at_ms
    }

    const base_ms = constants.DEFAULT_CONFIG.reconnect_delay_ms
    expect(delays).to.deep.equal([base_ms, base_ms * 2, base_ms * 4])
  })

  it('resets backoff after a connection that stayed up five minutes', async () => {
    const { peer_manager, clock } = create_peer_manager()
    const address = '::ffff:5.9.1.2'
    peer_manager.add_address({ address, port: 7075 })
    const entry = peer_manager.addresses.get(address)
    entry.failure_count = 4

    peer_manager.on_connected({ address })
    clock.now_ms += constants.BACKOFF_RESET_CONNECTED_MS
    peer_manager.on_disconnected({ address })

    expect(entry.next_attempt_at_ms - clock.now_ms).to.equal(
      constants.DEFAULT_CONFIG.reconnect_delay_ms
    )
  })

  it('refuses a second connection with a node id already connected', () => {
    const { peer_manager } = create_peer_manager()
    const peer_node_id = 'node_1example'

    expect(
      peer_manager.register_node_id({ peer_node_id, connection_key: 'first' })
    ).to.equal(true)
    expect(
      peer_manager.register_node_id({ peer_node_id, connection_key: 'second' })
    ).to.equal(false)

    peer_manager.release_node_id({ peer_node_id, connection_key: 'first' })
    expect(
      peer_manager.register_node_id({ peer_node_id, connection_key: 'second' })
    ).to.equal(true)
  })

  it('parses host:port and [address]:port bootstrap peers', () => {
    expect(parse_bootstrap_peer('[::ffff:1.2.3.4]:7075')).to.deep.equal({
      host: '::ffff:1.2.3.4',
      port: 7075
    })
    expect(parse_bootstrap_peer('peering.example:7075')).to.deep.equal({
      host: 'peering.example',
      port: 7075
    })
    expect(() => parse_bootstrap_peer('2a01:4f8::1:7075')).to.throw()
    expect(() => parse_bootstrap_peer('peering.example')).to.throw()
  })

  it('counts a bootstrap host that resolves to nothing and retries it on the next refill', async () => {
    let resolution_count = 0
    let addresses = []
    const { peer_manager, dialed } = create_peer_manager({
      bootstrap_peers: ['peering.example:7075'],
      resolve: async () => {
        resolution_count += 1
        return addresses
      }
    })

    await peer_manager.refill()
    expect(peer_manager.bootstrap_resolution_error_count).to.equal(1)
    expect(dialed).to.have.length(0)

    addresses = ['5.9.1.2']
    await peer_manager.refill()
    expect(resolution_count).to.equal(2)
    expect(dialed).to.deep.equal(['::ffff:5.9.1.2'])
  })

  it('excludes an address found to be the node itself', async () => {
    const { peer_manager, dialed, connected } = create_peer_manager()
    const address = '::ffff:5.9.1.2'
    peer_manager.add_address({ address, port: 7075 })
    await peer_manager.refill()
    connected.delete(address)

    peer_manager.exclude_address({ address })
    peer_manager.add_address({ address, port: 7075 })
    await peer_manager.refill()

    expect(dialed).to.have.length(1)
  })

  it('evicts an entry not waiting out a backoff before one that is', async () => {
    const { peer_manager, clock, connected } = create_peer_manager()
    const failing_address = public_ipv4(1)
    peer_manager.add_address({ address: failing_address, port: 7075 })
    await peer_manager.refill()
    connected.delete(failing_address)
    peer_manager.on_disconnected({ address: failing_address })
    peer_manager.maximum_peer_count = 0

    const maximum = constants.ADDRESS_TABLE_MAXIMUM_ENTRY_COUNT
    for (let i = 2; i <= maximum + 1; i++) {
      peer_manager.add_address({ address: public_ipv4(i), port: 7075 })
    }

    expect(peer_manager.addresses.has(failing_address)).to.equal(true)
    expect(peer_manager.addresses.has(public_ipv4(2))).to.equal(false)
    expect(
      peer_manager.addresses.get(failing_address).next_attempt_at_ms
    ).to.be.above(clock.now_ms)
  })

  it('backs off an address whose dial throws', async () => {
    const { peer_manager } = create_peer_manager()
    peer_manager.dial = () => {
      throw new Error('dial failure')
    }
    const address = '::ffff:5.9.1.2'
    peer_manager.add_address({ address, port: 7075 })

    await peer_manager.refill()

    const entry = peer_manager.addresses.get(address)
    expect(entry.state).to.equal('idle')
    expect(entry.failure_count).to.equal(1)
  })

  it('holds a duplicate node id address without counting a failure', async () => {
    const { peer_manager, clock, connected } = create_peer_manager()
    const address = '::ffff:5.9.1.2'
    peer_manager.add_address({ address, port: 7075 })
    await peer_manager.refill()
    connected.delete(address)

    peer_manager.on_disconnected({ address, is_duplicate_node_id: true })

    const entry = peer_manager.addresses.get(address)
    expect(entry.failure_count).to.equal(0)
    expect(entry.next_attempt_at_ms - clock.now_ms).to.equal(
      constants.MAXIMUM_RECONNECT_DELAY_MS
    )
  })
})
