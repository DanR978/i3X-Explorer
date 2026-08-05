import type { RelationshipType } from '../../api/types'
import {
  REL_AUTO_EXPAND_NEIGHBORS,
  REL_GROUP_PREFIX,
  REL_PREFIX,
  REL_SEP,
} from '../../stores/explorer'
import type { Neighbor } from '../graph/egoGraph'
import { BUCKET_ORDER, bucketOf, type RelationshipBucket } from '../graph/relationshipColors'

/**
 * The pure half of the sidebar's relationship walk: row ids, and how one
 * object's neighbours are organised underneath it.
 *
 * The hierarchy view nests by `parentId`, which is a tree by construction, one
 * parent per node, no cycles, no duplicates. Relationships are a *graph*: an
 * object can hang off many places at once, "feeds" and "fed by" are one physical
 * edge seen from either end, and loops (recycle lines, control loops) are normal
 * plant modelling rather than corrupt data. Two consequences shape everything
 * here:
 *
 *  - A row's identity is its PATH, not its element (see REL_SEP in the store).
 *  - A row never repeats an object that is already on its own branch. Dropping
 *    only the edge you arrived through is not enough, and reads badly the moment
 *    the walk is two hops deep: every descendant carries a HasParent back to the
 *    top, so the root reappears as a dead leaf under every single node below it.
 *    Anything visible by looking up the branch you are on is redundant, so the
 *    whole path is excluded, not just its last step.
 */

/** Append one element to a relationship path. `''` starts a new path at a root. */
export function relChildPath(parentPath: string, elementId: string): string {
  return parentPath === '' ? elementId : parentPath + REL_SEP + elementId
}

/** The expansion/selection id of the object row at `path`. */
export function relRowId(path: string): string {
  return REL_PREFIX + path
}

/** The expansion id of one relationship-type group under the row at `path`. */
export function relGroupRowId(path: string, groupKey: string): string {
  return REL_GROUP_PREFIX + path + REL_SEP + groupKey
}

/**
 * Every element on a path, including the one it ends at. This is the set a row's
 * neighbours are filtered against: whatever is already up the branch is not
 * news, so it is not drawn again.
 */
export function relPathIds(path: string): Set<string> {
  return new Set(path.split(REL_SEP))
}

/** The element a path ends at. */
export function relElementId(path: string): string {
  const cut = path.lastIndexOf(REL_SEP)
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * Row ids of every ancestor of the row at `path`, outermost first. Ancestors of
 * a path are exactly its prefixes, which is the whole reason paths are ids.
 */
export function relAncestorRowIds(path: string): string[] {
  const segments = path.split(REL_SEP)
  const ids: string[] = []
  for (let i = 1; i < segments.length; i++) {
    ids.push(relRowId(segments.slice(0, i).join(REL_SEP)))
  }
  return ids
}

/** One relationship kind's worth of neighbours, as a group row plus its members. */
export interface RelationshipGroup {
  /** The server's raw relationship type; '' when it reported none. */
  key: string
  /** What the group row reads: the server's own name for the relationship. */
  label: string
  bucket: RelationshipBucket
  neighbors: Neighbor[]
}

/**
 * "HasComponent" → "Has component", "feeds_to" → "Feeds to".
 *
 * Sentence case, not title case: a column of "Has Component" / "Feeds To" reads
 * like headings competing with the object names beside them. Runs of capitals
 * are left intact so an acronym in a vendor's vocabulary survives.
 */
export function humanizeRelationship(raw: string): string {
  const words = raw
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return 'Related'
  return words
    .map((word, i) => {
      if (word.length > 1 && word === word.toUpperCase()) return word
      return i === 0 ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase()
    })
    .join(' ')
}

/**
 * What a group of `type` calls itself: the server's declared displayName when it
 * has one, otherwise the raw type, and humanized either way.
 *
 * Humanizing the *declared* name too is deliberate. Servers overwhelmingly
 * declare a relationship's displayName as the identifier itself ("HasParent",
 * "SuppliedBy"), so taking it verbatim just puts an identifier in a column of
 * prose. A server that already writes "Supplied by" passes through unchanged,
 * since humanizing an already-humanized string is a no-op.
 */
export function relationshipLabel(
  type: string | undefined,
  index: Map<string, RelationshipType>
): string {
  if (!type) return 'Related'
  const declared = index.get(type)?.displayName
  return humanizeRelationship(declared && declared.trim() ? declared : type)
}

/**
 * Split one object's neighbours into groups, ordered the way the Relationships
 * tab reads them (BUCKET_ORDER: where it sits, then what it holds, then
 * inheritance, then everything else), alphabetically within a bucket.
 *
 * Grouping, rather than a flat list with a relationship badge per row, is what
 * keeps the interesting edges reachable. Badges look denser and read fine on a
 * node with eight neighbours, but a pump with 600 components and two "feeds"
 * edges buries the two rows you switched views to find, behind a paging control.
 * A group header puts every relationship kind at a fixed position under the
 * node no matter how lopsided the fan-out, and carries its own count and its own
 * paging.
 */
export function groupNeighbors(
  neighbors: Neighbor[],
  index: Map<string, RelationshipType>
): RelationshipGroup[] {
  const groups = new Map<string, RelationshipGroup>()
  for (const neighbor of neighbors) {
    const key = neighbor.relationshipType ?? ''
    const existing = groups.get(key)
    if (existing) {
      existing.neighbors.push(neighbor)
      continue
    }
    groups.set(key, {
      key,
      label: relationshipLabel(neighbor.relationshipType, index),
      bucket: bucketOf(neighbor.relationshipType),
      neighbors: [neighbor],
    })
  }
  return [...groups.values()].sort((a, b) => {
    const rank = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket]
    return rank !== 0 ? rank : a.label.localeCompare(b.label)
  })
}

/**
 * Which group rows to open the moment a node is expanded.
 *
 * A node with one relationship kind never draws a group header at all (see
 * buildTreeRows), so there is nothing to open. Past that, small nodes open
 * everything, since making someone click twice to see four children is friction
 * with no payoff, while a big node stays closed and reads as a table of
 * contents: "Parent 1 · Has component 640 · Feeds 2" answers "what is this
 * connected to" without unrolling 640 rows to say it.
 */
export function planGroupExpansion(path: string, groups: RelationshipGroup[]): string[] {
  if (groups.length <= 1) return []
  let total = 0
  for (const group of groups) total += group.neighbors.length
  if (total > REL_AUTO_EXPAND_NEIGHBORS) return []
  return groups.map(group => relGroupRowId(path, group.key))
}
