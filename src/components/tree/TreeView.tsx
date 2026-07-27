import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useExplorerStore, CHILD_PAGE_SIZE } from '../../stores/explorer'
import { useConnectionStore } from '../../stores/connection'
import { getClient } from '../../api/client'
import type { ObjectInstance } from '../../api/types'
import { TreeNode, TreeMoreNode, TreeRowIcon, IndentGuides } from './TreeNode'
import { buildTreeMenu } from './treeMenu'
import { Chevron } from '../common/Chevron'
import { ContextMenu, type MenuEntry } from '../common/ContextMenu'
import { CollapseAllIcon, TargetIcon } from '../common/icons'
import { useElementNavigation } from '../main/navigation'
import {
  buildTreeRows,
  activateRow,
  expandRow,
  resolveCompositionFlags,
  refreshAllObjects,
  ESTIMATED_ROW_HEIGHT,
  NAMESPACES_FOLDER_ID,
  OBJECTS_FOLDER_ID,
  HIERARCHICAL_FOLDER_ID,
  type TreeRow,
  type NodeRow,
} from './treeData'

const BACKGROUND_POLL_ENABLED = true

// Nearest ancestors pinned at the top of the scroll viewport while you're deep
// inside a large expansion. More than this and the header eats the viewport.
const MAX_STICKY_ROWS = 3

// Type-ahead: keystrokes within this window accumulate into one search buffer.
const TYPE_AHEAD_RESET_MS = 700

// px metrics for the offscreen width estimate; keep in sync with the row markup.
const TREE_INDENT_PX = 16
const TREE_BASE_PADDING_PX = 8
const TREE_CHEVRON_SLOT_PX = 16
const TREE_ICON_SLOT_PX = 15
const TREE_GAP_PX = 8
const TREE_COUNT_EXTRA_PX = 36
const TREE_WIDTH_SAFETY_PX = 32
// Widest plausible "Show N more · N hidden · show all" row.
const TREE_MORE_ROW_PX = 280
// Exactly measure only this many of the (approximately) widest rows.
const WIDTH_CANDIDATES = 48

/** Next focusable row index from `from` in `dir`; `from` when there is none. */
function stepFocus(rows: TreeRow[], from: number, dir: 1 | -1): number {
  let i = from + dir
  while (i >= 0 && i < rows.length && rows[i].kind === 'marker') i += dir
  return i >= 0 && i < rows.length ? i : from
}

/** Next node row (wrapping) whose label starts with the type-ahead buffer. */
function findTypeAhead(rows: TreeRow[], from: number, buffer: string): number {
  for (let offset = 1; offset <= rows.length; offset++) {
    const i = (from + offset) % rows.length
    const row = rows[i]
    if (row.kind === 'node' && row.label.toLowerCase().startsWith(buffer)) return i
  }
  return -1
}

/**
 * The sidebar tree. The ENTIRE tree — Namespaces, Objects, Hierarchy — is one
 * flattened row array (buildTreeRows) windowed by a single virtualizer, so the
 * DOM holds only the rows near the viewport no matter how many are visible.
 * Huge child lists are additionally paged with "Show more" rows (see
 * CHILD_PAGE_SIZE), a sticky ancestor header keeps context pinned while
 * scrolling deep inside one parent, and the whole thing is keyboard-driven
 * (arrows, Home/End, Enter, type-ahead) per the ARIA tree pattern.
 */
