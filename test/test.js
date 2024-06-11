/* global describe it */
import chai from 'chai'
import bytes from 'chai-bytes'

import NanoNode from '#lib/nano-node.js'

import { create_server_node, create_client_node } from '#test/utils.js'

chai.use(bytes)
const { expect } = chai

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Nano Node', function () {
  this.timeout(5000)

  it('handshake between server and client', async () => {
    const node_a = await create_server_node()
    const node_b = new NanoNode()

    let handshake_a
    let handshake_b

    node_b.on('handshake', (message) => {
      handshake_b = message
    })

    const waitForHandshake = () =>
      new Promise((resolve, reject) => {
        node_a.on('handshake', (message) => {
          handshake_a = message
          try {
            expect(handshake_a.node_id).to.equalBytes(
              node_b.node_key.public_key_buf
            )
            expect(handshake_b.node_id).to.equalBytes(
              node_a.node_key.public_key_buf
            )
            resolve()
          } catch (err) {
            reject(err)
          }
        })
      })

    // connect to node_a
    const { address, port } = node_a.server.address()
    node_b.connect_address({ address, port })

    await waitForHandshake()
  })

  it('node stop, close server and sockets', async () => {
    const serverNode = await create_server_node()
    const clientCount = 20
    const clientNodes = []
    for (let i = 0; i < clientCount; i++) {
      const node = await create_client_node(serverNode)
      clientNodes.push(node)
    }

    await wait(500)

    let closeEventCounter = 0
    serverNode.on('close', () => {
      closeEventCounter += 1
    })

    serverNode.stop()

    await wait(500)

    expect(serverNode.server.listening).to.equal(false)
    expect(serverNode.peers.size).to.equal(0)
    expect(closeEventCounter).to.equal(clientCount)

    for (const clientNode of clientNodes) {
      expect(clientNode.peers.size).equal(0)
    }
  })
})
