import type { ObjectInstance, ObjectType } from '../../api/types'
import {
  computeDepths,
  computeModelStats,
  hasParent,
  topBy,
  type ModelStats,
} from './modelStats'

/**
 * The insights report: the schema the instances imply, plus everything that
 * follows or breaks it. One pure computation feeds both the Home summary card
 * and the full Model Insights page, so their numbers can never disagree.
 *
 * The organizing idea (from real-catalog feedback): a bare outlier list is
 * lint, not insight. Every statement here is one of four honest kinds —
 *
 *   TypeProfile  — the inferred schema per type: where instances live, what
 *                  they contain (with cardinality), how deep, how they're named
 *   Convention   — a norm phrased affirmatively. 100% norms are the site's
 *                  implicit modeling documentation, not silence
 *   Deviation    — a strong norm with few exceptions, ranked by a Wilson
 *                  lower bound (990/1000 outranks 9/10) and EXPLAINED:
 *                  outliers are grouped by where they actually sit
 *   Split        — a norm whose exceptions are a population, not defects
 *                  ("94% under X, 6% under Y") — presented as a distribution
 *
 * No ML, deliberately: every claim is an exact count with its evidence
 * attached, and everything derives from `parentId` links and displayNames —
 * the only facts knowable without per-object round trips. All passes are
 * linear (Maps, no chain re-walks); see insightsReport.perf.test.ts for the
 * measured number.
 */

/** A norm needs this many instances before "most of them" means anything. */
export const MIN_NORM_INSTANCES = 8
/** Fraction of instances that must agree for a pattern to count as a norm. */
export const NORM_THRESHOLD = 0.9
/** Exceptions are a split (not defects) past this share of the type… */
export const SPLIT_MASS_SHARE = 0.05
/** …when at least this fraction of them concentrate in ONE alternative pattern. */
export const SPLIT_CONCENTRATION = 0.5
/** Sub-threshold two-population splits need each side to hold this share. */
export const SPLIT_MIN_SHARE = 0.1
/** Example instances carried per type / split population. */
export const EXAMPLES_PER_TYPE = 3
/** "Most anomalous objects" list length. */
export const TOP_ANOMALIES = 12
/** An object must break this many independent norms to rank as anomalous. */
export const MIN_ANOMALY_SCORE = 2

/* ── public data model ────────────────────────────────────────────────────── */

/** A clickable pointer at one object, disambiguated by where it sits. */
export interface InsightRef {
  elementId: string
  label: string
  /** The actual parent's label, or '(at root)' / '(parent not in catalog)'. */
  context: string
}

export interface TypePlacement {
  /** null for the special buckets (root / orphan / untyped parent). */
  parentTypeId: string | null
  parentTypeLabel: string
  count: number
  share: number
}

export interface ChildStat {
  childTypeId: string
  childTypeLabel: string
  /** Instances holding at least one child of this type. */
  presence: number
  presenceShare: number
  /** Cardinality among the instances that have it. */
  minCount: number
  maxCount: number
  /** Modal child count, and its share among the havers. */
  typicalCount: number
  typicalShare: number
}

export interface NamingProfile {
  /** Run-collapsed shape: letters→A, digits→9, separators kept ("PMP-999" → "A-9"). */
  signature: string
  matching: number
  share: number
}

export interface TypeProfile {
  typeId: string
  typeLabel: string
  instanceCount: number
  /** Sorted by count desc. Shares sum to 1. */
  placements: TypePlacement[]
  /** Sorted by presence share desc. */
  children: ChildStat[]
  depthMin: number
  depthMax: number
  /** Dominant name pattern when one exists and is informative; else null. */
  naming: NamingProfile | null
  examples: InsightRef[]
}

export type NormKind = 'missing-child' | 'unusual-parent' | 'naming'

export interface Convention {
  kind: NormKind
  typeId: string
  typeLabel: string
  /** Child type (missing-child) or parent type (unusual-parent). */
  relatedTypeId?: string
  relatedTypeLabel?: string
  /** "exactly 1" / "typically 2" — set for containment norms with tight cardinality. */
  cardinalityText?: string
  /** Name pattern (naming conventions). */
  signature?: string
  conforming: number
  total: number
  /** 1.0 = a perfect norm; < 1 = a near-norm whose exceptions live in a Deviation. */
  coverage: number
}

