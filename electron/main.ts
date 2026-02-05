import { app, BrowserWindow, shell, ipcMain } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Set the app name for macOS menu bar (overrides package.json "name")
app.setName('i3X Explorer')

// IPC handler for HTTP requests (bypasses CORS)
ipcMain.handle('http-request', async (_event, options: {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}) => {
  // Fix localhost IPv6 issue - Node prefers IPv6 but servers often only listen on IPv4
  let url = options.url
  if (url.includes('://localhost:')) {
    url = url.replace('://localhost:', '://127.0.0.1:')
  }

  console.log('[IPC] http-request:', options.method, url)
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body
    })

    const text = await response.text()
    console.log('[IPC] response:', response.status, response.statusText)
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text
    }
  } catch (error) {
    console.error('[IPC] fetch error:', error)
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : 'Unknown error',
      text: ''
    }
  }
})

// IPC handler for SSE streams (bypasses CORS)
ipcMain.handle('sse-connect', async (event, options: {
  url: string
  headers?: Record<string, string>
}) => {
  const webContents = event.sender
  const streamId = Date.now().toString()

  // Fix localhost IPv6 issue
  let url = options.url
  if (url.includes('://localhost:')) {
    url = url.replace('://localhost:', '://127.0.0.1:')
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: options.headers
    })

    if (!response.ok) {
      webContents.send(`sse-error-${streamId}`, `HTTP ${response.status}: ${response.statusText}`)
      return { streamId, ok: false }
    }

    if (!response.body) {
      webContents.send(`sse-error-${streamId}`, 'No response body')
      return { streamId, ok: false }
    }

    // Process the stream in the background
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const processStream = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            webContents.send(`sse-end-${streamId}`)
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6)
              if (dataStr.trim()) {
                webContents.send(`sse-data-${streamId}`, dataStr)
              }
            }
          }
        }
      } catch (error) {
        webContents.send(`sse-error-${streamId}`, error instanceof Error ? error.message : 'Stream error')
      }
    }

    processStream()
    return { streamId, ok: true }
  } catch (error) {
    return { streamId, ok: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Store active SSE abort controllers
const sseAbortControllers = new Map<string, AbortController>()

ipcMain.handle('sse-disconnect', async (_event, streamId: string) => {
  const controller = sseAbortControllers.get(streamId)
  if (controller) {
    controller.abort()
    sseAbortControllers.delete(streamId)
  }
})

// IPC handler to open DevTools
ipcMain.handle('open-devtools', (event) => {
  const webContents = event.sender
  webContents.openDevTools({ mode: 'detach' })
})

let mainWindow: BrowserWindow | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function createWindow() {
  // In dev mode, load preload directly from source (CJS format)
  // In production, load from dist-electron
  const preloadPath = VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron/preload.cjs')
    : path.join(__dirname, 'preload.cjs')

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#1e1e1e',
    show: false
  })

  // Show window when ready to avoid flash
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
