import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSubscriptionsStore } from '../../stores/subscriptions'
import { useConnectionStore } from '../../stores/connection'
import { getClient, type I3XClient } from '../../api/client'
import { SSESubscription, PollingSubscription, HttpStatusError, isSubscriptionGoneError } from '../../api/subscription'
import type { SyncResponseItem } from '../../api/types'

/**
 * Owns the SSE / polling transport for subscriptions.
 *
 * This lives above the routed views and stays mounted for the life of the app.
 * It used to sit inside the subscriptions panel, which meant collapsing that
 * panel tore down the live stream; now that the subscriptions UI is a tab,
 * unmounting on every tab switch would do the same. The transport logic itself
 * is unchanged — only its mount point moved.
 *
 * Store reads go through `getState()` rather than hook selectors so a live value
 * arriving every second doesn't re-render the whole application tree.
 */

interface SubscriptionTransport {
  /** True when the user chose polling, or the server can't stream. */
  usePolling: boolean
  setUsePolling: (value: boolean) => void
  /** Server declares `capabilities.subscribe.stream === false` (1.0 Release). */
  streamUnsupported: boolean
  startStream: (subscriptionId: string) => Promise<void>
  stopStream: (subscriptionId: string) => void
  deleteSubscription: (subscriptionId: string) => Promise<void>
}

const TransportContext = createContext<SubscriptionTransport | null>(null)

export function useSubscriptionTransport(): SubscriptionTransport {
  const context = useContext(TransportContext)
  if (!context) {
    throw new Error('useSubscriptionTransport must be used within <SubscriptionTransportProvider>')
  }
  return context
}

// 1.0 Release servers declare streaming support in /info capabilities;
// when it's false the stream endpoint returns 501 and polling is the only transport.
const isStreamUnsupported = (client: I3XClient): boolean =>
  client.getApiVersion() === 'v1' && client.getCapabilities()?.subscribe?.stream === false

