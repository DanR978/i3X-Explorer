import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ObjectInstance } from '../../api/types'
import { useExplorerStore } from '../../stores/explorer'
import { BUCKET_COLOR, dashArray, nodeFill, type RelationshipBucket } from './relationshipColors'

export interface RelationshipTreeProps {
  /** The element the cascade is centred on. */
  element: ObjectInstance
  /** Opens a related element in the detail view. */
  onSelectElement: (elementId: string) => void
}

/** A composition object can have thousands of children; past this we show a count. */
const MAX_CHILDREN = 48

/** Horizontal gap between sibling boxes, and the vertical gap between rows. */
const CHILD_GAP = 14
const ROW_GAP = 48

/**
 * Clear channel reserved down the middle of every wrapped row so the vein can
 * descend between boxes rather than behind them.
 */
const SPINE_GUTTER = 48

/** Shrink to fit, but never past the point where labels stop being readable. */
const MIN_SCALE = 0.6

/** Sub-pixel slack: widths are measured, and a hair of rounding must not wrap a row. */
const WIDTH_EPSILON = 2

interface Line {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  /** SVG strokeDasharray, or undefined for solid. */
  dash?: string
}

/**
 * Stroke for a relationship bucket. Both the edges and the legend swatches
 * resolve their colour and dash through this, so a solid entry in the key can
 * never sit next to a dashed edge of the same kind.
 */
function strokeFor(bucket: RelationshipBucket): { color: string; dash?: string } {
  return { color: BUCKET_COLOR[bucket], dash: dashArray(bucket) }
}

/** A box in the diagram's unscaled coordinate space. */
export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

const midX = (box: Box) => (box.left + box.right) / 2

/**
 * The connector geometry, pulled out of the component so it can be tested
 * without a DOM. Coordinates are already unscaled.
 *
 * One vein drops from the element to the last row's bus, passing through the
 * centre gutter that every wrapped row reserves. Each row then gets its own
 * horizontal bus and a stub down to each child.
 *
 * Segments must never overlap: two 1.5px strokes on the same pixels read as one
 * heavy line. The vein stops at the last bus, so the stub below it is adjacent,
 * not coincident.
 */
export function buildConnectors(self: Box, parent: Box | null, children: Box[]): Line[] {
  const lines: Line[] = []
  const selfX = midX(self)

  if (parent) {
    const { color, dash } = strokeFor('parent')
    const parentX = midX(parent)
    if (Math.abs(parentX - selfX) < 0.5) {
      lines.push({ x1: selfX, y1: parent.bottom, x2: selfX, y2: self.top, color, dash })
    } else {
      const midY = (parent.bottom + self.top) / 2
      lines.push({ x1: parentX, y1: parent.bottom, x2: parentX, y2: midY, color, dash })
      lines.push({ x1: parentX, y1: midY, x2: selfX, y2: midY, color, dash })
      lines.push({ x1: selfX, y1: midY, x2: selfX, y2: self.top, color, dash })
    }
  }

  if (children.length === 0) return lines

  const { color, dash } = strokeFor('child')

  const rows = new Map<number, Box[]>()
  for (const child of children) {
    const key = Math.round(child.top)
    const row = rows.get(key)
    if (row) row.push(child)
    else rows.set(key, [child])
  }
  const rowTops = Array.from(rows.keys()).sort((a, b) => a - b)
  const busYOf = (rowTop: number) => rowTop - ROW_GAP / 2

  // The vein: element bottom → the LAST row's bus, straight down the middle.
  lines.push({ x1: selfX, y1: self.bottom, x2: selfX, y2: busYOf(rowTops[rowTops.length - 1]), color, dash })

  for (const rowTop of rowTops) {
    const row = rows.get(rowTop)!
    const busY = busYOf(rowTop)
    const xs = row.map(midX)
    // Extend the bus to meet the vein when the vein falls outside the row's span.
    const minX = Math.min(...xs, selfX)
    const maxX = Math.max(...xs, selfX)
    if (maxX - minX > 0.5) lines.push({ x1: minX, y1: busY, x2: maxX, y2: busY, color, dash })

    for (const child of row) {
      const x = midX(child)
      lines.push({ x1: x, y1: busY, x2: x, y2: child.top, color, dash })
    }
  }

  return lines
}

/**
 * Greedy row packing. `budget` is the unscaled width available; every row keeps
 * SPINE_GUTTER free down the middle, so the usable width is that much smaller.
 * Returns a single ungutted row when the children fit on one line.
 */
