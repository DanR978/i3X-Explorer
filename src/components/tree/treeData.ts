import { getClient, type I3XClient } from '../../api/client'
import {
  useExplorerStore,
  CHILD_PAGE_SIZE,
  CHILD_PAGE_SLACK,
  REL_PREFIX,
  type SelectedItem,
  type TreeStructure,
} from '../../stores/explorer'
import type { Namespace, ObjectType, ObjectInstance, RelationshipType } from '../../api/types'
import { directNeighbors, type Neighbor } from '../graph/egoGraph'
import type { RelationshipBucket } from '../graph/relationshipColors'
import {
  groupNeighbors,
  planGroupExpansion,
  relAncestorRowIds,
  relChildPath,
  relGroupRowId,
  relPathIds,
  relRowId,
} from './relationshipTree'

// Special folder IDs
export const NAMESPACES_FOLDER_ID = 'folder:namespaces'
export const OBJECTS_FOLDER_ID = 'folder:objects'
export const HIERARCHICAL_FOLDER_ID = 'folder:hierarchical'

// Max depth for tree rendering to prevent infinite loops
export const MAX_TREE_DEPTH = 20

// Fallback row height until the real one is measured from the first mounted row.
export const ESTIMATED_ROW_HEIGHT = 28

// Resolve chevron state for a set of compositional parents by asking the server
// what /objects/related actually returns, i.e. the same data the render filter
// sees at expansion time. Single batch round trip; only unresolved isComposition
// objects are queried, so callers can pass a superset cheaply.
export async function resolveCompositionFlags(client: I3XClient, loaded: ObjectInstance[]): Promise<void> {
  if (loaded.length === 0) return
  const { compositionCache, mergeCompositionFlags } = useExplorerStore.getState()
  const toResolve: string[] = []
  for (const obj of loaded) {
    if (obj.isComposition && !compositionCache.has(obj.elementId)) {
      toResolve.push(obj.elementId)
    }
  }
  if (toResolve.length === 0) return
  const additions = new Map<string, number>()
  try {
    const related = await client.getRelatedObjectsBatch(toResolve, 'HasComponent')
    for (const parentId of toResolve) {
      const children = related.get(parentId) ?? []
      const qualifyingCount = children.filter(c =>
        c.isComposition && c.elementId !== parentId && c.parentId === parentId
      ).length
      additions.set(parentId, qualifyingCount)
    }
  } catch (err) {
    console.error('Failed to resolve composition flags via /objects/related:', err)
  }
  if (additions.size > 0) mergeCompositionFlags(additions)
}

/**
 * The relationship-walk counterpart to resolveCompositionFlags: ask the server,
 * in one batch, who each of these objects is actually connected to, and cache
 * the neighbour ids so their chevrons and counts stop being guesses.
 *
 * Called for the rows currently on screen, never for the whole catalog: a single
 * batch over tens of thousands of objects is slow and can fail outright, and the
 * answer is only needed for what someone is looking at.
 */
export async function resolveRelationshipFlags(client: I3XClient, loaded: ObjectInstance[]): Promise<void> {
  if (loaded.length === 0) return
  const { relatedNeighborIds, objectIndex, childrenByParent, mergeRelatedNeighborIds } = useExplorerStore.getState()
  const toResolve: ObjectInstance[] = []
  for (const obj of loaded) {
    if (!relatedNeighborIds.has(obj.elementId)) toResolve.push(obj)
  }
  if (toResolve.length === 0) return
  try {
    const related = await client.getRelatedObjectsBatch(toResolve.map(o => o.elementId))
    if (related.size === 0) return
    const store = { objectIndex, childrenByParent }
    mergeRelatedNeighborIds(
      toResolve.map(obj => [
        obj.elementId,
        directNeighbors(obj, related.get(obj.elementId) ?? [], store).map(n => n.object.elementId),
      ] as [string, string[]])
    )
  } catch (err) {
    console.error('Failed to resolve relationships via /objects/related:', err)
  }
}

// Coalesce + throttle full "all objects" refetches. Expanding a hierarchy node
// refetches the entire object set to surface dynamically-discovered objects
// (e.g. MQTT topics arriving over time). On large catalogs that full refetch is
// expensive, so rapid navigation shares one in-flight request and skips
// refetches that ran within a short window. Folder opens and the periodic
// background poll pass force=true, so freshness is still guaranteed.
//
// Composition chevrons are resolved lazily for the visible window (see
// TreeView), never for the whole catalog here, a single batch over
// tens of thousands of objects is slow and can fail, leaving chevrons wrong.
const ALL_OBJECTS_REFETCH_TTL_MS = 3000
let allObjectsFetchedAt = 0
let allObjectsInFlight: Promise<void> | null = null

