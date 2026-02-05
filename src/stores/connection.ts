import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface Credentials {
  username: string
  password: string
}

interface ConnectionState {
  serverUrl: string
  credentials: Credentials | null
  savedCredentials: Record<string, Credentials>
  isConnected: boolean
  isConnecting: boolean
  error: string | null
  showConnectionDialog: boolean
  recentUrls: string[]

  setServerUrl: (url: string) => void
  setCredentials: (credentials: Credentials | null) => void
  saveCredentialsForUrl: (url: string, credentials: Credentials | null) => void
  getCredentialsForUrl: (url: string) => Credentials | null
  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
  setError: (error: string | null) => void
  setShowConnectionDialog: (show: boolean) => void
  addRecentUrl: (url: string) => void
  disconnect: () => void
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set, get) => ({
      serverUrl: 'https://proveit-i3x.cesmii.net',
      credentials: null,
      savedCredentials: {},
      isConnected: false,
      isConnecting: false,
      error: null,
      showConnectionDialog: false,
      recentUrls: ['https://proveit-i3x.cesmii.net', 'http://localhost:8080'],

      setServerUrl: (url) => set({ serverUrl: url }),
      setCredentials: (credentials) => set({ credentials }),

      saveCredentialsForUrl: (url, credentials) => {
        const { savedCredentials } = get()
        if (credentials) {
          set({ savedCredentials: { ...savedCredentials, [url]: credentials } })
        } else {
          const { [url]: _, ...rest } = savedCredentials
          set({ savedCredentials: rest })
        }
      },

      getCredentialsForUrl: (url) => {
        const { savedCredentials } = get()
        return savedCredentials[url] || null
      },

      setConnected: (connected) => set({ isConnected: connected, isConnecting: false }),
      setConnecting: (connecting) => set({ isConnecting: connecting, error: null }),
      setError: (error) => set({ error, isConnecting: false }),
      setShowConnectionDialog: (show) => set({ showConnectionDialog: show }),

      addRecentUrl: (url) => {
        const { recentUrls } = get()
        if (!recentUrls.includes(url)) {
          set({ recentUrls: [url, ...recentUrls].slice(0, 10) })
        }
      },

      disconnect: () => set({
        isConnected: false,
        isConnecting: false,
        error: null,
        credentials: null
      })
    }),
    {
      name: 'i3x-connection',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        recentUrls: state.recentUrls,
        savedCredentials: state.savedCredentials
      })
    }
  )
)
