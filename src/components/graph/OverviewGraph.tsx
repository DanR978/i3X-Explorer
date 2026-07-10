import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { colorForType } from './nodeColor'

export interface OverviewGraphProps {
  /** Every object known to the explorer store — the nodes of the model map. */
  model: ObjectInstance[]
  /** Opens an element in the detail view. */
  onSelectElement: (elementId: string) => void
}

// The layout is O(n²) per iteration and every node becomes an SVG element, so a
// large catalog (this app routinely browses tens of thousands of objects) would
// freeze the renderer. Above the cap we show a count and point at the tree.
const MAX_GRAPH_NODES = 300

const VIEW_W = 1000
const VIEW_H = 560

const MIN_SCALE = 0.3
const MAX_SCALE = 3

// Edge colour. Only HasChildren exists here: the non-compositional edge types the
// mockup legend shows (Monitors / Controls / References) live behind
// POST /objects/related, and this panel resolves everything from the store.
const EDGE_COLOR = 'rgb(var(--i3x-border))'

interface GraphNode {
  id: string
  label: string
  typeId: string
  degree: number
  x: number
  y: number
}

interface GraphEdge {
  source: string
  target: string
}

interface Transform {
  scale: number
  x: number
  y: number
}

/** Deterministic [0,1) from an index — a seeded layout doesn't jitter on re-render. */
function seededUnit(index: number, salt: number): number {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

function radiusOf(node: GraphNode): number {
  return Math.min(9 + node.degree * 1.7, 20)
}

/** Force-directed layout: repulsion between all pairs, springs along edges, pull to centre. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): void {
  if (nodes.length === 0) return

  const indexById = new Map(nodes.map((n, i) => [n.id, i]))
  const velocities = nodes.map(() => ({ vx: 0, vy: 0 }))

  nodes.forEach((node, i) => {
    node.x = VIEW_W / 2 + (seededUnit(i, 1) - 0.5) * VIEW_W * 0.7
    node.y = VIEW_H / 2 + (seededUnit(i, 2) - 0.5) * VIEW_H * 0.7
  })

  // Bigger graphs get fewer passes — the pair loop already grows quadratically.
  const iterations = nodes.length > 150 ? 200 : 420

  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        const dx = a.x - b.x
        const dy = a.y - b.y
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.6
        const force = 7000 / (distance * distance)
        velocities[i].vx += (dx / distance) * force
        velocities[i].vy += (dy / distance) * force
        velocities[j].vx -= (dx / distance) * force
        velocities[j].vy -= (dy / distance) * force
      }
    }

    for (const edge of edges) {
      const ai = indexById.get(edge.source)
      const bi = indexById.get(edge.target)
      if (ai === undefined || bi === undefined) continue
      const a = nodes[ai]
      const b = nodes[bi]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.sqrt(dx * dx + dy * dy) || 0.6
      const force = (distance - 115) * 0.03
      velocities[ai].vx += (dx / distance) * force
      velocities[ai].vy += (dy / distance) * force
      velocities[bi].vx -= (dx / distance) * force
      velocities[bi].vy -= (dy / distance) * force
    }

    nodes.forEach((node, i) => {
      velocities[i].vx += (VIEW_W / 2 - node.x) * 0.004
      velocities[i].vy += (VIEW_H / 2 - node.y) * 0.004
      node.x += velocities[i].vx * cooling * 0.6
      node.y += velocities[i].vy * cooling * 0.6
      velocities[i].vx *= 0.86
      velocities[i].vy *= 0.86
    })
  }
}

function fitTransform(nodes: GraphNode[]): Transform {
  if (nodes.length === 0) return { scale: 1, x: 0, y: 0 }
  const xs = nodes.map(n => n.x)
  const ys = nodes.map(n => n.y)
  const minX = Math.min(...xs) - 40
  const maxX = Math.max(...xs) + 40
  const minY = Math.min(...ys) - 40
  const maxY = Math.max(...ys) + 40
  const scale = Math.min(VIEW_W / (maxX - minX), VIEW_H / (maxY - minY), 1.6)
  return {
    scale,
    x: (VIEW_W - (minX + maxX) * scale) / 2,
    y: (VIEW_H - (minY + maxY) * scale) / 2,
  }
}

export function OverviewGraph({ model, onSelectElement }: OverviewGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)

  const tooManyNodes = model.length > MAX_GRAPH_NODES

  const { nodes, edges, neighbors } = useMemo(() => {
    if (model.length === 0 || model.length > MAX_GRAPH_NODES) {
      return { nodes: [] as GraphNode[], edges: [] as GraphEdge[], neighbors: new Map<string, Set<string>>() }
    }

    const known = new Set(model.map(o => o.elementId))
    const edges: GraphEdge[] = []
    for (const object of model) {
      if (object.parentId && object.parentId !== '/' && known.has(object.parentId)) {
        edges.push({ source: object.parentId, target: object.elementId })
      }
    }

    const degree = new Map<string, number>()
    const neighbors = new Map<string, Set<string>>()
    const link = (a: string, b: string) => {
      degree.set(a, (degree.get(a) ?? 0) + 1)
      if (!neighbors.has(a)) neighbors.set(a, new Set())
      neighbors.get(a)!.add(b)
    }
    for (const edge of edges) {
      link(edge.source, edge.target)
      link(edge.target, edge.source)
    }

    const nodes: GraphNode[] = model.map(object => ({
      id: object.elementId,
      label: object.displayName,
      typeId: object.typeId,
      degree: degree.get(object.elementId) ?? 0,
      x: 0,
      y: 0,
    }))

    layout(nodes, edges)
    return { nodes, edges, neighbors }
  }, [model])

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  // Re-fit whenever the layout is rebuilt.
  useEffect(() => {
    setTransform(fitTransform(nodes))
  }, [nodes])

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
    if (!svg || nodes.length === 0) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const [ux, uy] = toUserSpace(event.clientX, event.clientY)
      zoomAbout(ux, uy, event.deltaY < 0 ? 1.12 : 0.89)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [nodes, toUserSpace, zoomAbout])

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

  if (model.length === 0) {
    return <GraphMessage title="No model loaded" hint="Connect to a server to load the model." />
  }

  if (tooManyNodes) {
    return (
      <GraphMessage
        title={`Model too large to map — ${model.length.toLocaleString()} objects`}
        hint={`The map renders up to ${MAX_GRAPH_NODES} nodes. Use the tree to browse this model, or select an element to see its immediate relationships.`}
      />
    )
  }

  const hovered = hoverId ? nodeById.get(hoverId) : null
  const hoveredNeighbors = hoverId ? neighbors.get(hoverId) : undefined
  const isDimmed = (id: string) =>
    hoverId != null && id !== hoverId && !hoveredNeighbors?.has(id)

  return (
    <div className="relative flex-1 min-h-0 border border-i3x-border rounded-xl overflow-hidden bg-i3x-surface">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Model map: ${nodes.length} objects, ${edges.length} parent-child relationships. Use the tree to browse with the keyboard.`}
        className={`w-full h-full block touch-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <defs>
          <marker
            id="overview-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill={EDGE_COLOR} />
          </marker>
        </defs>

        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
          {edges.map((edge, index) => {
            const a = nodeById.get(edge.source)
            const b = nodeById.get(edge.target)
            if (!a || !b) return null
            const dx = b.x - a.x
            const dy = b.y - a.y
            const distance = Math.sqrt(dx * dx + dy * dy) || 1
            const stop = radiusOf(b) + 3
            const dim = hoverId != null && edge.source !== hoverId && edge.target !== hoverId
            return (
              <line
                key={index}
                x1={a.x}
                y1={a.y}
                x2={b.x - (dx / distance) * stop}
                y2={b.y - (dy / distance) * stop}
                stroke={EDGE_COLOR}
                strokeWidth={1.4}
                markerEnd="url(#overview-arrow)"
                opacity={dim ? 0.12 : 1}
              />
            )
          })}

          {nodes.map(node => {
            const radius = radiusOf(node)
            return (
              <g
                key={node.id}
                data-node
                className="cursor-pointer"
                opacity={isDimmed(node.id) ? 0.12 : 1}
                onMouseEnter={() => setHoverId(node.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={() => onSelectElement(node.id)}
              >
                <circle
                  r={radius}
                  cx={node.x}
                  cy={node.y}
                  fill="rgb(var(--i3x-surface))"
                  stroke={colorForType(node.typeId)}
                  strokeWidth={node.id === hoverId ? 3 : 2}
                />
                <text
                  x={node.x}
                  y={node.y + radius + 13}
                  textAnchor="middle"
                  fontSize={11}
                  fill="rgb(var(--i3x-text-muted))"
                  stroke="rgb(var(--i3x-surface))"
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {node.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="absolute top-3 right-3 flex flex-col gap-1.5">
        <GraphButton label="Zoom in" onClick={() => zoomAbout(VIEW_W / 2, VIEW_H / 2, 1.25)}>+</GraphButton>
        <GraphButton label="Zoom out" onClick={() => zoomAbout(VIEW_W / 2, VIEW_H / 2, 0.8)}>−</GraphButton>
        <GraphButton label="Fit to view" onClick={() => setTransform(fitTransform(nodes))}>▢</GraphButton>
      </div>

      <div className="absolute left-3 bottom-3 bg-i3x-surface border border-i3x-border rounded-lg px-3 py-2 text-[11px] text-i3x-text-muted">
        <span aria-hidden="true" className="inline-block w-4 border-t-2 align-middle mr-2" style={{ borderColor: EDGE_COLOR }} />
        HasChildren
      </div>

      {hovered && (
        <div className="absolute left-3 top-3 bg-i3x-surface border border-i3x-border rounded-lg px-3 py-2 text-xs max-w-[240px] pointer-events-none">
          <b className="text-[13px] text-i3x-text">{hovered.label}</b>{' '}
          <span className="font-mono text-[11px] text-i3x-text-muted">{hovered.typeId}</span>
          <div className="mt-1 text-i3x-text-muted">
            {hovered.degree} {hovered.degree === 1 ? 'link' : 'links'} · click to open
          </div>
        </div>
      )}
    </div>
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

function GraphMessage({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex-1 min-h-[220px] flex flex-col items-center justify-center gap-2 text-center border border-dashed border-i3x-border rounded-xl bg-i3x-surface/50 p-6">
      <p className="text-sm text-i3x-text-muted">{title}</p>
      <p className="text-xs text-i3x-text-muted/70 max-w-md">{hint}</p>
    </div>
  )
}