export function packRows(
  widths: number[],
  budget: number
): { rows: number[][]; gutter: boolean } {
  if (widths.length === 0) return { rows: [], gutter: false }

  const natural = widths.reduce((a, b) => a + b, 0) + CHILD_GAP * (widths.length - 1)
  if (natural <= budget + WIDTH_EPSILON) {
    return { rows: [widths.map((_, i) => i)], gutter: false }
  }

  const limit = Math.max(budget - SPINE_GUTTER, 1)
  const rows: number[][] = []
  let current: number[] = []
  let currentWidth = 0

  widths.forEach((width, index) => {
    const added = current.length ? CHILD_GAP + width : width
    if (current.length && currentWidth + added > limit + WIDTH_EPSILON) {
      rows.push(current)
      current = [index]
      currentWidth = width
    } else {
      current.push(index)
      currentWidth += added
    }
  })
  if (current.length) rows.push(current)

  return { rows, gutter: rows.length > 1 }
}

/** Split point that balances the two halves of a row around the centre gutter. */
export function balancedSplit(widths: number[]): number {
  const total = widths.reduce((a, b) => a + b, 0)
  let best = 0
  let bestDelta = Infinity
  let left = 0
  for (let k = 0; k <= widths.length; k++) {
    if (k > 0) left += widths[k - 1]
    const delta = Math.abs(left - (total - left))
    if (delta < bestDelta) {
      bestDelta = delta
      best = k
    }
  }
  return best
}

/**
 * The cascade: parent above, the element, children fanned below, joined by
 * orthogonal connectors.
 *
 * Colour encodes the RELATIONSHIP — amber for the edge up to the parent, green
 * for the edges down to children, matching the legend. That is the only colour
 * language here; the type is already spelled out under each name.
 *
 * Connectors are measured from the laid-out DOM with getBoundingClientRect
 * deltas against the diagram root, which is immune to which ancestor happens to
 * be positioned. (offsetLeft/offsetTop was not: the rows are `position:relative`,
 * so each row was the offsetParent and every connector collapsed to y≈0.)
 */
