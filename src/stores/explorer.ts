import { create } from 'zustand'
import type { Namespace, ObjectType, ObjectInstance, RelationshipType } from '../api/types'

export type TreeNodeType = 'namespace' | 'objectType' | 'object' | 'folder'

export interface TreeNode {
  id: string
  type: TreeNodeType
  label: string
  data?: Namespace | ObjectType | ObjectInstance
  children?: TreeNode[]
  isLoading?: boolean
  isExpanded?: boolean
}

export interface SelectedItem {
  type: TreeNodeType
  id: string
  data: Namespace | ObjectType | ObjectInstance
}

/** The tabs of the element detail view. Part of a history stop, see NavEntry. */
export type DetailTab = 'overview' | 'relationships' | 'history' | 'subtree'

/** A full-panel page that overlays the selection: the two of them, or neither. */
export type MainPage = 'insights' | 'diff' | null

/**
 * One stop in the navigation history: everything the main panel needs to
 * redraw exactly what you were looking at.
 *
 * The stack used to hold bare selections, so Back restored *an element* but not
 * the page you were on: leaving the Subtree tab of an object and coming back
 * landed on its Overview, and the Insights and diff pages weren't history stops
 * at all (they were closed by any navigation and could not be returned to).
 * A stop is therefore a triple, and every one of those is a real navigation:
 * switching tabs pushes, opening a page pushes, closing it pushes.
 */
export interface NavEntry {
  /** null is Home; with a page set it's the page opened from Home. */
  item: SelectedItem | null
  /** Which detail tab was open. Only meaningful when `item` is an object. */
  tab: DetailTab
  /** The full-panel page drawn over the selection, if any. */
  page: MainPage
}

const HOME_ENTRY: NavEntry = { item: null, tab: 'overview', page: null }

// Bounded so a long browsing session can't grow the stack without limit.
const MAX_HISTORY = 50

// A parent with more children than this shows the first page plus a
// "Show more" row instead of dumping everything at once. Virtualization keeps
// rendering cheap regardless, this cap is about the *user*: 20k siblings under
// one node bury its siblings and make scrolling past it a chore. One screenful
// at a time is the point, so the page is small; the "Show more" row reveals
// another page, its right-click menu takes a custom number or reveals
// everything. The flat Objects folder is exempt (browsing everything is its
// whole point).
export const CHILD_PAGE_SIZE = 50
// Don't bother truncating for a trivial overflow, a "Show 6 more" row costs
// more attention than the 6 rows it hides.
export const CHILD_PAGE_SLACK = 10

// Hops the Relationships map walks out from the selected element. The default is
// one hop (just the direct relationships); deeper walks are opt-in. The ceiling
// caps the round trips a deep custom walk can fire (one per hop) on a deeply-linked model.
export const MIN_RELATIONSHIP_DEPTH = 1
export const MAX_RELATIONSHIP_DEPTH = 10
export const DEFAULT_RELATIONSHIP_DEPTH = 1

// Hops the Subtree tab walks DOWN from the selected element. Deeper than the
// Relationships default: the tab exists for deeply nested models, and a
// descendants-only walk stays narrow enough to afford the extra round trips.
export const DEFAULT_SUBTREE_DEPTH = 3

// The depth picker shows pills 1..N; "+" reveals one deeper per click, up to the
// ceiling. N lives in the store so the revealed pills persist across element
// selections for the session (the tab is re-mounted per element).
export const INITIAL_RELATIONSHIP_DEPTH_PILLS = 2

// Which way the Relationships map draws the same ego graph: a left-to-right tree
// (default) or the radial rings map. Lives in the store so the choice persists
// across element selections for the session.
export type RelationshipView = 'tree' | 'radial'

// How the sidebar's third folder nests the same set of root objects:
//   'hierarchy'     parentId only, one parent per node, derived from the store
//   'relationships' every edge the server reports, grouped by relationship type
// The roots are identical either way, so toggling never loses your place at the
// top level; only what hangs under a node changes.
export type TreeStructure = 'hierarchy' | 'relationships'

