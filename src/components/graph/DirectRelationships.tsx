import { useEffect, useMemo, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { getClient } from '../../api/client'
import { useExplorerStore } from '../../stores/explorer'
import { Chevron } from '../common/Chevron'
import { BUCKET_COLOR, bucketOf, type RelationshipBucket } from './relationshipColors'
import { directNeighbors, type Neighbor } from './egoGraph'
import { ELEMENT_DRAG_TYPE } from './RelationshipGraph'

/** Rows revealed per "show more" click. A composition parent can have thousands of children. */
const PAGE_SIZE = 50

export interface RelationshipGroup {
  /** The server's relationship type, e.g. HasComponent. */
  type: string
  bucket: RelationshipBucket
  items: Neighbor[]
}

/**
 * Every direct relationship of the element, gathered into one group per
 * relationship type. `neighbors` arrives already sorted (bucket, then name), so
 * insertion order carries that ordering into the groups and between them.
 */
export function groupByRelationship(neighbors: Neighbor[]): RelationshipGroup[] {
  const groups = new Map<string, RelationshipGroup>()

  for (const neighbor of neighbors) {
    const type = neighbor.relationshipType ?? 'Related'
    const group = groups.get(type)
    if (group) group.items.push(neighbor)
    else groups.set(type, { type, bucket: bucketOf(neighbor.relationshipType), items: [neighbor] })
  }

  return [...groups.values()]
}

/**
 * The flat list of every direct relationship: the hierarchy (parent, children)
 * and everything else (Monitors, InheritsFrom, and so on) in one place, so a
 * single view answers "what is this connected to?".
 *
 * Rows are draggable onto the relationship tree, which re-roots it on the
 * dropped element. The ◎ button does the same thing for keyboard users and for
 * anyone who doesn't discover the drag.
 */
export function DirectRelationships({
  element,
  onSelect,
  onFocus,
  onHover,
}: {
  element: ObjectInstance
  onSelect: (object: ObjectInstance) => void
  /** Root the relationship tree on this object, without navigating to it. */
  onFocus: (object: ObjectInstance) => void
  /** Row hovered or left. The map highlights that element as if hovered there. */
  onHover?: (elementId: string | null) => void
}) {
  const [related, setRelated] = useState<ObjectInstance[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const objectIndex = useExplorerStore(state => state.objectIndex)
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
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load relationships')
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [element.elementId])

  const groups = useMemo(
    () => groupByRelationship(directNeighbors(element, related, { objectIndex, childrenByParent })),
    [element, related, objectIndex, childrenByParent]
  )

  const total = useMemo(() => groups.reduce((sum, group) => sum + group.items.length, 0), [groups])

  if (isLoading && total === 0) {
    return <p className="text-xs text-i3x-text-muted">Loading relationships…</p>
  }
  if (error && total === 0) {
    return <p className="text-xs text-i3x-error">{error}</p>
  }
  if (total === 0) {
    return <p className="text-xs text-i3x-text-muted">No relationships.</p>
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <p className="mb-2 shrink-0 text-[11px] text-i3x-text-muted">
        {total.toLocaleString()} direct {total === 1 ? 'relationship' : 'relationships'} · drag a row
        onto the tree to root it there
      </p>

      {/* Fills the pane and scrolls in place, so a hub with thousands of children
          doesn't stretch the card. pr/-mr keeps the scrollbar off the rows. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 -mr-1">
        {groups.map(group => (
          <Group
            key={group.type}
            group={group}
            onSelect={onSelect}
            onFocus={onFocus}
            onHover={onHover}
          />
        ))}
      </div>
    </div>
  )
}

function Group({
  group,
  onSelect,
  onFocus,
  onHover,
}: {
  group: RelationshipGroup
  onSelect: (object: ObjectInstance) => void
  onFocus: (object: ObjectInstance) => void
  onHover?: (elementId: string | null) => void
}) {
  const [isOpen, setIsOpen] = useState(true)
  const [visible, setVisible] = useState(PAGE_SIZE)

  const shown = group.items.slice(0, visible)
  const remaining = group.items.length - shown.length
  const accent = BUCKET_COLOR[group.bucket]

  return (
    <section className="mb-1.5 last:mb-0">
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        aria-expanded={isOpen}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-i3x-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
      >
        <Chevron open={isOpen} />
        {/* The bucket color, so a row's kind reads the same here as on the map's edges. */}
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: accent }}
        />
        <span className="text-[12.5px] font-medium text-i3x-text truncate">{group.type}</span>
        <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-i3x-text-muted border border-i3x-border rounded-full px-1.5 py-px">
          {group.items.length.toLocaleString()}
        </span>
      </button>

      {isOpen && (
        // The accent rail ties every row back to the relationship it belongs to,
        // so the color doesn't have to be repeated on each one.
        <ul
          className="ml-[9px] pl-2.5 border-l"
          style={{ borderColor: `color-mix(in srgb, ${accent} 45%, transparent)` }}
        >
          {shown.map(item => (
            <Row
              key={item.object.elementId}
              object={item.object}
              onSelect={onSelect}
              onFocus={onFocus}
              onHover={onHover}
            />
          ))}

          {remaining > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setVisible(count => count + PAGE_SIZE)}
                className="ml-2 my-1 text-[11px] text-i3x-primary hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
              >
                Show {Math.min(PAGE_SIZE, remaining)} more ({remaining.toLocaleString()} remaining)
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

function Row({
  object,
  onSelect,
  onFocus,
  onHover,
}: {
  object: ObjectInstance
  onSelect: (object: ObjectInstance) => void
  onFocus: (object: ObjectInstance) => void
  onHover?: (elementId: string | null) => void
}) {
  return (
    <li
      draggable
      onDragStart={event => {
        event.dataTransfer.setData(ELEMENT_DRAG_TYPE, object.elementId)
        // text/plain keeps the drag legible to anything else that might accept it.
        event.dataTransfer.setData('text/plain', object.elementId)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      onMouseEnter={() => onHover?.(object.elementId)}
      onMouseLeave={() => onHover?.(null)}
      className="group flex items-center gap-1 rounded-lg hover:bg-i3x-bg"
    >
      <span
        aria-hidden="true"
        className="pl-1.5 text-[11px] leading-none text-i3x-text-muted/50 cursor-grab active:cursor-grabbing"
        title="Drag onto the tree to root it here"
      >
        ⠿
      </span>

      <button
        type="button"
        onClick={() => onSelect(object)}
        title={object.elementId}
        className="flex-1 min-w-0 flex items-baseline gap-2 px-1.5 py-1.5 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
      >
        <span className="text-[13px] text-i3x-text truncate">{object.displayName}</span>
        <span className="font-mono text-[11px] text-i3x-text-muted truncate ml-auto">
          {object.typeId}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onFocus(object)}
        aria-label={`Root the tree at ${object.displayName}`}
        title="Root the tree here"
        className="mr-1 w-6 h-6 grid place-items-center rounded-md text-i3x-text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-i3x-surface hover:text-i3x-primary transition-opacity motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
      >
        ◎
      </button>
    </li>
  )
}