export interface OutlierGroup {
  /** unusual-parent: the actual parent type; missing-child: the subtree root; naming: the deviant signature. */
  keyId: string | null
  keyLabel: string
  /** Set when every member sits inside one subtree (unusual-parent groups only). */
  subtreeRootId: string | null
  subtreeRootLabel: string | null
  /** The FULL list — never capped here; the UI windows it. */
  members: InsightRef[]
}

export interface Deviation {
  kind: NormKind
  typeId: string
  typeLabel: string
  relatedTypeId?: string
  relatedTypeLabel?: string
  signature?: string
  conforming: number
  total: number
  coverage: number
  /** Wilson 95% lower bound on coverage — the ranking key. */
  strength: number
  /** Sorted by member count desc. Member counts sum to outlierCount. */
  groups: OutlierGroup[]
  outlierCount: number
}

export interface SplitPopulation {
  parentTypeId: string | null
  parentTypeLabel: string
  count: number
  share: number
  examples: InsightRef[]
}

export interface Split {
  typeId: string
  typeLabel: string
  total: number
  /** ≥ 2 entries, share desc; the residue folds into '(elsewhere)'. */
  populations: SplitPopulation[]
}

export interface AnomalyEntry {
  elementId: string
  label: string
  typeLabel: string
  /** Number of independent norms this one object breaks. */
  score: number
  reasons: string[]
}

export interface DataQuality {
  orphans: InsightRef[]
  untyped: InsightRef[]
  unusedTypes: { typeId: string; label: string }[]
  duplicateElementIds: { elementId: string; count: number }[]
}

export interface InsightsSummary {
  typesAnalyzed: number
  conventions: number
  deviations: number
  splits: number
  dataQualityIssues: number
}

export interface InsightsReport {
  summary: InsightsSummary
  /** Instance count desc, then label asc. */
  profiles: TypeProfile[]
  conventions: Convention[]
  /** Strength (Wilson) desc. */
  deviations: Deviation[]
  splits: Split[]
  anomalies: AnomalyEntry[]
  dataQuality: DataQuality
}

/* ── name signatures ──────────────────────────────────────────────────────── */

/**
 * The shape of a name: letter runs collapse to `A`, digit runs to `9`,
 * everything else stays verbatim. "PMP-999" → "A-9", "Pump 12" → "A 9",
 * "NORTHSITE" → "A". A bare "A" matches any word, so it is treated as
 * uninformative and never establishes a naming norm.
 */
// Unicode-aware classes: a Cyrillic or CJK word must collapse to `A` (and
// full-width digits to `9`) exactly like a Latin one, or non-Latin catalogs
// get literal names as "patterns" and fabricated deviations.
const UNICODE_LETTER = /\p{L}/u
const UNICODE_DIGIT = /\p{Nd}/u

export function nameSignature(name: string): string {
  let out = ''
  let run: 'A' | '9' | null = null
  for (const ch of name) {
    // ASCII fast path first — this runs per character over the whole catalog,
    // and Unicode property tests are several times the cost of a range check.
    const code = ch.charCodeAt(0)
    const kind =
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        ? 'A'
        : code >= 48 && code <= 57
          ? '9'
          : code < 128
            ? null
            : UNICODE_LETTER.test(ch)
              ? 'A'
              : UNICODE_DIGIT.test(ch)
                ? '9'
                : null
    if (kind === null) {
      out += ch
      run = null
    } else if (kind !== run) {
      out += kind
      run = kind
    }
  }
  return out
}

function isInformativeSignature(signature: string): boolean {
  return signature !== '' && signature !== 'A'
}

/* ── statistics ───────────────────────────────────────────────────────────── */

/**
 * Wilson score lower bound (default 95%) on the proportion k/n: "how sure are
 * we the true conformance is at least this". Ranks 990/1000 above 9/10 even
 * though both are 90–99% raw — small samples earn less confidence. Standard
 * closed form, no dependencies.
 */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0
  const p = k / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return Math.max(0, (center - margin) / denominator)
}

/* ── special placement buckets ────────────────────────────────────────────── */

// Keys carry a leading space, which no sane elementId starts with, so they
// can't collide with a real parent typeId in the bucket maps.
const BUCKET_ROOT = ' root'
const BUCKET_ORPHAN = ' orphan'
const BUCKET_UNTYPED_PARENT = ' untyped-parent'
const BUCKET_ELSEWHERE = ' elsewhere'

