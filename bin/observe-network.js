// Runs a node against a network and prints JSON lines: a `statistics` line
// every 30 s, and one line per `peer_disconnected` and `invalid_signature`.
// With --probe-confirm-request it also checks, once, how peers answer a
// confirm_req for recently confirmed blocks.
import { monitorEventLoopDelay } from 'perf_hooks'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import NanoNode from '#lib/nano-node.js'
import { constants } from '#common'

const STATISTICS_INTERVAL_MS = 30 * 1000
const VOTING_WINDOW_MS = 5 * 60 * 1000
const PROBE_INTERVAL_MS = 15 * 1000
const PROBE_PAIR_MAXIMUM_COUNT = 8
const PROBE_MINIMUM_CONFIRMED_AGE_MS = 10 * 1000
const PROBE_MAXIMUM_CONFIRMED_AGE_MS = 60 * 1000
const PROBE_TIMEOUT_MS = 5000
const PROBE_BLOCK_MAXIMUM_COUNT = 16384

const argv = yargs(hideBin(process.argv))
  .option('network', {
    choices: ['live', 'beta', 'test'],
    demandOption: true
  })
  .option('bootstrap-peers', {
    type: 'string',
    demandOption: true,
    describe: 'Comma-separated host:port or [address]:port'
  })
  .option('duration-seconds', {
    type: 'number',
    describe: 'Exit after this many seconds; runs until signalled when unset'
  })
  .option('probe-confirm-request', {
    type: 'boolean',
    default: false,
    describe:
      'Send one confirm_req for blocks confirmed 10 to 60 s ago to half the peers, and print every vote naming them'
  })
  .strict()
  .parse()

const print = (record) => process.stdout.write(JSON.stringify(record) + '\n')
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error
  node.stop()
  process.exit(0)
})

const started_at_ms = Date.now()
const node = new NanoNode({
  network: constants.NETWORK[argv.network.toUpperCase()],
  bootstrap_peers: argv.bootstrapPeers.split(',').filter(Boolean)
})

node.on('peer_disconnected', (event) =>
  print({ type: 'peer_disconnected', ...event })
)
node.on('invalid_signature', (event) =>
  print({ type: 'invalid_signature', ...event })
)

const last_vote_at_ms_by_representative = new Map()
node.on('vote', ({ representative_account, received_at_ms }) => {
  last_vote_at_ms_by_representative.set(representative_account, received_at_ms)
})

const event_loop_delay = monitorEventLoopDelay({ resolution: 10 })
event_loop_delay.enable()

function print_statistics() {
  const now_ms = Date.now()
  for (const [account, last_vote_at_ms] of last_vote_at_ms_by_representative) {
    if (now_ms - last_vote_at_ms > VOTING_WINDOW_MS) {
      last_vote_at_ms_by_representative.delete(account)
    }
  }

  print({
    type: 'statistics',
    at_ms: now_ms,
    elapsed_seconds: Math.round((now_ms - started_at_ms) / 1000),
    ...node.get_statistics(),
    voting_representative_count_5m: last_vote_at_ms_by_representative.size,
    event_loop_lag_p50_ms: event_loop_delay.percentile(50) / 1e6,
    event_loop_lag_p99_ms: event_loop_delay.percentile(99) / 1e6,
    event_loop_lag_max_ms: event_loop_delay.max / 1e6,
    rss_mb: Math.round(process.memoryUsage().rss / 1e6)
  })
  event_loop_delay.reset()
}

setInterval(print_statistics, STATISTICS_INTERVAL_MS)

