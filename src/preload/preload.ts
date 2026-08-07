import { contextBridge, ipcRenderer } from 'electron'
import type { HearthBridge } from '../shared/ipc'

const bridge: HearthBridge = {
  ping: () => ipcRenderer.invoke('ping'),
}

contextBridge.exposeInMainWorld('hearth', bridge)