const SPECIAL_BUCKET_LABELS: Record<string, string> = {
  [BUCKET_ROOT]: '(at root)',
  [BUCKET_ORPHAN]: '(parent not in catalog)',
  [BUCKET_UNTYPED_PARENT]: '(under untyped objects)',
  [BUCKET_ELSEWHERE]: '(elsewhere)',
}

function isRealTypeBucket(key: string): boolean {
  return !(key in SPECIAL_BUCKET_LABELS)
}

/* ── computation ──────────────────────────────────────────────────────────── */

/**
 * The linear artifacts every pass needs: last-wins index, duplicate counts,
 * the deduped catalog view, and per-object depths. Built once and shared —
 * getInsightsReport hands the same scan to computeModelStats and
 * computeInsightsReport so the 100k index build and the depth walk (the most
 * expensive linear pass in either module) never run twice per catalog.
 */
export interface CatalogScan {
  index: Map<string, ObjectInstance>
  /** elementId → occurrences beyond the first (only ids that collided). */
  duplicateTally: Map<string, number>
  /** Deduped, last-wins view — the semantics of every other index in the app. */
  catalog: ObjectInstance[]
  depths: Map<string, number>
}

export function scanCatalog(objects: ObjectInstance[]): CatalogScan {
  const index = new Map<string, ObjectInstance>()
  const duplicateTally = new Map<string, number>()
  for (const object of objects) {
    if (index.has(object.elementId)) {
      duplicateTally.set(object.elementId, (duplicateTally.get(object.elementId) ?? 0) + 1)
    }
    index.set(object.elementId, object)
  }
  const catalog = [...index.values()]
  const depths = computeDepths(catalog, index)
  return { index, duplicateTally, catalog, depths }
}

