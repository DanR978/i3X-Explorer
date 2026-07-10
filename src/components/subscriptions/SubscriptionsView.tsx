import { useSubscriptionsStore } from '../../stores/subscriptions'
import { useExplorerStore } from '../../stores/explorer'
import { useSubscriptionTransport } from './SubscriptionTransport'
import { TrendView } from './TrendView'
import { StatusFacets } from '../details/ElementStatus'
import type { ObjectInstance } from '../../api/types'

/**
 * The global subscriptions surface: every monitored item across the active
 * subscription, its live quality, and trends for the numeric ones. Not scoped to
 * the selected element — it just highlights it when there's a match.
 */
export function SubscriptionsView() {
  const subscriptions = useSubscriptionsStore(state => state.subscriptions)
  const liveValues = useSubscriptionsStore(state => state.liveValues)
  const activeSubscriptionId = useSubscriptionsStore(state => state.activeSubscriptionId)
  const setActiveSubscription = useSubscriptionsStore(state => state.setActiveSubscription)

  const selectedElementId = useExplorerStore(state =>
    state.selectedItem?.type === 'object'
      ? (state.selectedItem.data as ObjectInstance).elementId
      : null
  )

  const { usePolling, setUsePolling, streamUnsupported, startStream, stopStream, deleteSubscription } =
    useSubscriptionTransport()

  const subscriptionList = Array.from(subscriptions.values())

  if (subscriptionList.length === 0) {
    return (
      <p className="text-[13px] text-i3x-text-muted p-4">
        No active subscriptions. Select an object and click{' '}
        <b className="font-medium text-i3x-text">Subscribe</b> to start monitoring it.
      </p>
    )
  }

  const active = activeSubscriptionId ? subscriptions.get(activeSubscriptionId) : undefined
  const monitoredItems = active?.monitoredItems ?? []
  const isStreaming = active?.isStreaming ?? false
  const polling = usePolling || streamUnsupported
  const rate = polling ? '2 s' : 'stream'

  const numericIds = monitoredItems.filter(elementId => {
    const liveValue = liveValues.get(elementId)
    return (
      liveValue &&
      (typeof liveValue.value === 'number' || !isNaN(parseFloat(String(liveValue.value))))
    )
  })

  return (
    <div className="p-4 space-y-4">
      {subscriptionList.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {subscriptionList.map(sub => (
            <button
              key={sub.id}
              type="button"
              onClick={() => setActiveSubscription(sub.id)}
              aria-pressed={activeSubscriptionId === sub.id}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg border transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary ${
                activeSubscriptionId === sub.id
                  ? 'bg-i3x-primary/10 border-i3x-primary text-i3x-primary'
                  : 'bg-i3x-bg border-i3x-border text-i3x-text hover:border-i3x-primary'
              }`}
            >
              {sub.isStreaming && (
                <span
                  aria-hidden="true"
                  className="w-2 h-2 rounded-full bg-i3x-success animate-pulse motion-reduce:animate-none"
                />
              )}
              <span className="font-mono">#{sub.id}</span>
              <span className="text-i3x-text-muted">{sub.monitoredItems.length} items</span>
            </button>
          ))}
        </div>
      )}

      {active && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-i3x-text-muted">
              Monitored items <span className="font-mono normal-case">{monitoredItems.length}</span>
            </h3>

            <div className="flex items-center gap-3 ml-auto">
              <label
                className="flex items-center gap-1.5 text-xs text-i3x-text-muted"
                title={
                  streamUnsupported
                    ? 'This server does not support SSE streaming (capabilities.subscribe.stream = false)'
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={polling}
                  onChange={e => setUsePolling(e.target.checked)}
                  disabled={isStreaming || streamUnsupported}
                  className="w-3 h-3"
                />
                Poll
              </label>

              {!isStreaming ? (
                <button
                  type="button"
                  onClick={() => startStream(active.id)}
                  className="px-3 py-1 text-xs bg-i3x-success/20 text-i3x-success rounded-lg hover:bg-i3x-success/30 transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
                >
                  Start {polling ? 'Polling' : 'Stream'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => stopStream(active.id)}
                  className="px-3 py-1 text-xs bg-i3x-warning/20 text-i3x-warning rounded-lg hover:bg-i3x-warning/30 transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
                >
                  Stop
                </button>
              )}

              <button
                type="button"
                onClick={() => deleteSubscription(active.id)}
                className="px-3 py-1 text-xs bg-i3x-error/20 text-i3x-error rounded-lg hover:bg-i3x-error/30 transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
              >
                Delete
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px] min-w-[520px]">
              <thead>
                <tr>
                  {['Element', 'Rate', 'Quality', 'Last update', ''].map((heading, i) => (
                    <th
                      key={heading || i}
                      scope="col"
                      className={`text-left font-medium text-i3x-text-muted text-[11px] uppercase tracking-wide pb-2 px-3 border-b border-i3x-border ${
                        i === 0 ? 'w-2/5' : ''
                      }`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monitoredItems.map(elementId => {
                  const liveValue = liveValues.get(elementId)
                  const isCurrent = elementId === selectedElementId
                  return (
                    <tr
                      key={elementId}
                      className={`border-b border-i3x-border/60 ${isCurrent ? 'bg-i3x-primary/5' : ''}`}
                    >
                      <td className="px-3 py-2.5">
                        <span
                          className={`block truncate max-w-[16rem] ${
                            isCurrent ? 'text-i3x-primary font-medium' : 'text-i3x-text'
                          }`}
                          title={elementId}
                        >
                          {elementId}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-i3x-text-muted">
                        {isStreaming ? rate : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        {liveValue ? (
                          <StatusFacets code={liveValue.quality} variant="compact" />
                        ) : (
                          <span className="text-xs text-i3x-text-muted">Waiting…</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-i3x-text-muted whitespace-nowrap">
                        {liveValue?.timestamp
                          ? new Date(liveValue.timestamp).toLocaleTimeString()
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {/* TODO(follow-up): wire to client.unregisterMonitoredItems +
                            store.removeMonitoredItem. This PR adds no API call sites. */}
                        <button
                          type="button"
                          disabled
                          aria-label={`Unsubscribe from ${elementId}`}
                          title="Unsubscribe — wired in a follow-up"
                          className="text-i3x-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {numericIds.length > 0 && (
            <div className="flex flex-wrap gap-4">
              {numericIds.map(elementId => (
                <div key={`trend-${elementId}`} className="flex flex-col min-w-0">
                  <span
                    className="text-xs text-i3x-text-muted mb-1 truncate max-w-[25rem]"
                    title={elementId}
                  >
                    {elementId}
                  </span>
                  <TrendView elementId={elementId} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
