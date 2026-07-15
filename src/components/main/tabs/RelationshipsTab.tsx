import { useCallback, useEffect, useState } from 'react'
import type { ObjectInstance } from '../../../api/types'
import {
  MAX_RELATIONSHIP_DEPTH,
  MIN_RELATIONSHIP_DEPTH,
  type RelationshipView,
  useExplorerStore,
} from '../../../stores/explorer'
import { DirectRelationships } from '../../graph/DirectRelationships'
import { RelationshipGraph } from '../../graph/RelationshipGraph'
import { RelationshipLegend } from '../../graph/RelationshipLegend'
import { Card, SegmentedControl } from '../primitives'
import { useElementNavigation } from '../navigation'

const VIEW_OPTIONS: { value: RelationshipView; label: string }[] = [
  { value: 'tree', label: 'Tree' },
  { value: 'radial', label: 'Rings' },
]

/**
 * One panel, two views of the same thing, laid out like a Fusion 360 workspace:
 * the browser list on the left, the tree canvas on the right.
 *
 * The list (left) answers "what is this connected to?": every direct
 * relationship, hierarchy and non-hierarchy alike, in one place. The tree (right)
 * answers "what is it connected to through those?", which only becomes a real
 * question past the first hop, so the tree walks out to a configurable depth
 * rather than stopping at the neighbors the list already spells out.
 *
 * Dragging a row from the list onto the tree re-roots it on that element, so you
 * can follow a chain outward without leaving the element you're inspecting.
 */
export function RelationshipsTab({ object }: { object: ObjectInstance }) {
  const objectIndex = useExplorerStore(state => state.objectIndex)
  const depth = useExplorerStore(state => state.relationshipDepth)
  const setDepth = useExplorerStore(state => state.setRelationshipDepth)
  const view = useExplorerStore(state => state.relationshipView)
  const setView = useExplorerStore(state => state.setRelationshipView)
  const { selectElement, selectObject } = useElementNavigation()

  // What the tree is rooted on. null = the selected element itself; anything else
  // is a neighbor the user dropped in, which re-roots the tree WITHOUT
  // navigating, so the detail view around it stays put.
  const [focused, setFocused] = useState<ObjectInstance | null>(null)

  // The element hovered in the list. The tree highlights it as if hovered there.
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Selecting a different element resets the tree back to it. (MainPanel re-keys
  // this view per element, so this only fires if that ever stops being true.)
  useEffect(() => {
    setFocused(null)
    setHoveredId(null)
  }, [object.elementId])

  const root = focused ?? object
  const isRefocused = root.elementId !== object.elementId

  const focusObject = useCallback(
    (target: ObjectInstance) =>
      setFocused(target.elementId === object.elementId ? null : target),
    [object.elementId]
  )

  // A drop only carries the elementId across the DOM, so it is resolved against
  // the catalog. A related object the store has never seen can't be rooted this
  // way. The ◎ button on each row hands over the whole object and always can.
  const focusElementId = (elementId: string) => {
    const target = objectIndex.get(elementId)
    if (target) focusObject(target)
  }

  return (
    <Card
      title={
        isRefocused ? (
          <>
            Relationships ·{' '}
            <span className="normal-case tracking-normal text-i3x-text">{root.displayName}</span>
          </>
        ) : (
          'Relationships'
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
          <SegmentedControl label="Relationship view" value={view} options={VIEW_OPTIONS} onChange={setView} />
          <span className="text-[11px] text-i3x-text-muted normal-case tracking-normal">Depth</span>
          <DepthControl value={depth} onChange={setDepth} />
        </div>
      }
      className="flex h-full flex-col min-h-0"
    >
      {/* The Fusion-style split: browser tree (left) beside the canvas (right).
          Fills the card's height (grows/shrinks with the window); a min-height on
          the panel and a min-width on the map keep it from collapsing. */}
      <div className="flex flex-1 min-h-0 flex-col lg:flex-row gap-4">
        <div className="h-[20rem] lg:h-auto lg:w-[340px] lg:flex-shrink-0 min-h-0">
          <DirectRelationships
            element={object}
            onSelect={selectObject}
            onFocus={focusObject}
            onHover={setHoveredId}
          />
        </div>

        <div className="h-[26rem] lg:h-auto flex-1 min-w-0 lg:min-w-[20rem] min-h-0">
          <RelationshipGraph
            root={root}
            depth={depth}
            onFocusElement={focusElementId}
            onSelectElement={selectElement}
            externalHoverId={hoveredId}
          />
        </div>
      </div>

      <p className="mt-3 shrink-0 text-[11.5px] text-i3x-text-muted">
        Hover a row to spotlight it on the map · drag a row onto the map to focus it there · drag to
        pan · scroll to zoom · click a node to open it
      </p>

      {/* The key sits below the split, not inside the drawing, so it can never
          overlap a node and it wraps on a narrow pane. */}
      <RelationshipLegend
        buckets={['parent', 'child', 'inherits', 'other']}
        className="mt-3 shrink-0"
      />
    </Card>
  )
}

/**
 * Depth picker: a pill per hop from MIN up to however many have been revealed,
 * then a "+" that reveals one more. The revealed count is session state in the
 * store, so the extra pills stay put when you switch between elements.
 */
function DepthControl({
  value,
  onChange,
}: {
  value: number
  onChange: (depth: number) => void
}) {
  const revealed = useExplorerStore(state => state.relationshipDepthShown)
  const reveal = useExplorerStore(state => state.revealRelationshipDepth)

  // Always show at least up to the current depth, so the active pill can't vanish.
  const shown = Math.max(revealed, value)
  const depths = Array.from(
    { length: shown - MIN_RELATIONSHIP_DEPTH + 1 },
    (_, index) => MIN_RELATIONSHIP_DEPTH + index
  )

  const pill =
    'px-3 py-1 text-[11.5px] rounded-md transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary'
  const active = 'bg-i3x-surface text-i3x-primary font-medium shadow-sm'
  const inactive = 'text-i3x-text-muted hover:text-i3x-text'

  return (
    <div
      role="group"
      aria-label="Relationship depth in hops"
      className="flex items-center gap-0.5 bg-i3x-bg border border-i3x-border rounded-lg p-0.5"
    >
      {depths.map(depth => (
        <button
          key={depth}
          type="button"
          aria-pressed={value === depth}
          onClick={() => onChange(depth)}
          className={`${pill} ${value === depth ? active : inactive}`}
        >
          {depth}
        </button>
      ))}

      {shown < MAX_RELATIONSHIP_DEPTH && (
        <button
          type="button"
          aria-label="Reveal a deeper depth"
          title="Add a deeper depth"
          onClick={reveal}
          className={`${pill} ${inactive}`}
        >
          +
        </button>
      )}
    </div>
  )
}
