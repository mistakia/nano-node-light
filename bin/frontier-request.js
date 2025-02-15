import debug from 'debug'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { AscPull } from '#lib/bootstrap.js'
import { constants, decode_address } from '#common'

const argv = yargs(hideBin(process.argv)).argv
const log = debug('frontier-request')
debug.enable('frontier-request,bootstrap')

const get_network = (network = 'live') => {
  return constants.NETWORK[network.toUpperCase()] || constants.NETWORK.BETA
}

const network = get_network(argv.network)

const setup_client = () => {
  const client = new AscPull({
    host: argv.host || network.ADDRESS,
    port: argv.port || network.PORT,
    network
  })
  
  client.on('open', () => log('asc_pull_client open'))
  client.on('error', (error) => log(error))
  client.on('close', () => log('asc_pull_client close'))
  client.on('frontiers', ({ id, frontiers }) => {
    log('Received frontiers:', frontiers)
    process.exit(0)
  })
  
  return client
}

const request_frontier = async ({ account_address }) => {
  const client = setup_client()
  
  client.on('open', () => {
    const { public_key } = decode_address({ address: account_address })
    const start_buffer = Buffer.from(public_key, 'hex')
    
    // Request just 1 frontier for the specific account
    client.request_frontiers({
      start: start_buffer,
      count: 1n
    })
  })
}

if (!argv.account) {
  console.error('Please provide an account address using --account')
  process.exit(1)
}

request_frontier({ account_address: argv.account })