export function RelationshipTree({ element, onSelectElement }: RelationshipTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const parentRowRef = useRef<HTMLDivElement>(null)
  const selfRowRef = useRef<HTMLDivElement>(null)
  const childrenRef = useRef<HTMLDivElement>(null)

  // O(1) store lookups. Scanning `allObjects` for the parent and filtering it for
  // children rebuilt a 50k Map and did a 50k pass on every selection.
  const objectIndex = useExplorerStore(state => state.objectIndex)
  const childrenByParent = useExplorerStore(state => state.childrenByParent)

  const { parent, children, hiddenChildren } = useMemo(() => {
    const all = childrenByParent.get(element.elementId) ?? []
    return {
      parent:
        element.parentId && element.parentId !== '/'
          ? objectIndex.get(element.parentId) ?? null
          : null,
      children: all.slice(0, MAX_CHILDREN),
      hiddenChildren: Math.max(0, all.length - MAX_CHILDREN),
    }
  }, [element, objectIndex, childrenByParent])

  const [scale, setScale] = useState(1)
  const [available, setAvailable] = useState(0)
  const [metrics, setMetrics] = useState<{ childWidths: number[]; headWidth: number }>({
    childWidths: [],
    headWidth: 0,
  })
  const [lines, setLines] = useState<Line[]>([])
  const [size, setSize] = useState({ width: 0, height: 0 })

  // Row layout is derived, not measured: the widths are known, so the packing is
  // deterministic and the DOM only has to render the result.
  const budget = available > 0 ? available / scale : 0
  const { rows, gutter } = useMemo(
    () => (budget > 0 ? packRows(metrics.childWidths, budget) : { rows: [], gutter: false }),
    [metrics.childWidths, budget]
  )

  // Root width is computed rather than left to `w-max`, which sized the root to
  // the children's *unwrapped* width — wider than the card, so `mx-auto` gave up
  // and the whole diagram sat left-aligned and overflowed to the right.
  const rootWidth = useMemo(() => {
    if (rows.length === 0) return undefined
    let widest = metrics.headWidth
    rows.forEach((row, index) => {
      const isLast = index === rows.length - 1
      const content =
        row.reduce((sum, i) => sum + metrics.childWidths[i], 0) + CHILD_GAP * (row.length - 1)
      const width = content + (gutter && !isLast ? SPINE_GUTTER : 0)
      if (width > widest) widest = width
    })
    return widest
  }, [rows, gutter, metrics])

  useLayoutEffect(() => {
    const container = containerRef.current
    const root = rootRef.current
    if (!container || !root) return

    const measure = () => {
      const width = container.clientWidth
      if (width === 0) return

      const rootRect = root.getBoundingClientRect()
      // Deltas are in scaled pixels; the SVG's coordinate space is unscaled.
      const relative = (el: HTMLElement): Box => {
        const rect = el.getBoundingClientRect()
        return {
          left: (rect.left - rootRect.left) / scale,
          right: (rect.right - rootRect.left) / scale,
          top: (rect.top - rootRect.top) / scale,
          bottom: (rect.bottom - rootRect.top) / scale,
        }
      }

      const childNodes = childrenRef.current
        ? (Array.from(childrenRef.current.querySelectorAll('[data-rt-node]')) as HTMLElement[])
        : []
      const selfNode = selfRowRef.current?.querySelector('[data-rt-node]') as HTMLElement | null
      const parentNode = parentRowRef.current?.querySelector('[data-rt-node]') as HTMLElement | null
      if (!selfNode) return

      // Fractional widths: summing integer offsetWidths lands a hair under the
      // true total and wraps a row that would otherwise have fitted.
      const childWidths = childNodes.map(node => node.getBoundingClientRect().width / scale)
      const selfBox = relative(selfNode)
      const parentBox = parentNode ? relative(parentNode) : null
      const headWidth = Math.max(
        selfBox.right - selfBox.left,
        parentBox ? parentBox.right - parentBox.left : 0
      )

      const natural =
        childWidths.reduce((a, b) => a + b, 0) + CHILD_GAP * Math.max(childWidths.length - 1, 0)
      const contentWidth = Math.max(natural, headWidth, 1)
      const nextScale = Math.min(1, Math.max(MIN_SCALE, width / contentWidth))

      if (Math.abs(nextScale - scale) > 0.002) {
        setScale(nextScale)
        return // re-measure once the new transform has been applied
      }
      if (width !== available) setAvailable(width)
      setMetrics(previous =>
        sameNumbers(previous.childWidths, childWidths) && previous.headWidth === headWidth
          ? previous
          : { childWidths, headWidth }
      )

      const next = buildConnectors(selfBox, parentBox, childNodes.map(relative))
      setLines(previous => (sameLines(previous, next) ? previous : next))
      setSize(previous =>
        previous.width === root.offsetWidth && previous.height === root.offsetHeight
          ? previous
          : { width: root.offsetWidth, height: root.offsetHeight }
      )
    }

    measure()

    // Watch the container, not the root: the root's box changes when we scale it,
    // which would feed the observer its own output.
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [element, parent, children, scale, available, rows, gutter])

  const renderChild = (index: number) => {
    const child = children[index]
    return (
      <CascadeNode
        key={child.elementId}
        object={child}
        accent={BUCKET_COLOR.child}
        onSelect={onSelectElement}
      />
    )
  }

  return (
    <div ref={containerRef} className="w-full overflow-hidden">
      {/* Reserve the scaled height so the card doesn't keep dead space below,
          and centre the (unscaled-width) root inside the container. */}
      <div
        className="flex justify-center items-start"
        style={{ height: size.height ? size.height * scale : undefined }}
      >
        <div
          ref={rootRef}
          className="relative text-center py-1"
          style={{
            width: rootWidth,
            transform: `scale(${scale})`,
            transformOrigin: 'top center',
          }}
        >
          <svg
            className="absolute left-0 top-0 pointer-events-none overflow-visible"
            width={size.width}
            height={size.height}
            aria-hidden="true"
          >
            {lines.map((line, i) => (
              /* No shapeRendering="crispEdges": it snaps a 1.5px stroke to 1 or 2
                 device pixels depending on the coordinate's fraction, so lines
                 came out at visibly different widths. */
              <line
                key={i}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke={line.color}
                strokeDasharray={line.dash}
                strokeWidth={1.5}
              />
            ))}
          </svg>

          <div ref={parentRowRef} className="relative z-[1]" style={{ marginBottom: ROW_GAP }}>
            {parent ? (
              <CascadeNode object={parent} accent={BUCKET_COLOR.parent} onSelect={onSelectElement} />
            ) : (
              <span
                data-rt-node
                className="inline-flex items-center gap-2 border border-i3x-border rounded-xl px-4 py-2.5 align-top text-left"
                style={{ background: nodeFill(false) }}
              >
                <span className="flex flex-col min-w-0">
                  <span className="text-[13px] font-medium text-i3x-text-muted whitespace-nowrap">(none)</span>
                  <span className="font-mono text-[11px] text-i3x-text-muted whitespace-nowrap">root element</span>
                </span>
              </span>
            )}
          </div>

          <div ref={selfRowRef} className="relative z-[1]" style={{ marginBottom: ROW_GAP }}>
            <span
              data-rt-node
              className="inline-flex items-center gap-2 bg-i3x-primary/10 border border-i3x-primary rounded-xl px-4 py-2.5 align-top text-left"
              style={element.isComposition ? { borderStyle: 'dashed' } : undefined}
            >
              <span className="flex flex-col min-w-0">
                <span className="text-[13px] font-medium text-i3x-primary whitespace-nowrap">
                  {element.displayName}
                </span>
                <span className="font-mono text-[11px] text-i3x-text-muted whitespace-nowrap">
                  {element.typeId}
                </span>
              </span>
            </span>
          </div>

          <div ref={childrenRef} className="relative z-[1]">
            {children.length === 0 && (
              <p className="text-xs text-i3x-text-muted py-2">No child elements.</p>
            )}

            {/* Before the first measurement we have no widths, so lay the children
                out on one line and let the effect below pack them properly. */}
            {children.length > 0 && rows.length === 0 && (
              <div className="flex justify-center items-start" style={{ gap: CHILD_GAP }}>
                {children.map((_, index) => renderChild(index))}
              </div>
            )}

            {rows.map((row, rowIndex) => {
              const isLast = rowIndex === rows.length - 1
              // The vein stops at the last row's bus, so only the rows it passes
              // through need a channel held open for it.
              const needsGutter = gutter && !isLast
              const style = { gap: CHILD_GAP, marginTop: rowIndex === 0 ? 0 : ROW_GAP }

              if (!needsGutter) {
                return (
                  <div key={rowIndex} className="flex justify-center items-start" style={style}>
                    {row.map(renderChild)}
                  </div>
                )
              }

              // A 1fr | gutter | 1fr grid pins the channel to the row's centre —
              // which is the root's centre, which is where the vein runs. Centring
              // with flex would drift the gutter whenever the halves differ in width.
              const split = balancedSplit(row.map(i => metrics.childWidths[i]))
              return (
                <div
                  key={rowIndex}
                  className="grid items-start"
                  style={{ ...style, gridTemplateColumns: `1fr ${SPINE_GUTTER}px 1fr` }}
                >
                  <div className="flex justify-end items-start" style={{ gap: CHILD_GAP }}>
                    {row.slice(0, split).map(renderChild)}
                  </div>
                  <span aria-hidden="true" />
                  <div className="flex justify-start items-start" style={{ gap: CHILD_GAP }}>
                    {row.slice(split).map(renderChild)}
                  </div>
                </div>
              )
            })}
          </div>

          {hiddenChildren > 0 && (
            <p className="text-[11.5px] text-i3x-text-muted mt-3">
              +{hiddenChildren.toLocaleString()} more {hiddenChildren === 1 ? 'child' : 'children'} not
              shown — expand this element in the tree to see them all.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function sameNumbers(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 0.5) return false
  return true
}

function sameLines(a: Line[], b: Line[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    const q = b[i]
    if (p.x1 !== q.x1 || p.y1 !== q.y1 || p.x2 !== q.x2 || p.y2 !== q.y2 || p.color !== q.color || p.dash !== q.dash) {
      return false
    }
  }
  return true
}

/**
 * `accent` is the relationship colour: amber for the parent, green for children.
 * Composition objects get a dashed border and the recessed fill, matching the
 * legend. A CSS dashed border (rather than an SVG rect behind the box) keeps the
 * box a single element, so measurement and hit-testing stay simple.
 */
function CascadeNode({
  object,
  accent,
  onSelect,
}: {
  object: ObjectInstance
  accent: string
  onSelect: (elementId: string) => void
}) {
  return (
    <span data-rt-node className="inline-block align-top">
      <button
        type="button"
        onClick={() => onSelect(object.elementId)}
        title={object.elementId}
        className="inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-left transition-colors motion-reduce:transition-none hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
        style={{
          borderColor: accent,
          borderStyle: object.isComposition ? 'dashed' : 'solid',
          background: nodeFill(object.isComposition),
        }}
      >
        <span className="flex flex-col min-w-0">
          <span className="text-[13px] font-medium text-i3x-text whitespace-nowrap">
            {object.displayName}
          </span>
          <span className="font-mono text-[11px] text-i3x-text-muted whitespace-nowrap">
            {object.typeId}
          </span>
        </span>
      </button>
    </span>
  )
}