export async function refreshAllObjects(client: I3XClient, force = false): Promise<void> {
  if (allObjectsInFlight) return allObjectsInFlight
  if (!force && Date.now() - allObjectsFetchedAt < ALL_OBJECTS_REFETCH_TTL_MS) return
  allObjectsInFlight = (async () => {
    try {
      const objects = await client.getObjects()
      useExplorerStore.getState().setAllObjects(objects)
      allObjectsFetchedAt = Date.now()
    } finally {
      allObjectsInFlight = null
    }
  })()
  return allObjectsInFlight
}

// Chevron predicate: consult the compositionCache, which holds the actual child
// count resolved via batched /objects/related. If we haven't resolved this
// object yet, fall back to its isComposition flag (chevron may show momentarily
// until the resolver lands).
export function hasCompositionChildren(obj: ObjectInstance, cache: Map<string, number>): boolean {
  if (!obj.isComposition) return false
  const cached = cache.get(obj.elementId)
  return cached === undefined ? true : cached > 0
}

// Get display label for an object, handling special cases like root "/"
export function getObjectLabel(obj: ObjectInstance): string {
  if (obj.displayName && obj.displayName.trim()) {
    return obj.displayName
  }
  // Fallback to elementId for objects with empty displayName (e.g., root "/")
  return obj.elementId
}

// Per the i3X Implementation Guide: schema.type is the sole authoritative leaf
// signal. A scalar type (number/integer/string/boolean) is a leaf "variable";
// everything else is a branch object. schema.type may be a union array
// (e.g. ["number","null"]): treat as leaf if any member is scalar. Shared by
// the tree row icons and the search modal so the two can never disagree.
const SCALAR_TYPES = new Set(['number', 'integer', 'string', 'boolean'])
export function isScalarSchemaType(raw: unknown): boolean {
  const schemaType = Array.isArray(raw)
    ? (raw as string[]).find(t => SCALAR_TYPES.has(t)) ?? ''
    : String(raw ?? '')
  return SCALAR_TYPES.has(schemaType)
}

// ── Flattened tree rows ─────────────────────────────────────────────────────
// The ENTIRE sidebar tree (Namespaces, Objects, Hierarchy) is flattened into
// one ordered array of uniform-height rows and windowed by a single
// virtualizer in TreeView. Nothing renders recursively: a hierarchy node with
// 20k children costs the same DOM as one with 2. Rows carry a parentIndex so
// the sticky ancestor header can walk up from any visible row in O(depth).

export interface NodeRow {
  kind: 'node'
  key: string
  /** Expansion/selection id: 'folder:…', 'ns:…', 'type:…', 'obj:…', 'hier:…', 'rel:…', 'relgrp:…'. */
  id: string
  nodeType: 'folder' | 'namespace' | 'objectType' | 'object' | 'relGroup'
  label: string
  data?: Namespace | ObjectType | ObjectInstance
  depth: number
  hasChildren: boolean
  isExpanded: boolean
  count?: number
  /** True when the count reflects filter matches rather than totals. */
  filtered?: boolean
  /** Relationship bucket, on 'relGroup' rows: colors the group's marker. */
  bucket?: RelationshipBucket
  /** Index of the parent row within the flattened array; -1 at the root. */
  parentIndex: number
}

export interface MarkerRow {
  kind: 'marker'
  key: string
  depth: number
  message: string
  parentIndex: number
}

/**
 * "Show N more" row, emitted when a parent's child list is paged. The paging
 * exists for the reader, not the renderer: virtualization makes 20k rows cheap
 * to draw, but they still bury the parent's siblings under a scroll marathon.
 */
export interface MoreRow {
  kind: 'more'
  key: string
  depth: number
  /** Node id whose child list is truncated (the childPageLimits key). */
  parentId: string
  shown: number
  hidden: number
  parentIndex: number
}

export type TreeRow = NodeRow | MarkerRow | MoreRow

