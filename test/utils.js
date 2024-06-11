import NanoNode from '#lib/nano-node.js'

export const create_server_node = () =>
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

export const create_client_node = (serverNode) => {
  const node = new NanoNode()
  // connect to server
  const { address, port } = serverNode.server.address()
  node.connect_address({ address, port })
  return node
}
