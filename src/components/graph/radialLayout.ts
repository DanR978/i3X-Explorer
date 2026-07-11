import type { EgoEdge, EgoGraph, EgoNode } from './egoGraph'

/**
 * Radial layout for an ego graph: the root at the centre, one concentric ring
 * per hop. Distance from the centre IS the depth, which is the whole point of a
 * configurable-depth view — a force blob would place a 3-hop node anywhere.
 *
 * Angles come from a weighted sector allocation down the BFS tree: each node
 * hands its children a slice of its own sector, sized by how many descendants
 * each carries. Siblings therefore stay together and tree edges never cross.
 * Non-tree edges (a node reachable two ways) are drawn as chords across the
 * rings — those crossings are real information, not layout noise.
 *
 * Pure and deterministic: same graph in, same picture out, no simulation and no
 * jitter between renders.
 */

export interface PositionedNode extends EgoNode {
  x: number
  y: number
  /** Circle radius in diagram units. */
  radius: number
  /** Bearing from the centre, radians — labels are pushed out along it. */
  angle: number
  degree: number
  /** False on rings too crowded to label; those nodes rely on hover. */
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
const FIRST_RING = 135
const RING_GAP = 115

/** Circumference each node needs to itself. A crowded ring grows rather than overlapping. */
const MIN_ARC = 30

/** A ring is only labelled when its nodes have this much arc each; below it, labels would collide. */
const LABEL_ARC = 66

const ROOT_RADIUS = 11
const MIN_NODE_RADIUS = 4.5
const MAX_NODE_RADIUS = 10

/** Room outside the last ring for its labels (or just the node circles when unlabelled). */
const LABEL_MARGIN = 150
const PLAIN_MARGIN = 46

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
  // their discovery order, which egoGraph sorts by relationship bucket then name —
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

  // Each ring clears the one inside it, and is wide enough that its nodes get
  // MIN_ARC of circumference each.
  const radii: number[] = [0]
  for (let depth = 1; depth <= maxDepth; depth++) {
    const crowded = (perRing[depth] * MIN_ARC) / (2 * Math.PI)
    radii[depth] = Math.max(radii[depth - 1] + RING_GAP, crowded, depth === 1 ? FIRST_RING : 0)
  }

  const angles = new Map<string, number>([[rootId, 0]])
  // Start at 12 o'clock (SVG y grows downward, so -π/2 is up).
  assignSectors(rootId, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, children, weight, angles)

  const labelled: boolean[] = []
  for (let depth = 1; depth <= maxDepth; depth++) {
    labelled[depth] = (2 * Math.PI * radii[depth]) / perRing[depth] >= LABEL_ARC
  }

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
      showLabel: node.depth === 0 || labelled[node.depth] === true,
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
  const extent = outer + (labelled[maxDepth] ? LABEL_MARGIN : PLAIN_MARGIN)

  return { nodes, edges, extent: Math.max(extent, FIRST_RING) }
}

/** Hands each child a slice of [start, end) proportional to its subtree, and centres it there. */
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
