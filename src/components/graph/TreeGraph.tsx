import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { BUCKET_COLOR, dashArray, nodeFill } from './relationshipColors'
import { COMPOSITION_DASH } from './relationshipColors'
import { descendantIds, type EgoGraph } from './egoGraph'
import { COLUMN_WIDTH, layoutTree, MAX_LABEL_CHARS, type PositionedNode } from './treeLayout'
import { ELEMENT_DRAG_TYPE } from './dragType'
import { FrameIcon } from '../common/icons'
import { I3xLoader } from '../common/I3xLoader'
import { FocusBadge } from './FocusBadge'
import type { LocateRequest } from './locator'

const MIN_SCALE = 0.2
const MAX_SCALE = 40

/** Room a framed branch leaves around itself, as a fraction of the pane. */
const FOCUS_MARGIN = 0.86
/** Diagram units a node's label takes to its right; framing has to include it. */
const LABEL_SPAN = 190

// Label + node sizes live in diagram units and scale with the map. The tree gives
// every node its own row, so they never collide however the map is scaled.
const FONT = 14
const LABEL_GAP = 8

// The initial view fits the whole tree (its bounding box) so every node is visible
// top to bottom, centred, at any depth. Content smaller than the minimum is shown
// at a comfortable size rather than blown up to fill the pane; zoom/pan to read a
// large tree from there.
const LEFT_PAD = 34
const RIGHT_PAD = 250
const V_PAD = 32
const MIN_VIEW_W = 1000
const MIN_VIEW_H = 520

export interface TreeGraphProps {
  /** The element at the root of the tree: the selected object, or whatever was dropped in. */
  root: ObjectInstance
  /**
   * The walk, owned one level up (`useEgoGraph`) and shared with the relationship
   * list, so the list and the drawing can never show different structures.
   */
  graph: EgoGraph | null
  isLoading: boolean
  error: string | null
  /** Hops the walk was asked for. Describes the drawing; it no longer drives it. */
  depth: number
  /** Whether that walk was descendants-only, for the accessible label's wording. */
  descendantsOnly?: boolean
  /**
   * Element dropped onto the canvas: re-root here without navigating away.
   * Omit to disable dropping (the Subtree tab has no drag source).
   */
  onRootElement?: (elementId: string) => void
  /** Clicking a node opens it in the detail view. */
  onSelectElement: (elementId: string) => void
  /**
   * An element hovered outside the tree, such as a row in the relationships list.
   * The tree highlights it as if it were hovered here. A real hover on the tree
   * takes priority.
   */
  externalHoverId?: string | null
  /**
   * A view request: centre on a node (`scope: 'node'`, a search pick) or frame
   * it with everything under it and hold that branch lit (`scope: 'subtree'`,
   * the list's focus button). Never re-roots or re-walks, it only moves the
   * viewport. Ignored if the node isn't drawn; answered late if it arrives while
   * the walk is still loading.
   */
  locate?: LocateRequest | null
}

/**
 * The depth-N relationship map for one element, drawn as a left-to-right tree.
 *
 * The root sits in the middle; parents are columns to the left, children to the
 * right; every node gets its own row. One node per row means a label always has
 * space, so names never overlap the way they do on a radial map. Edge color is the
 * relationship bucket, matching the legend below the card; cross-links (a node
 * reached more than one way) are the dashed curves. This is the "tree" view; the
 * "rings" view (`RadialGraph`) is the other option in the toggle.
 */
