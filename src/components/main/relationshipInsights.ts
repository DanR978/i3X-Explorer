import type { ObjectInstance, ObjectType } from '../../api/types'
import { hasParent } from './modelStats'

/**
 * Relationship intelligence, computed rather than guessed.
 *
 * The catalog's composition graph carries norms nobody wrote down: if 96% of
 * Pump instances contain a VibrationSensor child, that IS the site's modeling
 * convention, and the four pumps without one are either mis-modeled or missing
 * instrumentation. This module mines exactly those norms — per-type structural
 * fingerprints — and reports the instances that break them.
 *
 * No ML, deliberately. Every finding is an exact count with its evidence
 * attached ("117 of 120 have it, these 3 don't"), so an engineer can act on it
 * without trusting a black box. Like modelStats, everything derives from
 * `parentId` links — the only edges knowable without a per-object round trip —
 * and from the store alone: no requests, no caps, no sampling.
 *
 * Two norm kinds, both conservative by construction:
 *   missing-child   — instances of T nearly always contain a child of type C;
 *                     flag the instances of T that don't
 *   unusual-parent  — instances of T nearly always sit under a parent of type
 *                     P; flag the instances that sit elsewhere (including at
 *                     the root). Skipped when the dominant habitat is the root:
 *                     "mostly flat with a few nested" is common and rarely
 *                     actionable, and a quiet panel stays trustworthy
 */

/** A norm needs this many instances before "most of them" means anything. */
export const MIN_NORM_INSTANCES = 8
/** Fraction of instances that must agree for a pattern to count as a norm. */
export const NORM_THRESHOLD = 0.9
/** Outliers listed per finding; the rest are counted, not enumerated. */
export const MAX_OUTLIERS_LISTED = 8

export interface InsightOutlier {
  elementId: string
  label: string
}

export interface RelationshipInsight {
  kind: 'missing-child' | 'unusual-parent'
  /** The type whose instances establish the norm. */
  typeId: string
  typeLabel: string
  /** The type the norm relates to: the expected child type, or the usual parent type. */
  relatedTypeId: string
  relatedTypeLabel: string
  /** Instances that follow the norm. */
  conforming: number
  /** All instances of the type. */
  total: number
  /** conforming / total — always ≥ NORM_THRESHOLD and < 1 by construction. */
  coverage: number
  /** The first MAX_OUTLIERS_LISTED norm-breakers; outlierCount has the true total. */
  outliers: InsightOutlier[]
  outlierCount: number
}

export function computeRelationshipInsights(
  objects: ObjectInstance[],
  objectTypes: ObjectType[]
): RelationshipInsight[] {
  const typeLabels = new Map(objectTypes.map(type => [type.elementId, type.displayName || type.elementId]))
  const labelOf = (typeId: string) => typeLabels.get(typeId) ?? typeId

  const index = new Map<string, ObjectInstance>()
  for (const object of objects) index.set(object.elementId, object)

  // One pass: instances grouped by type, and the set of child *types* under
  // each parent. Direct lookups only — no chain walks, so parentId cycles
  // can't trap anything here.
  const instancesByType = new Map<string, ObjectInstance[]>()
  const childTypesOf = new Map<string, Set<string>>()

  for (const object of objects) {
    if (object.typeId) {
      const list = instancesByType.get(object.typeId)
      if (list) list.push(object)
      else instancesByType.set(object.typeId, [object])
    }

    if (!object.typeId || !hasParent(object)) continue
    const parent = index.get(object.parentId as string)
    if (!parent) continue
    const set = childTypesOf.get(parent.elementId)
    if (set) set.add(object.typeId)
    else childTypesOf.set(parent.elementId, new Set([object.typeId]))
  }

  const insights: RelationshipInsight[] = []

  for (const [typeId, instances] of instancesByType) {
    if (instances.length < MIN_NORM_INSTANCES) continue

    // ── missing-child ─────────────────────────────────────────────────────
    // How many instances of this type hold at least one child of each type.
    const childTypeTally = new Map<string, number>()
    for (const instance of instances) {
      const childTypes = childTypesOf.get(instance.elementId)
      if (!childTypes) continue
      for (const childType of childTypes) {
        childTypeTally.set(childType, (childTypeTally.get(childType) ?? 0) + 1)
      }
    }
    for (const [childTypeId, conforming] of childTypeTally) {
      const coverage = conforming / instances.length
      if (coverage < NORM_THRESHOLD || conforming === instances.length) continue
      insights.push({
        kind: 'missing-child',
        typeId,
        typeLabel: labelOf(typeId),
        relatedTypeId: childTypeId,
        relatedTypeLabel: labelOf(childTypeId),
        conforming,
        total: instances.length,
        coverage,
        ...collectOutliers(instances, instance => !childTypesOf.get(instance.elementId)?.has(childTypeId)),
      })
    }

    // ── unusual-parent ────────────────────────────────────────────────────
    // Where do instances of this type live? Only typed, in-catalog parents
    // count toward a habitat; root/orphan/untyped-parent instances can still
    // be outliers but never establish the norm (see module comment).
    const parentTypeTally = new Map<string, number>()
    for (const instance of instances) {
      const parent = hasParent(instance) ? index.get(instance.parentId as string) : undefined
      if (parent?.typeId) {
        parentTypeTally.set(parent.typeId, (parentTypeTally.get(parent.typeId) ?? 0) + 1)
      }
    }
    let dominantType = ''
    let dominantCount = 0
    for (const [parentTypeId, count] of parentTypeTally) {
      // Ties break lexicographically so the result is deterministic.
      if (count > dominantCount || (count === dominantCount && parentTypeId < dominantType)) {
        dominantType = parentTypeId
        dominantCount = count
      }
    }
    const coverage = dominantCount / instances.length
    if (dominantType && coverage >= NORM_THRESHOLD && dominantCount < instances.length) {
      insights.push({
        kind: 'unusual-parent',
        typeId,
        typeLabel: labelOf(typeId),
        relatedTypeId: dominantType,
        relatedTypeLabel: labelOf(dominantType),
        conforming: dominantCount,
        total: instances.length,
        coverage,
        ...collectOutliers(instances, instance => {
          const parent = hasParent(instance) ? index.get(instance.parentId as string) : undefined
          return parent?.typeId !== dominantType
        }),
      })
    }
  }

  // Strongest norms first: the fewer exceptions to the stronger consensus,
  // the more likely each exception is a real defect.
  insights.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.total - a.total ||
      a.typeLabel.localeCompare(b.typeLabel) ||
      a.relatedTypeLabel.localeCompare(b.relatedTypeLabel)
  )
  return insights
}

function collectOutliers(
  instances: ObjectInstance[],
  isOutlier: (instance: ObjectInstance) => boolean
): { outliers: InsightOutlier[]; outlierCount: number } {
  const outliers: InsightOutlier[] = []
  let outlierCount = 0
  for (const instance of instances) {
    if (!isOutlier(instance)) continue
    outlierCount++
    if (outliers.length < MAX_OUTLIERS_LISTED) {
      outliers.push({ elementId: instance.elementId, label: instance.displayName || instance.elementId })
    }
  }
  return { outliers, outlierCount }
}
