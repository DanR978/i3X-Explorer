import type { I3XClient } from '../../api/client'
import type { ObjectInstance } from '../../api/types'
import { bucketOf, type RelationshipBucket } from './relationshipColors'

/**
 * The ego graph: everything reachable from one element within N relationship
 * hops. This is what makes the Relationships tab worth having. A single hop is
 * just the list rendered as circles; the structure only appears past the first
 * level.
 *
 * Edges come from POST /objects/related, which returns all relationship kinds
 * (compositional and not). Walking it breadth-first gives depth N in N round
 * trips, because the v1 client can ask for a whole frontier in one call
 * (getRelatedObjectsBatch). v0 has no batch form and falls back to a throttled
 * fan-out.
 */

/** How some object is related to a neighbor of it. */
export interface Neighbor {
  object: ObjectInstance
  /** The server's relationship type, e.g. HasComponent / Monitors. */
  relationshipType?: string
}

export interface EgoNode {
  object: ObjectInstance
  /** Hops from the root; 0 is the root itself. */
  depth: number
  /** The node this one was first reached from (the BFS tree edge). Root: undefined. */
  via?: string
}

export interface EgoEdge {
  /**
   * The endpoint the edge was discovered FROM, which BFS guarantees is the
   * shallower of the two. So an edge always reads outward from the root, and its
   * bucket is the relationship as seen from the inner node.
   */
  source: string
  target: string
  relationshipType?: string
  bucket: RelationshipBucket
}

export interface EgoGraph {
  nodes: EgoNode[]
  edges: EgoEdge[]
}

/** The slices of the explorer store the walk reads. */
export interface StoreView {
  objectIndex: Map<string, ObjectInstance>
  childrenByParent: Map<string, ObjectInstance[]>
}

/** v0 has no batch endpoint, so a wide frontier becomes many requests. Don't open them all at once. */
const V0_CONCURRENCY = 6

/** Rank used to order relationships consistently in both the graph and the list. */
const BUCKET_ORDER: Record<RelationshipBucket, number> = {
  parent: 0,
  child: 1,
  inherits: 2,
  other: 3,
}

/**
 * Every direct relationship of `object`: what the server returned, unioned with
 * the compositional parent and children the store already knows.
 *
 * The union matters because servers differ in what /objects/related reports:
 * some omit the hierarchy, some omit everything else. The API entry wins on
 * conflict: it carries the true sourceRelationship, where the store can only
 * infer HasParent/HasComponent from parentId.
 */
export function directNeighbors(
  object: ObjectInstance,
  related: ObjectInstance[],
  store: StoreView
): Neighbor[] {
  const byId = new Map<string, Neighbor>()

  for (const neighbor of related) {
    if (neighbor.elementId === object.elementId) continue
    byId.set(neighbor.elementId, {
      object: neighbor,
      relationshipType: neighbor.sourceRelationship,
    })
  }

  const parentId = object.parentId && object.parentId !== '/' ? object.parentId : null
  const parent = parentId ? store.objectIndex.get(parentId) : undefined
  if (parent && !byId.has(parent.elementId)) {
    byId.set(parent.elementId, { object: parent, relationshipType: 'HasParent' })
  }

  for (const child of store.childrenByParent.get(object.elementId) ?? []) {
    if (child.elementId === object.elementId) continue
    if (!byId.has(child.elementId)) {
      byId.set(child.elementId, { object: child, relationshipType: 'HasComponent' })
    }
  }

  return sortNeighbors([...byId.values()])
}

/** Parent first, then children, then inheritance, then the rest; alphabetical within a bucket. */
export function sortNeighbors(neighbors: Neighbor[]): Neighbor[] {
  return [...neighbors].sort((a, b) => {
    const rank = BUCKET_ORDER[bucketOf(a.relationshipType)] - BUCKET_ORDER[bucketOf(b.relationshipType)]
    if (rank !== 0) return rank
    return a.object.displayName.localeCompare(b.object.displayName)
  })
}

/**
 * One line per pair per relationship family.
 *
 * HasComponent(A→B) and ComponentOf(B→A) are one physical edge seen from both
 * ends, so both land on the same `hier` key and only the first survives (the one
 * discovered from the shallower node). Without this, every hierarchy edge would
 * be drawn twice, in two different colors, once the walk reached its far end.
 */
export function edgeKey(a: string, b: string, bucket: RelationshipBucket): string {
  const family = bucket === 'parent' || bucket === 'child' ? 'hier' : bucket
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo}\u0000${hi}\u0000${family}`
}

/** Neighbors for a whole BFS frontier: one round trip on v1, a throttled fan-out on v0. */
async function fetchFrontier(
  client: I3XClient,
  ids: string[]
): Promise<Map<string, ObjectInstance[]>> {
  if (ids.length === 0) return new Map()

  if (client.getApiVersion() !== 'v0') {
    return client.getRelatedObjectsBatch(ids)
  }

  const out = new Map<string, ObjectInstance[]>()
  for (let i = 0; i < ids.length; i += V0_CONCURRENCY) {
    const slice = ids.slice(i, i + V0_CONCURRENCY)
    // One unreachable object must not sink the whole level.
    const results = await Promise.all(
      slice.map(id => client.getRelatedObjects(id).catch(() => [] as ObjectInstance[]))
    )
    slice.forEach((id, index) => out.set(id, results[index]))
  }
  return out
}

/**
 * Walk `depth` hops out from `root`.
 *
 * `cancelled` is checked after every level so a depth change or a navigation
 * mid-walk abandons the remaining round trips rather than resolving into a
 * component that has moved on.
 */
export async function expandEgoGraph({
  client,
  root,
  depth,
  store,
  cancelled = () => false,
}: {
  client: I3XClient
  root: ObjectInstance
  depth: number
  store: StoreView
  cancelled?: () => boolean
}): Promise<EgoGraph> {
  const nodes = new Map<string, EgoNode>([[root.elementId, { object: root, depth: 0 }]])
  const edges: EgoEdge[] = []
  const seen = new Set<string>()

  let frontier: ObjectInstance[] = [root]

  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const related = await fetchFrontier(client, frontier.map(object => object.elementId))
    if (cancelled()) break

    const next: ObjectInstance[] = []

    for (const source of frontier) {
      const neighbors = directNeighbors(source, related.get(source.elementId) ?? [], store)

      for (const neighbor of neighbors) {
        const id = neighbor.object.elementId

        if (!nodes.has(id)) {
          nodes.set(id, { object: neighbor.object, depth: level, via: source.elementId })
          next.push(neighbor.object)
        }

        const bucket = bucketOf(neighbor.relationshipType)
        const key = edgeKey(source.elementId, id, bucket)
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          source: source.elementId,
          target: id,
          relationshipType: neighbor.relationshipType,
          bucket,
        })
      }
    }

    frontier = next
  }

  return { nodes: [...nodes.values()], edges }
}
