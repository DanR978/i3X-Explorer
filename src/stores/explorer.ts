import { create } from 'zustand'
import type { Namespace, ObjectType, ObjectInstance } from '../api/types'

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

// A node is only visible once every folder/ancestor above it is expanded, so
// restoring a selection means restoring that path too. Mirrors the expansion
// SearchModal and the main panel perform before they call selectItem.
function expandedPathTo(
  item: SelectedItem,
  expandedNodes: Set<string>,
  objectIndex: Map<string, ObjectInstance>
): Set<string> {
  const expanded = new Set(expandedNodes)

  if (item.id.startsWith('hier:')) {
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
  objects: Map<string, ObjectInstance[]> // keyed by typeId
  allObjects: ObjectInstance[] // flat list of all objects
  hierarchicalRoots: ObjectInstance[] // root objects for the Hierarchy folder (from root=true query)
  childObjects: Map<string, ObjectInstance[]> // keyed by parent elementId
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
  // One-shot deep link into the detail view's tab strip ('relationships',
  // 'subtree', 'history'), set by tree context-menu actions right before
  // selectItem and consumed (cleared) by ObjectDetailView. A store field
  // because the tab state itself is local to the detail view and re-keyed
  // per element.
  pendingDetailTab: string | null
  selectedItem: SelectedItem | null
  // Visited selections, oldest first; null is the Home/overview screen, which is
  // a real navigation stop, Back must land on it, not skip over it. The stack
  // starts seeded with Home, and historyIndex is the cursor into it.
  history: (SelectedItem | null)[]
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

  setNamespaces: (namespaces: Namespace[]) => void
  setObjectTypes: (types: ObjectType[]) => void
  setObjects: (typeId: string, objects: ObjectInstance[]) => void
  setAllObjects: (objects: ObjectInstance[]) => void
  setHierarchicalRoots: (roots: ObjectInstance[]) => void
  setChildObjects: (parentId: string, children: ObjectInstance[]) => void
  mergeCompositionFlags: (entries: Iterable<[string, number]>) => void
  toggleNode: (nodeId: string) => void
  expandNode: (nodeId: string) => void
  collapseNode: (nodeId: string) => void
  raiseChildLimit: (nodeId: string, by: number) => void
  showAllChildren: (nodeId: string) => void
  requestDetailTab: (tab: string | null) => void
  selectItem: (item: SelectedItem | null) => void
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
  reset: () => void
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  namespaces: [],
  objectTypes: [],
  objects: new Map(),
  allObjects: [],
  hierarchicalRoots: [],
  childObjects: new Map(),
  compositionCache: new Map(),
  typeIndex: new Map(),
  childrenByParent: new Map(),
  objectIndex: new Map(),
  searchIndex: new Map(),
  expandedNodes: new Set(),
  childPageLimits: new Map(),
  pendingDetailTab: null,
  selectedItem: null,
  history: [null],
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

  mergeCompositionFlags: (entries) => {
    const current = get().compositionCache
    const updated = new Map(current)
    for (const [id, flag] of entries) updated.set(id, flag)
    set({ compositionCache: updated })
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

  requestDetailTab: (tab) => set({ pendingDetailTab: tab }),

  selectItem: (item) => {
    const { history, historyIndex } = get()
    // Re-selecting the current stop (clicking an already-selected row, or Home
    // while on Home) must not add a second entry, but still refreshes
    // selectedItem with the newer data.
    const current = historyIndex >= 0 ? history[historyIndex] : undefined
    const sameStop = item === null ? current === null : current != null && current.id === item.id
    if (historyIndex >= 0 && sameStop) {
      set({ selectedItem: item })
      return
    }
    // Navigating after going back discards the forward entries, like a browser.
    const entries = history.slice(0, historyIndex + 1)
    entries.push(item)
    const trimmed = entries.length > MAX_HISTORY ? entries.slice(-MAX_HISTORY) : entries
    set({ selectedItem: item, history: trimmed, historyIndex: trimmed.length - 1 })
  },

  // goBack/goForward restore a selection directly rather than calling selectItem,
  // which would push the entry back onto the stack and trap the cursor at the end.
  goBack: () => {
    const { history, historyIndex, expandedNodes, objectIndex } = get()
    if (historyIndex <= 0) return
    const target = history[historyIndex - 1]
    set({
      selectedItem: target,
      historyIndex: historyIndex - 1,
      // A null target is Home: nothing to reveal in the tree.
      expandedNodes: target ? expandedPathTo(target, expandedNodes, objectIndex) : expandedNodes,
    })
  },

  goForward: () => {
    const { history, historyIndex, expandedNodes, objectIndex } = get()
    if (historyIndex >= history.length - 1) return
    const target = history[historyIndex + 1]
    set({
      selectedItem: target,
      historyIndex: historyIndex + 1,
      expandedNodes: target ? expandedPathTo(target, expandedNodes, objectIndex) : expandedNodes,
    })
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

  reset: () => set({
    namespaces: [],
    objectTypes: [],
    objects: new Map(),
    allObjects: [],
    hierarchicalRoots: [],
    childObjects: new Map(),
    compositionCache: new Map(),
    typeIndex: new Map(),
    childrenByParent: new Map(),
    objectIndex: new Map(),
    searchIndex: new Map(),
    expandedNodes: new Set(),
    childPageLimits: new Map(),
    pendingDetailTab: null,
    selectedItem: null,
    history: [null],
    historyIndex: 0,
    isLoading: false,
    searchQuery: ''
  })
}))
