import debug from 'debug'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import {
  constants,
  wait,
  decode_connection_info,
  encode_address
} from '#common'
import NanoNode, { AscPull } from '../lib/nano-node.js'

debug.enable('frontier-scan,node,bootstrap')

const log = debug('frontier-scan')
const argv = yargs(hideBin(process.argv)).argv
const frontiers = new Map()
const discovered_representatives = new Map()
const get_network = (network = 'beta') => {
  return constants.NETWORK[network.toUpperCase()] || constants.NETWORK.BETA
}

const network = get_network(argv.network)
const config = {
  network,
  request_telemetry: argv.telemetry
}
const node = new NanoNode(config)

const scan_representative = async ({
  peer_address,
  peer_readable_address,
  representative_public_key
}) => {
  const { address, port } = decode_connection_info(peer_address)
  try {
    log(`Scanning frontiers from representative ${peer_readable_address}`)
    await scan_frontiers({
      representative_public_key,
      host: address,
      port: Number(port)
    })

    // Store the frontiers for this representative
    discovered_representatives.set(peer_address, {
      representative_public_key,
      last_scan: process.hrtime.bigint()
    })
  } catch (error) {
    log(`Error scanning representative ${peer_readable_address}:`, error)
  }
}

const scan_frontiers = ({ host, port, representative_public_key }) =>
  new Promise((resolve, reject) => {
    const representative_nano_address = encode_address({
      public_key_buf: Buffer.from(representative_public_key, 'hex')
    })
    const rep_frontiers = new Map()
    const asc_pull_client = new AscPull({
      host,
      port,
      network: network.ID
    })

    asc_pull_client.on('error', (error) => {
      reject(error)
    })

    asc_pull_client.on('open', () => {
      log('Connected to node for frontier scan')
      const start = Buffer.alloc(32, 0)
      setInterval(() => {
        asc_pull_client.request_frontiers({
          start,
          count: 1n
        })
      }, 5000)
    })

    asc_pull_client.on('frontiers', ({ frontiers: frontier_list }) => {
      for (const { account, hash } of frontier_list) {
        const nano_address = encode_address({
          public_key_buf: account
        })
        const frontier_hash = hash.toString('hex')

        log(`Frontier for account ${nano_address}: ${frontier_hash}`)

        // Store in global frontiers map
        if (!frontiers.has(nano_address)) {
          frontiers.set(nano_address, new Map())
        }

        const account_frontiers = frontiers.get(nano_address)
        account_frontiers.set(representative_nano_address, frontier_hash)

        // Check for forks
        if (account_frontiers.size > 1) {
          const frontier_hashes = Array.from(account_frontiers.values())
          const first_hash = frontier_hashes[0]
          const all_same = frontier_hashes.every((hash) => hash === first_hash)
          if (!all_same) {
            log(`Fork detected for account ${nano_address}`)
            log(`- ${first_hash}`)
            frontier_hashes.forEach((hash, index) => {
              if (hash !== first_hash) {
                log(`- ${account_frontiers.keys()[index]}: ${hash}`)
              }
            })
          }
        }
      }
    })

    asc_pull_client.on('close', () => {
      log('Frontier scan complete')
      resolve(rep_frontiers)
    })
  })

const check_if_representative = async ({
  peer_address,
  peer_readable_address,
  node_id
}) => {
  log(`Checking if ${peer_readable_address} is a representative`)
  const test_block_hash = Buffer.from(network.GENESIS_BLOCK, 'hex')
  const previous_block = Buffer.alloc(32, 0)
  const block_hash_pairs = [Buffer.concat([test_block_hash, previous_block])]

  return new Promise((resolve) => {
    const peer = node.peers.get(peer_address)
    if (!peer?.nano_socket?.handshake_completed) return resolve(false)

    let attempt = 0
    const max_attempts = 5
    let check_interval

    const vote_handler = (vote) => {
      if (vote.hashList[0].equals(test_block_hash)) {
        const representative_public_key = vote.account.toString('hex')
        cleanup()
        resolve(representative_public_key)
      }
    }

    const cleanup = () => {
      if (check_interval) clearInterval(check_interval)
      peer.nano_socket.removeListener('vote', vote_handler)
    }

    const check_for_representative = () => {
      attempt++
      log(
        `Attempt ${attempt} checking if ${peer_readable_address} is a representative`
      )

      if (attempt >= max_attempts) {
        cleanup()
        resolve(false)
        return
      }

      peer.nano_socket.send_confirm_req(block_hash_pairs)
      // Exponential backoff: 5s, 10s, 20s, 40s, 80s
      const next_interval = 5000 * Math.pow(2, attempt)
      check_interval = setTimeout(check_for_representative, next_interval)
    }

    peer.nano_socket.on('vote', vote_handler)
    check_for_representative()
  })
}

node.on('error', (error) => {
  if (error.code === 'ETIMEDOUT') return
  console.log(error)
})

node.on(
  'handshake',
  async ({ node_id, peer_address, peer_readable_address }) => {
    log(
      `Handshake with node ${node_id.toString(
        'hex'
      )} from ${peer_readable_address}`
    )

    await wait(5000)

    const representative_public_key = await check_if_representative({
      peer_address,
      peer_readable_address,
      node_id
    })

    if (representative_public_key) {
      log(
        `Discovered representative: ${peer_readable_address} (${representative_public_key})`
      )
      if (!discovered_representatives.has(peer_address)) {
        // // disconnect from the node
        // const peer = node.peers.get(peer_address)
        // peer.nano_socket.close()

        // await wait(5000)

        scan_representative({
          peer_address,
          peer_readable_address,
          representative_public_key
        })
      }
    }
  }
)

// connect to network bootstrap peers
node.connect_domain({
  address: network.ADDRESS,
  port: network.PORT
})

// Periodically rescan representatives
// setInterval(() => {
//   const RESCAN_INTERVAL = 30 * 60 * 1000 * 1000000 // 30 minutes in nanoseconds

//   for (const [peer_address, rep_data] of discovered_representatives.entries()) {
//     if (process.hrtime.bigint() - rep_data.last_scan > BigInt(RESCAN_INTERVAL)) {
//       scan_representative(peer_address)
//     }
//   }
// }, 5 * 60 * 1000) // Check every 5 minutes