export interface TreeBuildInput {
  namespaces: Namespace[]
  objectTypes: ObjectType[]
  /** Objects fetched per object type, keyed by typeId (loaded on type expand). */
  objectsByType: Map<string, ObjectInstance[]>
  allObjects: ObjectInstance[]
  hierarchicalRoots: ObjectInstance[]
  /** Compositional children fetched via /objects/related, keyed by parent. */
  childObjects: Map<string, ObjectInstance[]>
  /** parentId index over allObjects (store-maintained). */
  childrenByParent: Map<string, ObjectInstance[]>
  compositionCache: Map<string, number>
  expandedNodes: Set<string>
  childPageLimits: Map<string, number>
  /** Lowercased filter text; '' disables filtering. */
  filterText: string
  /** Current selection (store id). Rows on its path are exempt from paging. */
  selectedId: string | null
  /** elementId index over allObjects (store-maintained), for ancestor walks. */
  objectIndex: Map<string, ObjectInstance>
  /** elementId → pre-lowercased filter blob (store-maintained). */
  searchIndex: Map<string, string>
  /** How the third folder nests: by parentId, or by every reported relationship. */
  treeStructure: TreeStructure
  /** elementId → raw /objects/related payload, fetched on expand. */
  relatedObjects: Map<string, ObjectInstance[]>
  /** elementId → its neighbours' ids, resolved for on-screen rows (chevrons). */
  relatedNeighborIds: Map<string, string[]>
  /** Declared relationship types, for group labels. */
  relationshipTypeIndex: Map<string, RelationshipType>
}

/**
 * Produce the ordered, visible rows of the whole sidebar tree: expansion,
 * filtering (with ancestor keep-alive), per-parent paging, and cycle/depth
 * guards all resolve here, in one pure pass over store data. TreeView memoizes
 * the result and only windows it.
 */
