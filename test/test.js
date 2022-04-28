/* global describe it */
import chai from 'chai'
import bytes from 'chai-bytes'

import NanoNode from '#lib/nano-node.js'

chai.use(bytes)
const { expect } = chai

describe('Nano Node', function () {
  it('handshake between server and client', function (done) {
    try {
      const node_a = new NanoNode()
      node_a.listen({ port: 0 })

      let node_b
      let handshake_a
      let handshake_b

      node_a.on('handshake', (message) => {
        handshake_a = message
        try {
          expect(handshake_a.nodeId).to.equalBytes(node_b.nodeKey.public)
          expect(handshake_b.nodeId).to.equalBytes(node_a.nodeKey.public)
          done()
        } catch (err) {
          done(err)
        }
      })

      node_a.on('listening', () => {
        // create client node
        node_b = new NanoNode()

        // connect to node_a
        const { address, port } = node_a.server.address()
        node_b.connect({ address, port })

        node_b.on('handshake', (message) => {
          handshake_b = message
        })
      })
    } catch (err) {
      done(err)
    }
  })
})
