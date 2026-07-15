import { useState, useEffect, useRef, useCallback } from 'react'
import type { ObjectInstance, LastKnownValue } from '../../api/types'
import { getClient } from '../../api/client'
import { useExplorerStore } from '../../stores/explorer'
import { useSubscriptionsStore } from '../../stores/subscriptions'
import { Breadcrumb } from './Breadcrumb'
import { OverviewTab } from './tabs/OverviewTab'
import { RelationshipsTab } from './tabs/RelationshipsTab'
import { HistoryTab } from './tabs/HistoryTab'

// Subscriptions are deliberately absent: they're global state, not a property of
// whichever element happens to be selected, so they live in the bottom drawer.
type TabId = 'overview' | 'relationships' | 'history'

const TAB_ORDER: TabId[] = ['overview', 'relationships', 'history']
const TAB_LABELS: Record<TabId, string> = {
  overview: 'Overview',
  relationships: 'Relationships',
  history: 'History',
}

/**
 * View B — the element detail, shown whenever an object is selected.
 * Owns the current-value fetch and the subscribe action; the tabs are
 * presentational consumers of that state.
 */
export function ObjectDetailView({ object }: { object: ObjectInstance }) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')

  const [value, setValue] = useState<LastKnownValue | null>(null)
  const [isLoadingValue, setIsLoadingValue] = useState(false)
  const [valueError, setValueError] = useState<string | null>(null)
  const [valueView, setValueView] = useState<'parsed' | 'raw'>('parsed')

  const [isSubscribing, setIsSubscribing] = useState(false)
  const [subscribeError, setSubscribeError] = useState<string | null>(null)

  // Read subscription state through getState() inside the handler rather than a
  // hook: subscribing to the store here would re-render the whole detail view on
  // every live value that arrives.
  const childCount = useExplorerStore(
    state => state.childrenByParent.get(object.elementId)?.length ?? 0
  )

  const loadValue = useCallback(async () => {
    const client = getClient()
    if (!client) return

    setIsLoadingValue(true)
    setValueError(null)

    try {
      // 1.0 Release: composition objects return child values under "components"
      // when queried with maxDepth=0 (infinite recursion through HasComponent).
      // Beta/pre-release servers keep the default maxDepth=1 behavior untouched.
      const maxDepth = client.getApiVersion() === 'v1' && object.isComposition ? 0 : 1
      const result = await client.getValue(object.elementId, maxDepth)
      setValue(result)
    } catch (err) {
      setValueError(err instanceof Error ? err.message : 'Failed to load value')
    } finally {
      setIsLoadingValue(false)
    }
  }, [object.elementId, object.isComposition])

  useEffect(() => {
    loadValue()
  }, [loadValue])

  // Clear subscribe error when the selected object changes
  useEffect(() => {
    setSubscribeError(null)
  }, [object.elementId])

  const handleSubscribe = async () => {
    const client = getClient()
    if (!client) return

    setIsSubscribing(true)
    setSubscribeError(null)

    // Track any subscription we create so we can roll it back if register fails
    let newlyCreatedSubId: string | null = null

    try {
      let subscriptionId = useSubscriptionsStore.getState().activeSubscriptionId

      // Create subscription if none exists
      if (!subscriptionId) {
        const response = await client.createSubscription()
        subscriptionId = response.subscriptionId
        newlyCreatedSubId = subscriptionId

        useSubscriptionsStore.getState().addSubscription({
          id: subscriptionId,
          createdAt: new Date().toISOString(),
          monitoredItems: [],
          isStreaming: false
        })
      }

      // Register this object — if this throws, the catch block cleans up
      await client.registerMonitoredItems(subscriptionId, [object.elementId])
      useSubscriptionsStore.getState().addMonitoredItem(subscriptionId, object.elementId)
      // Reveal the global drawer so the new monitored item is visible immediately.
      useSubscriptionsStore.getState().setSubscriptionsOpen(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Subscribe failed'
      setSubscribeError(msg)
      console.error('Failed to subscribe:', err)

      // Roll back any subscription we just created so it doesn't sit empty in the UI
      if (newlyCreatedSubId) {
        useSubscriptionsStore.getState().removeSubscription(newlyCreatedSubId)
        try { await client.deleteSubscription(newlyCreatedSubId) } catch { /* best-effort */ }
      }
    } finally {
      setIsSubscribing(false)
    }
  }

  const tabCounts: Partial<Record<TabId, number>> = {
    relationships: childCount,
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-i3x-bg">
      <header className="bg-i3x-surface border-b border-i3x-border px-3 sm:px-5 pt-3.5">
        <Breadcrumb object={object} />

        {/* Wraps the action buttons below the title once the pane gets narrow. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-2">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1
              className="text-lg sm:text-xl font-semibold text-i3x-text truncate"
              title={object.displayName}
            >
              {object.displayName}
            </h1>
            <span className="hidden sm:block text-xs text-i3x-text-muted flex-shrink-0">
              Object Instance
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={handleSubscribe}
              disabled={isSubscribing}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-i3x-primary rounded-lg hover:bg-i3x-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
            >
              {isSubscribing ? 'Subscribing…' : <><span aria-hidden="true">◉</span> Subscribe</>}
            </button>
          </div>
        </div>

        {subscribeError && (
          <p className="text-xs text-i3x-error mt-1.5 sm:text-right" title={subscribeError}>
            {subscribeError}
          </p>
        )}

        <TabList activeTab={activeTab} onChange={setActiveTab} counts={tabCounts} />
      </header>

      <div className="flex-1 overflow-auto p-3 sm:p-5 min-h-0">
        <div
          role="tabpanel"
          id={`panel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
          tabIndex={0}
          // Relationships is the Fusion-style workspace — it spans the whole window;
          // the reading-width tabs stay capped at 960px.
          className={`focus:outline-none ${activeTab === 'relationships' ? '' : 'max-w-[960px]'}`}
        >
          {activeTab === 'overview' && (
            <OverviewTab
              object={object}
              value={value}
              valueView={valueView}
              onValueViewChange={setValueView}
              isLoadingValue={isLoadingValue}
              valueError={valueError}
              onRefresh={loadValue}
            />
          )}
          {activeTab === 'relationships' && <RelationshipsTab object={object} />}
          {activeTab === 'history' && <HistoryTab object={object} />}
        </div>
      </div>
    </div>
  )
}

/** Roving-tabindex tab strip: arrows move between tabs, Home/End jump to the ends. */
function TabList({
  activeTab,
  onChange,
  counts,
}: {
  activeTab: TabId
  onChange: (tab: TabId) => void
  counts: Partial<Record<TabId, number>>
}) {
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const currentIndex = TAB_ORDER.indexOf(activeTab)
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TAB_ORDER.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TAB_ORDER.length - 1

    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = TAB_ORDER[nextIndex]
    onChange(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="Element details"
      onKeyDown={handleKeyDown}
      className="flex gap-1 mt-3.5 overflow-x-auto"
    >
      {TAB_ORDER.map(tab => {
        const selected = tab === activeTab
        const count = counts[tab]
        return (
          <button
            key={tab}
            ref={element => { tabRefs.current[tab] = element }}
            type="button"
            role="tab"
            id={`tab-${tab}`}
            aria-selected={selected}
            aria-controls={`panel-${tab}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab)}
            className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 text-[13px] whitespace-nowrap border-b-2 transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary focus-visible:rounded-t ${
              selected
                ? 'text-i3x-primary border-i3x-primary font-medium'
                : 'text-i3x-text-muted border-transparent hover:text-i3x-text'
            }`}
          >
            {TAB_LABELS[tab]}
            {count != null && count > 0 && (
              <span className="font-mono text-[11px] text-i3x-text-muted bg-i3x-bg px-1.5 rounded-full">
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