export function buildTreeRows(input: TreeBuildInput): TreeRow[] {
  const {
    namespaces, objectTypes, objectsByType, allObjects, hierarchicalRoots,
    childObjects, childrenByParent, compositionCache, expandedNodes,
    childPageLimits, filterText, selectedId, objectIndex, searchIndex,
    treeStructure, relatedObjects, relatedNeighborIds, relationshipTypeIndex,
  } = input

  const rows: TreeRow[] = []
  const isExpanded = (id: string) => expandedNodes.has(id)

  // Prebuilt blob when the object came through allObjects (the common case);
  // inline lowercasing only for objects fetched via other endpoints.
  const objMatches = (obj: ObjectInstance) => {
    const blob = searchIndex.get(obj.elementId)
    if (blob !== undefined) return blob.includes(filterText)
    return (
      obj.displayName.toLowerCase().includes(filterText) ||
      obj.elementId.toLowerCase().includes(filterText) ||
      obj.namespaceUri.toLowerCase().includes(filterText)
    )
  }

  // Filter support sets. To make deep matches surface their ancestors:
  //   matchingTypeIds: type IDs with ≥1 matching object (keeps the type and its
  //     parent namespace visible even when their own names don't match)
  //   hierarchyVisibleIds: every match plus every ancestor up the parentId chain
  //   matchedNamespaceUris: namespace URIs reached transitively via matching
  //     types/objects
  const matchingTypeIds = new Set<string>()
  const hierarchyVisibleIds = new Set<string>()
  const matchedNamespaceUris = new Set<string>()
  let matchTotal = 0
  if (filterText) {
    for (const obj of allObjects) {
      if (!objMatches(obj)) continue
      matchTotal++
      matchingTypeIds.add(obj.typeId)
      let cur: ObjectInstance | undefined = obj
      while (cur && !hierarchyVisibleIds.has(cur.elementId)) {
        hierarchyVisibleIds.add(cur.elementId)
        cur = cur.parentId ? objectIndex.get(cur.parentId) : undefined
      }
    }
    for (const type of objectTypes) {
      const typeMatches =
        type.displayName.toLowerCase().includes(filterText) ||
        type.elementId.toLowerCase().includes(filterText) ||
        matchingTypeIds.has(type.elementId)
      if (typeMatches) matchedNamespaceUris.add(type.namespaceUri)
    }
  }

  // Per-parent paging. Trivial overflows are not truncated (a "Show 12 more"
  // row costs more attention than the 12 rows it hides).
  const pageLimit = (parentId: string, total: number) => {
    const limit = childPageLimits.get(parentId) ?? CHILD_PAGE_SIZE
    return total <= limit + CHILD_PAGE_SLACK ? total : Math.min(limit, total)
  }

  // Rows on the path to the current selection are exempt from paging: reveal
  // (a search jump, Back/Forward) must always find the selected row, even at
  // position 1,200 of a paged child list. The exempt entry is emitted after
  // the "Show more" row, out of sequence, but present and scrollable-to.
  const mustShowIds = new Set<string>()
  if (selectedId) {
    mustShowIds.add(selectedId)
    const prefix = selectedId.startsWith('hier:') ? 'hier:'
      : selectedId.startsWith('obj:') ? 'obj:' : null
    if (selectedId.startsWith(REL_PREFIX)) {
      // A relationship row's ancestors are the prefixes of its path, so no
      // parentId walk is needed (and none would be right: the path may have
      // arrived through "feeds" edges that parentId knows nothing about).
      for (const id of relAncestorRowIds(selectedId.slice(REL_PREFIX.length))) {
        mustShowIds.add(id)
      }
    } else if (prefix) {
      // Every ancestor up the parentId chain, so a deep selection can't have
      // an ancestor paged out from under it either.
      const visited = new Set<string>()
      let current = objectIndex.get(selectedId.slice(prefix.length))
      while (current?.parentId && current.parentId !== '/' && !visited.has(current.elementId)) {
        visited.add(current.elementId)
        const parent = objectIndex.get(current.parentId)
        if (!parent) break
        mustShowIds.add(`${prefix}${parent.elementId}`)
        current = parent
      }
    } else if (selectedId.startsWith('type:')) {
      const type = objectTypes.find(t => `type:${t.elementId}` === selectedId)
      if (type) mustShowIds.add(`ns:${type.namespaceUri}`)
    }
  }

  // Emit the paged-out entries of a truncated list that are on the selection
  // path. Scans only the hidden tail, and only while something is selected.
  const emitForced = <T,>(list: T[], limit: number, idOf: (item: T) => string, emit: (item: T) => void) => {
    if (limit >= list.length || mustShowIds.size === 0) return
    for (let i = limit; i < list.length; i++) {
      if (mustShowIds.has(idOf(list[i]))) emit(list[i])
    }
  }
  const pushMore = (parentId: string, parentKey: string, depth: number, shown: number, total: number, parentIndex: number) => {
    rows.push({
      kind: 'more', key: `${parentKey}#more`, depth, parentId,
      shown, hidden: total - shown, parentIndex,
    })
  }
  const pushMarker = (key: string, depth: number, message: string, parentIndex: number) => {
    rows.push({ kind: 'marker', key, depth, message, parentIndex })
  }

  // ── Composition walk ('obj:' ids): objects under a type node and the flat
  // Objects folder, expanding through fetched compositional children.
  const walkObj = (obj: ObjectInstance, depth: number, ancestors: Set<string>, path: string, parentIndex: number) => {
    const key = `${path}/${obj.elementId}`
    if (depth > MAX_TREE_DEPTH || ancestors.has(obj.elementId)) {
      pushMarker(`${key}#stop`, depth, ancestors.has(obj.elementId) ? '(cycle detected)' : '(max depth reached)', parentIndex)
      return
    }
    const id = `obj:${obj.elementId}`
    const children = childObjects.get(obj.elementId) ?? []
    const cachedCount = compositionCache.get(obj.elementId)
    const childCount = children.length > 0 ? children.length : cachedCount
    const expanded = isExpanded(id)
    const index = rows.length
    rows.push({
      kind: 'node', key, id, nodeType: 'object', label: getObjectLabel(obj),
      data: obj, depth, hasChildren: hasCompositionChildren(obj, compositionCache),
      isExpanded: expanded,
      count: childCount && childCount > 0 ? childCount : undefined,
      parentIndex,
    })
    if (!expanded || children.length === 0) return
    const visible = filterText ? children.filter(objMatches) : children
    const limit = pageLimit(id, visible.length)
    const childAncestors = new Set(ancestors)
    childAncestors.add(obj.elementId)
    for (let i = 0; i < limit; i++) walkObj(visible[i], depth + 1, childAncestors, key, index)
    if (limit < visible.length) pushMore(id, key, depth + 1, limit, visible.length, index)
    emitForced(visible, limit, c => `obj:${c.elementId}`, c => walkObj(c, depth + 1, childAncestors, key, index))
  }

  // ── Hierarchy walk ('hier:' ids): parent/child structure derived from the
  // store's parentId index, no per-node fetches.
  const walkHier = (obj: ObjectInstance, depth: number, ancestors: Set<string>, path: string, parentIndex: number) => {
    const key = `${path}/${obj.elementId}`
    if (depth > MAX_TREE_DEPTH || ancestors.has(obj.elementId)) {
      pushMarker(`${key}#stop`, depth, ancestors.has(obj.elementId) ? '(cycle detected)' : '(max depth reached)', parentIndex)
      return
    }
    const id = `hier:${obj.elementId}`
    const children = childrenByParent.get(obj.elementId) ?? []
    const expanded = isExpanded(id)
    const index = rows.length
    rows.push({
      kind: 'node', key, id, nodeType: 'object', label: getObjectLabel(obj),
      data: obj, depth, hasChildren: children.length > 0, isExpanded: expanded,
      count: children.length > 0 ? children.length : undefined,
      parentIndex,
    })
    if (!expanded || children.length === 0) return
    const visible = filterText ? children.filter(c => hierarchyVisibleIds.has(c.elementId)) : children
    const limit = pageLimit(id, visible.length)
    const childAncestors = new Set(ancestors)
    childAncestors.add(obj.elementId)
    for (let i = 0; i < limit; i++) walkHier(visible[i], depth + 1, childAncestors, key, index)
    if (limit < visible.length) pushMore(id, key, depth + 1, limit, visible.length, index)
    emitForced(visible, limit, c => `hier:${c.elementId}`, c => walkHier(c, depth + 1, childAncestors, key, index))
  }

  // ── Relationship walk ('rel:' ids): every edge the server reports, grouped
  // by relationship type. Unlike the two walks above, this one is a graph
  // flattened into a tree, so it carries a path (its identity, and the set of
  // objects its children are filtered against) and a hop count separate from the
  // row depth, since group rows consume depth without being a hop.
  const relStore = { objectIndex, childrenByParent }

  const walkRel = (
    obj: ObjectInstance,
    depth: number,
    hops: number,
    /** Every element on this branch, including `obj`. Its children exclude these. */
    branch: Set<string>,
    /** Full path INCLUDING this object; also its row id. */
    path: string,
    parentIndex: number
  ) => {
    const id = relRowId(path)
    const key = `rel/${path}`
    const index = rows.length
    const exhausted = hops >= MAX_TREE_DEPTH

    // Neighbours are only known once the row has been expanded and fetched.
    // Until then the chevron is optimistic (corrected within a frame or two by
    // the on-screen resolver), because a missing chevron hides a real
    // relationship, while a spurious one costs a click.
    const expanded = isExpanded(id)
    const related = exhausted || !expanded ? undefined : relatedObjects.get(obj.elementId)

    const groups = related
      ? groupNeighbors(
          directNeighbors(obj, related, relStore).filter(n =>
            !branch.has(n.object.elementId) && (!filterText || objMatches(n.object))
          ),
          relationshipTypeIndex
        )
      : null

    let shown: number | undefined
    if (groups) {
      shown = 0
      for (const group of groups) shown += group.neighbors.length
    } else if (!exhausted) {
      const known = relatedNeighborIds.get(obj.elementId)
      if (known) shown = known.reduce((n, nid) => (branch.has(nid) ? n : n + 1), 0)
    }

    rows.push({
      kind: 'node', key, id, nodeType: 'object', label: getObjectLabel(obj),
      data: obj, depth,
      hasChildren: exhausted ? false : shown === undefined || shown > 0,
      isExpanded: expanded,
      count: shown && shown > 0 ? shown : undefined,
      parentIndex,
    })
    if (exhausted) {
      pushMarker(`${key}#stop`, depth + 1, '(max depth reached)', index)
      return
    }
    if (!groups || shown === 0) return

    /** Emit one group's neighbours as rows, paged under `pageKey`. */
    const emitMembers = (
      neighbors: Neighbor[],
      childDepth: number,
      pageKey: string,
      ownerIndex: number
    ) => {
      const limit = pageLimit(pageKey, neighbors.length)
      const emit = (neighbor: Neighbor) => {
        const childPath = relChildPath(path, neighbor.object.elementId)
        const childBranch = new Set(branch)
        childBranch.add(neighbor.object.elementId)
        walkRel(neighbor.object, childDepth, hops + 1, childBranch, childPath, ownerIndex)
      }
      for (let i = 0; i < limit; i++) emit(neighbors[i])
      if (limit < neighbors.length) {
        pushMore(pageKey, `${key}#${pageKey}`, childDepth, limit, neighbors.length, ownerIndex)
      }
      emitForced(neighbors, limit,
        n => relRowId(relChildPath(path, n.object.elementId)), emit)
    }

    // A node with a single relationship kind nests its neighbours directly: a
    // header that says "Has component 4" above the only four rows there are is
    // an indent level charged for nothing. Past one kind the headers earn their
    // row, they are what keeps two "feeds" edges reachable under 600 components.
    if (groups.length === 1) {
      emitMembers(groups[0].neighbors, depth + 1, id, index)
      return
    }

    for (const group of groups) {
      const groupId = relGroupRowId(path, group.key)
      // Force a group open when the selection lies inside it: Back/Forward
      // restores the object path, but the group rows in between are not
      // derivable from it (see expandedPathTo).
      const holdsSelection = mustShowIds.size > 0 && group.neighbors.some(n =>
        mustShowIds.has(relRowId(relChildPath(path, n.object.elementId)))
      )
      const groupExpanded = isExpanded(groupId) || holdsSelection
      const groupIndex = rows.length
      rows.push({
        kind: 'node', key: `${key}#${group.key}`, id: groupId, nodeType: 'relGroup',
        label: group.label, depth: depth + 1,
        hasChildren: true, isExpanded: groupExpanded,
        count: group.neighbors.length,
        bucket: group.bucket,
        parentIndex: index,
      })
      if (groupExpanded) emitMembers(group.neighbors, depth + 2, groupId, groupIndex)
    }
  }

  // ── 1. Namespaces folder ──────────────────────────────────────────────────
  // Computed before the folder row so a filtered count can sit on it even
  // while the folder is collapsed.
  const visibleNamespaces = namespaces.filter(ns => {
    if (!filterText) return true
    if (
      ns.displayName.toLowerCase().includes(filterText) ||
      ns.uri.toLowerCase().includes(filterText)
    ) return true
    return matchedNamespaceUris.has(ns.uri)
  })
  const namespacesExpanded = isExpanded(NAMESPACES_FOLDER_ID)
  const namespacesIndex = rows.length
  rows.push({
    kind: 'node', key: NAMESPACES_FOLDER_ID, id: NAMESPACES_FOLDER_ID,
    nodeType: 'folder', label: 'Namespaces', depth: 0,
    hasChildren: namespaces.length > 0, isExpanded: namespacesExpanded,
    count: filterText ? visibleNamespaces.length : namespaces.length > 0 ? namespaces.length : undefined,
    filtered: filterText ? true : undefined,
    parentIndex: -1,
  })
  if (namespacesExpanded) {
    // Group object types by namespace; keep types whose name matches OR whose
    // descendant objects match.
    const typesByNamespace = new Map<string, ObjectType[]>()
    for (const type of objectTypes) {
      const keep =
        !filterText ||
        type.displayName.toLowerCase().includes(filterText) ||
        type.elementId.toLowerCase().includes(filterText) ||
        matchingTypeIds.has(type.elementId)
      if (!keep) continue
      const types = typesByNamespace.get(type.namespaceUri)
      if (types) types.push(type)
      else typesByNamespace.set(type.namespaceUri, [type])
    }

    // Instance count per type, derived from already-loaded allObjects (no
    // extra network). Only paid while the folder is actually open.
    const objectCountByType = new Map<string, number>()
    for (const o of allObjects) {
      objectCountByType.set(o.typeId, (objectCountByType.get(o.typeId) ?? 0) + 1)
    }

    const emitType = (type: ObjectType, nsIndex: number) => {
      const typeId = `type:${type.elementId}`
      const typeExpanded = isExpanded(typeId)
      const instanceCount = objectCountByType.get(type.elementId)
      const typeIndex = rows.length
      rows.push({
        kind: 'node', key: typeId, id: typeId, nodeType: 'objectType',
        label: type.displayName, data: type, depth: 2,
        hasChildren: true, isExpanded: typeExpanded,
        count: instanceCount && instanceCount > 0 ? instanceCount : undefined,
        parentIndex: nsIndex,
      })
      if (!typeExpanded) return

      const typeObjects = objectsByType.get(type.elementId) ?? []
      const visibleObjects = filterText ? typeObjects.filter(objMatches) : typeObjects
      const objLimit = pageLimit(typeId, visibleObjects.length)
      for (let o = 0; o < objLimit; o++) {
        walkObj(visibleObjects[o], 3, new Set<string>(), typeId, typeIndex)
      }
      if (objLimit < visibleObjects.length) {
        pushMore(typeId, typeId, 3, objLimit, visibleObjects.length, typeIndex)
      }
      emitForced(visibleObjects, objLimit, o => `obj:${o.elementId}`,
        o => walkObj(o, 3, new Set<string>(), typeId, typeIndex))
    }

    const emitNamespace = (namespace: Namespace) => {
      const nsId = `ns:${namespace.uri}`
      const nsTypes = typesByNamespace.get(namespace.uri) ?? []
      const nsExpanded = isExpanded(nsId)
      const nsIndex = rows.length
      rows.push({
        kind: 'node', key: nsId, id: nsId, nodeType: 'namespace',
        label: namespace.displayName, data: namespace, depth: 1,
        hasChildren: nsTypes.length > 0, isExpanded: nsExpanded,
        count: nsTypes.length > 0 ? nsTypes.length : undefined,
        parentIndex: namespacesIndex,
      })
      if (!nsExpanded) return

      const typeLimit = pageLimit(nsId, nsTypes.length)
      for (let t = 0; t < typeLimit; t++) emitType(nsTypes[t], nsIndex)
      if (typeLimit < nsTypes.length) pushMore(nsId, nsId, 2, typeLimit, nsTypes.length, nsIndex)
      emitForced(nsTypes, typeLimit, t => `type:${t.elementId}`, t => emitType(t, nsIndex))
    }

    const nsLimit = pageLimit(NAMESPACES_FOLDER_ID, visibleNamespaces.length)
    for (let n = 0; n < nsLimit; n++) emitNamespace(visibleNamespaces[n])
    if (nsLimit < visibleNamespaces.length) {
      pushMore(NAMESPACES_FOLDER_ID, NAMESPACES_FOLDER_ID, 1, nsLimit, visibleNamespaces.length, namespacesIndex)
    }
    emitForced(visibleNamespaces, nsLimit, ns => `ns:${ns.uri}`, emitNamespace)
  }

  // ── 2. Objects folder (flat list) ─────────────────────────────────────────
  // Deliberately unpaged at the top level: browsing the entire catalog is the
  // folder's purpose, and the virtualizer makes its size irrelevant to the DOM.
  const objectsExpanded = isExpanded(OBJECTS_FOLDER_ID)
  const objectsIndex = rows.length
  rows.push({
    kind: 'node', key: OBJECTS_FOLDER_ID, id: OBJECTS_FOLDER_ID,
    nodeType: 'folder', label: 'Objects', depth: 0,
    hasChildren: true, isExpanded: objectsExpanded,
    count: filterText ? matchTotal : allObjects.length > 0 ? allObjects.length : undefined,
    filtered: filterText ? true : undefined,
    parentIndex: -1,
  })
  if (objectsExpanded) {
    const visibleRoots = filterText ? allObjects.filter(objMatches) : allObjects
    for (const obj of visibleRoots) walkObj(obj, 1, new Set<string>(), 'all', objectsIndex)
    if (allObjects.length > 0 && visibleRoots.length === 0) {
      pushMarker('all#empty', 1, 'No matching objects', objectsIndex)
    }
  }

  // ── 3. Structure folder: the same roots, nested two different ways ────────
  // 'hierarchy' walks parentId (pure store data, no requests); 'relationships'
  // walks every edge the server reports, one fetch per expanded node. Same
  // roots either way, so the toggle never moves the top level.
  const asRelationships = treeStructure === 'relationships'
  const visibleRoots = filterText
    ? hierarchicalRoots.filter(obj => hierarchyVisibleIds.has(obj.elementId))
    : hierarchicalRoots
  const hierExpanded = isExpanded(HIERARCHICAL_FOLDER_ID)
  const hierIndex = rows.length
  rows.push({
    kind: 'node', key: HIERARCHICAL_FOLDER_ID, id: HIERARCHICAL_FOLDER_ID,
    nodeType: 'folder', label: asRelationships ? 'Relationships' : 'Hierarchy', depth: 0,
    hasChildren: true, isExpanded: hierExpanded,
    count: filterText ? visibleRoots.length : hierarchicalRoots.length > 0 ? hierarchicalRoots.length : undefined,
    filtered: filterText ? true : undefined,
    parentIndex: -1,
  })
  if (hierExpanded) {
    const walkRoot = asRelationships
      ? (obj: ObjectInstance) =>
          walkRel(obj, 1, 0, new Set([obj.elementId]), obj.elementId, hierIndex)
      : (obj: ObjectInstance) => walkHier(obj, 1, new Set<string>(), 'hier', hierIndex)
    const rootId = asRelationships
      ? (obj: ObjectInstance) => relRowId(obj.elementId)
      : (obj: ObjectInstance) => `hier:${obj.elementId}`

    const rootLimit = pageLimit(HIERARCHICAL_FOLDER_ID, visibleRoots.length)
    for (let i = 0; i < rootLimit; i++) walkRoot(visibleRoots[i])
    if (rootLimit < visibleRoots.length) {
      pushMore(HIERARCHICAL_FOLDER_ID, 'hier', 1, rootLimit, visibleRoots.length, hierIndex)
    }
    emitForced(visibleRoots, rootLimit, rootId, walkRoot)
    if (allObjects.length > 0 && visibleRoots.length === 0) {
      pushMarker('hier#empty', 1, filterText ? 'No matching objects' : 'No root objects found', hierIndex)
    }
  }

  return rows
}