export function computeInsightsReport(
  objects: ObjectInstance[],
  objectTypes: ObjectType[],
  scan: CatalogScan = scanCatalog(objects)
): InsightsReport {
  const typeLabels = new Map(
    objectTypes.map(type => [type.elementId, type.displayName || type.elementId])
  )
  const labelOf = (typeId: string) => typeLabels.get(typeId) ?? typeId
  const bucketLabel = (key: string) => SPECIAL_BUCKET_LABELS[key] ?? labelOf(key)

  const { index, duplicateTally, catalog, depths } = scan

  const refOf = (object: ObjectInstance): InsightRef => {
    let context = '(at root)'
    if (hasParent(object)) {
      const parent = index.get(object.parentId as string)
      context = parent ? parent.displayName || parent.elementId : '(parent not in catalog)'
    }
    return { elementId: object.elementId, label: object.displayName || object.elementId, context }
  }

  // ── pass 2: grouping ────────────────────────────────────────────────────
  const instancesByType = new Map<string, ObjectInstance[]>()
  const childCounts = new Map<string, Map<string, number>>() // parent elementId → child typeId → count
  const orphans: InsightRef[] = []
  const untyped: InsightRef[] = []

  for (const object of catalog) {
    if (object.typeId) {
      const list = instancesByType.get(object.typeId)
      if (list) list.push(object)
      else instancesByType.set(object.typeId, [object])
    } else {
      untyped.push(refOf(object))
    }

    if (!hasParent(object)) continue
    const parent = index.get(object.parentId as string)
    if (!parent) {
      orphans.push(refOf(object))
      continue
    }
    if (!object.typeId) continue
    let counts = childCounts.get(parent.elementId)
    if (!counts) {
      counts = new Map()
      childCounts.set(parent.elementId, counts)
    }
    counts.set(object.typeId, (counts.get(object.typeId) ?? 0) + 1)
  }

  // Shared memo across every subtree-root walk in the report.
  const rootCache = new Map<string, string>()

  // ── pass 3: profiles + findings per type ────────────────────────────────
  const profiles: TypeProfile[] = []
  const conventions: Convention[] = []
  const deviations: Deviation[] = []
  const splits: Split[] = []
  const anomalyTally = new Map<string, { object: ObjectInstance; reasons: string[] }>()

  const flag = (object: ObjectInstance, reason: string) => {
    const entry = anomalyTally.get(object.elementId)
    if (entry) entry.reasons.push(reason)
    else anomalyTally.set(object.elementId, { object, reasons: [reason] })
  }

  for (const [typeId, instances] of instancesByType) {
    const typeLabel = labelOf(typeId)
    const total = instances.length
    const normable = total >= MIN_NORM_INSTANCES

    // Placement buckets, members kept internally for outlier/example lists.
    const placementMembers = new Map<string, ObjectInstance[]>()
    for (const instance of instances) {
      let key = BUCKET_ROOT
      if (hasParent(instance)) {
        const parent = index.get(instance.parentId as string)
        key = !parent ? BUCKET_ORPHAN : parent.typeId ? parent.typeId : BUCKET_UNTYPED_PARENT
      }
      const members = placementMembers.get(key)
      if (members) members.push(instance)
      else placementMembers.set(key, [instance])
    }
    const buckets = [...placementMembers.entries()]
      .map(([key, members]) => ({ key, members, count: members.length }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))

    // Child stats with cardinality histograms.
    const childHistograms = new Map<string, Map<number, number>>() // child typeId → count → instances
    for (const instance of instances) {
      const counts = childCounts.get(instance.elementId)
      if (!counts) continue
      for (const [childTypeId, count] of counts) {
        let histogram = childHistograms.get(childTypeId)
        if (!histogram) {
          histogram = new Map()
          childHistograms.set(childTypeId, histogram)
        }
        histogram.set(count, (histogram.get(count) ?? 0) + 1)
      }
    }
    const children: ChildStat[] = [...childHistograms.entries()]
      .map(([childTypeId, histogram]) => {
        let presence = 0
        let minCount = Infinity
        let maxCount = 0
        let typicalCount = 0
        let typicalHits = 0
        for (const [count, hits] of histogram) {
          presence += hits
          if (count < minCount) minCount = count
          if (count > maxCount) maxCount = count
          if (hits > typicalHits || (hits === typicalHits && count < typicalCount)) {
            typicalCount = count
            typicalHits = hits
          }
        }
        return {
          childTypeId,
          childTypeLabel: labelOf(childTypeId),
          presence,
          presenceShare: presence / total,
          minCount,
          maxCount,
          typicalCount,
          typicalShare: typicalHits / presence,
        }
      })
      .sort(
        (a, b) => b.presenceShare - a.presenceShare || a.childTypeLabel.localeCompare(b.childTypeLabel)
      )

    // Naming signatures.
    const signatureMembers = new Map<string, ObjectInstance[]>()
    for (const instance of instances) {
      const signature = nameSignature(instance.displayName || '')
      const members = signatureMembers.get(signature)
      if (members) members.push(instance)
      else signatureMembers.set(signature, [instance])
    }
    let dominantSignature: { signature: string; members: ObjectInstance[] } | null = null
    for (const [signature, members] of signatureMembers) {
      if (!isInformativeSignature(signature)) continue
      if (
        !dominantSignature ||
        members.length > dominantSignature.members.length ||
        (members.length === dominantSignature.members.length &&
          signature < dominantSignature.signature)
      ) {
        dominantSignature = { signature, members }
      }
    }
    const namingShare = dominantSignature ? dominantSignature.members.length / total : 0

    // Depth range.
    let depthMin = Infinity
    let depthMax = 0
    for (const instance of instances) {
      const depth = depths.get(instance.elementId) ?? 0
      if (depth < depthMin) depthMin = depth
      if (depth > depthMax) depthMax = depth
    }

    profiles.push({
      typeId,
      typeLabel,
      instanceCount: total,
      placements: buckets.map(bucket => ({
        parentTypeId: isRealTypeBucket(bucket.key) ? bucket.key : null,
        parentTypeLabel: bucketLabel(bucket.key),
        count: bucket.count,
        share: bucket.count / total,
      })),
      children,
      depthMin: depthMin === Infinity ? 0 : depthMin,
      depthMax,
      naming:
        dominantSignature && namingShare >= NORM_THRESHOLD
          ? {
              signature: dominantSignature.signature,
              matching: dominantSignature.members.length,
              share: namingShare,
            }
          : null,
      examples: instances.slice(0, EXAMPLES_PER_TYPE).map(refOf),
    })

    if (!normable) continue

    // ── placement norm / split ────────────────────────────────────────────
    // Root, orphan and untyped-parent buckets never establish a norm: "usually
    // homeless" isn't a convention. They can still be split populations — a
    // split is descriptive, not normative.
    const normBucket = buckets.find(bucket => isRealTypeBucket(bucket.key))
    if (normBucket) {
      const normShare = normBucket.count / total
      const outlierBuckets = buckets.filter(bucket => bucket !== normBucket)
      const outlierCount = total - normBucket.count

      if (normShare === 1) {
        conventions.push({
          kind: 'unusual-parent',
          typeId,
          typeLabel,
          relatedTypeId: normBucket.key,
          relatedTypeLabel: bucketLabel(normBucket.key),
          conforming: total,
          total,
          coverage: 1,
        })
      } else if (normShare >= NORM_THRESHOLD) {
        const second = outlierBuckets[0]
        const isSplit =
          outlierCount >= MIN_NORM_INSTANCES &&
          outlierCount / total >= SPLIT_MASS_SHARE &&
          second !== undefined &&
          second.count >= SPLIT_CONCENTRATION * outlierCount
        if (isSplit) {
          splits.push(makeSplit(typeId, typeLabel, total, buckets, bucketLabel, refOf))
        } else {
          // The norm is real documentation even with exceptions; the
          // exceptions themselves live in the deviation.
          conventions.push({
            kind: 'unusual-parent',
            typeId,
            typeLabel,
            relatedTypeId: normBucket.key,
            relatedTypeLabel: bucketLabel(normBucket.key),
            conforming: normBucket.count,
            total,
            coverage: normShare,
          })
          const groups = outlierBuckets.map(bucket =>
            makeOutlierGroup(
              bucket.key,
              bucketLabel(bucket.key),
              bucket.members,
              index,
              rootCache,
              refOf
            )
          )
          deviations.push({
            kind: 'unusual-parent',
            typeId,
            typeLabel,
            relatedTypeId: normBucket.key,
            relatedTypeLabel: bucketLabel(normBucket.key),
            conforming: normBucket.count,
            total,
            coverage: normShare,
            strength: wilsonLower(normBucket.count, total),
            groups,
            outlierCount,
          })
          for (const bucket of outlierBuckets) {
            for (const member of bucket.members) {
              flag(
                member,
                `sits under ${bucketLabel(bucket.key)} (${typeLabel} norm: ${bucketLabel(normBucket.key)})`
              )
            }
          }
        }
      } else {
        // No dominant norm — is it a clean two-population split?
        const top1 = buckets[0]
        const top2 = buckets[1]
        const isSplit =
          top2 !== undefined &&
          (top1.count + top2.count) / total >= NORM_THRESHOLD &&
          top1.count / total >= SPLIT_MIN_SHARE &&
          top2.count / total >= SPLIT_MIN_SHARE &&
          top1.count >= MIN_NORM_INSTANCES &&
          top2.count >= MIN_NORM_INSTANCES &&
          (isRealTypeBucket(top1.key) || isRealTypeBucket(top2.key))
        if (isSplit) {
          splits.push(makeSplit(typeId, typeLabel, total, buckets, bucketLabel, refOf))
        }
      }
    }

    // ── containment norms per child type ──────────────────────────────────
    for (const stat of children) {
      // Self-containment never makes a norm: in a finite tree a recursive type
      // (Location under Location) always has leaves, so "N% contain their own type"
      // would flag every chain tail as a defect. The atlas profile still shows
      // the self-child stat — it's real structure, just not a promise.
      if (stat.childTypeId === typeId) continue
      if (stat.presenceShare === 1) {
        conventions.push({
          kind: 'missing-child',
          typeId,
          typeLabel,
          relatedTypeId: stat.childTypeId,
          relatedTypeLabel: stat.childTypeLabel,
          cardinalityText: cardinalityText(stat),
          conforming: total,
          total,
          coverage: 1,
        })
      } else if (stat.presenceShare >= NORM_THRESHOLD) {
        conventions.push({
          kind: 'missing-child',
          typeId,
          typeLabel,
          relatedTypeId: stat.childTypeId,
          relatedTypeLabel: stat.childTypeLabel,
          cardinalityText: cardinalityText(stat),
          conforming: stat.presence,
          total,
          coverage: stat.presenceShare,
        })
        const missing = instances.filter(
          instance => !childCounts.get(instance.elementId)?.has(stat.childTypeId)
        )
        deviations.push({
          kind: 'missing-child',
          typeId,
          typeLabel,
          relatedTypeId: stat.childTypeId,
          relatedTypeLabel: stat.childTypeLabel,
          conforming: stat.presence,
          total,
          coverage: stat.presenceShare,
          strength: wilsonLower(stat.presence, total),
          groups: groupBySubtreeRoot(missing, index, rootCache, refOf),
          outlierCount: missing.length,
        })
        for (const member of missing) flag(member, `missing ${stat.childTypeLabel}`)
      }
    }

    // ── naming norm ───────────────────────────────────────────────────────
    if (dominantSignature && namingShare >= NORM_THRESHOLD) {
      const signature = dominantSignature.signature
      if (namingShare === 1) {
        conventions.push({
          kind: 'naming',
          typeId,
          typeLabel,
          signature,
          conforming: total,
          total,
          coverage: 1,
        })
      } else {
        conventions.push({
          kind: 'naming',
          typeId,
          typeLabel,
          signature,
          conforming: dominantSignature.members.length,
          total,
          coverage: namingShare,
        })
        const deviantGroups = [...signatureMembers.entries()]
          .filter(([candidate]) => candidate !== signature)
          .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
          .map(([candidate, members]) => ({
            keyId: candidate,
            keyLabel: candidate === '' ? '(unnamed)' : candidate,
            subtreeRootId: null,
            subtreeRootLabel: null,
            members: members.map(refOf),
          }))
        const outlierCount = total - dominantSignature.members.length
        deviations.push({
          kind: 'naming',
          typeId,
          typeLabel,
          signature,
          conforming: dominantSignature.members.length,
          total,
          coverage: namingShare,
          strength: wilsonLower(dominantSignature.members.length, total),
          groups: deviantGroups,
          outlierCount,
        })
        for (const [candidate, members] of signatureMembers) {
          if (candidate === signature) continue
          for (const member of members) flag(member, `name breaks ${signature}`)
        }
      }
    }
  }

  // ── ordering ────────────────────────────────────────────────────────────
  profiles.sort(
    (a, b) => b.instanceCount - a.instanceCount || a.typeLabel.localeCompare(b.typeLabel)
  )
  conventions.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.total - a.total ||
      a.typeLabel.localeCompare(b.typeLabel) ||
      (a.relatedTypeLabel ?? a.signature ?? '').localeCompare(b.relatedTypeLabel ?? b.signature ?? '')
  )
  deviations.sort(
    (a, b) =>
      b.strength - a.strength ||
      a.typeLabel.localeCompare(b.typeLabel) ||
      (a.relatedTypeLabel ?? a.signature ?? '').localeCompare(b.relatedTypeLabel ?? b.signature ?? '')
  )
  splits.sort((a, b) => b.total - a.total || a.typeLabel.localeCompare(b.typeLabel))

  const anomalies: AnomalyEntry[] = topBy(
    [...anomalyTally.values()].filter(entry => entry.reasons.length >= MIN_ANOMALY_SCORE),
    entry => entry.reasons.length,
    TOP_ANOMALIES
  ).map(entry => ({
    elementId: entry.object.elementId,
    label: entry.object.displayName || entry.object.elementId,
    typeLabel: labelOf(entry.object.typeId ?? ''),
    score: entry.reasons.length,
    reasons: entry.reasons,
  }))

  const unusedTypes = objectTypes
    .filter(type => !instancesByType.has(type.elementId))
    .map(type => ({ typeId: type.elementId, label: type.displayName || type.elementId }))
  const duplicateElementIds = [...duplicateTally.entries()]
    .map(([elementId, extras]) => ({ elementId, count: extras + 1 }))
    .sort((a, b) => b.count - a.count || a.elementId.localeCompare(b.elementId))

  const dataQuality: DataQuality = { orphans, untyped, unusedTypes, duplicateElementIds }

  return {
    summary: {
      typesAnalyzed: profiles.length,
      conventions: conventions.length,
      deviations: deviations.length,
      splits: splits.length,
      dataQualityIssues:
        orphans.length + untyped.length + unusedTypes.length + duplicateElementIds.length,
    },
    profiles,
    conventions,
    deviations,
    splits,
    anomalies,
    dataQuality,
  }
}

