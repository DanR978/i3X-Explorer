import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { BUCKET_COLOR, BUCKET_DASH, nodeFill } from './relationshipColors'
import { COMPOSITION_DASH } from './relationshipColors'
import { descendantIds, type EgoGraph } from './egoGraph'
import { layoutRadial, MAX_LABEL_CHARS, type PositionedNode } from './radialLayout'
import { ELEMENT_DRAG_TYPE } from './dragType'
import { FrameIcon } from '../common/icons'
import { I3xLoader } from '../common/I3xLoader'
import { FocusBadge } from './FocusBadge'
import type { LocateRequest } from './locator'

const MIN_SCALE = 0.35
const MAX_SCALE = 40

/**
 * Semantic zoom: node positions live in diagram units, but dots, labels and
 * strokes are drawn at constant SCREEN size, their unit size is divided by
 * the zoom and calibrated against the measured pane (its minor dimension), so
 * "11px" text really renders at 11 CSS px on any pane. FALLBACK_PANE covers
 * the frame before the ResizeObserver's first measurement.
 */
const FALLBACK_PANE = 760

/** Screen px of headroom around the outer ring at fit, for its outward labels. */
const FIT_PAD_PX = 72

/**
 * A node's label appears when its angular slot × ring radius clears this many
 * reference px at the current zoom. Hubs own wide slots and label first; the
 * rest resolve as you zoom in.
 */
const LABEL_MIN_PX = 30
const LABEL_PX = 11

/** Room a framed branch leaves around itself, as a fraction of the pane. */
const FOCUS_MARGIN = 0.86

export interface RadialGraphProps {
  /** The element at the center: the selected object, or whatever was dropped in. */
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
  /** Element dropped onto the canvas: re-root here without navigating away. */
  onRootElement: (elementId: string) => void
  /** Clicking a node opens it in the detail view. */
  onSelectElement: (elementId: string) => void
  /**
   * An element hovered outside the map, such as a row in the relationships list.
   * The map highlights it as if it were hovered here. A real hover on the map
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
 * The depth-N relationship map for one element, drawn as a radial map.
 *
 * Rings are hops: the root at the center, its direct relationships on ring 1,
 * theirs on ring 2, and so on. Rings are fixed and compact, and everything is
 * drawn at constant screen size, so the fitted view is always a readable
 * overview no matter the fan-out: a 1,000-child ring reads as a dense band
 * with its hubs labeled, and zooming is the microscope that separates and
 * labels the rest (label culling is by angular slot, see radialLayout).
 * Edge color is the relationship bucket, read from the inner node outward,
 * matching the legend below the card. This is the "rings" view; the "tree"
 * view (`TreeGraph`) is the other option in the toggle.
 */
export function RadialGraph({
  root,
  graph,
  isLoading,
  error,
  depth,
  onRootElement,
  onSelectElement,
  externalHoverId,
  locate,
}: RadialGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)

  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [isDropTarget, setIsDropTarget] = useState(false)
  // The branch a subtree focus is holding lit. View state, not walk state: the
  // graph is untouched, the rest of it is simply dimmed around this one.
  const [focusId, setFocusId] = useState<string | null>(null)

