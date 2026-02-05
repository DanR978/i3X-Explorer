import { useState } from 'react'
import { useConnectionStore } from '../../stores/connection'
import type { Credentials } from '../../stores/connection'

type AuthMethod = 'none' | 'basic' | 'bearer'

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

  function getInitialAuthMethod(): AuthMethod {
    if (!savedCreds) return 'none'
    return savedCreds.type === 'bearer' ? 'bearer' : 'basic'
  }

  const [inputUrl, setInputUrl] = useState(serverUrl)
  const [authMethod, setAuthMethod] = useState<AuthMethod>(getInitialAuthMethod())
  const [username, setUsername] = useState(savedCreds?.type === 'basic' ? savedCreds.username : '')
  const [password, setPassword] = useState(savedCreds?.type === 'basic' ? savedCreds.password : '')
  const [token, setToken] = useState(savedCreds?.type === 'bearer' ? savedCreds.token : '')

  const handleSave = () => {
    setServerUrl(inputUrl)
    let newCredentials: Credentials | null = null
    if (authMethod === 'basic' && username) {
      newCredentials = { type: 'basic', username, password }
    } else if (authMethod === 'bearer' && token) {
      newCredentials = { type: 'bearer', token }
    }
    setCredentials(newCredentials)
    saveCredentialsForUrl(inputUrl, newCredentials)
    setShowConnectionDialog(false)
  }

  const handleCancel = () => {
    setShowConnectionDialog(false)
  }

  const handleSelectRecent = (url: string) => {
    setInputUrl(url)
    const creds = getCredentialsForUrl(url)
    if (creds) {
      if (creds.type === 'bearer') {
        setAuthMethod('bearer')
        setToken(creds.token)
        setUsername('')
        setPassword('')
      } else {
        setAuthMethod('basic')
        setUsername(creds.username)
        setPassword(creds.password)
        setToken('')
      }
    } else {
      setAuthMethod('none')
      setUsername('')
      setPassword('')
      setToken('')
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

          {/* Authentication method */}
          <div>
            <label className="block text-xs text-i3x-text-muted mb-1">
              Authentication
            </label>
            <select
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
              className="w-full px-3 py-2 text-sm bg-i3x-bg rounded border border-i3x-border focus:border-i3x-primary focus:outline-none"
            >
              <option value="none">None</option>
              <option value="basic">Basic Auth</option>
              <option value="bearer">Bearer Token</option>
            </select>
          </div>

          {/* Basic auth fields */}
          {authMethod === 'basic' && (
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

          {/* Bearer token field */}
          {authMethod === 'bearer' && (
            <div className="pl-6">
              <label className="block text-xs text-i3x-text-muted mb-1">
                Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="paste your bearer token"
                className="w-full px-3 py-2 text-sm bg-i3x-bg rounded border border-i3x-border focus:border-i3x-primary focus:outline-none"
              />
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
