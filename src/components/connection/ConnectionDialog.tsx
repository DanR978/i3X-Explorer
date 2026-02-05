import { useState } from 'react'
import { useConnectionStore } from '../../stores/connection'

export function ConnectionDialog() {
  const {
    serverUrl,
    recentUrls,
    setServerUrl,
    setCredentials,
    saveCredentialsForUrl,
    getCredentialsForUrl,
    setShowConnectionDialog
  } = useConnectionStore()

  // Initialize with saved credentials for current server
  const savedCreds = getCredentialsForUrl(serverUrl)
  const [inputUrl, setInputUrl] = useState(serverUrl)
  const [useAuth, setUseAuth] = useState(!!savedCreds)
  const [username, setUsername] = useState(savedCreds?.username ?? '')
  const [password, setPassword] = useState(savedCreds?.password ?? '')

  const handleSave = () => {
    setServerUrl(inputUrl)
    const newCredentials = useAuth && username ? { username, password } : null
    setCredentials(newCredentials)
    // Save credentials for this URL
    saveCredentialsForUrl(inputUrl, newCredentials)
    setShowConnectionDialog(false)
  }

  const handleCancel = () => {
    setShowConnectionDialog(false)
  }

  const handleSelectRecent = (url: string) => {
    setInputUrl(url)
    // Load saved credentials for selected URL
    const creds = getCredentialsForUrl(url)
    if (creds) {
      setUseAuth(true)
      setUsername(creds.username)
      setPassword(creds.password)
    } else {
      setUseAuth(false)
      setUsername('')
      setPassword('')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-i3x-surface rounded-lg shadow-xl w-full max-w-md border border-i3x-border">
        {/* Header */}
        <div className="px-4 py-3 border-b border-i3x-border">
          <h2 className="text-sm font-semibold text-i3x-text">Server Connection</h2>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-i3x-text-muted mb-1">
              Server URL
            </label>
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="https://i3x.example.com"
              className="w-full px-3 py-2 text-sm bg-i3x-bg rounded border border-i3x-border focus:border-i3x-primary focus:outline-none"
              autoFocus
            />
          </div>

          {/* Authentication toggle */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useAuth}
                onChange={(e) => setUseAuth(e.target.checked)}
                className="w-4 h-4 rounded border-i3x-border bg-i3x-bg text-i3x-primary focus:ring-i3x-primary focus:ring-offset-0"
              />
              <span className="text-xs text-i3x-text-muted">Use authentication</span>
            </label>
          </div>

          {/* Credentials fields */}
          {useAuth && (
            <div className="space-y-3 pl-6">
              <div>
                <label className="block text-xs text-i3x-text-muted mb-1">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  className="w-full px-3 py-2 text-sm bg-i3x-bg rounded border border-i3x-border focus:border-i3x-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-i3x-text-muted mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                  className="w-full px-3 py-2 text-sm bg-i3x-bg rounded border border-i3x-border focus:border-i3x-primary focus:outline-none"
                />
              </div>
            </div>
          )}

          {recentUrls.length > 0 && (
            <div>
              <label className="block text-xs text-i3x-text-muted mb-2">
                Recent Connections
              </label>
              <div className="space-y-1 max-h-32 overflow-auto">
                {recentUrls.map((url) => {
                  const hasSavedCreds = !!getCredentialsForUrl(url)
                  return (
                    <button
                      key={url}
                      onClick={() => handleSelectRecent(url)}
                      className={`w-full text-left px-3 py-1.5 text-sm rounded hover:bg-i3x-bg transition-colors flex items-center justify-between ${
                        url === inputUrl ? 'bg-i3x-primary/20 text-i3x-primary' : 'text-i3x-text'
                      }`}
                    >
                      <span className="truncate">{url}</span>
                      {hasSavedCreds && (
                        <span className="text-xs text-i3x-text-muted ml-2 shrink-0" title="Has saved credentials">
                          [auth]
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-i3x-border flex justify-end gap-2">
          <button
            onClick={handleCancel}
            className="px-4 py-1.5 text-sm text-i3x-text-muted hover:text-i3x-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!inputUrl}
            className="px-4 py-1.5 text-sm bg-i3x-primary text-white rounded hover:bg-i3x-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