function start_confirm_request_probe() {
  const root_by_block_hash = new Map()
  const first_final_vote_at_ms_by_hash = new Map()
  let is_collecting_candidates = true
  let probe = null

  node.on('block', ({ block_hash, root }) => {
    if (!is_collecting_candidates) return
    root_by_block_hash.set(block_hash, root)
    if (root_by_block_hash.size > PROBE_BLOCK_MAXIMUM_COUNT) {
      root_by_block_hash.delete(root_by_block_hash.keys().next().value)
    }
  })

  node.on('vote', (vote) => {
    if (is_collecting_candidates && vote.is_final) {
      for (const block_hash of vote.block_hashes) {
        if (!first_final_vote_at_ms_by_hash.has(block_hash)) {
          first_final_vote_at_ms_by_hash.set(block_hash, vote.received_at_ms)
        }
      }
    }

    if (!probe || !vote.block_hashes.some((hash) => probe.hashes.has(hash))) {
      return
    }
    const group = probe.asked.has(vote.peer_node_id)
      ? 'asked'
      : probe.control.has(vote.peer_node_id)
        ? 'control'
        : 'unassigned'
    probe.votes.push({
      group,
      peer_node_id: vote.peer_node_id,
      peer_address: vote.peer_address,
      representative_account: vote.representative_account,
      is_final: vote.is_final,
      is_rebroadcast: vote.is_rebroadcast
    })
  })

  function summarize(group) {
    const votes = probe.votes.filter((vote) => vote.group === group)
    const peers_with = (is_rebroadcast) =>
      new Set(
        votes
          .filter((vote) => vote.is_rebroadcast === is_rebroadcast)
          .map((vote) => vote.peer_node_id)
      ).size
    return {
      peer_count: group === 'asked' ? probe.asked.size : probe.control.size,
      peers_with_rebroadcast_clear_votes: peers_with(false),
      peers_with_rebroadcast_set_votes: peers_with(true),
      rebroadcast_clear_vote_count: votes.filter((vote) => !vote.is_rebroadcast)
        .length,
      rebroadcast_set_vote_count: votes.filter((vote) => vote.is_rebroadcast)
        .length
    }
  }

  async function run_probe(hash_root_pairs) {
    const peers = node.get_peers()
    probe = {
      hashes: new Set(hash_root_pairs.map(({ block_hash }) => block_hash)),
      asked: new Set(),
      control: new Set(),
      votes: []
    }
    peers.forEach(({ peer_node_id }, index) => {
      probe[index % 2 === 0 ? 'asked' : 'control'].add(peer_node_id)
    })

    const replies = await Promise.all(
      Array.from(probe.asked).map((peer_node_id) =>
        node
          .request_votes_from_peer({
            peer_node_id,
            hash_root_pairs,
            timeout_ms: PROBE_TIMEOUT_MS
          })
          .catch(() => [])
      )
    )

    print({
      type: 'confirm_request_probe',
      at_ms: Date.now(),
      hash_root_pairs,
      request_votes_from_peer_replying_peer_count: replies.filter(
        (votes) => votes.length
      ).length,
      asked: summarize('asked'),
      control: summarize('control'),
      votes: probe.votes.filter((vote) => vote.group === 'asked')
    })
  }

  const probe_timer = setInterval(() => {
    const now_ms = Date.now()
    const hash_root_pairs = []
    for (const [block_hash, first_at_ms] of first_final_vote_at_ms_by_hash) {
      const age_ms = now_ms - first_at_ms
      if (age_ms > PROBE_MAXIMUM_CONFIRMED_AGE_MS) {
        first_final_vote_at_ms_by_hash.delete(block_hash)
        continue
      }
      const root = root_by_block_hash.get(block_hash)
      if (root && age_ms >= PROBE_MINIMUM_CONFIRMED_AGE_MS) {
        hash_root_pairs.push({ block_hash, root })
      }
    }

    if (hash_root_pairs.length) {
      clearInterval(probe_timer)
      is_collecting_candidates = false
      root_by_block_hash.clear()
      first_final_vote_at_ms_by_hash.clear()
      run_probe(hash_root_pairs.slice(-PROBE_PAIR_MAXIMUM_COUNT))
    }
  }, PROBE_INTERVAL_MS)
}

if (argv.probeConfirmRequest) start_confirm_request_probe()

function shut_down() {
  print_statistics()
  node.stop()
  process.exit(0)
}

process.on('SIGINT', shut_down)
process.on('SIGTERM', shut_down)
if (argv.durationSeconds) setTimeout(shut_down, argv.durationSeconds * 1000)
