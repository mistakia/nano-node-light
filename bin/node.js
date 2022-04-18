import NanoNode from '#lib/nano-node.js'
import debug from 'debug'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
const argv = yargs(hideBin(process.argv)).argv

const log = debug('bin')
debug.enable('*')

if (!argv.address) {
  log('missing --address')
  process.exit()
}

if (!argv.port) {
  log('missing --port')
  process.exit()
}

const node = new NanoNode({
  address: argv.address,
  port: argv.port
})

node.on('message', (message) => {
  console.log(message)
})

node.on('error', (error) => {
  console.log(error)
})

node.connect({
  address: '::ffff:194.146.12.171',
  port: 54000
})
