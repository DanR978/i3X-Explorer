import type { SyncResponseItem } from './types'
import type { ClientCredentials } from './client'
import { buildAuthHeaders } from './auth'
import { extractVQT } from './normalize'

export type SubscriptionCallback = (items: SyncResponseItem[]) => void
export type ErrorCallback = (error: Error) => void

export class HttpStatusError extends Error {
  readonly status: number
  constructor(status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

// Detects server-side subscription expiry from either SSE (typed) or polling (string) error paths
export function isSubscriptionGoneError(error: Error): boolean {
  if (error instanceof HttpStatusError) return error.status === 404 || error.status === 410
  return error.message.startsWith('HTTP 404') || error.message.startsWith('HTTP 410')
}

export class SSESubscription {
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Set by disconnect(). A pending reconnect timer survives abort() (its callback
  // builds a fresh AbortController), so without this flag a deleted subscription's
  // timer would fire, 404, and trigger recovery, resurrecting the subscription.
  private disposed = false
  private url: string
  private credentials: ClientCredentials | null
  private postBody: object | undefined
  private failFastStatuses: number[]
  private onData: SubscriptionCallback
  private onError: ErrorCallback
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private connected = false

  constructor(
    url: string,
    onData: SubscriptionCallback,
    onError: ErrorCallback,
    credentials?: ClientCredentials | null,
    // If provided, the stream is opened with POST + JSON body (v1).
    // If omitted, uses GET (v0).
    postBody?: object,
    // Additional HTTP statuses that bypass the reconnect loop and surface
    // immediately via onError (404/410 always do). e.g. [501] for 1.0 Release
    // servers, where 501 means streaming is permanently unsupported.
    failFastStatuses: number[] = []
  ) {
    // Fix localhost IPv6 issue - Chromium may prefer IPv6 but servers often only listen on IPv4
    this.url = url.includes('://localhost:')
      ? url.replace('://localhost:', '://127.0.0.1:')
      : url
    this.onData = onData
    this.onError = onError
    this.credentials = credentials ?? null
    this.postBody = postBody
    this.failFastStatuses = failFastStatuses
  }

  connect(): void {
    this.disconnect()
    this.disposed = false
    const controller = new AbortController()
    this.abortController = controller
    void this.startFetch(controller)
  }

  // Takes its controller explicitly and re-checks identity against the instance
  // field: a loop superseded by a newer connect() can never flip state or
  // schedule a reconnect, even before its aborted fetch settles.
  private async startFetch(controller: AbortController): Promise<void> {
    if (this.disposed || controller !== this.abortController) return
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream'
    }

    if (this.postBody) {
      headers['Content-Type'] = 'application/json'
    }

    Object.assign(headers, buildAuthHeaders(this.credentials))

    try {
      const response = await fetch(this.url, {
        method: this.postBody ? 'POST' : 'GET',
        headers,
        body: this.postBody ? JSON.stringify(this.postBody) : undefined,
        signal: controller.signal
      })

      if (!response.ok) {
        const err = new HttpStatusError(response.status, response.statusText)
        // 404/410 means the subscription is gone, retrying will always fail.
        // failFastStatuses (e.g. 501 = streaming unsupported) are equally permanent.
        if (response.status === 404 || response.status === 410 || this.failFastStatuses.includes(response.status)) {
          this.onError(err)
          return
        }
        throw err
      }

      if (!response.body) {
        throw new Error('No response body')
      }

      console.log('SSE connection opened')
      this.connected = true
      this.reconnectAttempts = 0

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            if (dataStr.trim()) {
              this.processMessage(dataStr)
            }
          }
        }
      }

      // Stream ended normally
      this.connected = false
      this.handleDisconnect(controller)
    } catch (err) {
      this.connected = false
      if (err instanceof Error && err.name === 'AbortError') {
        // Intentional disconnect, don't reconnect
        return
      }
      console.error('SSE error:', err)
      this.handleDisconnect(controller)
    }
  }

  private processMessage(dataStr: string): void {
    try {
      const rawData = JSON.parse(dataStr) as Array<Record<string, unknown>>
      const items: SyncResponseItem[] = []
      for (const entry of rawData) {
        if (Array.isArray(entry.updates)) {
          // v1 release batch format: {sequenceNumber, updates: [{elementId, value, quality, timestamp}]}
          for (const update of entry.updates as Array<Record<string, unknown>>) {
            if (typeof update.elementId === 'string') {
              items.push({
                elementId: update.elementId,
                value: update.value,
                quality: (update.quality as string | null) ?? null,
                timestamp: (update.timestamp as string | null) ?? null
              })
            }
          }
        } else if (typeof entry.elementId === 'string') {
          // v1-beta flat format: {elementId, value, quality, timestamp}
          items.push({
            elementId: entry.elementId,
            value: entry.value,
            quality: (entry.quality as string | null) ?? null,
            timestamp: (entry.timestamp as string | null) ?? null
          })
        } else {
          // v0 keyed format: {elementId: {data: [{value, quality, timestamp}]}}
          for (const [elementId, payload] of Object.entries(entry)) {
            const p = payload as Record<string, unknown>
            if (p?.data && Array.isArray(p.data) && p.data[0]) {
              const vqt = extractVQT(p.data[0] as Record<string, unknown>)
              items.push({
                elementId,
                value: vqt.value,
                quality: vqt.quality ?? null,
                timestamp: vqt.timestamp ?? null
              })
            }
          }
        }
      }
      if (items.length > 0) {
        this.onData(items)
      }
    } catch (err) {
      console.error('Failed to parse SSE data:', err)
    }
  }

  private handleDisconnect(controller: AbortController): void {
    if (this.disposed || controller !== this.abortController) return
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (this.disposed) return
        const next = new AbortController()
        this.abortController = next
        void this.startFetch(next)
      }, delay)
    } else {
      this.onError(new Error('Max reconnection attempts reached'))
    }
  }

  disconnect(): void {
    this.disposed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.connected = false
    this.reconnectAttempts = 0
  }

  isConnected(): boolean {
    return this.connected
  }
}

// Polling-based subscription (QoS 2 fallback)
export class PollingSubscription {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private syncFn: () => Promise<SyncResponseItem[]>
  private onData: SubscriptionCallback
  private onError: ErrorCallback
  private pollInterval: number

  constructor(
    syncFn: () => Promise<SyncResponseItem[]>,
    onData: SubscriptionCallback,
    onError: ErrorCallback,
    pollInterval = 1000
  ) {
    this.syncFn = syncFn
    this.onData = onData
    this.onError = onError
    this.pollInterval = pollInterval
  }

  start(): void {
    this.stop()
    this.running = true
    void this.loop()
  }

  // Self-rescheduling chain, not setInterval: the next poll is armed only after
  // the previous sync settles, so a sync slower than the interval can never
  // stack concurrent requests against the server.
  private async loop(): Promise<void> {
    if (!this.running) return
    try {
      const items = await this.syncFn()
      if (this.running && items.length > 0) {
        this.onData(items)
      }
    } catch (err) {
      if (this.running) {
        this.onError(err instanceof Error ? err : new Error(String(err)))
      }
    }
    if (!this.running) return
    this.timer = setTimeout(() => void this.loop(), this.pollInterval)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  isRunning(): boolean {
    return this.running
  }
}
