import NanoNode from '#lib/nano-node.js'

export const createServerNode = () =>
  new Promise((resolve, reject) => {
    try {
      const node = new NanoNode()
      node.listen({ port: 0 })
      node.on('listening', () => {
        resolve(node)
      })
    } catch (err) {
      resolve(err)
    }
  })

export const createClientNode = (serverNode) => {
  const node = new NanoNode()
  // connect to server
  const { address, port } = serverNode.server.address()
  node.connectAddress({ address, port })
  return node
}
