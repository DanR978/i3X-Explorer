import { describe, expect, it } from 'vitest'
import {
  buildTreeRows,
  HIERARCHICAL_FOLDER_ID,
  OBJECTS_FOLDER_ID,
  type NodeRow,
  type TreeBuildInput,
  type TreeRow,
} from './treeData'
import { relGroupRowId, relRowId } from './relationshipTree'
import { CHILD_PAGE_SIZE, CHILD_PAGE_SLACK, REL_PREFIX, REL_SEP } from '../../stores/explorer'
import type { ObjectInstance } from '../../api/types'

function obj(elementId: string, over: Partial<ObjectInstance> = {}): ObjectInstance {
  return {
    elementId,
    displayName: elementId,
    typeId: 'T',
    parentId: null,
    isComposition: false,
    namespaceUri: 'urn:ns',
    ...over,
  }
}

function input(over: Partial<TreeBuildInput> = {}): TreeBuildInput {
  return {
    namespaces: [],
    objectTypes: [],
    objectsByType: new Map(),
    allObjects: [],
    hierarchicalRoots: [],
    childObjects: new Map(),
    childrenByParent: new Map(),
    compositionCache: new Map(),
    expandedNodes: new Set(),
    childPageLimits: new Map(),
    filterText: '',
    selectedId: null,
    objectIndex: new Map(),
    searchIndex: new Map(),
    treeStructure: 'hierarchy',
    relatedObjects: new Map(),
    relatedNeighborIds: new Map(),
    relationshipTypeIndex: new Map(),
    ...over,
  }
}

const nodeIndexOf = (rows: TreeRow[], id: string) =>
  rows.findIndex(r => r.kind === 'node' && r.id === id)

const markerMessages = (rows: TreeRow[]) =>
  rows.filter(r => r.kind === 'marker').map(r => r.message)

describe('buildTreeRows: hierarchy walk guards', () => {
  it('emits a cycle marker instead of recursing on a parentId cycle', () => {
    const A = obj('A')
    const B = obj('B', { parentId: 'A' })
    const rows = buildTreeRows(
      input({
        hierarchicalRoots: [A],
        childrenByParent: new Map([
          ['A', [B]],
          ['B', [A]], // the cycle
        ]),
        expandedNodes: new Set([HIERARCHICAL_FOLDER_ID, 'hier:A', 'hier:B']),
      })
    )
    expect(markerMessages(rows)).toContain('(cycle detected)')
    // The walk stopped: A appears once as a node, not twice.
    expect(rows.filter(r => r.kind === 'node' && r.id === 'hier:A')).toHaveLength(1)
  })

  it('emits a max-depth marker on a chain deeper than MAX_TREE_DEPTH', () => {
    const chain = Array.from({ length: 25 }, (_, i) =>
      obj(`c${i}`, { parentId: i === 0 ? null : `c${i - 1}` })
    )
    const childrenByParent = new Map(chain.slice(0, -1).map((o, i) => [o.elementId, [chain[i + 1]]]))
    const rows = buildTreeRows(
      input({
        hierarchicalRoots: [chain[0]],
        childrenByParent,
        expandedNodes: new Set([HIERARCHICAL_FOLDER_ID, ...chain.map(o => `hier:${o.elementId}`)]),
      })
    )
    expect(markerMessages(rows)).toContain('(max depth reached)')
  })
})

