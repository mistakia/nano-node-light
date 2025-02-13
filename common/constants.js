export const QUORUM_THRESHOLD = 60000000000000000000000000000000000000n

export const MAGIC_NUMBER = 'R'.charCodeAt(0)

export const SELF_ADDRESS = Buffer.alloc(16, 0)

export const QUERY_FLAG = 0
export const RESPONSE_FLAG = 1
export const V2_FLAG = 2

export const MINIMUM_PROTOCOL_VERSION = 0x14
export const CURRENT_PROTOCOL_VERSION = 0x15
export const MAXIMUM_PROTOCOL_VERSION = 0x15

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
  [MESSAGE_TYPE.INVALID]: 'Invalid',
  [MESSAGE_TYPE.NAT]: 'NaT',
  [MESSAGE_TYPE.KEEPALIVE]: 'KeepAlive',
  [MESSAGE_TYPE.PUBLISH]: 'Publish',
  [MESSAGE_TYPE.CONFIRM_REQ]: 'ConfirmReq',
  [MESSAGE_TYPE.CONFIRM_ACK]: 'ConfirmAck',
  [MESSAGE_TYPE.BULK_PULL]: 'BulkPull',
  [MESSAGE_TYPE.FRONTIER_REQ]: 'FrontierReq',
  [MESSAGE_TYPE.NODE_ID_HANDSHAKE]: 'NodeIDHandshake',
  [MESSAGE_TYPE.BULK_PULL_ACCOUNT]: 'BulkPullAccount',
  [MESSAGE_TYPE.TELEMETRY_REQ]: 'TelemetryReq',
  [MESSAGE_TYPE.TELEMETRY_ACK]: 'TelemetryAck',
  [MESSAGE_TYPE.ASC_PULL_REQ]: 'AscPullReq',
  [MESSAGE_TYPE.ASC_PULL_ACK]: 'AscPullAck',
  [MESSAGE_TYPE.PROTOCOL_UPGRADE]: 'ProtocolUpgrade'
}

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
    ADDRESS: 'peering.nano.org',
    PORT: 7075,
    TELEMETRY_CACHE_CUTOFF: 6e10, // 60 seconds,
    GENESIS_BLOCK:
      '991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948'
  },
  BETA: {
    ID: 'B'.charCodeAt(0),
    ADDRESS: 'peering-beta.nano.org',
    PORT: 54000,
    TELEMETRY_CACHE_CUTOFF: 15e9, // 15 seconds,
    GENESIS_BLOCK:
      'E1227CF974C1455A8B630433D94F3DDBF495EEAC9ADD2481A4A1D90A0D00F488'
  },
  TEST: {
    ID: 'X'.charCodeAt(0),
    ADDRESS: 'peering-test.nano.org',
    PORT: 17075,
    TELEMETRY_CACHE_CUTOFF: 6e10, // 60 seconds,
    GENESIS_BLOCK: '' // TODO
  }
}
