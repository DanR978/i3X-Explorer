import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectInstance } from '../../../api/types'
import { type RelationshipView, useExplorerStore } from '../../../stores/explorer'
import type { Neighbor } from '../../graph/egoGraph'
import { buildEgoTree } from '../../graph/egoTree'
import type { LocateRequest } from '../../graph/locator'
import { RelationshipGraph } from '../../graph/RelationshipGraph'
import { RelationshipLegend } from '../../graph/RelationshipLegend'
import { RelationshipList } from '../../graph/RelationshipList'
import { RelationshipSearch } from '../../graph/RelationshipSearch'
import { useEgoGraph } from '../../graph/useEgoGraph'
import { Card, SegmentedControl } from '../primitives'
import { useElementNavigation } from '../navigation'
import { DepthControl } from './DepthControl'

const VIEW_OPTIONS: { value: RelationshipView; label: string }[] = [
  { value: 'tree', label: 'Tree' },
  { value: 'radial', label: 'Rings' },
]

/**
 * One panel, two views of the same thing, laid out like a Fusion 360 workspace:
 * the browser list on the left, the tree canvas on the right.
 *
 * Both read ONE walk, owned here. The list used to fetch its own single hop
 * while each canvas walked to the chosen depth, so raising the depth grew the
 * drawing and left the list behind at one hop. Now the depth control moves both:
 * the list nests out to exactly what the map draws, and the two panes cannot
 * disagree because there is only one walk to disagree about.
 *
 * Dragging a row from the list onto the tree re-roots it on that element, so you
 * can follow a chain outward without leaving the element you're inspecting. The
 * list follows the new root too, for the same reason.
 *
 * Focusing is the cheaper cousin of that and is kept separate on purpose: it
 * moves the viewport onto a row's branch and lights it, leaving the walk, the
 * root and the selection exactly as they were. Re-rooting costs a round trip
 * per hop and redraws both panes; focusing costs nothing and redraws nothing.
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

  // Header search. The text filters the list; picking a suggestion spotlights the
  // node on the map and asks the map to zoom to it (the LocateRequest).
  const [query, setQuery] = useState('')
  const [spotlightId, setSpotlightId] = useState<string | null>(null)
  const [locate, setLocate] = useState<LocateRequest | null>(null)
  const locateToken = useRef(0)

  // Selecting a different element resets the tree back to it. (MainPanel re-keys
  // this view per element, so this only fires if that ever stops being true.)
  useEffect(() => {
    setFocused(null)
    setHoveredId(null)
    setQuery('')
  }, [object.elementId])

  const root = focused ?? object
  const isRefocused = root.elementId !== object.elementId

  // The one walk. Both panes render it, so the list nests out to exactly what
  // the map draws and a re-root moves them together.
  const { graph, isLoading, error } = useEgoGraph(root, depth)
  const tree = useMemo(() => (graph ? buildEgoTree(graph) : null), [graph])

  // Autocomplete over everything on the map, not just the direct neighbors: at
  // depth 3 the thing you're hunting for is usually further out than one hop.
  const neighbors = useMemo<Neighbor[]>(
    () =>
      tree
        ? [...tree.byId.values()].map(node => ({
            object: node.object,
            relationshipType: node.relationshipType,
          }))
        : [],
    [tree]
  )

  // A new root is a new picture (and a reset transform), so a lingering
  // spotlight or zoom request there would be stale.
  useEffect(() => {
    setSpotlightId(null)
    setLocate(null)
  }, [root.elementId])

  const handleQueryChange = useCallback((text: string) => {
    setQuery(text)
    // Typing again (or clearing) withdraws the locator until the next pick.
    setSpotlightId(null)
  }, [])

  const handleLocate = useCallback((elementId: string) => {
    setSpotlightId(elementId)
    locateToken.current += 1
    setLocate({ elementId, token: locateToken.current, scope: 'node' })
  }, [])

  /**
   * The list's focus action. A pure view request: the map frames this element
   * with its children and dims the rest. No walk, no re-root, no navigation, so
   * the drawing you were reading stays the drawing you are reading.
   */
  const focusOnMap = useCallback((target: ObjectInstance) => {
    // A held subtree focus supersedes any search spotlight.
    setSpotlightId(null)
    locateToken.current += 1
    setLocate({ elementId: target.elementId, token: locateToken.current, scope: 'subtree' })
  }, [])

  /** Re-root the walk here: the drag-and-drop gesture, and the menu's version of it. */
  const rootObject = useCallback(
    (target: ObjectInstance) =>
      setFocused(target.elementId === object.elementId ? null : target),
    [object.elementId]
  )

  // A drop only carries the elementId across the DOM, so it is resolved against
  // the catalog. A related object the store has never seen can't be rooted this
  // way. The menu's "Root the map here" hands over the whole object and always can.
  const rootElementId = (elementId: string) => {
    const target = objectIndex.get(elementId)
    if (target) rootObject(target)
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
          <RelationshipSearch
            neighbors={neighbors}
            query={query}
            onQueryChange={handleQueryChange}
            onLocate={handleLocate}
          />
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
          <RelationshipList
            tree={tree}
            isLoading={isLoading}
            error={error}
            depth={depth}
            onSelect={selectObject}
            onFocus={focusOnMap}
            onRoot={rootObject}
            onHover={setHoveredId}
            filter={query}
          />
        </div>

        <div className="h-[26rem] lg:h-auto flex-1 min-w-0 lg:min-w-[20rem] min-h-0">
          <RelationshipGraph
            root={root}
            graph={graph}
            isLoading={isLoading}
            error={error}
            depth={depth}
            onRootElement={rootElementId}
            onSelectElement={selectElement}
            externalHoverId={hoveredId ?? spotlightId}
            locate={locate}
          />
        </div>
      </div>

      <p className="mt-3 shrink-0 text-[11.5px] text-i3x-text-muted">
        Hover a row to spotlight it on the map · use a row's focus button to zoom to it and its
        children · drag a row onto the map to root it there · right-click a row for more · drag to
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
