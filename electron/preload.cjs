const { contextBridge, ipcRenderer } = require('electron')

console.log('PRELOAD SCRIPT LOADING - IPC version')

// Expose any needed APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  // HTTP request proxy (bypasses CORS)
  httpRequest: (options) => {
    return ipcRenderer.invoke('http-request', options)
  },
  // SSE stream proxy (bypasses CORS)
  sseConnect: (options) => {
    return ipcRenderer.invoke('sse-connect', options)
  },
  sseDisconnect: (streamId) => {
    return ipcRenderer.invoke('sse-disconnect', streamId)
  },
  onSSEData: (streamId, callback) => {
    const channel = `sse-data-${streamId}`
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onSSEError: (streamId, callback) => {
    const channel = `sse-error-${streamId}`
    const listener = (_event, error) => callback(error)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onSSEEnd: (streamId, callback) => {
    const channel = `sse-end-${streamId}`
    const listener = () => callback()
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  // Credential encryption via OS keychain
  encryptString: (plaintext) => ipcRenderer.invoke('safe-storage-encrypt', plaintext),
  decryptString: (encrypted) => ipcRenderer.invoke('safe-storage-decrypt', encrypted),
  // Open DevTools in detached window
  openDevTools: () => {
    return ipcRenderer.invoke('open-devtools')
  }
})
