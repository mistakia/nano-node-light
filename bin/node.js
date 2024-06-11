import debug from 'debug'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import NanoNode from '#lib/nano-node.js'
import { constants } from '#common'

const argv = yargs(hideBin(process.argv)).argv

const log = debug('bin')
debug.enable('*')

const get_network = (network = 'live') => {
  return constants.NETWORK[network.toUpperCase()] || constants.NETWORK.BETA
}

const network = get_network(argv.network)
const config = {
  network,
  request_telemetry: argv.telemetry
}
const node = new NanoNode(config)

node.on('error', (error) => {
  console.log(error)
})

node.on('telemetry', (telemetry) => {
  log(telemetry)
})

// connect to network bootstrap peers
node.connect_domain({
  address: network.ADDRESS,
  port: network.PORT
})