// Row ids in the relationship walk. Unlike the hierarchy, where every object
// appears exactly once, the same object legitimately hangs off many places in a
// relationship graph, so its id has to be the PATH that reached it, not the
// element. Keying expansion on the element instead would open every occurrence
// of a hub at once, which on a densely linked model is an explosion.
//
// The path is the chain of elementIds joined by NUL, which cannot occur inside
// an elementId, so a path is never ambiguous and an ancestor is exactly a
// prefix. Lives here rather than in relationshipTree.ts because this store
// needs it too (expandedPathTo) and modules under components/ import the store,
// never the reverse.
export const REL_SEP = '\u0000'
export const REL_PREFIX = 'rel:'
export const REL_GROUP_PREFIX = 'relgrp:'

// Expanding a relationship node whose neighbours all fit inside this budget
// opens its relationship groups immediately. Past it, the groups stay closed and
// the node reads as a table of contents ("Parent 1 · Children 640 · Feeds 2"),
// which is the more useful answer at that size.
export const REL_AUTO_EXPAND_NEIGHBORS = 12

// A node is only visible once every folder/ancestor above it is expanded, so
// restoring a selection means restoring that path too. Mirrors the expansion
// SearchModal and the main panel perform before they call selectItem.
function expandedPathTo(
  item: SelectedItem,
  expandedNodes: Set<string>,
  objectIndex: Map<string, ObjectInstance>
): Set<string> {
  const expanded = new Set(expandedNodes)

  // A relationship row's id is the chain of elementIds that reached it, so its
  // ancestors are literally its prefixes. The relationship-type group rows in
  // between are not derivable here, and don't need to be: buildTreeRows
  // force-opens any group that holds the selection.
  if (item.id.startsWith(REL_PREFIX)) {
    expanded.add('folder:hierarchical')
    const segments = item.id.slice(REL_PREFIX.length).split(REL_SEP)
    for (let i = 1; i < segments.length; i++) {
      expanded.add(REL_PREFIX + segments.slice(0, i).join(REL_SEP))
    }
  } else if (item.id.startsWith('hier:')) {
    expanded.add('folder:hierarchical')
    const visited = new Set<string>()
    let current = item.data as ObjectInstance
    while (current.parentId && current.parentId !== '/' && !visited.has(current.elementId)) {
      visited.add(current.elementId)
      // O(1) lookup: a per-ancestor scan of allObjects made Back/Forward
      // O(depth × n), which is ~1M comparisons on a 50k catalog.
      const parent = objectIndex.get(current.parentId)
      if (!parent) break
      expanded.add(`hier:${parent.elementId}`)
      current = parent
    }
  } else if (item.id.startsWith('obj:')) {
    // The Objects folder lists every object at the top level, so no ancestor walk.
    expanded.add('folder:objects')
  } else if (item.id.startsWith('ns:')) {
    expanded.add('folder:namespaces')
  } else if (item.id.startsWith('type:')) {
    expanded.add('folder:namespaces')
    expanded.add(`ns:${(item.data as ObjectType).namespaceUri}`)
  }

  return expanded
}

