export const CHANNELS = {
  PING: 'ping',
} as const

export interface PingResult {
  electron: string
  node: string
}

export interface HearthBridge {
  ping: () => Promise<PingResult>
}
