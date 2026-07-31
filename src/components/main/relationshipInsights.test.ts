import { describe, expect, it } from 'vitest'
import {
  MAX_OUTLIERS_LISTED,
  MIN_NORM_INSTANCES,
  NORM_THRESHOLD,
  computeRelationshipInsights,
} from './relationshipInsights'
import type { ObjectInstance, ObjectType } from '../../api/types'

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

function type(elementId: string, displayName = elementId): ObjectType {
  return { elementId, displayName, namespaceUri: 'urn:ns', schema: {} }
}

/**
 * N pumps, each with a sensor child except the listed holdouts. Enough
 * instances to clear MIN_NORM_INSTANCES with the holdouts still ≥ threshold.
 */
function pumpsWithSensors(count: number, holdouts: number[]): ObjectInstance[] {
  const objects: ObjectInstance[] = []
  for (let i = 0; i < count; i++) {
    objects.push(obj(`pump${i}`, { typeId: 'pump' }))
    if (!holdouts.includes(i)) {
      objects.push(obj(`sensor${i}`, { typeId: 'sensor', parentId: `pump${i}` }))
    }
  }
  return objects
}

describe('computeRelationshipInsights: missing-child', () => {
  it('flags instances missing a child type that nearly all siblings have', () => {
    const insights = computeRelationshipInsights(
      pumpsWithSensors(20, [3, 17]),
      [type('pump', 'Pump'), type('sensor', 'Vibration Sensor')]
    )
    expect(insights).toHaveLength(1)
    const finding = insights[0]
    expect(finding.kind).toBe('missing-child')
    expect(finding.typeLabel).toBe('Pump')
    expect(finding.relatedTypeLabel).toBe('Vibration Sensor')
    expect(finding.conforming).toBe(18)
    expect(finding.total).toBe(20)
    expect(finding.outlierCount).toBe(2)
    expect(finding.outliers.map(o => o.elementId)).toEqual(['pump3', 'pump17'])
  })

  it('stays silent at 100% coverage — a norm with no exceptions is not a finding', () => {
    expect(computeRelationshipInsights(pumpsWithSensors(20, []), [])).toHaveLength(0)
  })

  it('stays silent below the coverage threshold', () => {
    // 14 of 20 = 70%: a tendency, not a norm.
    const holdouts = [0, 1, 2, 3, 4, 5]
    expect(computeRelationshipInsights(pumpsWithSensors(20, holdouts), [])).toHaveLength(0)
  })

  it('needs MIN_NORM_INSTANCES before any pattern counts', () => {
    const insights = computeRelationshipInsights(
      pumpsWithSensors(MIN_NORM_INSTANCES - 1, []),
      []
    )
    expect(insights).toHaveLength(0)
  })

  it('lists at most MAX_OUTLIERS_LISTED outliers but counts them all', () => {
    // 100 pumps, 10 holdouts → coverage 0.9, exactly at the threshold.
    const holdouts = Array.from({ length: 10 }, (_, i) => i * 7)
    const insights = computeRelationshipInsights(pumpsWithSensors(100, holdouts), [])
    expect(insights).toHaveLength(1)
    expect(insights[0].coverage).toBeGreaterThanOrEqual(NORM_THRESHOLD)
    expect(insights[0].outlierCount).toBe(10)
    expect(insights[0].outliers).toHaveLength(MAX_OUTLIERS_LISTED)
  })
})