describe('buildTreeRows: paging', () => {
  const bigFamily = (childCount: number) => {
    const parent = obj('P')
    const kids = Array.from({ length: childCount }, (_, i) => obj(`k${i}`, { parentId: 'P' }))
    return input({
      hierarchicalRoots: [parent],
      childrenByParent: new Map([['P', kids]]),
      expandedNodes: new Set([HIERARCHICAL_FOLDER_ID, 'hier:P']),
      objectIndex: new Map([parent, ...kids].map(o => [o.elementId, o])),
    })
  }

  it('pages past CHILD_PAGE_SIZE + SLACK with an accurate "more" row', () => {
    const rows = buildTreeRows(bigFamily(CHILD_PAGE_SIZE + CHILD_PAGE_SLACK + 10))
    const childRows = rows.filter(r => r.kind === 'node' && r.id.startsWith('hier:k'))
    expect(childRows).toHaveLength(CHILD_PAGE_SIZE)
    const more = rows.find(r => r.kind === 'more')
    expect(more).toMatchObject({
      parentId: 'hier:P',
      shown: CHILD_PAGE_SIZE,
      hidden: CHILD_PAGE_SLACK + 10,
    })
  })

  it('does not truncate a trivial overflow (within the slack)', () => {
    const rows = buildTreeRows(bigFamily(CHILD_PAGE_SIZE + CHILD_PAGE_SLACK))
    expect(rows.filter(r => r.kind === 'node' && r.id.startsWith('hier:k'))).toHaveLength(
      CHILD_PAGE_SIZE + CHILD_PAGE_SLACK
    )
    expect(rows.some(r => r.kind === 'more')).toBe(false)
  })

  it('leaves the flat Objects folder top level unpaged', () => {
    const all = Array.from({ length: CHILD_PAGE_SIZE + CHILD_PAGE_SLACK + 50 }, (_, i) => obj(`o${i}`))
    const rows = buildTreeRows(
      input({ allObjects: all, expandedNodes: new Set([OBJECTS_FOLDER_ID]) })
    )
    expect(rows.filter(r => r.kind === 'node' && r.id.startsWith('obj:'))).toHaveLength(all.length)
    expect(rows.some(r => r.kind === 'more')).toBe(false)
  })

  it('force-emits a paged-out row on the selection path, after the more row', () => {
    const base = bigFamily(CHILD_PAGE_SIZE + CHILD_PAGE_SLACK + 10)
    const selected = `hier:k${CHILD_PAGE_SIZE + 1}` // beyond the visible page
    const rows = buildTreeRows({ ...base, selectedId: selected })
    const selectedIndex = nodeIndexOf(rows, selected)
    const moreIndex = rows.findIndex(r => r.kind === 'more')
    expect(selectedIndex).toBeGreaterThan(moreIndex)
    // Exactly one page plus the forced row.
    expect(rows.filter(r => r.kind === 'node' && r.id.startsWith('hier:k'))).toHaveLength(
      CHILD_PAGE_SIZE + 1
    )
  })
})