interface ExplorerState {
  namespaces: Namespace[]
  objectTypes: ObjectType[]
  // Declared relationship types, fetched once on connect. The walk needs them
  // only to LABEL its groups: a group header should read "Feeds to" / "Fed by"
  // in the server's own vocabulary rather than echoing a raw elementId.
  relationshipTypes: RelationshipType[]
  // elementId (and relationshipId, when the server sends one) → its declared
  // type, so a group header resolves its label with one lookup.
  relationshipTypeIndex: Map<string, RelationshipType>
  objects: Map<string, ObjectInstance[]> // keyed by typeId
  allObjects: ObjectInstance[] // flat list of all objects
  hierarchicalRoots: ObjectInstance[] // root objects for the Hierarchy folder (from root=true query)
  childObjects: Map<string, ObjectInstance[]> // keyed by parent elementId
  // elementId → everything POST /objects/related returned for it, unfiltered,
  // fetched when a relationship row is expanded. Kept raw (not pre-grouped) so
  // the walk can union it with the store's own parent/child knowledge through
  // the same directNeighbors() the Relationships tab uses, and so the two
  // surfaces can never disagree about what an object is connected to.
  relatedObjects: Map<string, ObjectInstance[]>
  // elementId → the elementIds of its direct neighbours, resolved in batches for
  // the rows currently on screen. The relationship chevron is optimistic until
  // this lands (any object might be connected to something) and then
  // self-corrects, exactly as compositionCache does for the hierarchy.
  //
  // Ids rather than a bare count, because the count a row actually shows depends
  // on where it hangs: the edge it was reached through is dropped, and a leaf
  // whose only neighbour is the parent above it must lose its chevron. A count
  // cannot answer that; a cheap id list can, without holding a second copy of
  // every neighbouring object.
  relatedNeighborIds: Map<string, string[]>
  // elementId → count of qualifying compositional children (children where
  // isComposition && parentId === this elementId). Resolved authoritatively
  // via batched POST /objects/related so it never disagrees with the render
  // filter applied at expansion time. Also drives chevron state (count > 0).
  compositionCache: Map<string, number>
  // elementId → its object type, rebuilt once whenever objectTypes changes.
  // Shared by every tree node for icon bucketing so a node never has to build
  // a Map over all object types on its own.
  typeIndex: Map<string, ObjectType>
  // parentId → its direct children, rebuilt once whenever allObjects changes.
  // The hierarchy view looks up children here in O(1) instead of scanning the
  // entire allObjects array (O(n)) on every node.
  childrenByParent: Map<string, ObjectInstance[]>
  // elementId → object, rebuilt once whenever allObjects changes. Ancestor walks
  // (breadcrumb, back/forward, search results) used to call allObjects.find per
  // level, making each walk O(depth × n). With this they are O(depth).
  objectIndex: Map<string, ObjectInstance>
  // elementId → pre-lowercased "name\0elementId\0namespaceUri" blob, rebuilt
  // with allObjects. The tree filter runs per keystroke over the whole catalog;
  // one prebuilt blob turns 3 toLowerCase calls per object per keystroke into a
  // single .includes(). Objects fetched outside allObjects fall back inline.
  searchIndex: Map<string, string>
  expandedNodes: Set<string>
  // Node id → how many children are currently revealed for parents whose child
  // list is paged (see CHILD_PAGE_SIZE). Absent = first page. Infinity = all.
  childPageLimits: Map<string, number>
  selectedItem: SelectedItem | null
  // Which detail tab the current stop is on, and which full-panel page (if any)
  // is drawn over it. Both mirror history[historyIndex]: the history is the
  // source of truth for what the main panel shows, so Back/Forward restore the
  // page you were on and not merely the element.
  detailTab: DetailTab
  activePage: MainPage
  // Visited stops, oldest first; Home is a real one, Back must land on it rather
  // than skip over it, so the stack starts seeded with it and historyIndex is
  // the cursor into it.
  history: NavEntry[]
  historyIndex: number
  isLoading: boolean
  searchQuery: string
  pollIntervalMs: number
  manualRefreshTick: number
  sidebarCollapsed: boolean
  // How many hops the Relationships map walks out from the selected element.
  // Lives here, not in the tab: MainPanel re-keys the detail view per element, so
  // tab-local state would snap back to the default on every selection.
  relationshipDepth: number
  // Highest depth pill the picker currently shows (1..this). "+" bumps it.
  // Shared by the Relationships and Subtree pickers: revealing a deeper pill is
  // a session-level "I go deep here" signal, not a per-tab one.
  relationshipDepthShown: number
  // Which view the Relationships map draws: 'tree' or 'radial'.
  relationshipView: RelationshipView
  // How many hops the Subtree tab walks down from the selected element. Same
  // reason as relationshipDepth for living here rather than in the tab.
  subtreeDepth: number
  // How the sidebar's third folder nests its objects: by parentId, or by every
  // relationship the server reports.
  treeStructure: TreeStructure

  setNamespaces: (namespaces: Namespace[]) => void
  setObjectTypes: (types: ObjectType[]) => void
  setRelationshipTypes: (types: RelationshipType[]) => void
  setObjects: (typeId: string, objects: ObjectInstance[]) => void
  setAllObjects: (objects: ObjectInstance[]) => void
  setHierarchicalRoots: (roots: ObjectInstance[]) => void
  setChildObjects: (parentId: string, children: ObjectInstance[]) => void
  setRelatedObjects: (elementId: string, related: ObjectInstance[]) => void
  mergeCompositionFlags: (entries: Iterable<[string, number]>) => void
  mergeRelatedNeighborIds: (entries: Iterable<[string, string[]]>) => void
  toggleNode: (nodeId: string) => void
  expandNode: (nodeId: string) => void
  /** Expand several nodes in one write (relationship groups on expand). */
  expandNodes: (nodeIds: Iterable<string>) => void
  collapseNode: (nodeId: string) => void
  raiseChildLimit: (nodeId: string, by: number) => void
  showAllChildren: (nodeId: string) => void
  /**
   * Open an item (or Home, with null). `tab` deep-links the detail view; when
   * omitted a new element opens on Overview and re-selecting the element you
   * are already on keeps the tab you are reading.
   */
  selectItem: (item: SelectedItem | null, tab?: DetailTab) => void
  /** Switch the detail tab. A tab is a page, so this is a navigation stop. */
  setDetailTab: (tab: DetailTab) => void
  /** Show a full-panel page (insights / diff) over the current selection. */
  openPage: (page: Exclude<MainPage, null>) => void
  /** Leave the current page, back to whatever the selection points at. */
  closePage: () => void
  goBack: () => void
  goForward: () => void
  setLoading: (loading: boolean) => void
  setSearchQuery: (query: string) => void
  setPollIntervalMs: (ms: number) => void
  triggerManualRefresh: () => void
  toggleSidebar: () => void
  setRelationshipDepth: (depth: number) => void
  revealRelationshipDepth: () => void
  setRelationshipView: (view: RelationshipView) => void
  setSubtreeDepth: (depth: number) => void
  setTreeStructure: (structure: TreeStructure) => void
  reset: () => void
}