// ── Row activation ──────────────────────────────────────────────────────────
// Shared by mouse (TreeNode click) and keyboard (TreeView key handling), so
// both paths select, expand, and fetch identically.

/**
 * Fetch whatever a just-expanded row needs from the server. Fire-and-forget
 * from the caller's perspective; results land in the store and re-render.
 */
export async function loadChildrenFor(row: NodeRow): Promise<void> {
  const client = getClient()
  if (!client) return
  const { setObjects, setHierarchicalRoots, setChildObjects, mergeCompositionFlags } = useExplorerStore.getState()
  const { id, nodeType, data } = row

  // Relationship node: fetch every relationship kind (no type filter), then
  // decide which of the resulting groups to open. Checked before the
  // composition branch below, because a 'rel:' row is also nodeType 'object'.
  if (id.startsWith(REL_PREFIX)) {
    const obj = data as ObjectInstance
    try {
      const related = await client.getRelatedObjects(obj.elementId)
      const { setRelatedObjects, mergeRelatedNeighborIds, expandNodes, objectIndex, childrenByParent, relationshipTypeIndex } =
        useExplorerStore.getState()
      setRelatedObjects(obj.elementId, related)

      const neighbors = directNeighbors(obj, related, { objectIndex, childrenByParent })
      // Cache the ids so this row's chevron (and every other occurrence of the
      // same object elsewhere in the walk) is exact from here on.
      mergeRelatedNeighborIds([[obj.elementId, neighbors.map(n => n.object.elementId)]])

      const path = id.slice(REL_PREFIX.length)
      const branch = relPathIds(path)
      const groups = groupNeighbors(
        neighbors.filter(n => !branch.has(n.object.elementId)),
        relationshipTypeIndex
      )
      const toOpen = planGroupExpansion(path, groups)
      if (toOpen.length > 0) expandNodes(toOpen)
    } catch (err) {
      console.error('Failed to load relationships:', err)
    }
    return
  }
  // Group rows hold no data of their own; their members are already in the
  // parent's fetched payload.
  if (nodeType === 'relGroup') return

  // Re-fetch objects for this type whenever expanding (always fresh)
  if (nodeType === 'objectType') {
    try {
      const objectType = data as ObjectType
      const objects = await client.getObjects(objectType.elementId)
      await resolveCompositionFlags(client, objects)
      setObjects(objectType.elementId, objects)
    } catch (err) {
      console.error('Failed to load objects:', err)
    }
    return
  }

  // Opening the Objects/Hierarchy folder forces a fresh full fetch (bypasses
  // the navigation throttle).
  if (id === OBJECTS_FOLDER_ID || id === HIERARCHICAL_FOLDER_ID) {
    try {
      await refreshAllObjects(client, true)
    } catch (err) {
      console.error('Failed to load all objects:', err)
    }
    // For the Hierarchy folder, also fetch root objects via root=true so the
    // server determines what counts as a root (avoids relying on
    // parentId === '/' locally).
    if (id === HIERARCHICAL_FOLDER_ID) {
      try {
        const roots = await client.getObjects(undefined, false, true)
        await resolveCompositionFlags(client, roots)
        setHierarchicalRoots(roots)
      } catch (err) {
        console.error('Failed to load root objects:', err)
      }
    }
    return
  }

  // Hierarchy node: re-fetch all objects to pick up newly discovered ones.
  // Throttled/coalesced so rapidly expanding many nodes doesn't trigger a full
  // 58k-object refetch per click on large catalogs.
  if (id.startsWith('hier:')) {
    try {
      await refreshAllObjects(client)
    } catch (err) {
      console.error('Failed to refresh objects for hierarchy node:', err)
    }
    return
  }

  // Compositional object: re-fetch child objects (always fresh)
  if (nodeType === 'object') {
    const obj = data as ObjectInstance
    if (!obj.isComposition) return
    try {
      const related = await client.getRelatedObjects(obj.elementId, 'HasComponent')
      const compositionalChildren = related.filter(child =>
        child.isComposition &&
        child.elementId !== obj.elementId &&
        child.parentId === obj.elementId
      )
      await resolveCompositionFlags(client, compositionalChildren)
      setChildObjects(obj.elementId, compositionalChildren)
      // Reflect the real qualifying-child count on the parent so an optimistic
      // chevron self-corrects to "no chevron" when a click reveals nothing.
      mergeCompositionFlags([[obj.elementId, compositionalChildren.length]])
    } catch (err) {
      console.error('Failed to load child objects:', err)
    }
  }
}

/** The full click/Enter behavior for a node row: select, toggle, fetch. */
export function activateRow(row: NodeRow): void {
  const { toggleNode, selectItem } = useExplorerStore.getState()
  if (row.data && row.nodeType !== 'folder') {
    selectItem({ type: row.nodeType, id: row.id, data: row.data } as SelectedItem)
  }
  if (row.hasChildren) {
    toggleNode(row.id)
    if (!row.isExpanded) void loadChildrenFor(row)
  }
}

/** Expand without selecting (ArrowRight). No-op if already expanded. */
export function expandRow(row: NodeRow): void {
  if (!row.hasChildren || row.isExpanded) return
  useExplorerStore.getState().expandNode(row.id)
  void loadChildrenFor(row)
}
