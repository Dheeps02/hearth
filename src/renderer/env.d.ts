import type { HearthBridge } from '@shared/ipc'

declare global {
  interface Window {
    hearth: HearthBridge
  }
}

export {}
