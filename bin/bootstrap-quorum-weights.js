import debug from 'debug'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import NanoNode from '#lib/nano-node.js'
import { FrontierReq, BulkPull } from '#lib/bootstrap.js'
import { constants, decode_address, encode_address } from '#common'
import seed_accounts from '#common/seed-accounts.js'

const argv = yargs(hideBin(process.argv)).argv
const log = debug('bootstrap')
debug.enable('bootstrap')

const get_network = (network = 'live') => {
  return constants.NETWORK[network.toUpperCase()] || constants.NETWORK.BETA
}

const network = get_network(argv.network)
const node = new NanoNode({ network, telemetry: true })

node.on('error', (error) => {
  log(error)
})

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

const get_account_block = async ({ block_hash_buf }) => {
  bulk_pull_client.request({ start: block_hash_buf, count: 1 })
  const block_info = await new Promise((resolve) =>
    bulk_pull_client.once('block', resolve)
  )
  return block_info
}

const get_account_frontier = async (account_public_key) => {
  const account_public_key_buffer = Buffer.from(account_public_key, 'hex')
  frontier_req_client.request({ start: account_public_key_buffer, count: 1 })

  const block = await new Promise((resolve) =>
    frontier_req_client.once('frontier', resolve)
  )
  const block_info = await get_account_block({
    block_hash_buf: block.frontier_hash_buf
  })

  return {
    frontier_hash: block.frontier_hash_buf.toString('hex'),
    block_info: block_info
  }
}

const confirm_block = async ({ block_hash }) => {
  const block_hash_buffer = Buffer.from(block_hash, 'hex')
  const block_info = await get_account_block({
    block_hash_buf: block_hash_buffer
  })

  const account_address = encode_address({
    public_key_buf: block_info.account_address
  })

  const confirmed_block = await node.confirm_block({
    block_hash,
    account_address,
    previous_block_hash_buffer: block_info.previous_hash,
    representative_public_key:
      block_info.representative_account.toString('hex'),
    balance: BigInt(`0x${block_info.balance.toString('hex')}`)
  })
  return confirmed_block
}

const confirm_account = async ({ account_address }) => {
  const { public_key: account_public_key } = decode_address({
    address: account_address
  })
  const { frontier_hash, block_info } = await get_account_frontier(
    account_public_key
  )

  const confirmed_block = await node.confirm_block({
    block_hash: frontier_hash,
    account_address,
    previous_block_hash_buffer: block_info.previous_hash,
    representative_public_key:
      block_info.representative_account.toString('hex'),
    balance: BigInt(`0x${block_info.balance.toString('hex')}`)
  })

  return confirmed_block
}

const bootstrap_quorum_weights = async () => {
  const start_time = process.hrtime()

  node.on('frontiers_confirmed', async () => {
    const [seconds, nanoseconds] = process.hrtime(start_time)
    const bootstrap_time = process.hrtime()
    log(
      `Quorum frontiers bootstraped and confirmed in ${seconds}s and ${
        nanoseconds / 1e6
      }ms`
    )

    if (argv.confirm_block_hash) {
      const confirmed_block = await confirm_block({
        block_hash: argv.confirm_block_hash
      })
      const [seconds, nanoseconds] = process.hrtime(bootstrap_time)
      log(`Block confirmed in ${seconds}s and ${nanoseconds / 1e6}ms`)
      console.log(confirmed_block.toJSON())
      process.exit()
    } else if (argv.confirm_account) {
      const confirmed_block = await confirm_account({
        account_address: argv.confirm_account
      })
      const [seconds, nanoseconds] = process.hrtime(bootstrap_time)
      log(`Account confirmed in ${seconds}s and ${nanoseconds / 1e6}ms`)
      console.log(confirmed_block.toJSON())
      process.exit()
    } else {
      process.exit()
    }
  })

  const frontiers = []

  for (const account_address of seed_accounts) {
    const { public_key: account_public_key } = decode_address({
      address: account_address
    })
    const { frontier_hash, block_info } = await get_account_frontier(
      account_public_key
    )
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

node.connect_domain({ address: network.ADDRESS, port: network.PORT })
bootstrap_quorum_weights()
