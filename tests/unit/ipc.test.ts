import { describe, it, expect } from 'vitest'
import { CHANNELS } from '@shared/ipc'

describe('CHANNELS', () => {
  it('PING is the string "ping"', () => {
    expect(CHANNELS.PING).toBe('ping')
  })
})