describe('buildTreeRows: relationship walk', () => {
  const related = (elementId: string, relationshipType: string): ObjectInstance =>
    obj(elementId, { sourceRelationship: relationshipType })

  /** Relationship-mode input with the folder open and `expanded` rows expanded. */
  const relInput = (
    roots: ObjectInstance[],
    relatedObjects: Map<string, ObjectInstance[]>,
    expanded: string[] = []
  ) =>
    input({
      treeStructure: 'relationships',
      hierarchicalRoots: roots,
      relatedObjects,
      expandedNodes: new Set([HIERARCHICAL_FOLDER_ID, ...expanded]),
    })

  const path = (...ids: string[]) => ids.join(REL_SEP)

  it('nests a single relationship kind directly, with no group header', () => {
    const rows = buildTreeRows(
      relInput(
        [obj('A')],
        new Map([['A', [related('B', 'HasComponent'), related('C', 'HasComponent')]]]),
        [relRowId('A')]
      )
    )
    expect(rows.some(r => r.kind === 'node' && r.nodeType === 'relGroup')).toBe(false)
    const b = rows[nodeIndexOf(rows, relRowId(path('A', 'B')))]
    expect(b).toMatchObject({ depth: 2, label: 'B' })
    expect(rows[nodeIndexOf(rows, relRowId('A'))]).toMatchObject({ count: 2 })
  })

  it('draws a group row per relationship kind once there is more than one', () => {
    const rows = buildTreeRows(
      relInput(
        [obj('A')],
        new Map([['A', [related('P', 'HasParent'), related('B', 'HasComponent'), related('T', 'FeedsTo')]]]),
        [relRowId('A')]
      )
    )
    const groups = rows.filter(r => r.kind === 'node' && r.nodeType === 'relGroup')
    expect(groups.map(g => (g as NodeRow).label)).toEqual(['Has parent', 'Has component', 'Feeds to'])
    expect(groups.every(g => (g as NodeRow).depth === 2)).toBe(true)
    // Collapsed by default: the headers are the answer at this point.
    expect(nodeIndexOf(rows, relRowId(path('A', 'B')))).toBe(-1)
  })

  it('puts a group members at one more level, once the group is open', () => {
    const groupId = relGroupRowId('A', 'FeedsTo')
    const rows = buildTreeRows(
      relInput(
        [obj('A')],
        new Map([['A', [related('P', 'HasParent'), related('T', 'FeedsTo')]]]),
        [relRowId('A'), groupId]
      )
    )
    expect(rows[nodeIndexOf(rows, relRowId(path('A', 'T')))]).toMatchObject({ depth: 3 })
    // The other group stayed shut.
    expect(nodeIndexOf(rows, relRowId(path('A', 'P')))).toBe(-1)
  })

  it('drops the edge it arrived through, so a node never lists its own parent', () => {
    const rows = buildTreeRows(
      relInput(
        [obj('A')],
        new Map([
          ['A', [related('B', 'HasComponent')]],
          // B reports A back (the same physical edge, seen from the far end).
          ['B', [related('A', 'HasParent'), related('C', 'HasComponent')]],
        ]),
        [relRowId('A'), relRowId(path('A', 'B'))]
      )
    )
    expect(nodeIndexOf(rows, relRowId(path('A', 'B', 'C')))).toBeGreaterThan(-1)
    expect(nodeIndexOf(rows, relRowId(path('A', 'B', 'A')))).toBe(-1)
    // One kind left after the drop, so still no group header.
    expect(rows.some(r => r.kind === 'node' && r.nodeType === 'relGroup')).toBe(false)
  })

  it('drops every ancestor, not only the one it came from', () => {
    // The failure this guards: a descendant three hops down still carries a
    // HasParent up to the root, so the root came back as a dead leaf under every
    // node beneath it. Dropping the immediate parent alone does not catch it.
    const rows = buildTreeRows(
      relInput(
        [obj('root')],
        new Map([
          ['root', [related('mid', 'HasComponent')]],
          ['mid', [related('leaf', 'HasComponent')]],
          ['leaf', [related('root', 'HasParent'), related('sink', 'FeedsTo')]],
        ]),
        [relRowId('root'), relRowId(path('root', 'mid')), relRowId(path('root', 'mid', 'leaf'))]
      )
    )
    expect(nodeIndexOf(rows, relRowId(path('root', 'mid', 'leaf', 'root')))).toBe(-1)
    // The genuinely new edge survives, and is the only kind left, so no header.
    expect(nodeIndexOf(rows, relRowId(path('root', 'mid', 'leaf', 'sink')))).toBeGreaterThan(-1)
    expect(rows.filter(r => r.kind === 'node' && r.nodeType === 'relGroup')).toHaveLength(0)
    // The count on the leaf row reflects what is actually drawn under it.
    expect(rows[nodeIndexOf(rows, relRowId(path('root', 'mid', 'leaf')))]).toMatchObject({ count: 1 })
  })

  it('closes a loop by not redrawing the branch, and stops walking it', () => {
    const rows = buildTreeRows(
      relInput(
        [obj('A')],
        new Map([
          ['A', [related('B', 'HasComponent')]],
          ['B', [related('C', 'HasComponent')]],
          ['C', [related('A', 'HasComponent')]], // back to the top
        ]),
        [relRowId('A'), relRowId(path('A', 'B')), relRowId(path('A', 'B', 'C'))]
      )
    )
    expect(nodeIndexOf(rows, relRowId(path('A', 'B', 'C')))).toBeGreaterThan(-1)
    // A is already the branch this row hangs from, so it is not drawn again and
    // the walk terminates rather than spiralling.
    expect(nodeIndexOf(rows, relRowId(path('A', 'B', 'C', 'A')))).toBe(-1)
    expect(rows[nodeIndexOf(rows, relRowId(path('A', 'B', 'C')))]).toMatchObject({
      hasChildren: false,
      count: undefined,
    })
  })

  it('pages a large group and force-emits the selection inside it', () => {
    // Neighbours are ordered alphabetically by name, so pad the numbers: with
    // bare k0…k69 the "past the page" row lands inside it lexicographically.
    const kids = Array.from({ length: CHILD_PAGE_SIZE + CHILD_PAGE_SLACK + 10 }, (_, i) =>
      related(`k${String(i).padStart(3, '0')}`, 'HasComponent')
    )
    const selected = relRowId(path('A', `k${String(CHILD_PAGE_SIZE + 1).padStart(3, '0')}`))
    const rows = buildTreeRows({
      ...relInput([obj('A')], new Map([['A', kids]]), [relRowId('A')]),
      selectedId: selected,
    })
    const shown = rows.filter(r => r.kind === 'node' && r.id.startsWith(relRowId(path('A', 'k'))))
    expect(shown).toHaveLength(CHILD_PAGE_SIZE + 1) // one page plus the forced row
    expect(nodeIndexOf(rows, selected)).toBeGreaterThan(rows.findIndex(r => r.kind === 'more'))
  })

  it('opens a collapsed group that holds the current selection', () => {
    const selected = relRowId(path('A', 'T'))
    const rows = buildTreeRows({
      ...relInput(
        [obj('A')],
        new Map([['A', [related('P', 'HasParent'), related('T', 'FeedsTo')]]]),
        [relRowId('A')] // neither group expanded
      ),
      selectedId: selected,
    })
    expect(nodeIndexOf(rows, selected)).toBeGreaterThan(-1)
    // Only the group on the path opened; the other stayed shut.
    expect(nodeIndexOf(rows, relRowId(path('A', 'P')))).toBe(-1)
  })

  it('leaves the hierarchy walk alone when the structure is hierarchy', () => {
    const rows = buildTreeRows(
      input({
        hierarchicalRoots: [obj('A')],
        childrenByParent: new Map([['A', [obj('B', { parentId: 'A' })]]]),
        relatedObjects: new Map([['A', [related('Z', 'FeedsTo')]]]),
        expandedNodes: new Set([HIERARCHICAL_FOLDER_ID, 'hier:A']),
      })
    )
    expect(nodeIndexOf(rows, 'hier:B')).toBeGreaterThan(-1)
    expect(rows.some(r => r.kind === 'node' && r.id.startsWith(REL_PREFIX))).toBe(false)
  })
})

describe('buildTreeRows: parentIndex chains', () => {
  it('points every row at the row it was emitted under', () => {
    const A = obj('A')
    const B = obj('B', { parentId: 'A' })
    const rows = buildTreeRows(
      input({
        hierarchicalRoots: [A],
        childrenByParent: new Map([['A', [B]]]),
        expandedNodes: new Set([HIERARCHICAL_FOLDER_ID, 'hier:A']),
      })
    )
    const folderIndex = nodeIndexOf(rows, HIERARCHICAL_FOLDER_ID)
    const aIndex = nodeIndexOf(rows, 'hier:A')
    const bIndex = nodeIndexOf(rows, 'hier:B')
    expect(rows[folderIndex].parentIndex).toBe(-1)
    expect(rows[aIndex].parentIndex).toBe(folderIndex)
    expect(rows[bIndex].parentIndex).toBe(aIndex)
  })
})
