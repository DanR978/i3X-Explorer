import { describe, expect, it } from 'vitest'
import {
  buildTreeRows,
  HIERARCHICAL_FOLDER_ID,
  OBJECTS_FOLDER_ID,
  type TreeBuildInput,
  type TreeRow,
} from './treeData'
import { CHILD_PAGE_SIZE, CHILD_PAGE_SLACK } from '../../stores/explorer'
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
