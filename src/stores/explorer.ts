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
  expandedNodes: Set<string>
  selectedItem: SelectedItem | null
  // Visited selections, oldest first. historyIndex is the cursor into it, or -1
  // when nothing has been selected yet.
  history: SelectedItem[]
  historyIndex: number
  isLoading: boolean
  searchQuery: string
  pollIntervalMs: number
  manualRefreshTick: number
  sidebarCollapsed: boolean

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
  selectItem: (item: SelectedItem | null) => void
  goBack: () => void
  goForward: () => void
  setLoading: (loading: boolean) => void
  setSearchQuery: (query: string) => void
  setPollIntervalMs: (ms: number) => void
  triggerManualRefresh: () => void
  toggleSidebar: () => void
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
  expandedNodes: new Set(),
  selectedItem: null,
  history: [],
  historyIndex: -1,
  isLoading: false,
  searchQuery: '',
  pollIntervalMs: 30_000,
  manualRefreshTick: 0,
  sidebarCollapsed: false,

  setNamespaces: (namespaces) => set({ namespaces }),
  setObjectTypes: (types) => set({
    objectTypes: types,
    typeIndex: new Map(types.map(t => [t.elementId, t])),
  }),

  setObjects: (typeId, objects) => {
    const current = get().objects
    const updated = new Map(current)
    updated.set(typeId, objects)
    set({ objects: updated })
  },

  setAllObjects: (objects) => {
    // Index children by parentId and objects by elementId once here, so the
    // hierarchy view resolves a node's children — and ancestor walks resolve a
    // parent — with a single Map lookup instead of scanning the whole list.
    const childrenByParent = new Map<string, ObjectInstance[]>()
    const objectIndex = new Map<string, ObjectInstance>()
    for (const o of objects) {
      objectIndex.set(o.elementId, o)
      const pid = o.parentId
      if (!pid) continue
      const arr = childrenByParent.get(pid)
      if (arr) arr.push(o)
      else childrenByParent.set(pid, [o])
    }
    set({ allObjects: objects, childrenByParent, objectIndex })
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
    const { expandedNodes } = get()
    const updated = new Set(expandedNodes)
    if (updated.has(nodeId)) {
      updated.delete(nodeId)
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

  selectItem: (item) => {
    if (!item) {
      set({ selectedItem: item })
      return
    }
    const { history, historyIndex } = get()
    // Re-selecting the current node (clicking an already-selected row) must not
    // add a second entry, but still refreshes selectedItem with the newer data.
    if (historyIndex >= 0 && history[historyIndex].id === item.id) {
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
      expandedNodes: expandedPathTo(target, expandedNodes, objectIndex),
    })
  },

  goForward: () => {
    const { history, historyIndex, expandedNodes, objectIndex } = get()
    if (historyIndex >= history.length - 1) return
    const target = history[historyIndex + 1]
    set({
      selectedItem: target,
      historyIndex: historyIndex + 1,
      expandedNodes: expandedPathTo(target, expandedNodes, objectIndex),
    })
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setPollIntervalMs: (ms) => set({ pollIntervalMs: ms }),
  triggerManualRefresh: () => set(state => ({ manualRefreshTick: state.manualRefreshTick + 1 })),
  toggleSidebar: () => set(state => ({ sidebarCollapsed: !state.sidebarCollapsed })),

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
    expandedNodes: new Set(),
    selectedItem: null,
    history: [],
    historyIndex: -1,
    isLoading: false,
    searchQuery: ''
  })
}))