  // Actual pane size (CSS px, minor dimension). All semantic-zoom sizing and
  // the fit pad are calibrated against it.
  const paneRef = useRef<HTMLDivElement>(null)
  const [paneMin, setPaneMin] = useState(FALLBACK_PANE)
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setPaneMin(Math.min(width, height))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => (graph ? layoutRadial(graph) : null), [graph])

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

  // zoomAbout reads the adaptive ceiling through a ref so its identity stays
  // stable (the wheel listener depends on it). The ref is assigned below, once
  // the layout-derived ceiling is computed.
  const maxScaleRef = useRef(MAX_SCALE)

  const zoomAbout = useCallback((cx: number, cy: number, factor: number) => {
    setTransform(current => {
      const scale = Math.max(MIN_SCALE, Math.min(maxScaleRef.current, current.scale * factor))
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
    // `error` is a dep so a failed re-walk (which unmounts the svg but keeps
    // the old layout) still runs the cleanup and drops the listener.
    if (!svg || !layout || error) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const [ux, uy] = toUserSpace(event.clientX, event.clientY)
      zoomAbout(ux, uy, event.deltaY < 0 ? 1.12 : 0.89)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [layout, error, toUserSpace, zoomAbout])

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
    event.dataTransfer.types.includes(ELEMENT_DRAG_TYPE)

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
    if (elementId) onRootElement(elementId)
  }

  // A row hovered in the list highlights here just like a map hover, but an actual
  // hover on the map wins. BOTH sources are validated against the drawn set: the
  // map's own hoverId goes stale when a re-root or depth change replaces the
  // layout while the cursor sits on an old node (mouseleave never fires for
  // unmounts), and an undrawn id would dim the entire map with nothing lit.
  const mapHoverId = hoverId && nodeById.has(hoverId) ? hoverId : null
  const activeHoverId =
    mapHoverId ?? (externalHoverId && nodeById.has(externalHoverId) ? externalHoverId : null)

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

  // Fit extent: the outer ring plus FIT_PAD_PX of *screen* headroom for its
  // outward labels. Solved in units (extent = outer + padPx·2·extent/pane) so
  // the pad holds its screen size at any depth; the denominator floor keeps a
  // tiny pane from inflating the extent without bound.
  const outerRadius = layout?.outerRadius ?? 200
  const extent = outerRadius / Math.max(0.5, 1 - (2 * FIT_PAD_PX) / paneMin)

  // Everything screen-sized is some multiple of this: px × unitOverScale =
  // diagram units that render at px CSS pixels at the current zoom.
  const unitOverScale = (extent * 2) / paneMin / transform.scale

  // The zoom ceiling adapts to the densest slot: MAX_SCALE is the floor, but a
  // crowded ring needs more before its sliver slots can label and separate,
  // a hard cap there would leave those nodes unreachable at any zoom.
  const maxScale = useMemo(() => {
    if (!layout) return MAX_SCALE
    let tightestArc = Infinity
    for (const node of layout.nodes) {
      if (node.depth === 0) continue
      const arc = Math.hypot(node.x, node.y) * node.slot
      if (arc > 0 && arc < tightestArc) tightestArc = arc
    }
    if (!Number.isFinite(tightestArc)) return MAX_SCALE
    const needed = ((LABEL_MIN_PX * (extent * 2)) / paneMin / tightestArc) * 1.3
    return Math.max(MAX_SCALE, needed)
  }, [layout, extent, paneMin])
  maxScaleRef.current = maxScale

  // Which labels fit at this zoom. Quantized so the set doesn't churn (and the
  // memo doesn't recompute) on every wheel tick; pan never recomputes it.
  const scaleKey = Math.round(transform.scale * 8) / 8
  const labeledIds = useMemo(() => {
    const set = new Set<string>()
    if (!layout) return set
    const minArcUnits = (LABEL_MIN_PX * (extent * 2)) / paneMin / scaleKey
    for (const node of layout.nodes) {
      if (node.depth === 0 || Math.hypot(node.x, node.y) * node.slot >= minArcUnits) {
        set.add(node.object.elementId)
      }
    }
    return set
  }, [layout, extent, paneMin, scaleKey])

  // Dense edge fans get lighter ink so the rings stay readable underneath.
  const edgeCount = layout?.edges.length ?? 0
  const baseEdgeOpacity = edgeCount > 600 ? 0.4 : edgeCount > 250 ? 0.6 : 0.85

  // Node and edge layers are memoized so panning (which only moves the group
  // transform) doesn't reconcile thousands of elements per frame.
  // Hovering is the live gesture, so it takes over the dimming while it lasts;
  // the focus comes back the moment the cursor leaves.
  const isDim = useCallback(
    (id: string) =>
      activeHoverId !== null
        ? id !== activeHoverId && !hoveredNeighbors?.has(id)
        : focusSet !== null && !focusSet.has(id),
    [activeHoverId, hoveredNeighbors, focusSet]
  )

  const edgeElements = useMemo(() => {
    if (!layout) return null
    const width = 1.3 * unitOverScale
    return layout.edges.map(edge => {
      const dash = BUCKET_DASH[edge.bucket]
      return (
        <line
          key={`${edge.source}|${edge.target}|${edge.bucket}`}
          x1={edge.x1}
          y1={edge.y1}
          x2={edge.x2}
          y2={edge.y2}
          stroke={BUCKET_COLOR[edge.bucket]}
          strokeDasharray={dash ? dash.map(d => d * unitOverScale).join(',') : undefined}
          strokeWidth={width}
          opacity={isDim(edge.source) && isDim(edge.target) ? 0.1 : baseEdgeOpacity}
        />
      )
    })
  }, [layout, unitOverScale, isDim, baseEdgeOpacity])

  const nodeElements = useMemo(() => {
    if (!layout) return null
    return layout.nodes.map(node => {
      const id = node.object.elementId
      // While a focus is held, its own node reads as the emphasized one, and the
      // lit branch keeps its labels regardless of how tight its slots are.
      const focused = activeHoverId === null && focusSet !== null && focusSet.has(id)
      return (
        <GraphNode
          key={id}
          node={node}
          unitOverScale={unitOverScale}
          dimmed={isDim(id)}
          emphasized={activeHoverId === id || (focused && id === focusId)}
          showLabel={labeledIds.has(id) || activeHoverId === id || focused}
          onHover={setHoverId}
          onSelect={onSelectElement}
        />
      )
    })
  }, [layout, unitOverScale, isDim, activeHoverId, focusSet, focusId, labeledIds, onSelectElement])

  // Locator: a search pick centres the view on that node and zooms far enough in
  // that its own label resolves (the 1.6× headroom over the label gate survives
  // because the clamp is the adaptive ceiling, which always covers the tightest
  // slot). The token ref starts at the mount-time token so a remount (the
  // Tree/Rings toggle) doesn't re-answer an old request; a pick that isn't drawn
  // is answered late while the walk is still loading, but once the walk settles
  // without it, it's marked handled so a later deeper walk can't replay a
  // long-forgotten jump.
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
      const ring = Math.hypot(node.x, node.y)
      const needed =
        ring > 0 && node.slot > 0
          ? (LABEL_MIN_PX * 1.6 * (extent * 2)) / paneMin / (ring * node.slot)
          : 2.5
      const scale = Math.max(2.5, Math.min(maxScale, needed))
      setTransform({ scale, x: -node.x * scale, y: -node.y * scale })
      return
    }

    // Frame the branch. On rings a subtree is an arc rather than a block, so
    // this is its bounding box; the floor keeps a single leaf (a box of zero
    // extent) from being zoomed to the ceiling.
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
    const span = extent * 2
    const boxW = Math.max(maxX - minX, span / 8)
    const boxH = Math.max(maxY - minY, span / 8)
    const scale = Math.max(
      MIN_SCALE,
      Math.min(maxScale, Math.min(span / boxW, span / boxH) * FOCUS_MARGIN)
    )
    setFocusId(node.object.elementId)
    setTransform({
      scale,
      x: -((minX + maxX) / 2) * scale,
      y: -((minY + maxY) / 2) * scale,
    })
  }, [locate, nodeById, layout, extent, paneMin, maxScale, isLoading])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        ref={paneRef}
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
            <p className="text-sm text-i3x-text-muted">No relationships.</p>
            <p className="text-xs text-i3x-text-muted/70 mt-1">
              This element has no links to any other object.
            </p>
          </Centered>
        ) : (
          layout && (
            <svg
              ref={svgRef}
              viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
              // Fit the whole graph in view, centered, so everything is always
              // visible. A wide pane gets side margins rather than cropping nodes.
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
              aria-label={`Relationship map for ${root.displayName}, ${layout.nodes.length} objects within ${depth} hops`}
            >
              <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
                {layout.rings.map(ring => (
                  <g key={ring.depth}>
                    <circle
                      cx={0}
                      cy={0}
                      r={ring.radius}
                      fill="none"
                      stroke="rgb(var(--i3x-border))"
                      strokeWidth={unitOverScale}
                      strokeDasharray={`${2 * unitOverScale},${6 * unitOverScale}`}
                      opacity={0.6}
                    />
                    {/* Anchored due north, where the sector allocation leaves a seam.
                        The count says what a dense band actually holds. */}
                    <text
                      x={0}
                      y={-ring.radius - 6 * unitOverScale}
                      textAnchor="middle"
                      className="fill-i3x-text-muted"
                      fontSize={9.5 * unitOverScale}
                      opacity={0.75}
                    >
                      {ring.depth} {ring.depth === 1 ? 'hop' : 'hops'} ·{' '}
                      {ring.count.toLocaleString()}
                    </text>
                  </g>
                ))}

                {edgeElements}
                {nodeElements}
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

        {/* Overlays are gated on !error too: a failed re-walk keeps the old
            layout but unmounts the svg, and buttons floating over the error
            message would mutate pan/zoom for a map that isn't there. */}
        {!error && layout && layout.nodes.length > 1 && (
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

        {!error && hovered && (
          <div className="absolute left-3 top-3 max-w-[260px] bg-i3x-surface border border-i3x-border rounded-lg px-3 py-2 text-xs pointer-events-none">
            <b className="text-[13px] text-i3x-text block truncate">{hovered.object.displayName}</b>
            <div className="font-mono text-[11px] text-i3x-text-muted truncate">
              {hovered.object.typeId}
            </div>
            <div className="mt-1 text-i3x-text-muted">
              {hovered.depth === 0
                ? 'center'
                : `${hovered.depth} ${hovered.depth === 1 ? 'hop' : 'hops'} out`}{' '}
              · {hovered.degree} {hovered.degree === 1 ? 'link' : 'links'} · click to open
            </div>
          </div>
        )}

        {isDropTarget && (
          <div className="absolute inset-0 grid place-items-center bg-i3x-primary/5 pointer-events-none">
            <span className="bg-i3x-surface border border-i3x-primary rounded-lg px-3 py-2 text-xs text-i3x-text">
              Drop to center the map here
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
 * filled in the primary color. All sizes are screen-constant (unitOverScale),
 * so a dot is the same 8px whether the map is fitted or at 40×. Memoized:
 * panning changes no prop, so the pan path never re-renders node subtrees.
 */
const GraphNode = memo(function GraphNode({
  node,
  unitOverScale,
  dimmed,
  emphasized,
  showLabel,
  onHover,
  onSelect,
}: {
  node: PositionedNode
  /** Diagram units per reference-pane px at the current zoom. */
  unitOverScale: number
  dimmed: boolean
  /** The active-hover node (map hover or a hovered list row). Gets a focus ring. */
  emphasized: boolean
  showLabel: boolean
  onHover: (id: string | null) => void
  onSelect: (id: string) => void
}) {
  const px = (n: number) => n * unitOverScale
  const isRoot = node.depth === 0
  const isComposition = node.object.isComposition === true
  const dotRadius = isRoot ? px(10) : px(4 + Math.min(Math.sqrt(node.degree) * 1.2, 4))
  // Push the label out along the node's own bearing, and flip its anchor across
  // the vertical axis so it always reads away from the center.
  const outward = isRoot ? 0 : dotRadius + px(6)
  const labelX = node.x + Math.cos(node.angle) * outward
  const labelY = isRoot ? node.y - dotRadius - px(7) : node.y + Math.sin(node.angle) * outward
  const anchor = isRoot ? 'middle' : Math.cos(node.angle) >= 0 ? 'start' : 'end'

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
          r={dotRadius + px(5)}
          fill="none"
          stroke="rgb(var(--i3x-primary))"
          strokeWidth={px(2)}
        />
      )}
      <circle
        cx={node.x}
        cy={node.y}
        r={dotRadius}
        fill={isRoot ? 'rgb(var(--i3x-primary))' : nodeFill(isComposition)}
        stroke={isRoot ? 'rgb(var(--i3x-primary))' : 'rgb(var(--i3x-text-muted))'}
        strokeWidth={px(1.5)}
        strokeDasharray={
          isComposition && !isRoot ? COMPOSITION_DASH.map(d => px(d)).join(',') : undefined
        }
      />
      {/* A fat transparent disc: a 5px circle is a miserable hover target. On a
          crowded ring the disc shrinks to the node's own angular slot, so discs
          tile instead of stacking, the hover lands on the node nearest the
          cursor rather than whichever painted last, and a pan can start just
          off the band instead of everything on it counting as a node press. */}
      <circle
        cx={node.x}
        cy={node.y}
        r={
          isRoot
            ? Math.max(dotRadius + px(7), px(13))
            : Math.min(
                Math.max(dotRadius + px(7), px(13)),
                Math.max(dotRadius + px(2), (Math.hypot(node.x, node.y) * node.slot) / 2)
              )
        }
        fill="transparent"
      />
      {showLabel && (
        <text
          x={labelX}
          y={labelY}
          textAnchor={anchor}
          dominantBaseline="middle"
          fontSize={px(LABEL_PX)}
          className={
            isRoot
              ? 'fill-i3x-text font-medium'
              : emphasized
                ? 'fill-i3x-primary font-medium'
                : 'fill-i3x-text'
          }
          style={{
            paintOrder: 'stroke',
            stroke: 'rgb(var(--i3x-bg))',
            strokeWidth: px(3),
            strokeLinejoin: 'round',
          }}
        >
          {truncateLabel(node.object.displayName)}
        </text>
      )}
    </g>
  )
})

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