function cardinalityText(stat: ChildStat): string | undefined {
  if (stat.minCount === stat.maxCount) return `exactly ${stat.minCount}`
  if (stat.typicalShare >= NORM_THRESHOLD) return `typically ${stat.typicalCount}`
  return undefined
}

function makeSplit(
  typeId: string,
  typeLabel: string,
  total: number,
  buckets: { key: string; members: ObjectInstance[]; count: number }[],
  bucketLabel: (key: string) => string,
  refOf: (object: ObjectInstance) => InsightRef
): Split {
  // Show populations down to the split floor; fold the long tail into one
  // "(elsewhere)" row so a messy type doesn't render twenty slivers.
  const populations: SplitPopulation[] = []
  let residue = 0
  for (const bucket of buckets) {
    if (populations.length < 2 || bucket.count / total >= SPLIT_MIN_SHARE) {
      populations.push({
        parentTypeId: isRealTypeBucket(bucket.key) ? bucket.key : null,
        parentTypeLabel: bucketLabel(bucket.key),
        count: bucket.count,
        share: bucket.count / total,
        examples: bucket.members.slice(0, EXAMPLES_PER_TYPE).map(refOf),
      })
    } else {
      residue += bucket.count
    }
  }
  if (residue > 0) {
    populations.push({
      parentTypeId: null,
      parentTypeLabel: SPECIAL_BUCKET_LABELS[BUCKET_ELSEWHERE],
      count: residue,
      share: residue / total,
      examples: [],
    })
  }
  return { typeId, typeLabel, total, populations }
}

