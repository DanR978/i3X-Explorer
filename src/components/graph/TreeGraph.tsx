import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { getClient } from '../../api/client'
import { useExplorerStore } from '../../stores/explorer'
import { BUCKET_COLOR, dashArray, nodeFill } from './relationshipColors'
import { COMPOSITION_DASH } from './relationshipColors'
import { expandEgoGraph, type EgoGraph } from './egoGraph'
import { COLUMN_WIDTH, layoutTree, MAX_LABEL_CHARS, type PositionedNode } from './treeLayout'
import { ELEMENT_DRAG_TYPE } from './dragType'
import { FrameIcon } from '../common/icons'
import type { LocateRequest } from './locator'

const MIN_SCALE = 0.2
const MAX_SCALE = 20

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
  depth: number
  /**
   * Walk child edges only, from the very first hop: the pure subtree beneath the
   * root — no parent leaf, no non-hierarchy links. The Subtree tab sets this.
   */
  descendantsOnly?: boolean
  /**
   * Element dropped onto the canvas: re-root here without navigating away.
   * Omit to disable dropping (the Subtree tab has no drag source).
   */
  onFocusElement?: (elementId: string) => void
  /** Clicking a node opens it in the detail view. */
  onSelectElement: (elementId: string) => void
  /**
   * An element hovered outside the tree, such as a row in the relationships list.
   * The tree highlights it as if it were hovered here. A real hover on the tree
   * takes priority.
   */
  externalHoverId?: string | null
  /**
   * A search pick: centre the view on this node and zoom in. Ignored if the node
   * isn't drawn; answered late if it arrives while the walk is still loading.
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
  depth,
  descendantsOnly = false,
  onFocusElement,
  onSelectElement,
  externalHoverId,
  locate,
}: TreeGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)

  const objectIndex = useExplorerStore(state => state.objectIndex)
  const childrenByParent = useExplorerStore(state => state.childrenByParent)

  const [graph, setGraph] = useState<EgoGraph | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [isDropTarget, setIsDropTarget] = useState(false)

  // The walk reads the store, but a change to allObjects (the 30s poll) must not
  // re-trigger it. Only the root and the depth do. Refs keep the effect's deps honest.
  const storeRef = useRef({ objectIndex, childrenByParent })
  storeRef.current = { objectIndex, childrenByParent }

  useEffect(() => {
    const client = getClient()
    if (!client) {
      setError('Not connected.')
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    expandEgoGraph({
      client,
      root,
      depth,
      store: storeRef.current,
      descendantsOnly,
      cancelled: () => cancelled,
    })
      .then(result => {
        if (!cancelled) setGraph(result)
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to walk relationships')
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [root, depth, descendantsOnly])

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

  // A new root is a new picture; keep the old pan/zoom and it would open off-screen.
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 })
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
    onFocusElement != null && event.dataTransfer.types.includes(ELEMENT_DRAG_TYPE)

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
    if (elementId) onFocusElement?.(elementId)
  }

  // A row hovered in the list highlights here just like a map hover, but an actual
  // hover on the map wins. An external id that isn't drawn is ignored, so it can't
  // dim the whole map with nothing lit.
  const activeHoverId =
    hoverId ?? (externalHoverId && nodeById.has(externalHoverId) ? externalHoverId : null)

  const hovered = activeHoverId ? nodeById.get(activeHoverId) : null
  const hoveredNeighbors = activeHoverId ? neighbors.get(activeHoverId) : undefined
  const dimmed = (id: string) =>
    activeHoverId !== null && id !== activeHoverId && !hoveredNeighbors?.has(id)

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

  // Locator: a search pick centres the view on that node and zooms in enough to
  // read its neighborhood (a couple of columns). The token ref means a request is
  // answered exactly once — but late, if it lands while the walk is still loading,
  // since nodeById refreshing re-runs the effect with the request still unhandled.
  const handledLocateToken = useRef(0)
  useEffect(() => {
    if (!locate || locate.token === handledLocateToken.current) return
    const node = nodeById.get(locate.elementId)
    if (!node) return
    handledLocateToken.current = locate.token
    const scale = Math.min(MAX_SCALE, Math.max(1.6, view.w / 900))
    setTransform({
      scale,
      // Bias half a label to the right of the node so the name is centred too.
      x: view.x + view.w / 2 - (node.x + 60) * scale,
      y: view.y + view.h / 2 - node.y * scale,
    })
  }, [locate, nodeById, view])

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
            <p className="text-xs text-i3x-text-muted">Walking relationships…</p>
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
              className={`w-full h-full select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'} ${
                isLoading ? 'opacity-50' : ''
              }`}
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
                    emphasized={activeHoverId === node.object.elementId}
                    onHover={setHoverId}
                    onSelect={onSelectElement}
                  />
                ))}
              </g>
            </svg>
          )
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
              onClick={() => setTransform({ scale: 1, x: 0, y: 0 })}
            >
              <FrameIcon size={13} />
            </GraphButton>
          </div>
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

      {isLoading && graph && (
        <p className="mt-2 shrink-0 text-[11.5px] text-i3x-text-muted">Expanding…</p>
      )}
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
  return <div className="h-full grid place-items-center text-center px-6">{children}</div>
}

/** A very long name is clipped here; the hover card carries the full one. */
function truncateLabel(name: string, max = MAX_LABEL_CHARS): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}