describe('computeRelationshipInsights: unusual-parent', () => {
  it('flags instances living under a different parent type than the norm', () => {
    const objects: ObjectInstance[] = [obj('rackA', { typeId: 'rack' }), obj('bin', { typeId: 'bin' })]
    for (let i = 0; i < 19; i++) {
      objects.push(obj(`plc${i}`, { typeId: 'plc', parentId: 'rackA' }))
    }
    objects.push(obj('plc19', { typeId: 'plc', parentId: 'bin' }))

    const insights = computeRelationshipInsights(objects, [type('plc', 'PLC'), type('rack', 'Rack')])
    const finding = insights.find(f => f.kind === 'unusual-parent' && f.typeId === 'plc')
    expect(finding).toBeDefined()
    expect(finding!.relatedTypeLabel).toBe('Rack')
    expect(finding!.conforming).toBe(19)
    expect(finding!.total).toBe(20)
    expect(finding!.outliers.map(o => o.elementId)).toEqual(['plc19'])
  })

  it('counts root-level instances as outliers when the norm is a real parent type', () => {
    const objects: ObjectInstance[] = [obj('rackA', { typeId: 'rack' })]
    for (let i = 0; i < 19; i++) {
      objects.push(obj(`plc${i}`, { typeId: 'plc', parentId: 'rackA' }))
    }
    objects.push(obj('plc19', { typeId: 'plc' })) // at the root

    const insights = computeRelationshipInsights(objects, [])
    const finding = insights.find(f => f.kind === 'unusual-parent' && f.typeId === 'plc')
    expect(finding).toBeDefined()
    expect(finding!.outliers.map(o => o.elementId)).toEqual(['plc19'])
  })

  it('never treats the root as a habitat: mostly-flat types produce no finding', () => {
    // 19 at root, 1 nested — the inverse case stays silent by design.
    const objects: ObjectInstance[] = [obj('rackA', { typeId: 'rack' })]
    for (let i = 0; i < 19; i++) {
      objects.push(obj(`plc${i}`, { typeId: 'plc' }))
    }
    objects.push(obj('plc19', { typeId: 'plc', parentId: 'rackA' }))

    const insights = computeRelationshipInsights(objects, [])
    expect(insights.filter(f => f.kind === 'unusual-parent')).toHaveLength(0)
  })
})

describe('computeRelationshipInsights: robustness', () => {
  it('handles empty inputs', () => {
    expect(computeRelationshipInsights([], [])).toEqual([])
  })

  it('ignores untyped objects entirely', () => {
    const objects = pumpsWithSensors(20, [3]).concat([obj('mystery', { typeId: '' })])
    const insights = computeRelationshipInsights(objects, [])
    expect(insights).toHaveLength(1)
    expect(insights[0].typeId).toBe('pump')
  })

  it('survives parentId cycles — lookups are direct, no chain walks', () => {
    const objects: ObjectInstance[] = []
    for (let i = 0; i < 10; i++) {
      // A↔B pairs: every object's parent is its partner.
      objects.push(obj(`a${i}`, { typeId: 'A', parentId: `b${i}` }))
      objects.push(obj(`b${i}`, { typeId: 'B', parentId: `a${i}` }))
    }
    const insights = computeRelationshipInsights(objects, [])
    // Both directions are 100% norms → no findings, and no hang.
    expect(insights).toEqual([])
  })

  it('sorts strongest norms first', () => {
    const objects = [
      // 99 of 100 pumps have a sensor (99%).
      ...pumpsWithSensors(100, [50]),
      // 18 of 20 valves have an actuator (90%).
      ...Array.from({ length: 20 }, (_, i) => obj(`valve${i}`, { typeId: 'valve' })),
      ...Array.from({ length: 18 }, (_, i) =>
        obj(`act${i}`, { typeId: 'actuator', parentId: `valve${i}` })
      ),
    ]
    const insights = computeRelationshipInsights(objects, [])
    expect(insights.map(f => f.typeId)).toEqual(['pump', 'valve'])
  })

  it('computes 100k objects within budget (linear, no chain walks)', () => {
    // 1,000 racks of type rack, each holding 99 PLCs; every rack but ~1% also
    // holds a switch, so one strong missing-child norm falls out.
    const objects: ObjectInstance[] = []
    for (let rack = 0; rack < 1_000; rack++) {
      objects.push(obj(`rack${rack}`, { typeId: 'rack' }))
      for (let slot = 0; slot < 98; slot++) {
        objects.push(obj(`rack${rack}-plc${slot}`, { typeId: 'plc', parentId: `rack${rack}` }))
      }
      if (rack % 97 !== 0) {
        objects.push(obj(`rack${rack}-switch`, { typeId: 'switch', parentId: `rack${rack}` }))
      }
    }

    const start = performance.now()
    const insights = computeRelationshipInsights(objects, [])
    const ms = performance.now() - start
    console.log(`[perf] relationship insights over ${objects.length.toLocaleString()} objects: ${ms.toFixed(0)}ms`)

    const missingSwitch = insights.find(f => f.kind === 'missing-child' && f.relatedTypeId === 'switch')
    expect(missingSwitch).toBeDefined()
    expect(missingSwitch!.outlierCount).toBe(11) // racks 0, 97, 194, … 970
    expect(ms).toBeLessThan(1_000)
  })
})
