import { useEffect } from 'react'
import { useConnectionStore } from './stores/connection'
import { useSubscriptionsStore } from './stores/subscriptions'
import { getClient } from './api/client'
import { Toolbar } from './components/layout/Toolbar'
import { Sidebar } from './components/layout/Sidebar'
import { MainPanel } from './components/layout/MainPanel'
import { StatusBar } from './components/layout/StatusBar'
import { SubscriptionTransportProvider } from './components/subscriptions/SubscriptionTransport'
import { SubscriptionsDrawer } from './components/subscriptions/SubscriptionsDrawer'
import { ConnectionDialog } from './components/connection/ConnectionDialog'
import { UpdateChecker } from './components/updater/UpdateChecker'

function App() {
  const { showConnectionDialog, ignoreCertErrors } = useConnectionStore()

  // Sync persisted ignoreCertErrors to main process on startup
  useEffect(() => {
    window.electronAPI?.setIgnoreCertErrors(ignoreCertErrors)
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onAppBeforeQuit) return
    return window.electronAPI.onAppBeforeQuit(async () => {
      try {
        const client = getClient()
        if (client) {
          const ids = Array.from(useSubscriptionsStore.getState().subscriptions.keys())
          await Promise.allSettled(ids.map((id) => client.deleteSubscription(id)))
        }
      } finally {
        window.electronAPI?.notifyCleanupDone()
      }
    })
  }, [])

  return (
    // The subscription transport lives above the views so switching tabs (or
    // navigating away from an element) never tears down a live stream.
    <SubscriptionTransportProvider>
      <div className="h-full flex flex-col bg-i3x-bg">
        <Toolbar />

        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Left sidebar - Tree browser */}
          <Sidebar />

          {/* Main content area, Home shell or tabbed element detail */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <MainPanel />
          </div>
        </div>

        {/* Subscriptions are global, not element-scoped, so they get a drawer
            spanning the window rather than a tab inside one element. */}
        <SubscriptionsDrawer />

        <StatusBar />

        {showConnectionDialog && <ConnectionDialog />}
        <UpdateChecker />
      </div>
    </SubscriptionTransportProvider>
  )
}

export default App
