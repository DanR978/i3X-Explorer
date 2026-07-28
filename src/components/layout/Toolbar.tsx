import { useState, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConnectionStore } from '../../stores/connection'
import { useExplorerStore } from '../../stores/explorer'
import { performConnect, performDisconnect } from '../../services/connection'
import { SearchModal } from '../search/SearchModal'
import { SearchIcon, CheckIcon, RedirectIcon, BlockedIcon } from '../common/icons'
import { Spinner } from '../common/Spinner'
import iconPng from '/icon.png'

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  const saved = localStorage.getItem('i3x-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const POLL_OPTIONS = [
  { label: 'Refresh every 15 seconds', ms: 15_000 },
  { label: 'Refresh every 30 seconds', ms: 30_000 },
  { label: 'Refresh every 60 seconds', ms: 60_000 },
  { label: 'No automatic refresh', ms: 0 },
]

export function Toolbar() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [showSettingsMenu, setShowSettingsMenu] = useState(false)
  const [showSearch, setShowSearch] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('i3x-theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')
  // Shallow picks, not bare store hooks: a bare hook re-renders the toolbar on
  // every store write. Actions are stable refs, so including them is free.
  const {
    serverUrl,
    isConnected,
    isConnecting,
    error,
    setShowConnectionDialog,
    redirectNotice,
    setRedirectNotice,
    v0Blocked,
    setV0Blocked
  } = useConnectionStore(useShallow(s => ({
    serverUrl: s.serverUrl,
    isConnected: s.isConnected,
    isConnecting: s.isConnecting,
    error: s.error,
    setShowConnectionDialog: s.setShowConnectionDialog,
    redirectNotice: s.redirectNotice,
    setRedirectNotice: s.setRedirectNotice,
    v0Blocked: s.v0Blocked,
    setV0Blocked: s.setV0Blocked
  })))

  const { pollIntervalMs, setPollIntervalMs, triggerManualRefresh, sidebarCollapsed, toggleSidebar, goBack, goForward, selectItem } = useExplorerStore(useShallow(s => ({
    pollIntervalMs: s.pollIntervalMs,
    setPollIntervalMs: s.setPollIntervalMs,
    triggerManualRefresh: s.triggerManualRefresh,
    sidebarCollapsed: s.sidebarCollapsed,
    toggleSidebar: s.toggleSidebar,
    goBack: s.goBack,
    goForward: s.goForward,
    selectItem: s.selectItem
  })))
  // Clearing the selection is what "Home" means, the main panel renders its
  // Home shell whenever nothing is selected.
  const showHome = () => selectItem(null)
  const canGoBack = useExplorerStore(s => s.historyIndex > 0)
  const canGoForward = useExplorerStore(s => s.historyIndex < s.history.length - 1)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (isConnected) setShowSearch(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isConnected])

  // X1/X2, the side buttons on most mice. Electron only, in the web build they
  // drive the browser's own history and taking them over would strand the SPA.
  useEffect(() => {
    if (!window.electronAPI) return
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault()
        goBack()
      } else if (e.button === 4) {
        e.preventDefault()
        goForward()
      }
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [goBack, goForward])

  // The flows live in services/connection.ts so the connection dialog can
  // re-run them on Save-while-connected.
  const handleConnect = () => performConnect()
  const handleDisconnect = () => performDisconnect()

  return (
    <div className="h-12 bg-i3x-surface border-b border-i3x-border flex items-center px-3 gap-2 sm:gap-3 drag-region flex-shrink-0">
      {/* macOS traffic light spacing */}
      {window.electronAPI?.platform === 'darwin' && <div className="w-16" />}

      <button
        onClick={showHome}
        title="Model overview"
        className="no-drag flex items-center gap-2 rounded px-1 py-1 hover:bg-i3x-bg transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
      >
        <img src={iconPng} alt="" className="w-5 h-5" />
        <h1 className="hidden md:block text-sm font-semibold text-i3x-text whitespace-nowrap">i3X Explorer</h1>
      </button>

      <button
        onClick={toggleSidebar}
        title={sidebarCollapsed ? 'Show tree panel' : 'Hide tree panel'}
        aria-label={sidebarCollapsed ? 'Show tree panel' : 'Hide tree panel'}
        className="no-drag p-1.5 rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          {/* Fill the side rail when expanded so the icon reads as "panel shown" */}
          {!sidebarCollapsed && <rect x="3" y="3" width="6" height="18" fill="currentColor" stroke="none" />}
        </svg>
      </button>

      <button
        onClick={showHome}
        title="Home"
        aria-label="Home"
        className="no-drag p-1.5 rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg transition-colors motion-reduce:transition-none"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
        </svg>
      </button>

      <button
        onClick={goBack}
        disabled={!canGoBack}
        title="Back"
        aria-label="Back"
        className="no-drag p-1.5 rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-i3x-text-muted"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
      </button>

      <button
        onClick={goForward}
        disabled={!canGoForward}
        title="Forward"
        aria-label="Forward"
        className="no-drag p-1.5 rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-i3x-text-muted"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>

      <div className="flex-1 flex items-center gap-2 min-w-0">
        <button
          onClick={() => setShowConnectionDialog(true)}
          title={serverUrl || 'Click to configure'}
          className="px-3 py-1.5 text-xs font-mono bg-i3x-bg rounded border border-i3x-border hover:border-i3x-primary transition-colors motion-reduce:transition-none truncate min-w-0 max-w-[10rem] sm:max-w-sm lg:max-w-2xl"
        >
          {serverUrl || 'Click to configure'}
        </button>

        {!isConnected ? (
          <button
            onClick={handleConnect}
            disabled={isConnecting || !serverUrl}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-i3x-primary text-white rounded hover:bg-i3x-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isConnecting ? <><Spinner size={11} /> Connecting…</> : 'Connect'}
          </button>
        ) : (
          <button
            onClick={handleDisconnect}
            className="px-3 py-1.5 text-xs bg-i3x-error/20 text-i3x-error rounded hover:bg-i3x-error/30 transition-colors"
          >
            Disconnect
          </button>
        )}
        <button
          onClick={() => setShowSearch(true)}
          disabled={!isConnected}
          title="Search objects (⌘K)"
          aria-label="Search objects"
          className="px-3 py-1.5 text-xs bg-i3x-bg rounded border border-i3x-border hover:border-i3x-primary transition-colors motion-reduce:transition-none disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0"
        >
          <SearchIcon size={13} className="text-i3x-text-muted" />
          <span className="hidden sm:inline">Search</span>
        </button>
      </div>

      {/* Settings gear + theme toggle. Connection status, counts and the
          Developer button now live in the bottom status bar. */}
      <div className="flex items-center no-drag flex-shrink-0">
        <div className="relative">
          <button
            onClick={() => setShowSettingsMenu(m => !m)}
            title="Settings"
            aria-label="Settings"
            className="w-7 h-7 flex items-center justify-center rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg transition-colors motion-reduce:transition-none"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {showSettingsMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowSettingsMenu(false)} />
              <div className="absolute right-0 top-9 z-50 bg-i3x-surface border border-i3x-border rounded-lg shadow-xl w-56 py-1">
                {POLL_OPTIONS.map(opt => (
                  <button
                    key={opt.ms}
                    onClick={() => { setPollIntervalMs(opt.ms); setShowSettingsMenu(false) }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-i3x-bg transition-colors flex items-center justify-between ${
                      pollIntervalMs === opt.ms ? 'text-i3x-primary' : 'text-i3x-text'
                    }`}
                  >
                    {opt.label}
                    {pollIntervalMs === opt.ms && <CheckIcon size={13} />}
                  </button>
                ))}
                <div className="border-t border-i3x-border my-1" />
                <button
                  onClick={() => { triggerManualRefresh(); setShowSettingsMenu(false) }}
                  disabled={!isConnected}
                  className="w-full text-left px-3 py-2 text-xs text-i3x-text hover:bg-i3x-bg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Refresh now
                </button>
              </div>
            </>
          )}
        </div>
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="w-7 h-7 flex items-center justify-center rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg transition-colors motion-reduce:transition-none"
        >
          {/* The icon names the theme you'd switch *to*, matching the tooltip. */}
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      </div>

      {/* Never hide this: a failed connect has no other visible feedback in the
          toolbar now that the status readouts live in the bottom bar. */}
      {error && (
        <span className="text-xs text-i3x-error truncate max-w-[8rem] lg:max-w-xs flex-shrink-0" title={error}>
          {error}
        </span>
      )}

      {redirectNotice && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-i3x-surface rounded-lg shadow-xl w-full max-w-md border border-i3x-border">
            <div className="px-4 py-3 border-b border-i3x-border flex items-center gap-2">
              <RedirectIcon size={17} className="text-i3x-warning" />
              <h2 className="text-sm font-semibold text-i3x-text">Server Redirected</h2>
            </div>
            <div className="p-4 space-y-3 text-sm text-i3x-text">
              <p>
                The server at <span className="font-mono break-all">{redirectNotice.from}</span> redirected
                this connection to <span className="font-mono break-all">{redirectNotice.to}</span>.
              </p>
              <p>
                The server URL has been updated to the new address, and any saved
                credentials were carried over. Future connections will use it directly.
              </p>
            </div>
            <div className="px-4 py-3 border-t border-i3x-border flex justify-end">
              <button
                onClick={() => setRedirectNotice(null)}
                className="px-4 py-1.5 text-sm bg-i3x-primary text-white rounded transition-colors hover:bg-i3x-primary/80"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {showSearch && <SearchModal onClose={() => setShowSearch(false)} />}

      {v0Blocked && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-i3x-surface rounded-lg shadow-xl w-full max-w-md border border-i3x-border">
            <div className="px-4 py-3 border-b border-i3x-border flex items-center gap-2">
              <BlockedIcon size={17} className="text-i3x-error" />
              <h2 className="text-sm font-semibold text-i3x-text">Unsupported API Version</h2>
            </div>
            <div className="p-4 space-y-3 text-sm text-i3x-text">
              <p>This server implements the <span className="font-mono font-semibold text-i3x-error">v0</span> Alpha API, which is no longer supported.</p>
              <p>i3X Explorer requires <strong>v1</strong> or later. Please upgrade your server to the v1 spec before connecting.</p>
              <p>
                Find migration details at{' '}
                <a
                  href="https://www.i3x.dev"
                  target="_blank"
                  rel="noreferrer"
                  className="text-i3x-primary underline hover:text-i3x-primary/80"
                >
                  www.i3x.dev
                </a>
              </p>
            </div>
            <div className="px-4 py-3 border-t border-i3x-border flex justify-end">
              <button
                onClick={() => setV0Blocked(false)}
                className="px-4 py-1.5 text-sm bg-i3x-primary text-white rounded transition-colors hover:bg-i3x-primary/80"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