function makeOutlierGroup(
  keyId: string,
  keyLabel: string,
  members: ObjectInstance[],
  index: Map<string, ObjectInstance>,
  rootCache: Map<string, string>,
  refOf: (object: ObjectInstance) => InsightRef
): OutlierGroup {
  // "All within NORTHSITE" — only when every member resolves to one subtree root
  // that isn't the member itself (a group of top-level strays has no story).
  let commonRoot: string | null | undefined
  for (const member of members) {
    const root = subtreeRootOf(member.elementId, index, rootCache)
    if (root === member.elementId) {
      commonRoot = null
      break
    }
    if (commonRoot === undefined) commonRoot = root
    else if (commonRoot !== root) {
      commonRoot = null
      break
    }
  }
  const rootObject = commonRoot ? index.get(commonRoot) : undefined
  return {
    keyId: isRealTypeBucket(keyId) ? keyId : null,
    keyLabel,
    subtreeRootId: rootObject ? commonRoot! : null,
    subtreeRootLabel: rootObject ? rootObject.displayName || rootObject.elementId : null,
    members: members.map(refOf),
  }
}

function groupBySubtreeRoot(
  members: ObjectInstance[],
  index: Map<string, ObjectInstance>,
  rootCache: Map<string, string>,
  refOf: (object: ObjectInstance) => InsightRef
): OutlierGroup[] {
  const groups = new Map<string, ObjectInstance[]>()
  for (const member of members) {
    const root = subtreeRootOf(member.elementId, index, rootCache)
    const list = groups.get(root)
    if (list) list.push(member)
    else groups.set(root, [member])
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([rootId, groupMembers]) => {
      const rootObject = index.get(rootId)
      const isSelf = groupMembers.length === 1 && groupMembers[0].elementId === rootId
      const label = isSelf
        ? '(top-level)'
        : rootObject
          ? rootObject.displayName || rootObject.elementId
          : rootId
      return {
        keyId: rootId,
        keyLabel: label,
        subtreeRootId: isSelf ? null : rootId,
        subtreeRootLabel: isSelf ? null : label,
        members: groupMembers.map(refOf),
      }
    })
}

