import debug from 'debug'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import NanoNode from '#lib/nano-node.js'
import { FrontierReq, BulkPull } from '#lib/bootstrap.js'
import { constants, decodeAddress } from '#common'
import seed_accounts from '#common/seed-accounts.js'

const argv = yargs(hideBin(process.argv)).argv
const log = debug('bootstrap')
debug.enable('bootstrap,node')

const get_network = (network = 'live') => {
  return constants.NETWORK[network.toUpperCase()] || constants.NETWORK.BETA
}

const network = get_network(argv.network)
const node = new NanoNode({ network, telemetry: true })

node.on('error', () => {})

const setup_client = (Client_Constructor, event_name) => {
  const client = new Client_Constructor({
    host: argv.host || network.ADDRESS,
    port: argv.port || network.PORT,
    network
  })
  client.on('open', () => log(`${event_name} open`))
  client.on('error', (error) => log(error))
  client.on('close', () => log(`${event_name} close`))
  return client
}

const bulk_pull_client = setup_client(BulkPull, 'bulk_pull_client')
const frontier_req_client = setup_client(FrontierReq, 'frontier_req_client')

const get_account_frontier = async (account_public_key) => {
  const account_public_key_buffer = Buffer.from(account_public_key, 'hex')
  frontier_req_client.request({ start: account_public_key_buffer, count: 1 })

  const block = await new Promise((resolve) =>
    frontier_req_client.once('frontier', resolve)
  )
  bulk_pull_client.request({ start: block.Frontier, count: 1 })

  const block_info = await new Promise((resolve) =>
    bulk_pull_client.once('block', resolve)
  )
  return {
    frontier_hash: block.Frontier.toString('hex'),
    block_info: block_info
  }
}

const bootstrap_quorum_weights = async () => {
  const start_time = process.hrtime()

  node.on('frontiers_confirmed', () => {
    const [seconds, nanoseconds] = process.hrtime(start_time)
    log(`All frontiers confirmed in ${seconds}s and ${nanoseconds / 1e6}ms`)
    process.exit()
  })

  const frontiers = []

  for (const account_address of seed_accounts) {
    const { publicKey } = decodeAddress({ address: account_address })
    const { frontier_hash, block_info } = await get_account_frontier(publicKey)
    frontiers.push({
      block_hash: frontier_hash,
      previous_block_hash_buffer: block_info.previous_hash,
      account: account_address,
      representative_public_key:
        block_info.representative_account.toString('hex'),
      balance: BigInt(`0x${block_info.balance.toString('hex')}`)
    })
  }

  log(`bootstrapped ${frontiers.length} frontiers`)

  await node.bootstrap_quorum_weights_from_frontiers({ frontiers })
}

node.connectDomain({ address: network.ADDRESS, port: network.PORT })
bootstrap_quorum_weights()
