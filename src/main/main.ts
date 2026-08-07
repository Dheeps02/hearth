import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'

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

  const appOrigin = process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).origin
    : 'file://'

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

ipcMain.handle('ping', () => ({
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