/**
 * Root-level ancestor, memoised across the whole report; the visited set
 * breaks parentId cycles (same pattern as diffEngine.rootOf).
 */
function subtreeRootOf(
  elementId: string,
  index: Map<string, ObjectInstance>,
  cache: Map<string, string>
): string {
  const path: string[] = []
  const visited = new Set<string>()
  let currentId = elementId

  while (true) {
    const cached = cache.get(currentId)
    if (cached !== undefined) {
      currentId = cached
      break
    }
    const object = index.get(currentId)
    if (!object || !hasParent(object)) break
    const parentId = object.parentId as string
    if (!index.has(parentId) || visited.has(parentId)) break
    visited.add(currentId)
    path.push(currentId)
    currentId = parentId
  }

  for (const id of path) cache.set(id, currentId)
  cache.set(elementId, currentId)
  return currentId
}

/* ── prose builders (pure, tested; components stay thin) ──────────────────── */

export function conventionText(convention: Convention): string {
  const { typeLabel, relatedTypeLabel, conforming, total, coverage } = convention
  const every = coverage === 1
  const counts = `${conforming.toLocaleString()} of ${total.toLocaleString()}`
  switch (convention.kind) {
    case 'missing-child': {
      const amount = convention.cardinalityText ? `${convention.cardinalityText} ` : 'a '
      return every
        ? `Every ${typeLabel} contains ${amount}${relatedTypeLabel}`
        : `${counts} ${typeLabel} instances contain ${amount}${relatedTypeLabel}`
    }
    case 'unusual-parent':
      return every
        ? `Every ${typeLabel} sits under a ${relatedTypeLabel}`
        : `${counts} ${typeLabel} instances sit under a ${relatedTypeLabel}`
    case 'naming':
      return every
        ? `Every ${typeLabel} name follows the pattern ${convention.signature}`
        : `${counts} ${typeLabel} names follow the pattern ${convention.signature}`
  }
}

