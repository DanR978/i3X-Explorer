import type { EgoEdge, EgoGraph, EgoNode } from './egoGraph'

/**
 * Radial layout for an ego graph: the root at the center, one concentric ring
 * per hop. Distance from the center IS the depth, which is the whole point of a
 * configurable-depth view (a force blob would place a 3-hop node anywhere).
 *
 * Angles come from a weighted sector allocation down the BFS tree: each node
 * hands its children a slice of its own sector, sized by how many descendants
 * each carries. Siblings therefore stay together and tree edges never cross.
 * Non-tree edges (a node reachable two ways) are drawn as chords across the
 * rings, since those crossings are real information, not layout noise.
 *
 * Pure and deterministic: same graph in, same picture out, no simulation and no
 * jitter between renders.
 */

export interface PositionedNode extends EgoNode {
  x: number
  y: number
  /** Circle radius in diagram units. */
  radius: number
  /** Bearing from the center, in radians. Labels are pushed out along it. */
  angle: number
  degree: number
  /** Always true now: every node renders its name. Kept so the renderer stays generic. */
  showLabel: boolean
}

export interface PositionedEdge extends EgoEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface RadialLayout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  /** The drawing spans [-extent, extent] on both axes. */
  extent: number
}

/** The first ring sits out far enough that the root's label has room. */
const FIRST_RING = 150

/** Gap between rings, *before* the extra room added to clear the widest label. */
const RING_GAP_BASE = 64

/** Floor on the arc each node gets: its circle plus a small gap, even with no label. */
const MIN_ARC = 46

/**
 * Every node is labeled, so a crowded ring has to spread or the names stack on
 * top of each other. Each node reserves this fraction of its label's width as
 * tangential room. Full width would over-spread the ring's sides, where labels
 * stack vertically and only need their height. LABEL_GAP is the breathing room
 * on top of that. Bigger names give wider rings, so the layout sizes itself to
 * its own text.
 */
const LABEL_SPREAD = 0.7
const LABEL_GAP = 16

/** Slack outside the last ring so its (outward) labels aren't clipped. */
const LABEL_PAD = 30

const ROOT_RADIUS = 11
const MIN_NODE_RADIUS = 4.5
const MAX_NODE_RADIUS = 10

/** Longest label drawn, in characters. Must match truncateLabel in the renderer. */
export const MAX_LABEL_CHARS = 24

/** Approx width of one label character at fontSize 11, in diagram units. */
const CHAR_WIDTH = 6.4

export function layoutRadial(graph: EgoGraph): RadialLayout {
  const root = graph.nodes.find(node => node.depth === 0)
  if (!root) return { nodes: [], edges: [], extent: 1 }

  const rootId = root.object.elementId

  const degree = new Map<string, number>()
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  // The BFS tree: `via` is the node each one was first reached from. Children keep
  // their discovery order, which egoGraph sorts by relationship bucket then name,
  // so a ring reads parent-ish, then children, then references, going clockwise.
  const children = new Map<string, string[]>()
  for (const node of graph.nodes) {
    if (!node.via) continue
    const siblings = children.get(node.via)
    if (siblings) siblings.push(node.object.elementId)
    else children.set(node.via, [node.object.elementId])
  }

  // Subtree size, deepest first so a node's children are always already weighted.
  const weight = new Map<string, number>()
  for (const node of [...graph.nodes].sort((a, b) => b.depth - a.depth)) {
    const id = node.object.elementId
    const kids = children.get(id) ?? []
    weight.set(
      id,
      kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + (weight.get(kid) ?? 1), 0)
    )
  }

  let maxDepth = 0
  const perRing: number[] = []
  for (const node of graph.nodes) {
    perRing[node.depth] = (perRing[node.depth] ?? 0) + 1
    if (node.depth > maxDepth) maxDepth = node.depth
  }

  // Label-aware spacing. Every label is drawn, so spacing is sized from the actual
  // text: the widest label on each ring drives how far that ring spreads, and the
  // widest label anywhere drives the gap between rings (so an outward-pointing
  // label never lands on the next ring out). Short names ⇒ tight; long names ⇒ airy.
  const labelWidth = (node: EgoNode) =>
    Math.min(node.object.displayName.length, MAX_LABEL_CHARS) * CHAR_WIDTH

  let maxLabelWidth = 0
  const ringLabelWidth: number[] = []
  for (const node of graph.nodes) {
    const width = labelWidth(node)
    if (width > maxLabelWidth) maxLabelWidth = width
    if (width > (ringLabelWidth[node.depth] ?? 0)) ringLabelWidth[node.depth] = width
  }
  const ringGap = RING_GAP_BASE + maxLabelWidth

  // Each ring clears the one inside it (with room for its labels), and is wide
  // enough that every node gets its own arc for circle plus label, so a crowded
  // ring grows outward instead of stacking names.
  const radii: number[] = [0]
  for (let depth = 1; depth <= maxDepth; depth++) {
    const arcPerNode = Math.max(MIN_ARC, (ringLabelWidth[depth] ?? 0) * LABEL_SPREAD + LABEL_GAP)
    const crowded = (perRing[depth] * arcPerNode) / (2 * Math.PI)
    radii[depth] = Math.max(radii[depth - 1] + ringGap, crowded, depth === 1 ? FIRST_RING : 0)
  }

  const angles = new Map<string, number>([[rootId, 0]])
  // Start at 12 o'clock (SVG y grows downward, so -π/2 is up).
  assignSectors(rootId, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, children, weight, angles)

  const nodes: PositionedNode[] = graph.nodes.map(node => {
    const id = node.object.elementId
    const angle = angles.get(id) ?? 0
    const ring = radii[node.depth] ?? 0
    const links = degree.get(id) ?? 0
    return {
      ...node,
      x: Math.cos(angle) * ring,
      y: Math.sin(angle) * ring,
      angle,
      degree: links,
      radius:
        node.depth === 0
          ? ROOT_RADIUS
          : Math.min(MIN_NODE_RADIUS + Math.sqrt(links) * 1.6, MAX_NODE_RADIUS),
      // Every node is labeled. The crowded-ring suppression is gone, names always render.
      showLabel: true,
    }
  })

  const positions = new Map(nodes.map(node => [node.object.elementId, node]))
  const edges: PositionedEdge[] = []
  for (const edge of graph.edges) {
    const from = positions.get(edge.source)
    const to = positions.get(edge.target)
    if (!from || !to) continue
    edges.push({ ...edge, x1: from.x, y1: from.y, x2: to.x, y2: to.y })
  }

  const outer = radii[maxDepth] ?? 0
  const extent = outer + maxLabelWidth + LABEL_PAD

  return { nodes, edges, extent: Math.max(extent, FIRST_RING) }
}

/** Hands each child a slice of [start, end) proportional to its subtree, and centers it there. */
function assignSectors(
  id: string,
  start: number,
  end: number,
  children: Map<string, string[]>,
  weight: Map<string, number>,
  angles: Map<string, number>
): void {
  const kids = children.get(id)
  if (!kids || kids.length === 0) return

  const total = kids.reduce((sum, kid) => sum + (weight.get(kid) ?? 1), 0) || 1
  let cursor = start

  for (const kid of kids) {
    const span = ((end - start) * (weight.get(kid) ?? 1)) / total
    angles.set(kid, cursor + span / 2)
    // Depth is capped at MAX_EGO_DEPTH, so this recursion can't run away.
    assignSectors(kid, cursor, cursor + span, children, weight, angles)
    cursor += span
  }
}
