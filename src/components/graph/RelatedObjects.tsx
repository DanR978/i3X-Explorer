import { useEffect, useMemo, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { getClient } from '../../api/client'
import { useExplorerStore } from '../../stores/explorer'
import { BUCKET_COLOR, bucketOf, nodeFill } from './relationshipColors'

/**
 * Non-compositional relationships — Monitors, SuppliedBy, InheritsFrom,
 * References, and anything else the server reports.
 *
 * The hierarchy (parent and compositional children) is drawn by the cascade
 * above; those come from the store and need no fetch. Everything else comes from
 * POST /objects/related with no relationship-type filter, exactly as the
 * original relationship graph fetched it. Without this, the amber/green cascade
 * is the only relationship view and the legend's Inherits/Other buckets are
 * unreachable.
 *
 * Each related object arrives as a full ObjectInstance carrying its
 * sourceRelationship, so a click navigates with the data already in hand.
 */
/**
 * The non-hierarchy relationships to show: everything the server returned minus
 * what the cascade already draws (the compositional parent and direct children)
 * and the element itself. Sorted by bucket, then name. Pure, so it can be tested
 * without a network or a DOM.
 */
export function selectNonHierarchy(
  related: ObjectInstance[],
  element: ObjectInstance,
  children: ObjectInstance[]
): ObjectInstance[] {
  const shown = new Set<string>([element.elementId])
  if (element.parentId && element.parentId !== '/') shown.add(element.parentId)
  for (const child of children) shown.add(child.elementId)

  return related
    .filter(object => !shown.has(object.elementId))
    .sort((a, b) => {
      const ba = bucketOf(a.sourceRelationship)
      const bb = bucketOf(b.sourceRelationship)
      if (ba !== bb) return ba.localeCompare(bb)
      return a.displayName.localeCompare(b.displayName)
    })
}

export function RelatedObjects({
  element,
  onSelect,
}: {
  element: ObjectInstance
  onSelect: (object: ObjectInstance) => void
}) {
  const [related, setRelated] = useState<ObjectInstance[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const childrenByParent = useExplorerStore(state => state.childrenByParent)

  useEffect(() => {
    const client = getClient()
    if (!client) return

    let cancelled = false
    setIsLoading(true)
    setError(null)

    client
      .getRelatedObjects(element.elementId)
      .then(objects => {
        if (!cancelled) setRelated(objects)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load relationships')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [element.elementId])

  // Drop what the cascade already shows (compositional parent + direct children);
  // what remains is precisely the non-hierarchy edges.
  const nonHierarchy = useMemo(
    () => selectNonHierarchy(related, element, childrenByParent.get(element.elementId) ?? []),
    [related, element, childrenByParent]
  )

  if (isLoading && related.length === 0) {
    return <p className="text-xs text-i3x-text-muted">Loading related objects…</p>
  }
  if (error) {
    return <p className="text-xs text-i3x-error">{error}</p>
  }
  if (nonHierarchy.length === 0) {
    return <p className="text-xs text-i3x-text-muted">No other relationships.</p>
  }

  return (
    <div className="flex flex-wrap gap-2.5">
      {nonHierarchy.map(object => {
        const bucket = bucketOf(object.sourceRelationship)
        const accent = BUCKET_COLOR[bucket]
        return (
          <button
            key={object.elementId}
            type="button"
            onClick={() => onSelect(object)}
            title={object.elementId}
            className="inline-flex flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2 text-left transition-colors motion-reduce:transition-none hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
            style={{
              borderColor: accent,
              borderStyle: object.isComposition ? 'dashed' : 'solid',
              background: nodeFill(object.isComposition),
            }}
          >
            <span className="text-[13px] font-medium text-i3x-text whitespace-nowrap">
              {object.displayName}
            </span>
            {/* Colour repeats the border so the relationship reads even at a glance. */}
            <span className="font-mono text-[11px] whitespace-nowrap" style={{ color: accent }}>
              {object.sourceRelationship ?? 'Related'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