export function SubscriptionTransportProvider({ children }: { children: ReactNode }) {
  const isConnected = useConnectionStore(state => state.isConnected)

  const sseRef = useRef<SSESubscription | null>(null)
  const pollingRef = useRef<PollingSubscription | null>(null)
  const recoveryAttemptsRef = useRef(0)
  const [usePolling, setUsePolling] = useState(false) // Default to SSE streaming

  // `startStream` reads this synchronously from a ref so a transport switch made
  // in the same tick (the 501 fallback) is honoured immediately.
  const usePollingRef = useRef(usePolling)
  usePollingRef.current = usePolling

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sseRef.current?.disconnect()
      pollingRef.current?.stop()
    }
  }, [])

  // Cleanup when disconnected from server
  useEffect(() => {
    if (!isConnected) {
      sseRef.current?.disconnect()
      sseRef.current = null
      pollingRef.current?.stop()
      pollingRef.current = null
      useSubscriptionsStore.getState().clearAll()
    }
  }, [isConnected])

  const handleDataUpdate = useCallback((items: SyncResponseItem[]) => {
    recoveryAttemptsRef.current = 0
    const { updateLiveValue } = useSubscriptionsStore.getState()
    items.forEach(item => {
      updateLiveValue({
        elementId: item.elementId,
        displayName: item.elementId,
        value: item.value,
        timestamp: item.timestamp,
        quality: item.quality,
        lastUpdated: Date.now()
      })
    })
  }, [])

  // Forward declaration: recovery restarts the stream, and the stream's error
  // handler triggers recovery. A ref breaks the cycle.
  const startStreamRef = useRef<(subscriptionId: string) => Promise<void>>()

  const handleRecovery = useCallback(async (oldSubscriptionId: string) => {
    const client = getClient()
    if (!client) return

    const store = useSubscriptionsStore.getState()

    if (recoveryAttemptsRef.current >= 3) {
      console.warn(`Subscription ${oldSubscriptionId} recovery aborted after 3 attempts`)
      store.setStreaming(oldSubscriptionId, false)
      return
    }
    recoveryAttemptsRef.current++
    console.warn(`Subscription ${oldSubscriptionId} expired on server, recovering (attempt ${recoveryAttemptsRef.current})...`)

    const oldSub = store.subscriptions.get(oldSubscriptionId)
    const monitoredItems = oldSub?.monitoredItems ?? []

    monitoredItems.forEach(elementId => {
      store.removeMonitoredItem(oldSubscriptionId, elementId)
    })
    store.removeSubscription(oldSubscriptionId)
    // Best-effort delete on the server — the subscription is likely already gone (404/410)
    // but this cleans up the clientId entry from the client-side map.
    try { await client.deleteSubscription(oldSubscriptionId) } catch { /* already gone */ }

    try {
      const { subscriptionId: newId } = await client.createSubscription()
      if (monitoredItems.length > 0) {
        await client.registerMonitoredItems(newId, monitoredItems)
      }
      useSubscriptionsStore.getState().addSubscription({
        id: newId,
        createdAt: new Date().toISOString(),
        monitoredItems,
        isStreaming: false
      })
      useSubscriptionsStore.getState().setActiveSubscription(newId)
      await startStreamRef.current?.(newId)
    } catch (err) {
      console.error('Subscription recovery failed:', err)
    }
  }, [])

  const startPolling = useCallback((subscriptionId: string, client: I3XClient) => {
    // Use polling (QoS2) - more reliable, works with CORS
    pollingRef.current = new PollingSubscription(
      () => client.sync(subscriptionId),
      handleDataUpdate,
      error => {
        if (isSubscriptionGoneError(error)) {
          handleRecovery(subscriptionId)
        } else {
          console.error('Polling error:', error)
          useSubscriptionsStore.getState().setStreaming(subscriptionId, false)
        }
      },
      2000 // Poll every 2 seconds
    )
    pollingRef.current.start()
  }, [handleDataUpdate, handleRecovery])

  const startStream = useCallback(async (subscriptionId: string) => {
    const client = getClient()
    if (!client) return

    // Disconnect existing connections
    sseRef.current?.disconnect()
    pollingRef.current?.stop()

    const isRelease = client.getApiVersion() === 'v1'

    if (usePollingRef.current || isStreamUnsupported(client)) {
      if (!usePollingRef.current) setUsePolling(true)
      startPolling(subscriptionId, client)
    } else {
      // Use SSE (QoS0) - real-time but may have CORS issues
      // v0: GET /subscriptions/{id}/stream  v1: POST /subscriptions/stream
      const streamConfig = client.getStreamConfig(subscriptionId)
      sseRef.current = new SSESubscription(
        streamConfig.url,
        handleDataUpdate,
        error => {
          if (isSubscriptionGoneError(error)) {
            handleRecovery(subscriptionId)
          } else if (isRelease && error instanceof HttpStatusError && error.status === 501) {
            // 1.0: 501 = streaming permanently unsupported — fall back to polling
            console.warn('Server does not support SSE streaming (HTTP 501), falling back to polling')
            setUsePolling(true)
            usePollingRef.current = true
            startPolling(subscriptionId, client)
          } else {
            console.error('SSE error:', error)
            useSubscriptionsStore.getState().setStreaming(subscriptionId, false)
          }
        },
        client.getCredentials(),
        streamConfig.postBody,
        // 1.0: 501 is permanent; don't burn reconnect attempts on it
        isRelease ? [501] : []
      )
      sseRef.current.connect()
    }

    useSubscriptionsStore.getState().setStreaming(subscriptionId, true)
  }, [handleDataUpdate, handleRecovery, startPolling])

  useEffect(() => {
    startStreamRef.current = startStream
  }, [startStream])

  const stopStream = useCallback((subscriptionId: string) => {
    sseRef.current?.disconnect()
    pollingRef.current?.stop()
    useSubscriptionsStore.getState().setStreaming(subscriptionId, false)
  }, [])

  const deleteSubscription = useCallback(async (subscriptionId: string) => {
    const client = getClient()
    if (!client) return

    // Stop transport first to close timer-fire race window
    sseRef.current?.disconnect()
    sseRef.current = null
    pollingRef.current?.stop()
    pollingRef.current = null

    try {
      useSubscriptionsStore.getState().removeSubscription(subscriptionId)
      await client.deleteSubscription(subscriptionId)
    } catch (err) {
      console.error('Failed to delete subscription:', err)
    }
  }, [])

  const connectedClient = getClient()
  const streamUnsupported = connectedClient ? isStreamUnsupported(connectedClient) : false

  const value = useMemo<SubscriptionTransport>(
    () => ({ usePolling, setUsePolling, streamUnsupported, startStream, stopStream, deleteSubscription }),
    [usePolling, streamUnsupported, startStream, stopStream, deleteSubscription]
  )

  return <TransportContext.Provider value={value}>{children}</TransportContext.Provider>
}
