/* global describe it */
import chai from 'chai'

import {
  create_node,
  create_server_node,
  connect_raw_peer,
  wait,
  wait_for_event
} from '#test/utils.js'

const { expect } = chai

describe('Nano Node handshake', function () {
  this.timeout(5000)

  it('handshake between server and client', async () => {
    const node_a = await create_server_node()
    const { port } = node_a.server.address()

    const connected_a = wait_for_event(node_a, 'peer_connected')
    const node_b = create_node({ bootstrap_peers: [`127.0.0.1:${port}`] })
    const connected_b = wait_for_event(node_b, 'peer_connected')

    const [event_a, event_b] = await Promise.all([connected_a, connected_b])
    expect(event_a.peer_node_id).to.equal(node_b.node_id)
    expect(event_b.peer_node_id).to.equal(node_a.node_id)
    expect(event_b.peer_address).to.equal('::ffff:127.0.0.1')
    expect(event_b.peer_port).to.equal(port)

    node_a.stop()
    node_b.stop()
  })

  it('a raw peer completes a handshake with a node', async () => {
    const node = await create_server_node()
    const peer = await connect_raw_peer(node)

    expect(peer.peer_node_id).to.match(/^node_/)
    expect(node.get_peers()).to.have.length(1)

    peer.close()
    node.stop()
  })

  it('node stop, close server and sockets', async () => {
    const server_node = await create_server_node()
    const { port } = server_node.server.address()
    const client_count = 20
    const client_nodes = []
    for (let i = 0; i < client_count; i++) {
      client_nodes.push(create_node({ bootstrap_peers: [`127.0.0.1:${port}`] }))
    }

    await wait(500)
    expect(server_node.get_peers()).to.have.length(client_count)

    let disconnect_count = 0
    server_node.on('peer_disconnected', () => {
      disconnect_count += 1
    })

    server_node.stop()
    await wait(500)

    expect(server_node.server.listening).to.equal(false)
    expect(server_node.peers.size).to.equal(0)
    expect(disconnect_count).to.equal(client_count)

    for (const client_node of client_nodes) {
      expect(client_node.peers.size).equal(0)
      client_node.stop()
    }
  })
})
