import { describe, expect, it } from 'vitest'
import {
  groupNeighbors,
  humanizeRelationship,
  planGroupExpansion,
  relAncestorRowIds,
  relChildPath,
  relElementId,
  relGroupRowId,
  relPathIds,
  relRowId,
  type RelationshipGroup,
} from './relationshipTree'
import { REL_AUTO_EXPAND_NEIGHBORS, REL_SEP } from '../../stores/explorer'
import type { Neighbor } from '../graph/egoGraph'
import type { ObjectInstance, RelationshipType } from '../../api/types'

function obj(elementId: string): ObjectInstance {
  return {
    elementId,
    displayName: elementId,
    typeId: 'T',
    parentId: null,
    isComposition: false,
    namespaceUri: 'urn:ns',
  }
}

const neighbor = (id: string, relationshipType?: string): Neighbor => ({
  object: obj(id),
  relationshipType,
})

const relType = (elementId: string, displayName: string): RelationshipType => ({
  elementId,
  displayName,
  namespaceUri: 'urn:ns',
  reverseOf: '',
})

describe('relationship paths', () => {
  it('builds, reads and reverses a path', () => {
    const a = relChildPath('', 'A')
    const ab = relChildPath(a, 'B')
    const abc = relChildPath(ab, 'C')

    expect(a).toBe('A')
    expect(abc).toBe(['A', 'B', 'C'].join(REL_SEP))
    expect(relElementId(abc)).toBe('C')
  })

  it('reports the whole branch, which is what a row filters its neighbours by', () => {
    const abc = ['A', 'B', 'C'].join(REL_SEP)
    expect([...relPathIds(abc)].sort()).toEqual(['A', 'B', 'C'])
    // Not just the step above: A is three hops up and still must not be redrawn.
    expect(relPathIds(abc).has('A')).toBe(true)
    expect(relPathIds('A')).toEqual(new Set(['A']))
  })

  it('treats every prefix of a path as an ancestor row', () => {
    const path = ['A', 'B', 'C'].join(REL_SEP)
    expect(relAncestorRowIds(path)).toEqual([
      relRowId('A'),
      relRowId(['A', 'B'].join(REL_SEP)),
    ])
    expect(relAncestorRowIds('A')).toEqual([])
  })

  it('keeps the same element distinct at different places in the walk', () => {
    // The whole reason a row id is a path: one hub reached two ways is two rows,
    // and expanding one must not expand the other.
    expect(relRowId(['A', 'X'].join(REL_SEP))).not.toBe(relRowId(['B', 'X'].join(REL_SEP)))
  })
})

describe('humanizeRelationship', () => {
  it('renders camel case and separators as sentence case', () => {
    expect(humanizeRelationship('HasComponent')).toBe('Has component')
    expect(humanizeRelationship('FeedsTo')).toBe('Feeds to')
    expect(humanizeRelationship('fed_by')).toBe('Fed by')
    expect(humanizeRelationship('InheritsFrom')).toBe('Inherits from')
  })

  it('leaves runs of capitals alone', () => {
    expect(humanizeRelationship('HasOPCUANode')).toBe('Has OPCUA node')
  })

  it('falls back rather than rendering an empty label', () => {
    expect(humanizeRelationship('')).toBe('Related')
    expect(humanizeRelationship('  ')).toBe('Related')
  })
})

describe('groupNeighbors', () => {
  const index = new Map([['FeedsTo', relType('FeedsTo', 'Feeds to')]])

  it('groups by relationship type and orders by bucket, then label', () => {
    const groups = groupNeighbors(
      [
        neighbor('sink', 'FeedsTo'),
        neighbor('kid', 'HasComponent'),
        neighbor('mum', 'HasParent'),
        neighbor('base', 'InheritsFrom'),
      ],
      index
    )
    // Where it sits, what it holds, what it inherits, then everything else.
    expect(groups.map(g => g.key)).toEqual(['HasParent', 'HasComponent', 'InheritsFrom', 'FeedsTo'])
    expect(groups.map(g => g.bucket)).toEqual(['parent', 'child', 'inherits', 'other'])
  })

  it('prefers the server declared name, and humanizes it either way', () => {
    // A server that already writes prose passes straight through.
    const [feeds] = groupNeighbors([neighbor('sink', 'FeedsTo')], index)
    expect(feeds.label).toBe('Feeds to')
    // The common case: displayName IS the identifier. Taking it verbatim would
    // put "SuppliedBy" in a column of prose.
    const asIdentifier = new Map([['SuppliedBy', relType('SuppliedBy', 'SuppliedBy')]])
    const [supplied] = groupNeighbors([neighbor('src', 'SuppliedBy')], asIdentifier)
    expect(supplied.label).toBe('Supplied by')
    // No declared type at all: derive from the raw relationship.
    const [unnamed] = groupNeighbors([neighbor('sink', 'PumpsInto')], new Map())
    expect(unnamed.label).toBe('Pumps into')
  })

  it('collects neighbours with no reported relationship under one group', () => {
    const groups = groupNeighbors([neighbor('x'), neighbor('y')], new Map())
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: '', label: 'Related', bucket: 'other' })
    expect(groups[0].neighbors).toHaveLength(2)
  })
})

describe('planGroupExpansion', () => {
  const group = (key: string, size: number): RelationshipGroup => ({
    key,
    label: key,
    bucket: 'other',
    neighbors: Array.from({ length: size }, (_, i) => neighbor(`${key}${i}`, key)),
  })

  it('opens nothing when there is a single kind (no header is drawn for it)', () => {
    expect(planGroupExpansion('A', [group('HasComponent', 4)])).toEqual([])
  })

  it('opens every group of a small node', () => {
    const groups = [group('HasParent', 1), group('HasComponent', 3)]
    expect(planGroupExpansion('A', groups)).toEqual([
      relGroupRowId('A', 'HasParent'),
      relGroupRowId('A', 'HasComponent'),
    ])
  })

  it('leaves a big node closed, so it reads as a table of contents', () => {
    const groups = [group('HasParent', 1), group('HasComponent', REL_AUTO_EXPAND_NEIGHBORS)]
    expect(planGroupExpansion('A', groups)).toEqual([])
  })
})
