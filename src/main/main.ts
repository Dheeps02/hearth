import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { CHANNELS } from '@shared/ipc'

const windowVaultMap = new Map<number, string | undefined>()

function createWindow(vaultPath?: string): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  windowVaultMap.set(win.id, vaultPath)
  win.on('closed', () => windowVaultMap.delete(win.id))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Dev: allow anything on the Vite dev server origin.
  // Prod: allow only the exact index.html URL. Using 'file://' as the prefix
  // (the previous approach) allowed navigation to any file on disk.
  // TODO: replace loadFile with a custom protocol (protocol.handle('app://'))
  // so the renderer has a real origin and 'self' in the CSP behaves predictably.
  const appUrl = process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).origin
    : pathToFileURL(join(__dirname, '../dist/index.html')).href

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.VITE_DEV_SERVER_URL
      ? url.startsWith(appUrl)
      : url === appUrl
    if (!allowed) event.preventDefault()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

ipcMain.handle(CHANNELS.PING, () => ({
  electron: process.versions.electron,
  node: process.versions.node,
}))

app.whenReady().then(() => createWindow())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