export function deviationHeadline(deviation: Deviation): string {
  const { typeLabel, relatedTypeLabel, conforming, total, outlierCount } = deviation
  const counts = `${conforming.toLocaleString()} of ${total.toLocaleString()}`
  const rest =
    outlierCount === 1 ? 'the one exception' : `the ${outlierCount.toLocaleString()} exceptions`
  switch (deviation.kind) {
    case 'missing-child':
      return `${counts} ${typeLabel} instances contain a ${relatedTypeLabel} — ${rest}:`
    case 'unusual-parent':
      return `${counts} ${typeLabel} instances sit under a ${relatedTypeLabel} — ${rest}:`
    case 'naming':
      return `${counts} ${typeLabel} names follow ${deviation.signature} — ${rest}:`
  }
}

export function groupLabel(kind: NormKind, group: OutlierGroup): string {
  const n = group.members.length.toLocaleString()
  const suffix =
    kind === 'unusual-parent' && group.subtreeRootLabel
      ? ` — all within ${group.subtreeRootLabel}`
      : ''
  switch (kind) {
    case 'unusual-parent':
      return group.keyId === null && group.keyLabel === '(at root)'
        ? `${n} at the root${suffix}`
        : `${n} sit under ${group.keyLabel} instead${suffix}`
    case 'missing-child':
      return group.subtreeRootLabel ? `${n} within ${group.subtreeRootLabel}` : `${n} at the top level`
    case 'naming':
      return `${n} named like ${group.keyLabel}`
  }
}

/* ── shared memo ──────────────────────────────────────────────────────────── */

interface ReportCacheEntry {
  objects: ObjectInstance[]
  objectTypes: ObjectType[]
  namespaceCount: number
  stats: ModelStats
  report: InsightsReport
}

let reportCache: ReportCacheEntry | null = null

/**
 * One-slot memo on reference identity: the Home card and the Insights page
 * call this with the same store references, so whichever renders second gets
 * a cache hit and reopening the page never recomputes. Also the single place
 * computeModelStats runs, so stats and the report always describe the same
 * catalog snapshot.
 */
export function getInsightsReport(
  objects: ObjectInstance[],
  objectTypes: ObjectType[],
  namespaceCount: number
): { stats: ModelStats; report: InsightsReport } {
  if (
    reportCache &&
    reportCache.objects === objects &&
    reportCache.objectTypes === objectTypes &&
    reportCache.namespaceCount === namespaceCount
  ) {
    return reportCache
  }
  // One scan feeds both computations — the index build and the depth walk are
  // the costly linear passes, and running them twice per catalog bought nothing.
  const scan = scanCatalog(objects)
  const stats = computeModelStats(objects, objectTypes, namespaceCount, {
    index: scan.index,
    depths: scan.depths,
  })
  const report = computeInsightsReport(objects, objectTypes, scan)
  reportCache = { objects, objectTypes, namespaceCount, stats, report }
  return reportCache
}