export function TreeView() {
  // Narrow selectors so the tree re-renders only for the slices it uses, not on
  // every unrelated store update (e.g. live subscription values).
  const namespaces = useExplorerStore(s => s.namespaces)
  const objectTypes = useExplorerStore(s => s.objectTypes)
  const objects = useExplorerStore(s => s.objects)
  const allObjects = useExplorerStore(s => s.allObjects)
  const hierarchicalRoots = useExplorerStore(s => s.hierarchicalRoots)
  const childObjects = useExplorerStore(s => s.childObjects)
  const childrenByParent = useExplorerStore(s => s.childrenByParent)
  const compositionCache = useExplorerStore(s => s.compositionCache)
  const expandedNodes = useExplorerStore(s => s.expandedNodes)
  const childPageLimits = useExplorerStore(s => s.childPageLimits)
  const objectIndex = useExplorerStore(s => s.objectIndex)
  const searchIndex = useExplorerStore(s => s.searchIndex)
  const searchQuery = useExplorerStore(s => s.searchQuery)
  const setSearchQuery = useExplorerStore(s => s.setSearchQuery)
  const pollIntervalMs = useExplorerStore(s => s.pollIntervalMs)
  const manualRefreshTick = useExplorerStore(s => s.manualRefreshTick)
  const selectedId = useExplorerStore(s => s.selectedItem?.id ?? null)
  const isConnected = useConnectionStore(state => state.isConnected)

  // The input tracks searchQuery directly; the expensive rebuild follows the
  // deferred value, so typing never blocks on filtering a 58k-object catalog.
  const deferredQuery = useDeferredValue(searchQuery)
  const filterText = deferredQuery.toLowerCase()

  // The whole visible tree as one ordered array. Memoized so scroll-driven
  // re-renders reuse it; it rebuilds only when tree data/expansion/filter change.
  const rows = useMemo(
    () =>
      buildTreeRows({
        namespaces,
        objectTypes,
        objectsByType: objects,
        allObjects,
        hierarchicalRoots,
        childObjects,
        childrenByParent,
        compositionCache,
        expandedNodes,
        childPageLimits,
        filterText,
        selectedId,
        objectIndex,
        searchIndex,
      }),
    [namespaces, objectTypes, objects, allObjects, hierarchicalRoots,
     childObjects, childrenByParent, compositionCache, expandedNodes,
     childPageLimits, filterText, selectedId, objectIndex, searchIndex]
  )

  // ── Virtualization ────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(ESTIMATED_ROW_HEIGHT)
  const rowHeightRef = useRef(ESTIMATED_ROW_HEIGHT)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: index => rows[index].key,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
  const paddingBottom =
    virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0

  // Measure the true row height once from the first mounted node row so the
  // spacer math matches the DOM regardless of platform font metrics.
  const measuredRef = useRef(false)
  const measureFirstRow = useCallback((el: HTMLDivElement | null) => {
    if (!el || measuredRef.current) return
    const h = el.getBoundingClientRect().height
    if (h > 0) {
      measuredRef.current = true
      rowHeightRef.current = h
      if (Math.abs(h - rowHeight) > 0.5) setRowHeight(h)
    }
  }, [rowHeight])

  // ── Content width ─────────────────────────────────────────────────────────
  // The tree scrolls both axes and only mounts visible rows, so the content
  // width must be computed, not laid out. One cheap approximate pass finds the
  // few widest candidates; only those are measured exactly with canvas text
  // metrics (measuring all 50k+ labels per rebuild would cost real time).
  const [listMinWidth, setListMinWidth] = useState(0)
  useLayoutEffect(() => {
    if (rows.length === 0) {
      setListMinWidth(0)
      return
    }
    const approxOf = (row: TreeRow) => {
      const labelLen =
        row.kind === 'node' ? row.label.length :
        row.kind === 'marker' ? row.message.length : 0
      const countLen =
        row.kind === 'node' && row.count !== undefined
          ? row.count.toLocaleString().length : 0
      let approx = row.depth * TREE_INDENT_PX + TREE_BASE_PADDING_PX + labelLen * 8
      approx += row.kind === 'more'
        ? TREE_MORE_ROW_PX
        : TREE_CHEVRON_SLOT_PX + TREE_ICON_SLOT_PX + TREE_GAP_PX * 2
      if (countLen > 0) approx += TREE_COUNT_EXTRA_PX + countLen * 8
      return approx + TREE_WIDTH_SAFETY_PX
    }

    const candidates: { row: TreeRow; approx: number }[] = []
    for (const row of rows) {
      const approx = approxOf(row)
      if (candidates.length < WIDTH_CANDIDATES) {
        candidates.push({ row, approx })
        continue
      }
      let minIdx = 0
      for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].approx < candidates[minIdx].approx) minIdx = i
      }
      if (approx > candidates[minIdx].approx) candidates[minIdx] = { row, approx }
    }

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const labelEl = scrollRef.current?.querySelector('.tree-node .tree-label')
    const styleSource = labelEl ?? scrollRef.current
    if (context && styleSource) {
      const style = window.getComputedStyle(styleSource)
      context.font = style.font || `${style.fontSize} ${style.fontFamily}`
    }
    const measureText = (text: string) => context?.measureText(text).width ?? text.length * 8

    let widest = 0
    for (const { row } of candidates) {
      const leftPadding = row.depth * TREE_INDENT_PX + TREE_BASE_PADDING_PX
      let width = leftPadding + TREE_WIDTH_SAFETY_PX
      if (row.kind === 'node') {
        width += TREE_CHEVRON_SLOT_PX + TREE_ICON_SLOT_PX + TREE_GAP_PX * 2 + measureText(row.label)
        if (row.count !== undefined) {
          width += TREE_COUNT_EXTRA_PX + measureText(row.count.toLocaleString())
        }
      } else if (row.kind === 'marker') {
        width += measureText(row.message)
      } else {
        width += TREE_CHEVRON_SLOT_PX + TREE_GAP_PX + TREE_MORE_ROW_PX
      }
      widest = Math.max(widest, Math.ceil(width))
    }
    setListMinWidth(prev => (Math.abs(prev - widest) > 0.5 ? widest : prev))
  }, [rows])

  // ── Lazy composition chevrons ─────────────────────────────────────────────
  // Resolve real child counts for the composition ('obj:') rows currently in
  // view, so optimistic chevrons self-correct without resolving the whole
  // catalog at once. Debounced so it fires once scrolling settles.
  useEffect(() => {
    const client = getClient()
    if (!client) return
    const targets: ObjectInstance[] = []
    for (const vi of virtualItems) {
      const row = rows[vi.index]
      if (row.kind !== 'node' || row.nodeType !== 'object' || !row.id.startsWith('obj:')) continue
      const obj = row.data as ObjectInstance
      if (obj.isComposition && !compositionCache.has(obj.elementId)) targets.push(obj)
    }
    if (targets.length === 0) return
    const handle = setTimeout(() => { void resolveCompositionFlags(client, targets) }, 150)
    return () => clearTimeout(handle)
  }, [virtualItems, rows, compositionCache])

  // ── Sticky ancestor header ────────────────────────────────────────────────
  // While scrolled deep inside one parent's (possibly enormous) child list, its
  // ancestor chain stays pinned at the top of the viewport, so "where am I" is
  // always answered. Clicking a pinned row jumps back to it.
  const [firstIndex, setFirstIndex] = useState(0)
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const next = Math.max(0, Math.floor(event.currentTarget.scrollTop / rowHeightRef.current))
    setFirstIndex(prev => (prev === next ? prev : next))
    // Rows shift under a fixed-position menu; close it rather than drift.
    setMenu(null)
  }, [])

  const fullAncestors = useCallback((index: number): number[] => {
    const chain: number[] = []
    let p = rows[Math.min(index, rows.length - 1)]?.parentIndex ?? -1
    while (p >= 0) {
      chain.unshift(p)
      p = rows[p].parentIndex
    }
    return chain
  }, [rows])

  const stickyChain = useMemo(() => {
    if (firstIndex <= 0 || rows.length === 0) return [] as number[]
    // Fixed-point: the header occupies rows of its own height, so the chain is
    // computed for the row that ends up visible just below it.
    let chain: number[] = []
    for (let iteration = 0; iteration < 4; iteration++) {
      const next = fullAncestors(firstIndex + chain.length)
      if (next.length === chain.length) { chain = next; break }
      chain = next
    }
    return chain.slice(-MAX_STICKY_ROWS)
  }, [rows, firstIndex, fullAncestors])

  const stickyLenRef = useRef(0)
  stickyLenRef.current = stickyChain.length

  const jumpToRow = useCallback((index: number) => {
    // Land the row just below the sticky rows that will remain above it.
    const pinned = Math.min(fullAncestors(index).length, MAX_STICKY_ROWS)
    virtualizer.scrollToOffset(Math.max(0, (index - pinned) * rowHeightRef.current))
  }, [virtualizer, fullAncestors])

  // ── Context menu ──────────────────────────────────────────────────────────
  // Entries are built at open time (buildTreeMenu) and capture the row's data
  // in closures, so they stay valid even if the row list shifts underneath.
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const { selectElement } = useElementNavigation()

  const openMenuForRow = useCallback((index: number, x: number, y: number) => {
    const row = rows[index]
    if (!row) return
    const entries = buildTreeMenu(row, selectElement)
    if (!entries) return
    setFocusedIndex(index)
    setMenu({ x, y, entries })
  }, [rows, selectElement])

  const closeMenu = useCallback(() => {
    setMenu(null)
    // Hand focus back to the tree so keyboard navigation resumes seamlessly.
    scrollRef.current?.focus({ preventScroll: true })
  }, [])

  const handleRowContextMenu = useCallback((index: number) => (event: React.MouseEvent) => {
    event.preventDefault()
    openMenuForRow(index, event.clientX, event.clientY)
  }, [openMenuForRow])

  /** Keyboard path (Shift+F10 / Menu key): anchor the menu to the focused row. */
  const openMenuAtRow = useCallback((index: number) => {
    const scrollEl = scrollRef.current
    if (!scrollEl || !rows[index]) return
    const rect = scrollEl.getBoundingClientRect()
    const h = rowHeightRef.current
    const y = rect.top + (index * h - scrollEl.scrollTop) + h
    const x = rect.left + Math.min(rows[index].depth * 16 + 60, rect.width / 2)
    openMenuForRow(index, x, y)
  }, [rows, openMenuForRow])

  // ── Keyboard navigation (ARIA tree pattern) ───────────────────────────────
  // Roving focus lives on the tree container (aria-activedescendant); arrows
  // move, Left/Right collapse/expand, Enter/Space activate, letters type-ahead.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const typeAheadRef = useRef({ buffer: '', at: 0 })

  const ensureRowVisible = useCallback((index: number) => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const h = rowHeightRef.current
    const top = index * h
    const stickyPx = stickyLenRef.current * h
    if (top < scrollEl.scrollTop + stickyPx) {
      scrollEl.scrollTop = Math.max(0, top - stickyPx)
    } else if (top + h > scrollEl.scrollTop + scrollEl.clientHeight) {
      scrollEl.scrollTop = top + h - scrollEl.clientHeight
    }
  }, [])

  const moveFocus = useCallback((index: number) => {
    if (index < 0 || index >= rows.length) return
    setFocusedIndex(index)
    ensureRowVisible(index)
  }, [rows.length, ensureRowVisible])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return
    // Leave modified keys to the browser/app (shortcuts, devtools, etc.).
    if (event.ctrlKey || event.metaKey || event.altKey) return

    const current = focusedIndex !== null && focusedIndex < rows.length
      ? focusedIndex
      : Math.max(0, rows.findIndex(r => r.kind === 'node' && r.id === selectedId))
    const row = rows[current]

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(stepFocus(rows, current, 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(stepFocus(rows, current, -1))
        break
      case 'ArrowRight':
        event.preventDefault()
        if (row?.kind !== 'node') break
        if (row.hasChildren && !row.isExpanded) {
          expandRow(row)
          setFocusedIndex(current)
        } else if (row.isExpanded && rows[current + 1]?.parentIndex === current) {
          moveFocus(current + 1)
        }
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (!row) break
        if (row.kind === 'node' && row.hasChildren && row.isExpanded) {
          useExplorerStore.getState().collapseNode(row.id)
          setFocusedIndex(current)
        } else if (row.parentIndex >= 0) {
          moveFocus(row.parentIndex)
        }
        break
      case 'Home':
        event.preventDefault()
        moveFocus(stepFocus(rows, -1, 1))
        break
      case 'End':
        event.preventDefault()
        moveFocus(stepFocus(rows, rows.length, -1))
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (row?.kind === 'node') activateRow(row)
        else if (row?.kind === 'more') {
          useExplorerStore.getState().raiseChildLimit(row.parentId, CHILD_PAGE_SIZE)
        }
        setFocusedIndex(current)
        break
      case 'ContextMenu':
        event.preventDefault()
        openMenuAtRow(current)
        break
      case 'F10':
        if (!event.shiftKey) break
        event.preventDefault()
        openMenuAtRow(current)
        break
      default: {
        // Type-ahead: printable characters jump to the next matching label.
        if (event.key.length !== 1) break
        event.preventDefault()
        const now = performance.now()
        const state = typeAheadRef.current
        state.buffer = now - state.at < TYPE_AHEAD_RESET_MS
          ? state.buffer + event.key.toLowerCase()
          : event.key.toLowerCase()
        state.at = now
        const match = findTypeAhead(rows, current, state.buffer)
        if (match >= 0) moveFocus(match)
      }
    }
  }, [rows, focusedIndex, selectedId, moveFocus, openMenuAtRow])

  // ── Reveal the selected node ──────────────────────────────────────────────
  // Uniform row heights mean every row has a position whether mounted or not,
  // so reveal is pure index math — no DOM probing across tree sections.
  const lastRevealedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId) return
    // Selection unchanged: data moved, the user didn't. Don't fight their scroll.
    if (lastRevealedRef.current === selectedId) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const index = rows.findIndex(r => r.kind === 'node' && r.id === selectedId)
    // Not in the visible forest yet (data loading, ancestor collapsed): leave
    // the ref unset so a later rows change retries.
    if (index === -1) return
    lastRevealedRef.current = selectedId
    setFocusedIndex(index)
    const h = rowHeightRef.current
    const top = index * h
    const viewTop = scrollEl.scrollTop + stickyLenRef.current * h
    if (top >= viewTop && top + h <= scrollEl.scrollTop + scrollEl.clientHeight) return
    // Vertical-only: scrollToIndex writes scrollTop and never scrollLeft, so a
    // horizontally-scrolled tree stays put.
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [selectedId, rows, virtualizer])

  // ── Expansion entry animation ─────────────────────────────────────────────
  // Track which node most recently expanded; its direct children get a short
  // ease-in when they mount. Scroll-driven mounts never qualify, so scrolling
  // stays animation-free.
  const prevExpandedRef = useRef(expandedNodes)
  const lastExpandRef = useRef<{ id: string; at: number } | null>(null)
  if (prevExpandedRef.current !== expandedNodes) {
    for (const id of expandedNodes) {
      if (!prevExpandedRef.current.has(id)) {
        lastExpandRef.current = { id, at: performance.now() }
        break
      }
    }
    prevExpandedRef.current = expandedNodes
  }
  const expandInfo = lastExpandRef.current
  const animatingExpandId =
    expandInfo && performance.now() - expandInfo.at < 400 ? expandInfo.id : null

  // ── Active indent guide ───────────────────────────────────────────────────
  // The guide column under the selected node is accented for its descendants,
  // so the subtree you're working in reads at a glance.
  const selectedRowIndex = useMemo(
    () => (selectedId ? rows.findIndex(r => r.kind === 'node' && r.id === selectedId) : -1),
    [rows, selectedId]
  )
  const activeGuideFor = useCallback((index: number): number | null => {
    if (selectedRowIndex < 0) return null
    let p = rows[index].parentIndex
    while (p >= 0) {
      if (p === selectedRowIndex) return (rows[selectedRowIndex] as NodeRow).depth
      p = rows[p].parentIndex
    }
    return null
  }, [rows, selectedRowIndex])

  // ── Background refresh ────────────────────────────────────────────────────
  const refreshTree = useCallback(async () => {
    const client = getClient()
    if (!client) return

    const { expandedNodes, setNamespaces, setObjectTypes, setObjects, setHierarchicalRoots, setChildObjects } = useExplorerStore.getState()

    try {
      const [namespaces, objectTypes] = await Promise.all([
        client.getNamespaces(),
        client.getObjectTypes()
      ])
      setNamespaces(namespaces)
      setObjectTypes(objectTypes)
    } catch (err) {
      console.error('Background refresh: namespaces/types failed', err)
    }

    let allObjectsRefreshed = false
    const refreshedChildIds = new Set<string>()

    for (const nodeId of expandedNodes) {
      if (nodeId.startsWith('type:')) {
        const typeElementId = nodeId.slice(5)
        try {
          const objects = await client.getObjects(typeElementId)
          await resolveCompositionFlags(client, objects)
          setObjects(typeElementId, objects)
        } catch (err) {
          console.error('Background refresh: type failed', typeElementId, err)
        }
      }

      if ((nodeId === OBJECTS_FOLDER_ID || nodeId === HIERARCHICAL_FOLDER_ID) && !allObjectsRefreshed) {
        allObjectsRefreshed = true
        try {
          await refreshAllObjects(client, true)
        } catch (err) {
          console.error('Background refresh: all objects failed', err)
        }
      }

      if (nodeId === HIERARCHICAL_FOLDER_ID) {
        try {
          const roots = await client.getObjects(undefined, false, true)
          await resolveCompositionFlags(client, roots)
          setHierarchicalRoots(roots)
        } catch (err) {
          console.error('Background refresh: root objects failed', err)
        }
      }

      if (nodeId.startsWith('obj:') || nodeId.startsWith('hier:')) {
        const elementId = nodeId.startsWith('obj:') ? nodeId.slice(4) : nodeId.slice(5)
        if (!refreshedChildIds.has(elementId)) {
          refreshedChildIds.add(elementId)
          try {
            const related = await client.getRelatedObjects(elementId, 'HasComponent')
            const compositionalChildren = related.filter(child =>
              child.isComposition &&
              child.elementId !== elementId &&
              child.parentId === elementId
            )
            await resolveCompositionFlags(client, compositionalChildren)
            setChildObjects(elementId, compositionalChildren)
          } catch (err) {
            console.error('Background refresh: children failed', elementId, err)
          }
        }
      }
    }
  }, [])

  // Background poll on configured interval (0 = disabled)
  useEffect(() => {
    if (!isConnected || !BACKGROUND_POLL_ENABLED || pollIntervalMs === 0) return
    const intervalId = setInterval(refreshTree, pollIntervalMs)
    return () => clearInterval(intervalId)
  }, [isConnected, pollIntervalMs, refreshTree])

  // Manual refresh trigger
  useEffect(() => {
    if (!isConnected || manualRefreshTick === 0) return
    refreshTree()
  }, [manualRefreshTick, isConnected, refreshTree])

  // Auto-expand the three root folders whenever a search query is active so
  // matches are visible without the user having to click each folder open.
  useEffect(() => {
    if (!searchQuery.trim()) return
    const { expandNode } = useExplorerStore.getState()
    expandNode(NAMESPACES_FOLDER_ID)
    expandNode(OBJECTS_FOLDER_ID)
    expandNode(HIERARCHICAL_FOLDER_ID)
  }, [searchQuery])

  // ── Micro-toolbar actions ─────────────────────────────────────────────────
  const collapseAll = useCallback(() => {
    useExplorerStore.setState({ expandedNodes: new Set(), childPageLimits: new Map() })
    setFocusedIndex(null)
  }, [])

  const locateSelection = useCallback(() => {
    if (!selectedId) return
    const index = rows.findIndex(r => r.kind === 'node' && r.id === selectedId)
    if (index === -1) return
    setFocusedIndex(index)
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [selectedId, rows, virtualizer])

  const hasNamespaces = namespaces.length > 0
  const firstNodeItem = virtualItems.find(vi => rows[vi.index]?.kind === 'node')
  const toolButton =
    'shrink-0 w-6 h-6 grid place-items-center rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary'

  return (
    <div className="flex flex-col h-full min-h-0 text-i3x-text">
      {/* Filter input + micro-toolbar, fixed header so it stays put (and
          full-width) while the tree body scrolls horizontally */}
      <div className="shrink-0 bg-i3x-surface pb-2 mb-1 flex items-center gap-1.5">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Filter tree…"
          className="flex-1 min-w-0 px-2 py-1 text-sm bg-i3x-bg border border-i3x-border rounded text-i3x-text placeholder:text-i3x-text-muted focus:outline-none focus:border-i3x-primary"
        />
        <button
          type="button"
          onClick={collapseAll}
          title="Collapse all"
          aria-label="Collapse all"
          className={toolButton}
        >
          <CollapseAllIcon size={14} />
        </button>
        <button
          type="button"
          onClick={locateSelection}
          disabled={!selectedId}
          title="Reveal selection"
          aria-label="Reveal selection"
          className={toolButton}
        >
          <TargetIcon size={14} />
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        {/* Sticky ancestor header: pinned to the viewport, unaffected by
            horizontal scroll, above the windowed rows. */}
        {stickyChain.length > 0 && (
          <div className="absolute top-0 left-0 right-2 z-10 border-b border-i3x-border bg-i3x-surface/95 backdrop-blur-[2px] shadow-sm overflow-hidden">
            {stickyChain.map(index => {
              const row = rows[index] as NodeRow
              return (
                <div
                  key={row.key}
                  onClick={() => jumpToRow(index)}
                  onContextMenu={handleRowContextMenu(index)}
                  title={`Jump to ${row.label}`}
                  style={{ paddingLeft: `${row.depth * 16 + 8}px`, height: rowHeight }}
                  className="flex items-center gap-2 pr-2 cursor-pointer hover:bg-i3x-text/[0.06]"
                >
                  <span className="w-4 flex-shrink-0 flex items-center justify-center">
                    <Chevron open />
                  </span>
                  <span className="flex-shrink-0 flex items-center">
                    <TreeRowIcon row={row} />
                  </span>
                  <span className="whitespace-nowrap text-sm truncate">{row.label}</span>
                </div>
              )
            })}
          </div>
        )}

        {/* Tree body, scrolls both axes. The inner w-max wrapper grows to the
            computed widest row so long labels/deep nesting extend a horizontal
            scrollbar, while min-w-full keeps rows (highlights, count pills)
            panel-wide when content fits. */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          role="tree"
          aria-label="Model tree"
          aria-activedescendant={focusedIndex !== null ? `tree-row-${focusedIndex}` : undefined}
          className="h-full overflow-auto focus:outline-none"
        >
          <div
            className="w-max min-w-full"
            style={listMinWidth > 0 ? { minWidth: listMinWidth } : undefined}
          >
            <div style={{ paddingTop, paddingBottom }}>
              {virtualItems.map(vi => {
                const row = rows[vi.index]
                const parentRow = row.parentIndex >= 0 ? rows[row.parentIndex] : undefined
                const entering =
                  animatingExpandId !== null &&
                  parentRow?.kind === 'node' &&
                  parentRow.id === animatingExpandId
                const enterDelay = entering
                  ? Math.min(Math.max(vi.index - row.parentIndex - 1, 0), 10) * 14
                  : 0
                const wrapperClass = entering ? 'tree-row-enter' : undefined
                const wrapperStyle = enterDelay > 0 ? { animationDelay: `${enterDelay}ms` } : undefined
                const focused = focusedIndex === vi.index
                const activeGuide = activeGuideFor(vi.index)

                if (row.kind === 'marker') {
                  return (
                    <div key={row.key} className={wrapperClass} style={wrapperStyle}>
                      <div
                        style={{ paddingLeft: `${row.depth * 16 + 8}px`, height: rowHeight }}
                        className="relative flex items-center text-i3x-text-muted text-sm"
                      >
                        <IndentGuides depth={row.depth} active={activeGuide} />
                        {row.message}
                      </div>
                    </div>
                  )
                }
                if (row.kind === 'more') {
                  return (
                    <div
                      key={row.key}
                      id={`tree-row-${vi.index}`}
                      className={wrapperClass}
                      style={wrapperStyle}
                      onClick={() => setFocusedIndex(vi.index)}
                      onContextMenu={handleRowContextMenu(vi.index)}
                    >
                      <TreeMoreNode row={row} height={rowHeight} focused={focused} activeGuide={activeGuide} />
                    </div>
                  )
                }
                const measure = vi.key === firstNodeItem?.key ? measureFirstRow : undefined
                return (
                  <div
                    key={row.key}
                    ref={measure}
                    className={wrapperClass}
                    style={wrapperStyle}
                    onClick={() => setFocusedIndex(vi.index)}
                    onContextMenu={handleRowContextMenu(vi.index)}
                  >
                    <TreeNode
                      row={row}
                      focused={focused}
                      activeGuide={activeGuide}
                      domId={`tree-row-${vi.index}`}
                    />
                  </div>
                )
              })}
            </div>
          </div>

          {!hasNamespaces && (
            <div className="text-center text-i3x-text-muted text-sm py-4">
              {searchQuery ? 'No results found' : 'Connect to a server to browse'}
            </div>
          )}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} />}
    </div>
  )
}