export function TreeGraph({
  root,
  graph,
  isLoading,
  error,
  depth,
  descendantsOnly = false,
  onRootElement,
  onSelectElement,
  externalHoverId,
  locate,
}: TreeGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)

  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [isDropTarget, setIsDropTarget] = useState(false)
  // The branch a subtree focus is holding lit. View state, not walk state: the
  // graph is untouched, the rest of it is simply dimmed around this one.
  const [focusId, setFocusId] = useState<string | null>(null)

  const layout = useMemo(() => (graph ? layoutTree(graph) : null), [graph])

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of layout?.edges ?? []) {
      if (!map.has(edge.source)) map.set(edge.source, new Set())
      if (!map.has(edge.target)) map.set(edge.target, new Set())
      map.get(edge.source)!.add(edge.target)
      map.get(edge.target)!.add(edge.source)
    }
    return map
  }, [layout])

  const nodeById = useMemo(
    () => new Map((layout?.nodes ?? []).map(node => [node.object.elementId, node])),
    [layout]
  )

  // A new root is a new picture; keep the old pan/zoom and it would open
  // off-screen, and a focus held over from the old one would light a branch
  // that may not even be drawn any more.
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 })
    setFocusId(null)
  }, [root.elementId])

  const toUserSpace = useCallback((clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return [0, 0]
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const user = point.matrixTransform(ctm.inverse())
    return [user.x, user.y]
  }, [])

  const zoomAbout = useCallback((cx: number, cy: number, factor: number) => {
    setTransform(current => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current.scale * factor))
      return {
        scale,
        x: cx - (cx - current.x) * (scale / current.scale),
        y: cy - (cy - current.y) * (scale / current.scale),
      }
    })
  }, [])

  // React attaches onWheel passively at the root, so preventDefault there is a
  // no-op. Bind it directly to keep the page from scrolling while zooming.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !layout) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const [ux, uy] = toUserSpace(event.clientX, event.clientY)
      zoomAbout(ux, uy, event.deltaY < 0 ? 1.12 : 0.89)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [layout, toUserSpace, zoomAbout])

  const panOrigin = useRef<[number, number] | null>(null)

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('[data-node]')) return
    panOrigin.current = toUserSpace(event.clientX, event.clientY)
    setIsPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!panOrigin.current) return
    const [ux, uy] = toUserSpace(event.clientX, event.clientY)
    const [lx, ly] = panOrigin.current
    panOrigin.current = [ux, uy]
    setTransform(current => ({ ...current, x: current.x + (ux - lx), y: current.y + (uy - ly) }))
  }

  const endPan = (event: React.PointerEvent<SVGSVGElement>) => {
    panOrigin.current = null
    setIsPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const carriesElement = (event: React.DragEvent) =>
    onRootElement != null && event.dataTransfer.types.includes(ELEMENT_DRAG_TYPE)

  const handleDragOver = (event: React.DragEvent) => {
    if (!carriesElement(event)) return
    // Without preventDefault the browser refuses the drop outright.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsDropTarget(true)
  }

  const handleDrop = (event: React.DragEvent) => {
    if (!carriesElement(event)) return
    event.preventDefault()
    setIsDropTarget(false)
    const elementId = event.dataTransfer.getData(ELEMENT_DRAG_TYPE)
    if (elementId) onRootElement?.(elementId)
  }

  // A row hovered in the list highlights here just like a map hover, but an actual
  // hover on the map wins. An external id that isn't drawn is ignored, so it can't
  // dim the whole map with nothing lit.
  const activeHoverId =
    hoverId ?? (externalHoverId && nodeById.has(externalHoverId) ? externalHoverId : null)

  const hovered = activeHoverId ? nodeById.get(activeHoverId) : null
  const hoveredNeighbors = activeHoverId ? neighbors.get(activeHoverId) : undefined

  // The lit branch. Re-derived from the current layout, so a deeper walk grows
  // the focus with the drawing, and a focus whose node is no longer drawn is
  // dropped rather than dimming everything with nothing lit.
  const focusSet = useMemo(() => {
    if (!layout || !focusId || !nodeById.has(focusId)) return null
    return descendantIds(layout.nodes, focusId)
  }, [layout, focusId, nodeById])
  const focusNode = focusSet ? nodeById.get(focusId!) : null

  // Hovering is the live gesture, so it takes over the dimming while it lasts;
  // the focus comes back the moment the cursor leaves.
  const dimmed = (id: string) =>
    activeHoverId !== null
      ? id !== activeHoverId && !hoveredNeighbors?.has(id)
      : focusSet !== null && !focusSet.has(id)

  // The initial view: the content box, clamped so a small tree isn't blown up and a
  // huge one isn't shrunk to nothing (you scroll instead). Centred on the content.
  const view = useMemo(() => {
    const left = (layout?.minX ?? 0) - LEFT_PAD
    const right = (layout?.maxX ?? 0) + RIGHT_PAD
    const top = (layout?.minY ?? 0) - V_PAD
    const bottom = (layout?.maxY ?? 0) + V_PAD
    const w = Math.max(right - left, MIN_VIEW_W)
    const h = Math.max(bottom - top, MIN_VIEW_H)
    return { w, h, x: (left + right) / 2 - w / 2, y: (top + bottom) / 2 - h / 2 }
  }, [layout])
  const { w: viewW, h: viewH, x: viewX, y: viewY } = view

  // Locator. A 'node' request (a search pick) centres the view on that node and
  // zooms in enough to read its neighborhood; a 'subtree' request frames the
  // whole branch, whatever its size, and lights it. Neither touches the walk.
  // The token ref means a request is answered exactly once, but late, if it
  // lands while the walk is still loading, since nodeById refreshing re-runs the
  // effect with the request still unhandled. The ref starts at the mount-time
  // token so a remount (the Tree/Rings toggle) doesn't re-answer an old request;
  // a pick that isn't drawn is answered late while the walk is still loading,
  // but once the walk settles without it, it's marked handled so a later deeper
  // walk can't replay a long-forgotten jump.
  const handledLocateToken = useRef(locate?.token ?? 0)
  useEffect(() => {
    if (!locate || locate.token === handledLocateToken.current) return
    const node = nodeById.get(locate.elementId)
    if (!node || !layout) {
      if (!isLoading) handledLocateToken.current = locate.token
      return
    }
    handledLocateToken.current = locate.token

    if (locate.scope !== 'subtree') {
      setFocusId(null)
      const scale = Math.min(MAX_SCALE, Math.max(1.6, view.w / 900))
      setTransform({
        scale,
        // Bias half a label to the right of the node so the name is centred too.
        x: view.x + view.w / 2 - (node.x + 60) * scale,
        y: view.y + view.h / 2 - node.y * scale,
      })
      return
    }

    // Frame the branch: its own bounding box (plus the room its labels need)
    // scaled to fill the pane. A single leaf has no extent of its own, so the
    // box is floored at one column, otherwise the fit would divide by ~0 and
    // slam into the zoom ceiling.
    const ids = descendantIds(layout.nodes, node.object.elementId)
    let minX = node.x
    let maxX = node.x
    let minY = node.y
    let maxY = node.y
    for (const drawn of layout.nodes) {
      if (!ids.has(drawn.object.elementId)) continue
      if (drawn.x < minX) minX = drawn.x
      if (drawn.x > maxX) maxX = drawn.x
      if (drawn.y < minY) minY = drawn.y
      if (drawn.y > maxY) maxY = drawn.y
    }
    maxX += LABEL_SPAN
    const boxW = Math.max(maxX - minX, COLUMN_WIDTH)
    const boxH = Math.max(maxY - minY, 120)
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, (Math.min(view.w / boxW, view.h / boxH) * FOCUS_MARGIN))
    )
    setFocusId(node.object.elementId)
    setTransform({
      scale,
      x: view.x + view.w / 2 - ((minX + maxX) / 2) * scale,
      y: view.y + view.h / 2 - ((minY + maxY) / 2) * scale,
    })
  }, [locate, nodeById, layout, view, isLoading])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDropTarget(false)}
        onDrop={handleDrop}
        className={`relative flex-1 min-h-0 rounded-xl border overflow-hidden bg-i3x-bg transition-colors motion-reduce:transition-none ${
          isDropTarget ? 'border-i3x-primary ring-2 ring-i3x-primary/40' : 'border-i3x-border'
        }`}
      >
        {error ? (
          <Centered>
            <p className="text-xs text-i3x-error">{error}</p>
          </Centered>
        ) : !layout && isLoading ? (
          <Centered>
            <I3xLoader size={64} className="mx-auto" />
            <p className="mt-3 text-xs text-i3x-text-muted">Walking relationships…</p>
          </Centered>
        ) : layout && layout.nodes.length <= 1 ? (
          <Centered>
            <p className="text-sm text-i3x-text-muted">
              {descendantsOnly ? 'No children.' : 'No relationships.'}
            </p>
            <p className="text-xs text-i3x-text-muted/70 mt-1">
              {descendantsOnly
                ? 'This element has nothing beneath it.'
                : 'This element has no links to any other object.'}
            </p>
          </Centered>
        ) : (
          layout && (
            <svg
              ref={svgRef}
              viewBox={`${viewX} ${viewY} ${viewW} ${viewH}`}
              preserveAspectRatio="xMidYMid meet"
              // While a walk runs the old drawing is grayed right out, colour
              // and all, so it reads as the stale thing it is and the loader
              // isn't competing with a live-looking map underneath it.
              className={`w-full h-full select-none transition-opacity motion-reduce:transition-none ${
                isPanning ? 'cursor-grabbing' : 'cursor-grab'
              } ${isLoading ? 'grayscale opacity-10' : ''}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              role="img"
              aria-label={`${descendantsOnly ? 'Subtree of' : 'Relationship tree for'} ${root.displayName}, ${layout.nodes.length} objects within ${depth} hops`}
            >
              <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
                {/* Column guides: one per generation. Negative is upstream
                    (parents, to the left); positive is downstream (children). */}
                {layout.columns.map(column => {
                  const x = column * COLUMN_WIDTH
                  return (
                    <g key={column}>
                      {column !== 0 && (
                        <line
                          x1={x}
                          y1={layout.minY - V_PAD / 2}
                          x2={x}
                          y2={layout.maxY + V_PAD / 2}
                          stroke="rgb(var(--i3x-border))"
                          strokeWidth={1}
                          strokeDasharray="2,7"
                          opacity={0.4}
                        />
                      )}
                      <text
                        x={x}
                        y={layout.minY - V_PAD}
                        textAnchor="middle"
                        className="fill-i3x-text-muted"
                        fontSize={12}
                        opacity={0.7}
                      >
                        {column === 0 ? 'root' : column < 0 ? `${-column} up` : `${column} down`}
                      </text>
                    </g>
                  )
                })}

                {/* Edges: horizontal S-curves. Tree edges read solid-ish in the
                    bucket color; cross-links are dashed and fainter. */}
                {layout.edges.map(edge => {
                  const midX = (edge.x1 + edge.x2) / 2
                  const faded = dimmed(edge.source) && dimmed(edge.target)
                  return (
                    <path
                      key={`${edge.source}|${edge.target}|${edge.bucket}`}
                      d={`M${edge.x1},${edge.y1} C${midX},${edge.y1} ${midX},${edge.y2} ${edge.x2},${edge.y2}`}
                      fill="none"
                      stroke={BUCKET_COLOR[edge.bucket]}
                      strokeDasharray={edge.tree ? dashArray(edge.bucket) : '3,4'}
                      strokeWidth={1.5}
                      opacity={faded ? 0.1 : edge.tree ? 0.8 : 0.5}
                    />
                  )
                })}

                {layout.nodes.map(node => (
                  <GraphNode
                    key={node.object.elementId}
                    node={node}
                    dimmed={dimmed(node.object.elementId)}
                    emphasized={
                      activeHoverId === node.object.elementId ||
                      (activeHoverId === null && focusId === node.object.elementId)
                    }
                    onHover={setHoverId}
                    onSelect={onSelectElement}
                  />
                ))}
              </g>
            </svg>
          )
        )}

        {/* The walk is in flight: say so, over the grayed-out old drawing (the
            svg's own class does the graying, see above). Only showing this on
            the first walk meant a depth change (or any re-walk) sat there
            looking finished while a round trip per hop was still running. */}
        {!error && isLoading && layout && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="text-center">
              <I3xLoader size={64} className="mx-auto" />
              <p className="mt-3 text-xs text-i3x-text-muted">Walking relationships…</p>
            </div>
          </div>
        )}

        {layout && layout.nodes.length > 1 && (
          <div className="absolute top-3 right-3 flex flex-col gap-1.5">
            <GraphButton label="Zoom in" onClick={() => zoomAbout(0, 0, 1.3)}>
              +
            </GraphButton>
            <GraphButton label="Zoom out" onClick={() => zoomAbout(0, 0, 0.77)}>
              −
            </GraphButton>
            <GraphButton
              label="Reset view"
              onClick={() => {
                setTransform({ scale: 1, x: 0, y: 0 })
                setFocusId(null)
              }}
            >
              <FrameIcon size={13} />
            </GraphButton>
          </div>
        )}

        {!error && focusNode && focusSet && (
          <FocusBadge
            name={focusNode.object.displayName}
            count={focusSet.size}
            onClear={() => setFocusId(null)}
          />
        )}

        {hovered && (
          <div className="absolute left-3 top-3 max-w-[260px] bg-i3x-surface border border-i3x-border rounded-lg px-3 py-2 text-xs pointer-events-none">
            <b className="text-[13px] text-i3x-text block truncate">{hovered.object.displayName}</b>
            <div className="font-mono text-[11px] text-i3x-text-muted truncate">
              {hovered.object.typeId}
            </div>
            <div className="mt-1 text-i3x-text-muted">
              {hovered.depth === 0
                ? 'root'
                : `${hovered.depth} ${hovered.depth === 1 ? 'hop' : 'hops'} out`}{' '}
              · {hovered.degree} {hovered.degree === 1 ? 'link' : 'links'} · click to open
            </div>
          </div>
        )}

        {isDropTarget && (
          <div className="absolute inset-0 grid place-items-center bg-i3x-primary/5 pointer-events-none">
            <span className="bg-i3x-surface border border-i3x-primary rounded-lg px-3 py-2 text-xs text-i3x-text">
              Drop to root the tree here
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Nodes are neutral so the edge colors carry the relationship, matching the
 * legend. Composition objects are hollow with a dashed border; the root is
 * filled in the primary color. The name sits to the right, inside the column.
 */
function GraphNode({
  node,
  dimmed,
  emphasized,
  onHover,
  onSelect,
}: {
  node: PositionedNode
  dimmed: boolean
  /** The active-hover node (map hover or a hovered list row). Gets a focus ring. */
  emphasized: boolean
  onHover: (id: string | null) => void
  onSelect: (id: string) => void
}) {
  const isRoot = node.depth === 0
  const isComposition = node.object.isComposition === true

  return (
    <g
      data-node
      className="cursor-pointer"
      opacity={dimmed ? 0.2 : 1}
      onMouseEnter={() => onHover(node.object.elementId)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(node.object.elementId)}
    >
      {/* Focus ring, behind the node so the node sits on top. Makes the active
          element easy to find when the list, not the cursor, is driving the hover. */}
      {emphasized && (
        <circle
          cx={node.x}
          cy={node.y}
          r={node.radius + 4}
          fill="none"
          stroke="rgb(var(--i3x-primary))"
          strokeWidth={2}
        />
      )}
      <circle
        cx={node.x}
        cy={node.y}
        r={node.radius}
        fill={isRoot ? 'rgb(var(--i3x-primary))' : nodeFill(isComposition)}
        stroke={isRoot ? 'rgb(var(--i3x-primary))' : 'rgb(var(--i3x-text-muted))'}
        strokeWidth={1.5}
        strokeDasharray={isComposition && !isRoot ? COMPOSITION_DASH.join(',') : undefined}
      />
      {/* A fat transparent disc: a tiny circle is a miserable hover target. */}
      <circle cx={node.x} cy={node.y} r={Math.max(node.radius + 7, 12)} fill="transparent" />
      <text
        x={node.x + node.radius + LABEL_GAP}
        y={node.y}
        textAnchor="start"
        dominantBaseline="middle"
        fontSize={FONT}
        className={
          isRoot
            ? 'fill-i3x-text font-semibold'
            : emphasized
              ? 'fill-i3x-primary font-medium'
              : 'fill-i3x-text'
        }
        style={{
          paintOrder: 'stroke',
          stroke: 'rgb(var(--i3x-bg))',
          strokeWidth: 4,
          strokeLinejoin: 'round',
        }}
      >
        {truncateLabel(node.object.displayName)}
      </text>
    </g>
  )
}

function GraphButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="w-8 h-8 grid place-items-center border border-i3x-border bg-i3x-surface rounded-lg text-i3x-text-muted hover:bg-i3x-bg hover:text-i3x-text transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
    >
      {children}
    </button>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  // One inner block, so multiple children (logo + caption, or a two-line
  // empty state) stack tightly instead of becoming separate grid rows that
  // split the panel's full height between them.
  return (
    <div className="h-full grid place-items-center text-center px-6">
      <div>{children}</div>
    </div>
  )
}

/** A very long name is clipped here; the hover card carries the full one. */
function truncateLabel(name: string, max = MAX_LABEL_CHARS): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}
