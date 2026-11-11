export const MAGIC_NUMBER = 'R'.charCodeAt(0)

export const SELF_ADDRESS = Buffer.alloc(16, 0)

export const QUERY_FLAG = 0
export const RESPONSE_FLAG = 1
export const V2_FLAG = 2

export const MINIMUM_PROTOCOL_VERSION = 0x14
export const CURRENT_PROTOCOL_VERSION = 0x15
export const MAXIMUM_PROTOCOL_VERSION = 0x15

export const KEEPALIVE_INTERVAL = 15 * 1000

export const MESSAGE_TYPE = {
  INVALID: 0x00,
  NAT: 0x01,
  KEEPALIVE: 0x02,
  PUBLISH: 0x03,
  CONFIRM_REQ: 0x04,
  CONFIRM_ACK: 0x05,
  BULK_PULL: 0x06,
  FRONTIER_REQ: 0x08,
  NODE_ID_HANDSHAKE: 0x0a,
  BULK_PULL_ACCOUNT: 0x0b,
  TELEMETRY_REQ: 0x0c,
  TELEMETRY_ACK: 0x0d,
  ASC_PULL_REQ: 0x0e,
  ASC_PULL_ACK: 0x0f,
  PROTOCOL_UPGRADE: 0x1f
}
export const MESSAGE_TYPE_NAME = {
  [MESSAGE_TYPE.INVALID]: 'invalid',
  [MESSAGE_TYPE.NAT]: 'not_a_type',
  [MESSAGE_TYPE.KEEPALIVE]: 'keepalive',
  [MESSAGE_TYPE.PUBLISH]: 'publish',
  [MESSAGE_TYPE.CONFIRM_REQ]: 'confirm_req',
  [MESSAGE_TYPE.CONFIRM_ACK]: 'confirm_ack',
  [MESSAGE_TYPE.BULK_PULL]: 'bulk_pull',
  [MESSAGE_TYPE.FRONTIER_REQ]: 'frontier_req',
  [MESSAGE_TYPE.NODE_ID_HANDSHAKE]: 'node_id_handshake',
  [MESSAGE_TYPE.BULK_PULL_ACCOUNT]: 'bulk_pull_account',
  [MESSAGE_TYPE.TELEMETRY_REQ]: 'telemetry_req',
  [MESSAGE_TYPE.TELEMETRY_ACK]: 'telemetry_ack',
  [MESSAGE_TYPE.ASC_PULL_REQ]: 'asc_pull_req',
  [MESSAGE_TYPE.ASC_PULL_ACK]: 'asc_pull_ack',
  [MESSAGE_TYPE.PROTOCOL_UPGRADE]: 'protocol_upgrade'
}

export const BLOCK_TYPE = {
  INVALID: 0x00,
  NOT_A_BLOCK: 0x01,
  SEND: 0x02,
  RECEIVE: 0x03,
  OPEN: 0x04,
  CHANGE: 0x05,
  STATE: 0x06
}

// Header extension bit 2 marks a confirm_ack relayed by a node other than
// the voting representative's own.
export const REBROADCAST_FLAG = 0x4

export const BLOCK_SIZES = {
  0x00: 0, // Invalid
  0x01: 0, // Not A Block (NaB)
  0x02: 152, // Send (Legacy)
  0x03: 136, // Receive (Legacy)
  0x04: 168, // Open (Legacy)
  0x05: 136, // Change (Legacy)
  0x06: 216 // State
}

export const NETWORK = {
  LIVE: {
    ID: 'C'.charCodeAt(0),
    PORT: 7075,
    GENESIS_BLOCK:
      '991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948',
    // Epoch blocks are signed by the epoch signer, not the account. Keyed by
    // the epoch link ("epoch v1 block", "epoch v2 block" zero-padded).
    EPOCH_SIGNER_BY_LINK: {
      '65706f636820763120626c6f636b000000000000000000000000000000000000':
        'e89208dd038fbb269987689621d52292ae9c35941a7484756ecced92a65093ba',
      '65706f636820763220626c6f636b000000000000000000000000000000000000':
        'dd24a9200d4bf8247981e4ac63dbde38fd2319386970a26d02ecc98c79975db1'
    }
  },
  BETA: {
    ID: 'B'.charCodeAt(0),
    PORT: 54000,
    GENESIS_BLOCK:
      'E1227CF974C1455A8B630433D94F3DDBF495EEAC9ADD2481A4A1D90A0D00F488'
  },
  TEST: {
    ID: 'X'.charCodeAt(0),
    PORT: 17075,
    GENESIS_BLOCK: '' // TODO
  }
}

export const DISCONNECT_REASON = {
  SOCKET_CLOSED: 'socket_closed',
  SOCKET_ERROR: 'socket_error',
  HANDSHAKE_TIMEOUT: 'handshake_timeout',
  IDLE_TIMEOUT: 'idle_timeout',
  PROTOCOL_ERROR: 'protocol_error',
  HANDSHAKE_INVALID: 'handshake_invalid',
  DUPLICATE_NODE_ID: 'duplicate_node_id',
  TELEMETRY_NODE_ID_MISMATCH: 'telemetry_node_id_mismatch'
}

export const DROP_REASON = {
  BEFORE_HANDSHAKE: 'before_handshake',
  MALFORMED: 'malformed',
  HANDLER_ERROR: 'handler_error',
  PUBLISH_LEGACY_IGNORED: 'publish_legacy_ignored'
}

export const DEFAULT_CONFIG = {
  maximum_peer_count: 200,
  handshake_timeout_ms: 10000,
  idle_timeout_ms: 120000,
  reconnect_delay_ms: 60000,
  vote_cache_maximum_entry_count: 65536
}

export const BLOCK_CACHE_MAXIMUM_ENTRY_COUNT = 16384
export const ADDRESS_TABLE_MAXIMUM_ENTRY_COUNT = 2048
export const PEER_REFILL_INTERVAL_MS = 15 * 1000
export const MAXIMUM_RECONNECT_DELAY_MS = 30 * 60 * 1000
export const BACKOFF_RESET_CONNECTED_MS = 5 * 60 * 1000
