/* global describe it afterEach */
import { execFileSync } from 'child_process'
import fs from 'fs'
import chai from 'chai'

import NanoNode from '#lib/nano-node.js'
import { constants } from '#common'
import {
  connect_raw_peer,
  create_server_node,
  encode_state_block,
  encode_vote,
  random_hash,
  wait,
  wait_for_event,
  FINAL_VOTE_TIMESTAMP,
  TEST_NETWORK,
  TEST_REPRESENTATIVE_KEY
} from '#test/utils.js'

const { expect } = chai

describe('Nano Node', function () {
  this.timeout(10000)

  const cleanup = []
  afterEach(() => {
    for (const close of cleanup.splice(0)) close()
  })

  async function start_node(config) {
    const node = await create_server_node(config)
    cleanup.push(() => node.stop())
    return node
  }

  async function connect_peer(node) {
    const peer = await connect_raw_peer(node)
    cleanup.push(() => peer.close())
    return peer
  }

  it('emits a duplicate vote with is_duplicate set and verifies it once', async () => {
    const node = await start_node()
    const peer = await connect_peer(node)
    const votes = []
    node.on('vote', (vote) => votes.push(vote))

    const vote_message = encode_vote({ block_hashes: [random_hash()] })
    peer.send(vote_message)
    peer.send(vote_message)
    await wait(100)

    expect(votes.map((vote) => vote.is_duplicate)).to.deep.equal([false, true])
    expect(votes[0].peer_node_id).to.equal(peer.peer_node_id)
    expect(votes[0].vote_hash).to.equal(vote_message.vote_hash.toString('hex'))
    expect(votes[0].representative_account).to.match(/^nano_/)
    const statistics = node.get_statistics()
    expect(statistics.votes_verified_count).to.equal(1)
    expect(statistics.votes_duplicate_count).to.equal(1)
  })

  it('emits invalid_signature for a vote with a corrupted signature', async () => {
    const node = await start_node()
    const peer = await connect_peer(node)
    const invalid_signature = wait_for_event(node, 'invalid_signature')
    const votes = []
    node.on('vote', (vote) => votes.push(vote))

    peer.send(
      encode_vote({ block_hashes: [random_hash()], corrupt_signature: true })
    )
    const event = await invalid_signature

    expect(event.message_type).to.equal('confirm_ack')
    expect(event.peer_node_id).to.equal(peer.peer_node_id)
    expect(event.signer_public_key).to.equal(
      TEST_REPRESENTATIVE_KEY.public_key_buf.toString('hex')
    )
    expect(votes).to.have.length(0)
    expect(node.get_statistics().invalid_signature_count).to.equal(1)
  })

  it('emits block for a published state block with its hash and root', async () => {
    const node = await start_node()
    const peer = await connect_peer(node)
    const block_received = wait_for_event(node, 'block')

    const block_message = encode_state_block({ balance: 123456789n })
    peer.send(block_message)
    const block = await block_received

    expect(block.block_hash).to.equal(block_message.block_hash.toString('hex'))
    expect(block.root).to.equal(block_message.root.toString('hex'))
    expect(block.balance).to.equal('123456789')
    expect(block.is_duplicate).to.equal(false)
    expect(node.get_statistics().blocks_verified_count).to.equal(1)
  })

  it('counts a legacy publish as ignored', async () => {
    const node = await start_node()
    const peer = await connect_peer(node)

    peer.send({
      message_type: constants.MESSAGE_TYPE.PUBLISH,
      message: Buffer.alloc(constants.BLOCK_SIZES[constants.BLOCK_TYPE.SEND]),
      extensions: constants.BLOCK_TYPE.SEND << 8
    })
    await wait(100)

    const { messages_dropped_by_reason } = node.get_statistics()
    expect(messages_dropped_by_reason.publish_legacy_ignored).to.equal(1)
  })

  it('closes a peer whose telemetry is signed by a different node id', async () => {
    const node = await start_node()
    const peer = await connect_peer(node)
    const disconnected = wait_for_event(node, 'peer_disconnected')
    const fixtures = JSON.parse(
      fs.readFileSync(
        new URL('./fixtures/mainnet-messages.json', import.meta.url)
      )
    )
    const [telemetry] = fixtures.telemetry

    peer.send({
      message_type: constants.MESSAGE_TYPE.TELEMETRY_ACK,
      message: Buffer.from(telemetry.body, 'hex'),
      extensions: telemetry.extensions
    })

    expect((await disconnected).disconnect_reason).to.equal(
      constants.DISCONNECT_REASON.TELEMETRY_NODE_ID_MISMATCH
    )
  })

  it('request_votes_from_peer returns only the target peer votes with the rebroadcast flag clear', async () => {
    const node = await start_node()
    const target_peer = await connect_peer(node)
    const other_peer = await connect_peer(node)
    const block_hash = random_hash()
    const root = random_hash()

    target_peer.on('message', ({ message_type }) => {
      if (message_type !== constants.MESSAGE_TYPE.CONFIRM_REQ) return
      target_peer.send(
        encode_vote({
          block_hashes: [block_hash],
          timestamp: FINAL_VOTE_TIMESTAMP
        })
      )
      target_peer.send(
        encode_vote({
          block_hashes: [block_hash],
          timestamp: FINAL_VOTE_TIMESTAMP - 1n,
          is_rebroadcast: true
        })
      )
      target_peer.send(encode_vote({ block_hashes: [random_hash()] }))
      other_peer.send(
        encode_vote({
          block_hashes: [block_hash],
          timestamp: FINAL_VOTE_TIMESTAMP
        })
      )
    })

    const { requested_at_ms, votes } = await node.request_votes_from_peer({
      peer_node_id: target_peer.peer_node_id,
      hash_root_pairs: [
        { block_hash: block_hash.toString('hex'), root: root.toString('hex') }
      ],
      timeout_ms: 300
    })

    expect(votes).to.have.length(1)
    expect(votes[0].peer_node_id).to.equal(target_peer.peer_node_id)
    expect(votes[0].is_rebroadcast).to.equal(false)
    expect(votes[0].block_hashes).to.deep.equal([block_hash.toString('hex')])
    expect(requested_at_ms).to.be.a('number')
    expect(votes[0].received_at_ms - requested_at_ms).to.be.within(0, 300)
  })

  it('request_votes_from_peer rejects for an unknown peer', async () => {
    const node = await start_node()
    let error
    try {
      await node.request_votes_from_peer({
        peer_node_id: 'node_unknown',
        hash_root_pairs: []
      })
    } catch (caught) {
      error = caught
    }
    expect(error.message).to.match(/no handshaken peer/)
  })

  it('get_peers lists exactly the handshaken peers', async () => {
    const node = await start_node()
    const peer_a = await connect_peer(node)
    const peer_b = await connect_peer(node)

    const peer_node_ids = node.get_peers().map((peer) => peer.peer_node_id)
    expect(peer_node_ids.sort()).to.deep.equal(
      [peer_a.peer_node_id, peer_b.peer_node_id].sort()
    )
    for (const peer of node.get_peers()) {
      expect(peer.peer_address).to.equal('::ffff:127.0.0.1')
      expect(peer.connected_at_ms).to.be.a('number')
    }
  })

  it('throws when constructed without network or bootstrap_peers', () => {
    expect(() => new NanoNode({ bootstrap_peers: [] })).to.throw(
      'network is required'
    )
    expect(() => new NanoNode({ network: TEST_NETWORK })).to.throw(
      /bootstrap_peers is required/
    )
  })

  it('rethrows a listener exception after the other listeners ran', () => {
    const script = `
      import NanoNode from '#lib/nano-node.js'
      import { constants } from '#common'
      const node = new NanoNode({ network: constants.NETWORK.BETA, bootstrap_peers: [] })
      node.on('peer_connected', () => { throw new Error('listener failure') })
      node.on('peer_connected', () => { console.log('second listener ran') })
      node.emit_to_consumers('peer_connected', {})
    `
    let result
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        stdio: 'pipe'
      })
    } catch (error) {
      result = error
    }

    expect(result, 'child process should exit non-zero').to.not.equal(undefined)
    expect(result.status).to.not.equal(0)
    expect(result.stdout).to.include('second listener ran')
    expect(result.stderr).to.include('listener failure')
  })
})