/**
 * Add a stop and move the cursor onto it. Navigating after going back discards
 * the forward entries, like a browser. Everything the main panel reads
 * (selectedItem / detailTab / activePage) is written from the entry, so the
 * three can never drift out of sync with the stack.
 */
function pushEntry(entry: NavEntry) {
  const { history, historyIndex } = useExplorerStore.getState()
  const entries = history.slice(0, historyIndex + 1)
  entries.push(entry)
  const trimmed = entries.length > MAX_HISTORY ? entries.slice(-MAX_HISTORY) : entries
  useExplorerStore.setState({
    selectedItem: entry.item,
    detailTab: entry.tab,
    activePage: entry.page,
    history: trimmed,
    historyIndex: trimmed.length - 1,
  })
}

/** Restore an existing stop without pushing (Back/Forward). */
function gotoIndex(index: number) {
  const { history, expandedNodes, objectIndex } = useExplorerStore.getState()
  const target = history[index]
  if (!target) return
  useExplorerStore.setState({
    selectedItem: target.item,
    detailTab: target.tab,
    activePage: target.page,
    historyIndex: index,
    // A null item is Home or a full-panel page: nothing to reveal in the tree.
    expandedNodes: target.item
      ? expandedPathTo(target.item, expandedNodes, objectIndex)
      : expandedNodes,
  })
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  namespaces: [],
  objectTypes: [],
  relationshipTypes: [],
  relationshipTypeIndex: new Map(),
  objects: new Map(),
  allObjects: [],
  hierarchicalRoots: [],
  childObjects: new Map(),
  relatedObjects: new Map(),
  relatedNeighborIds: new Map(),
  compositionCache: new Map(),
  typeIndex: new Map(),
  childrenByParent: new Map(),
  objectIndex: new Map(),
  searchIndex: new Map(),
  expandedNodes: new Set(),
  childPageLimits: new Map(),
  selectedItem: null,
  detailTab: 'overview',
  activePage: null,
  history: [HOME_ENTRY],
  historyIndex: 0,
  isLoading: false,
  searchQuery: '',
  pollIntervalMs: 30_000,
  manualRefreshTick: 0,
  sidebarCollapsed: false,
  relationshipDepth: DEFAULT_RELATIONSHIP_DEPTH,
  relationshipDepthShown: INITIAL_RELATIONSHIP_DEPTH_PILLS,
  relationshipView: 'tree',
  subtreeDepth: DEFAULT_SUBTREE_DEPTH,
  treeStructure: 'hierarchy',

  // The 30s background poll re-fetches namespaces and types unconditionally
  // and would store a brand-new array every tick even when nothing changed.
  // Downstream memos key on array identity (getInsightsReport recomputes a
  // ~130ms report at 100k objects on any miss), so when the content is
  // byte-identical we keep the old reference and skip the write entirely,
  // no re-render, no recompute. Both lists are small (namespaces a handful,
  // types at most hundreds), so the stringify costs microseconds-to-low-ms
  // once per poll tick, three orders of magnitude under what it saves.
  setNamespaces: (namespaces) => {
    const current = get().namespaces
    if (
      current.length === namespaces.length &&
      JSON.stringify(current) === JSON.stringify(namespaces)
    ) return
    set({ namespaces })
  },
  setObjectTypes: (types) => {
    const current = get().objectTypes
    if (current.length === types.length && JSON.stringify(current) === JSON.stringify(types)) return
    set({
      objectTypes: types,
      typeIndex: new Map(types.map(t => [t.elementId, t])),
    })
  },

  // Same content-identical guard as the two above: relationship types are
  // re-fetched by the background poll and this index feeds the relationship
  // walk's memo.
  setRelationshipTypes: (types) => {
    const current = get().relationshipTypes
    if (current.length === types.length && JSON.stringify(current) === JSON.stringify(types)) return
    const index = new Map<string, RelationshipType>()
    for (const t of types) {
      index.set(t.elementId, t)
      // Servers report an object's sourceRelationship as either the type's
      // elementId or its relationshipId; index both so the lookup can't miss.
      if (t.relationshipId) index.set(t.relationshipId, t)
    }
    set({ relationshipTypes: types, relationshipTypeIndex: index })
  },

  setObjects: (typeId, objects) => {
    const current = get().objects
    const updated = new Map(current)
    updated.set(typeId, objects)
    set({ objects: updated })
  },

  setAllObjects: (objects) => {
    // Index children by parentId and objects by elementId once here, so the
    // hierarchy view resolves a node's children, and ancestor walks resolve a
    // parent, with a single Map lookup instead of scanning the whole list.
    // The filter blob is built here too: pay the lowercasing once per fetch,
    // not three times per object per filter keystroke.
    const childrenByParent = new Map<string, ObjectInstance[]>()
    const objectIndex = new Map<string, ObjectInstance>()
    const searchIndex = new Map<string, string>()
    for (const o of objects) {
      objectIndex.set(o.elementId, o)
      searchIndex.set(o.elementId, `${o.displayName} ${o.elementId} ${o.namespaceUri}`.toLowerCase())
      const pid = o.parentId
      if (!pid) continue
      const arr = childrenByParent.get(pid)
      if (arr) arr.push(o)
      else childrenByParent.set(pid, [o])
    }
    set({ allObjects: objects, childrenByParent, objectIndex, searchIndex })
  },
  setHierarchicalRoots: (roots) => set({ hierarchicalRoots: roots }),

  setChildObjects: (parentId, children) => {
    const current = get().childObjects
    const updated = new Map(current)
    updated.set(parentId, children)
    set({ childObjects: updated })
  },

  setRelatedObjects: (elementId, related) => {
    const current = get().relatedObjects
    const updated = new Map(current)
    updated.set(elementId, related)
    set({ relatedObjects: updated })
  },

  mergeCompositionFlags: (entries) => {
    const current = get().compositionCache
    const updated = new Map(current)
    for (const [id, flag] of entries) updated.set(id, flag)
    set({ compositionCache: updated })
  },

  mergeRelatedNeighborIds: (entries) => {
    const current = get().relatedNeighborIds
    const updated = new Map(current)
    for (const [id, neighborIds] of entries) updated.set(id, neighborIds)
    set({ relatedNeighborIds: updated })
  },

  toggleNode: (nodeId) => {
    const { expandedNodes, childPageLimits } = get()
    const updated = new Set(expandedNodes)
    if (updated.has(nodeId)) {
      updated.delete(nodeId)
      // Collapsing resets the paging for that parent: re-expanding starts back
      // at the first page rather than a stale multi-thousand-row reveal.
      if (childPageLimits.has(nodeId)) {
        const limits = new Map(childPageLimits)
        limits.delete(nodeId)
        set({ expandedNodes: updated, childPageLimits: limits })
        return
      }
    } else {
      updated.add(nodeId)
    }
    set({ expandedNodes: updated })
  },

  expandNode: (nodeId) => {
    const { expandedNodes } = get()
    const updated = new Set(expandedNodes)
    updated.add(nodeId)
    set({ expandedNodes: updated })
  },

  expandNodes: (nodeIds) => {
    const { expandedNodes } = get()
    const updated = new Set(expandedNodes)
    const before = updated.size
    for (const id of nodeIds) updated.add(id)
    if (updated.size === before) return
    set({ expandedNodes: updated })
  },

  collapseNode: (nodeId) => {
    const { expandedNodes } = get()
    const updated = new Set(expandedNodes)
    updated.delete(nodeId)
    set({ expandedNodes: updated })
  },

  raiseChildLimit: (nodeId, by) => {
    const limits = new Map(get().childPageLimits)
    limits.set(nodeId, (limits.get(nodeId) ?? CHILD_PAGE_SIZE) + by)
    set({ childPageLimits: limits })
  },

  showAllChildren: (nodeId) => {
    const limits = new Map(get().childPageLimits)
    limits.set(nodeId, Infinity)
    set({ childPageLimits: limits })
  },

  selectItem: (item, tab) => {
    const { history, historyIndex } = get()
    const current = history[historyIndex] ?? HOME_ENTRY
    const sameItem = item === null ? current.item === null : current.item?.id === item.id
    // Re-selecting the element you're already on keeps the tab you're reading,
    // so clicking its tree row again doesn't kick you back to Overview.
    const nextTab = tab ?? (sameItem ? current.tab : 'overview')
    // Re-selecting the current stop must not add a second entry, but still
    // refreshes selectedItem with the newer data. Leaving a full-panel page is
    // a navigation even when the selection underneath is unchanged.
    if (sameItem && nextTab === current.tab && current.page === null) {
      set({ selectedItem: item })
      return
    }
    pushEntry({ item, tab: nextTab, page: null })
  },

  setDetailTab: (tab) => {
    const { history, historyIndex } = get()
    const current = history[historyIndex] ?? HOME_ENTRY
    if (current.tab === tab && current.page === null) return
    pushEntry({ item: current.item, tab, page: null })
  },

  openPage: (page) => {
    const { history, historyIndex } = get()
    const current = history[historyIndex] ?? HOME_ENTRY
    if (current.page === page) return
    // The selection is carried along, so closing the page (or Back) returns to
    // whatever you were looking at before it opened.
    pushEntry({ item: current.item, tab: current.tab, page })
  },

  closePage: () => {
    const { history, historyIndex } = get()
    const current = history[historyIndex] ?? HOME_ENTRY
    if (current.page === null) return
    pushEntry({ item: current.item, tab: current.tab, page: null })
  },

  // goBack/goForward restore a stop directly rather than calling selectItem,
  // which would push it back onto the stack and trap the cursor at the end.
  goBack: () => {
    const { historyIndex } = get()
    if (historyIndex <= 0) return
    gotoIndex(historyIndex - 1)
  },

  goForward: () => {
    const { history, historyIndex } = get()
    if (historyIndex >= history.length - 1) return
    gotoIndex(historyIndex + 1)
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setPollIntervalMs: (ms) => set({ pollIntervalMs: ms }),
  triggerManualRefresh: () => set(state => ({ manualRefreshTick: state.manualRefreshTick + 1 })),
  toggleSidebar: () => set(state => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setRelationshipDepth: (depth) => set({
    relationshipDepth: Math.max(MIN_RELATIONSHIP_DEPTH, Math.min(MAX_RELATIONSHIP_DEPTH, depth)),
  }),
  revealRelationshipDepth: () => set(state => ({
    relationshipDepthShown: Math.min(MAX_RELATIONSHIP_DEPTH, state.relationshipDepthShown + 1),
  })),
  setRelationshipView: (view) => set({ relationshipView: view }),
  setSubtreeDepth: (depth) => set({
    subtreeDepth: Math.max(MIN_RELATIONSHIP_DEPTH, Math.min(MAX_RELATIONSHIP_DEPTH, depth)),
  }),

  // Both walks start from the same hierarchicalRoots, so toggling never moves
  // the top level. The two id namespaces ('hier:' and 'rel:') are disjoint and
  // both are simply left in expandedNodes: each view keeps its own expansion,
  // so switching over to check a relationship and switching back lands you
  // exactly where you were rather than on a collapsed tree.
  setTreeStructure: (structure) => set({ treeStructure: structure }),

  reset: () => set({
    namespaces: [],
    objectTypes: [],
    relationshipTypes: [],
    relationshipTypeIndex: new Map(),
    objects: new Map(),
    allObjects: [],
    hierarchicalRoots: [],
    childObjects: new Map(),
    relatedObjects: new Map(),
    relatedNeighborIds: new Map(),
    compositionCache: new Map(),
    typeIndex: new Map(),
    childrenByParent: new Map(),
    objectIndex: new Map(),
    searchIndex: new Map(),
    expandedNodes: new Set(),
    childPageLimits: new Map(),
    selectedItem: null,
    detailTab: 'overview',
    activePage: null,
    history: [HOME_ENTRY],
    historyIndex: 0,
    isLoading: false,
    searchQuery: ''
  })
}))
