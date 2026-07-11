import { useCallback, useEffect, useState } from 'react'
import type { ObjectInstance } from '../../../api/types'
import {
  MAX_RELATIONSHIP_DEPTH,
  MIN_RELATIONSHIP_DEPTH,
  useExplorerStore,
} from '../../../stores/explorer'
import { DirectRelationships } from '../../graph/DirectRelationships'
import { RelationshipGraph } from '../../graph/RelationshipGraph'
import { RelationshipLegend } from '../../graph/RelationshipLegend'
import { Card, SegmentedControl } from '../primitives'
import { useElementNavigation } from '../navigation'

const DEPTH_OPTIONS = Array.from(
  { length: MAX_RELATIONSHIP_DEPTH - MIN_RELATIONSHIP_DEPTH + 1 },
  (_, index) => {
    const depth = MIN_RELATIONSHIP_DEPTH + index
    return { value: String(depth), label: String(depth) }
  }
)

/**
 * Two views of the same thing, and they answer different questions.
 *
 * The list answers "what is this connected to?" — every direct relationship,
 * hierarchy and non-hierarchy alike, in one place. The map answers "what is it
 * connected to *through* those?" — which only becomes a real question past the
 * first hop, so the map walks out to a configurable depth rather than stopping
 * at the neighbours the list already spells out.
 *
 * Dragging a row from the list onto the map re-centres the map on it, so you can
 * follow a chain outward without leaving the element you're inspecting.
 */
export function RelationshipsTab({ object }: { object: ObjectInstance }) {
  const objectIndex = useExplorerStore(state => state.objectIndex)
  const depth = useExplorerStore(state => state.relationshipDepth)
  const setDepth = useExplorerStore(state => state.setRelationshipDepth)
  const { selectElement, selectObject } = useElementNavigation()

  // What the map is centred on. null = the selected element itself; anything else
  // is a neighbour the user dropped in, which re-centres the map WITHOUT
  // navigating — the detail view around it stays put.
  const [focused, setFocused] = useState<ObjectInstance | null>(null)

  // Selecting a different element resets the map back to it. (MainPanel re-keys
  // this view per element, so this only fires if that ever stops being true.)
  useEffect(() => setFocused(null), [object.elementId])

  const root = focused ?? object
  const isRefocused = root.elementId !== object.elementId

  const focusObject = useCallback(
    (target: ObjectInstance) =>
      setFocused(target.elementId === object.elementId ? null : target),
    [object.elementId]
  )

  // A drop only carries the elementId across the DOM, so it is resolved against
  // the catalog. A related object the store has never seen can't be centred this
  // way — the ◎ button on each row hands over the whole object and always can.
  const focusElementId = (elementId: string) => {
    const target = objectIndex.get(elementId)
    if (target) focusObject(target)
  }

  return (
    <div className="space-y-3">
      <Card title="Direct relationships">
        <DirectRelationships element={object} onSelect={selectObject} onFocus={focusObject} />
      </Card>

      <Card
        title={
          isRefocused ? (
            <>
              Relationship map ·{' '}
              <span className="normal-case tracking-normal text-i3x-text">{root.displayName}</span>
            </>
          ) : (
            'Relationship map'
          )
        }
        actions={
          <div className="flex items-center gap-2">
            {isRefocused && (
              <button
                type="button"
                onClick={() => setFocused(null)}
                className="text-[11px] text-i3x-primary hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
              >
                Back to {object.displayName}
              </button>
            )}
            <span className="text-[11px] text-i3x-text-muted normal-case tracking-normal">Depth</span>
            <SegmentedControl
              label="Relationship depth in hops"
              value={String(depth)}
              options={DEPTH_OPTIONS}
              onChange={value => setDepth(Number(value))}
            />
          </div>
        }
      >
        <RelationshipGraph
          root={root}
          depth={depth}
          onFocusElement={focusElementId}
          onSelectElement={selectElement}
        />

        <p className="mt-2 text-[11.5px] text-i3x-text-muted">
          Drag to pan · scroll to zoom · hover a node for its links · click a node to open it
        </p>
      </Card>

      {/* The key sits beneath the cards, not inside the drawing, so it can never
          overlap a node and it wraps on a narrow pane. */}
      <RelationshipLegend buckets={['parent', 'child', 'inherits', 'other']} className="px-1" />
    </div>
  )
}
