import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { getClient } from '../../api/client'
import { useExplorerStore } from '../../stores/explorer'
import { BUCKET_COLOR, dashArray, nodeFill } from './relationshipColors'
import { COMPOSITION_DASH } from './relationshipColors'
import { expandEgoGraph, type EgoGraph } from './egoGraph'
import { layoutRadial, MAX_LABEL_CHARS, type PositionedNode } from './radialLayout'

/** The MIME a dragged relationship row carries. Also the handle the graph drop target looks for. */
export const ELEMENT_DRAG_TYPE = 'application/x-i3x-element-id'

const MIN_SCALE = 0.35
const MAX_SCALE = 20

export interface RelationshipGraphProps {
  /** The element at the center: the selected object, or whatever was dropped in. */
  root: ObjectInstance
  depth: number
  /** Element dropped onto the canvas: re-root here without navigating away. */
  onFocusElement: (elementId: string) => void
  /** Clicking a node opens it in the detail view. */
  onSelectElement: (elementId: string) => void
  /**
   * An element hovered outside the map, such as a row in the relationships list.
   * The map highlights it as if it were hovered here. A real hover on the map
   * takes priority.
   */
  externalHoverId?: string | null
}

/**
 * The depth-N relationship map for one element.
 *
 * Rings are hops: the root at the center, its direct relationships on ring 1,
 * theirs on ring 2, and so on. Edge color is the relationship bucket, read from
 * the inner node outward, matching the legend below the card.
 */
export function RelationshipGraph({
  root,
  depth,
  onFocusElement,
  onSelectElement,
  externalHoverId,
}: RelationshipGraphProps) {
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
  }, [root, depth])

  const layout = useMemo(() => (graph ? layoutRadial(graph) : null), [graph])

  // Ring guides, derived from the laid-out nodes so they can't drift from them.
  const rings = useMemo(() => {
    if (!layout) return []
    const byDepth = new Map<number, number>()
    for (const node of layout.nodes) {
      if (node.depth === 0) continue
      byDepth.set(node.depth, Math.hypot(node.x, node.y))
    }
    return [...byDepth.entries()].sort((a, b) => a[0] - b[0])
  }, [layout])

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
    if (elementId) onFocusElement(elementId)
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

  const extent = layout?.extent ?? 200

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
              className={`w-full h-full select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'} ${
                isLoading ? 'opacity-50' : ''
              }`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              role="img"
              aria-label={`Relationship map for ${root.displayName}, ${layout.nodes.length} objects within ${depth} hops`}
            >
              <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
                {rings.map(([ringDepth, radius]) => (
                  <g key={ringDepth}>
                    <circle
                      cx={0}
                      cy={0}
                      r={radius}
                      fill="none"
                      stroke="rgb(var(--i3x-border))"
                      strokeWidth={1}
                      strokeDasharray="2,6"
                      opacity={0.6}
                    />
                    {/* Anchored due north, where the sector allocation leaves a seam. */}
                    <text
                      x={0}
                      y={-radius - 5}
                      textAnchor="middle"
                      className="fill-i3x-text-muted"
                      fontSize={9}
                      opacity={0.7}
                    >
                      {ringDepth} {ringDepth === 1 ? 'hop' : 'hops'}
                    </text>
                  </g>
                ))}

                {layout.edges.map(edge => (
                  <line
                    key={`${edge.source}|${edge.target}|${edge.bucket}`}
                    x1={edge.x1}
                    y1={edge.y1}
                    x2={edge.x2}
                    y2={edge.y2}
                    stroke={BUCKET_COLOR[edge.bucket]}
                    strokeDasharray={dashArray(edge.bucket)}
                    strokeWidth={1.5}
                    opacity={dimmed(edge.source) && dimmed(edge.target) ? 0.12 : 0.85}
                  />
                ))}

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
              ▢
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

      {isLoading && graph && (
        <p className="mt-2 shrink-0 text-[11.5px] text-i3x-text-muted">Expanding…</p>
      )}
    </div>
  )
}

/**
 * Nodes are neutral so the edge colors carry the relationship, matching the
 * legend. Composition objects are hollow with a dashed border; the root is
 * filled in the primary color.
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
  // Push the label out along the node's own bearing, and flip its anchor across
  // the vertical axis so it always reads away from the center.
  const outward = isRoot ? 0 : node.radius + 6
  const labelX = node.x + Math.cos(node.angle) * outward
  const labelY = isRoot ? node.y - node.radius - 7 : node.y + Math.sin(node.angle) * outward
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
          r={node.radius + 5}
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
      {/* A fat transparent disc: a 5px circle is a miserable hover target. */}
      <circle cx={node.x} cy={node.y} r={Math.max(node.radius + 7, 13)} fill="transparent" />
      {node.showLabel && (
        <text
          x={labelX}
          y={labelY}
          textAnchor={anchor}
          dominantBaseline="middle"
          fontSize={11}
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
            strokeWidth: 3,
            strokeLinejoin: 'round',
          }}
        >
          {truncateLabel(node.object.displayName)}
        </text>
      )}
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

/** Every node is labeled; a very long name is clipped here and the hover card carries the full one. */
function truncateLabel(name: string, max = MAX_LABEL_CHARS): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}
