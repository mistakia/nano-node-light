/* global describe it afterEach */
import chai from 'chai'

import { constants } from '#common'
import {
  RawPeer,
  connect_raw_peer,
  create_server_node,
  encode_vote,
  random_hash,
  wait,
  wait_for_event
} from '#test/utils.js'

const { expect } = chai
const { DISCONNECT_REASON } = constants

describe('Nano Socket', function () {
  this.timeout(5000)

  const cleanup = []
  afterEach(() => {
    for (const close of cleanup.splice(0)) close()
  })

  async function start_node(config) {
    const node = await create_server_node(config)
    cleanup.push(() => node.stop())
    return node
  }

  async function open_raw_peer(node, options = {}) {
    const peer = new RawPeer({ port: node.server.address().port, ...options })
    cleanup.push(() => peer.close())
    await peer.connected
    return peer
  }

  it('drops and counts a confirm_ack sent before the handshake', async () => {
    const node = await start_node()
    const votes = []
    node.on('vote', (vote) => votes.push(vote))

    const peer = await open_raw_peer(node)
    peer.send(encode_vote({ block_hashes: [random_hash()] }))
    await wait(100)

    expect(votes).to.have.length(0)
    const { messages_dropped_by_reason } = node.get_statistics()
    expect(messages_dropped_by_reason.before_handshake).to.equal(1)
  })

  it('closes a peer that never completes its handshake', async () => {
    const node = await start_node({ handshake_timeout_ms: 200 })
    const disconnected = wait_for_event(node, 'peer_disconnected')

    await open_raw_peer(node)
    const { disconnect_reason } = await disconnected

    expect(disconnect_reason).to.equal(DISCONNECT_REASON.HANDSHAKE_TIMEOUT)
  })

  it('closes a handshake with a bad signature and reports it', async () => {
    const node = await start_node()
    const disconnected = wait_for_event(node, 'peer_disconnected')
    const invalid_signature = wait_for_event(node, 'invalid_signature')

    const peer = await open_raw_peer(node, {
      invalid_handshake_signature: true
    })
    peer.send_handshake_query()

    expect((await disconnected).disconnect_reason).to.equal(
      DISCONNECT_REASON.HANDSHAKE_INVALID
    )
    const { message_type, signer_public_key } = await invalid_signature
    expect(message_type).to.equal('node_id_handshake')
    expect(signer_public_key).to.equal(
      peer.node_key.public_key_buf.toString('hex')
    )
  })

  it('closes only the peer that sends an unknown type', async () => {
    const node = await start_node()
    const bad_peer = await connect_raw_peer(node)
    const good_peer = await connect_raw_peer(node)
    cleanup.push(
      () => bad_peer.close(),
      () => good_peer.close()
    )

    const disconnected = wait_for_event(node, 'peer_disconnected')
    bad_peer.send({
      message_type: 0x10,
      message: Buffer.alloc(0),
      extensions: 0
    })
    const disconnect = await disconnected

    expect(disconnect.disconnect_reason).to.equal(
      DISCONNECT_REASON.PROTOCOL_ERROR
    )
    expect(disconnect.peer_node_id).to.equal(bad_peer.peer_node_id)

    const vote_received = wait_for_event(node, 'vote')
    good_peer.send(encode_vote({ block_hashes: [random_hash()] }))
    const vote = await vote_received

    expect(vote.peer_node_id).to.equal(good_peer.peer_node_id)
    expect(node.get_peers()).to.have.length(1)
  })
})
