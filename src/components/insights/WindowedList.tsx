import { useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/**
 * The one virtualized list on the insights page: dynamic row heights via
 * measureElement (atlas rows expand in place), rows in normal flow between
 * top/bottom spacer padding — the same windowing pattern as the tree and the
 * diff view, factored out because this page needs it in four places.
 *
 * The caller owns the height bound (className), because the right bound
 * differs per site: the atlas is a tall fixed region, an inner outlier list
 * is a short one.
 */
export function WindowedList<T>({
  items,
  estimateHeight,
  className = '',
  getKey,
  renderRow,
}: {
  items: T[]
  /** Initial row-height guess; real heights are measured after mount. */
  estimateHeight: number
  /** Scroll-container classes — must bound the height (e.g. `max-h-[32rem]`). */
  className?: string
  getKey?: (item: T, index: number) => string
  renderRow: (item: T, index: number) => ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateHeight,
    overscan: 8,
    getItemKey: getKey ? index => getKey(items[index], index) : undefined,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
  const paddingBottom =
    virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0

  return (
    <div ref={scrollRef} className={`overflow-y-auto ${className}`}>
      <div style={{ paddingTop, paddingBottom }}>
        {virtualItems.map(virtualItem => (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
          >
            {renderRow(items[virtualItem.index], virtualItem.index)}
          </div>
        ))}
      </div>
    </div>
  )
}
