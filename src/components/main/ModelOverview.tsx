import { useMemo, useState } from 'react'
import type { ObjectInstance, ObjectType } from '../../api/types'
import {
  computeModelStats,
  withOther,
  type ModelStats,
  type ObjectRef,
  type Tally,
} from './modelStats'
import { Card, SegmentedControl } from './primitives'
import { InfoHint } from './InfoHint'
import { useElementNavigation } from './navigation'

/** Bars past this fold into an "Other" row — a catalog can declare hundreds of types. */
const MAX_BARS = 12

/** The containment matrix is square-ish; past this the cells stop being readable. */
const MAX_MATRIX = 10

/**
 * Sequential ramp, one hue, light → dark. Five steps: past ~7 bins adjacent
 * classes blur, and the eye can't rank them anyway. Alpha over the surface
 * rather than five hard-coded colours, so it tracks the theme in both modes.
 */
const RAMP = [0.14, 0.32, 0.52, 0.74, 1] as const

/** Which ramp step a count lands on. sqrt, because these counts are heavily skewed. */
function rampStep(count: number, max: number): number {
  if (count <= 0) return -1
  if (max <= 0) return 0
  const scaled = Math.sqrt(count) / Math.sqrt(max)
  return Math.min(RAMP.length - 1, Math.floor(scaled * RAMP.length))
}

const swatch = (step: number) =>
  step < 0 ? 'transparent' : `rgb(var(--i3x-primary) / ${RAMP[step]})`

/**
 * What the model is made of — and, more to the point, where to start reading it.
 *
 * On a 100k-object server the counts alone are wallpaper: knowing there are
 * 100,000 objects tells you nothing you can act on. So every row here is a way
 * IN. The hubs are where the structure actually is, the roots are the entry
 * points, a type bar opens that type, and the issues card tells you when the
 * catalog is lying to you. Nothing on this page is a dead end.
 */
export function ModelOverview({
  objects,
  objectTypes,
  namespaceCount,
}: {
  objects: ObjectInstance[]
  objectTypes: ObjectType[]
  namespaceCount: number
}) {
  const { selectElement, selectType } = useElementNavigation()

  const stats = useMemo(
    () => computeModelStats(objects, objectTypes, namespaceCount),
    [objects, objectTypes, namespaceCount]
  )

  if (objects.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-center p-6">
        <div>
          <p className="text-sm text-i3x-text-muted">No model loaded</p>
          <p className="text-xs text-i3x-text-muted/70 mt-1">
            Connect to a server to load the model.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-3">
      <StatRow stats={stats} />

      <Issues stats={stats} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card
          title="Largest containers"
          actions={
            <InfoHint label="What is this?" title="Largest containers">
              The objects holding the most direct children. On a big model this is where the
              structure lives — start here rather than scrolling the tree. Click one to open it.
            </InfoHint>
          }
        >
          <ObjectList
            items={stats.hubs}
            empty="Nothing in this model contains anything else."
            unit="children"
            onSelect={selectElement}
          />
        </Card>

        <Card
          title={`Entry points · ${stats.roots.toLocaleString()} root ${
            stats.roots === 1 ? 'object' : 'objects'
          }`}
          actions={
            <InfoHint label="What is this?" title="Entry points">
              Objects you can't navigate up from — either they name no parent, or their parent isn't
              in this catalog. They're the tops of the hierarchy, and the natural places to start
              browsing.
              <br />
              <br />
              A model with thousands of roots is flat rather than hierarchical, which is worth
              knowing before you go looking for a tree that isn't there.
            </InfoHint>
          }
        >
          <ObjectList
            items={stats.rootObjects}
            empty="No roots — every object names a parent."
            unit="children"
            onSelect={selectElement}
          />
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title={`Objects by type · ${stats.typesInUse.toLocaleString()} in use`}>
          <BarList
            items={withOther(stats.byType, MAX_BARS)}
            total={stats.objects}
            unit="objects"
            onSelect={selectType}
          />
        </Card>

        <Card
          title="Hierarchy shape"
          actions={
            <InfoHint label="How is depth counted?" title="Hierarchy shape">
              Levels are counted down the compositional{' '}
              <span className="font-mono">parentId</span> chain: a root is level 0, its children
              level 1, and so on. Fan-out is how many direct children an object holds.
            </InfoHint>
          }
        >
          <BarList items={stats.byDepth} total={stats.objects} unit="objects" />
          <dl className="mt-4 pt-3 border-t border-i3x-border grid grid-cols-2 gap-x-4 gap-y-2">
            <Fact label="Leaf objects" value={stats.leaves.toLocaleString()} />
            <Fact label="Composition objects" value={stats.compositions.toLocaleString()} />
            <Fact
              label="Children per parent"
              value={`${stats.avgFanout.toFixed(1)} avg · ${stats.maxFanout.toLocaleString()} max`}
            />
            <Fact label="Deepest chain" value={`${stats.maxDepth.toLocaleString()} levels`} />
          </dl>
        </Card>
      </div>

      <ContainmentMatrix stats={stats} />

      {stats.byNamespace.length > 1 && (
        <Card title="Objects by namespace">
          <BarList items={withOther(stats.byNamespace, MAX_BARS)} total={stats.objects} unit="objects" />
        </Card>
      )}
    </div>
  )
}

/** The headline numbers. Proportional figures — tabular-nums makes display sizes look loose. */
function StatRow({ stats }: { stats: ModelStats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
      <Stat label="Objects" value={stats.objects} />
      <Stat label="Object types" value={stats.typesInUse} sub={`of ${stats.typesDeclared} declared`} />
      <Stat label="Namespaces" value={stats.namespaces} />
      <Stat
        label="Containment links"
        value={stats.links}
        hint={
          <InfoHint label="What counts as a link?" title="Containment links">
            Every object that names a parent in this catalog. These are compositional{' '}
            <span className="font-mono">parentId</span> links — the only relationships the client
            can know without asking the server about each object one at a time.
            <br />
            <br />
            Other relationship kinds (<span className="font-mono">Monitors</span>,{' '}
            <span className="font-mono">InheritsFrom</span>, …) live behind{' '}
            <span className="font-mono">POST /objects/related</span>, which is per-object. They are
            shown in full on an element's <b className="text-i3x-text">Relationships</b> tab, and
            are not counted here.
          </InfoHint>
        }
      />
      <Stat label="Root objects" value={stats.roots} />
      <Stat
        label="Hierarchy depth"
        value={stats.maxDepth}
        sub={stats.maxDepth === 1 ? 'level below root' : 'levels below root'}
      />
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  hint,
}: {
  label: string
  value: number
  sub?: string
  hint?: React.ReactNode
}) {
  return (
    <div className="relative bg-i3x-surface border border-i3x-border rounded-xl px-4 py-3">
      {hint && <span className="absolute top-2.5 right-2.5">{hint}</span>}
      <div className="text-2xl font-semibold text-i3x-text leading-tight">
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] text-i3x-text-muted mt-0.5">{label}</div>
      {sub && <div className="text-[10.5px] text-i3x-text-muted/70 mt-0.5">{sub}</div>}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-i3x-text-muted">{label}</dt>
      <dd className="text-[13px] text-i3x-text tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * Only renders when something is actually wrong. A permanently-visible "0 issues"
 * panel trains people to ignore the space it occupies.
 */
function Issues({ stats }: { stats: ModelStats }) {
  const found: { text: string; hint: React.ReactNode }[] = []

  if (stats.orphans > 0) {
    found.push({
      text: `${stats.orphans.toLocaleString()} orphaned ${
        stats.orphans === 1 ? 'object' : 'objects'
      }`,
      hint: (
        <InfoHint label="What is an orphan?" title="Orphaned objects" align="left">
          Their <span className="font-mono">parentId</span> names an object this catalog doesn't
          contain. Usually it means the catalog is only partly loaded, or the server reports parents
          it won't list.
          <br />
          <br />
          Nothing can be known about where they sit, so they're counted as roots — you can't
          navigate up from one — and they appear under{' '}
          <b className="text-i3x-text">Entry points</b>.
        </InfoHint>
      ),
    })
  }

  if (stats.untyped > 0) {
    found.push({
      text: `${stats.untyped.toLocaleString()} untyped ${
        stats.untyped === 1 ? 'object' : 'objects'
      }`,
      hint: (
        <InfoHint label="What does untyped mean?" title="Untyped objects" align="left">
          These objects carry no <span className="font-mono">typeId</span>, so nothing describes
          their shape — no schema, and no way to group them with anything else.
        </InfoHint>
      ),
    })
  }

  if (stats.unusedTypes > 0) {
    found.push({
      text: `${stats.unusedTypes.toLocaleString()} declared ${
        stats.unusedTypes === 1 ? 'type has' : 'types have'
      } no instances`,
      hint: (
        <InfoHint label="Why does this matter?" title="Types with no instances" align="left">
          The server declares these object types but no object in the catalog uses them. Harmless in
          itself — but on a partial load it's a hint that objects you expected are missing.
        </InfoHint>
      ),
    })
  }

  if (found.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-i3x-warning/5 border border-i3x-warning/30 rounded-xl px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-i3x-warning">
        Worth knowing
      </span>
      {found.map(issue => (
        <span key={issue.text} className="inline-flex items-center gap-1.5 text-[12px] text-i3x-text">
          {issue.text}
          {issue.hint}
        </span>
      ))}
    </div>
  )
}

/** A ranked list of objects, each one a way into the tree. */
function ObjectList({
  items,
  empty,
  unit,
  onSelect,
}: {
  items: ObjectRef[]
  empty: string
  unit: string
  onSelect: (elementId: string) => void
}) {
  if (items.length === 0) return <p className="text-xs text-i3x-text-muted">{empty}</p>

  return (
    <ul className="space-y-0.5">
      {items.map(item => (
        <li key={item.elementId}>
          <button
            type="button"
            onClick={() => onSelect(item.elementId)}
            title={item.elementId}
            className="w-full flex items-baseline gap-3 px-2 py-1.5 rounded-lg text-left hover:bg-i3x-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
          >
            <span className="text-[13px] text-i3x-text truncate">{item.label}</span>
            <span className="text-[11px] text-i3x-text-muted truncate">{item.typeLabel}</span>
            <span className="ml-auto shrink-0 text-[12px] text-i3x-text-muted tabular-nums">
              {item.children.toLocaleString()} {unit}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Ranked magnitude, so: one hue for every bar. Colouring bars darker-where-bigger
 * would double-encode the length as hue and burn the only free channel on
 * information the bar already shows.
 */
function BarList({
  items,
  total,
  unit,
  onSelect,
}: {
  items: Tally[]
  total: number
  unit: string
  /** When given, each row opens its category. The "Other" fold-up row stays inert. */
  onSelect?: (key: string) => void
}) {
  const max = items.reduce((peak, item) => Math.max(peak, item.count), 0)
  if (max === 0) return <p className="text-xs text-i3x-text-muted">Nothing to count.</p>

  return (
    <ul className="space-y-1.5">
      {items.map(item => {
        const share = total > 0 ? (item.count / total) * 100 : 0
        const clickable = onSelect !== undefined && !item.isOther

        const body = (
          <>
            <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
              <span className="text-[12px] text-i3x-text truncate text-left">{item.label}</span>
              <span className="text-[12px] text-i3x-text-muted tabular-nums">
                {item.count.toLocaleString()}
              </span>
            </span>
            <span className="block mt-1 h-1.5 rounded-full bg-i3x-bg overflow-hidden">
              {/* Anchored to the baseline, rounded only at the data end. */}
              <span
                className="block h-full rounded-r-[4px]"
                style={{
                  width: `${Math.max((item.count / max) * 100, 1)}%`,
                  background: 'rgb(var(--i3x-primary) / 0.8)',
                }}
              />
            </span>
          </>
        )

        const tooltip = `${item.label} — ${item.count.toLocaleString()} ${unit} (${share.toFixed(1)}%)${
          clickable ? ' · click to open' : ''
        }`

        return (
          <li key={item.key}>
            {clickable ? (
              <button
                type="button"
                onClick={() => onSelect!(item.key)}
                title={tooltip}
                className="w-full block px-1 py-0.5 -mx-1 rounded-lg hover:bg-i3x-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
              >
                {body}
              </button>
            ) : (
              <span className="block px-1 py-0.5 -mx-1" title={tooltip}>
                {body}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * What contains what: parent type × child type, cell = how many objects of the
 * child type sit under an object of the parent type. This is the question a
 * schema-less catalog can't answer for you — and at 100k objects it's the fastest
 * way to learn the model's grammar without opening a single node.
 *
 * A heatmap is a grid of magnitudes, so the colour job is sequential — one hue,
 * more-is-darker, with a scale legend. Values are never colour-only: the hovered
 * cell is read out above the grid, and the Table view lists every link with its
 * count.
 */
function ContainmentMatrix({ stats }: { stats: ModelStats }) {
  const [view, setView] = useState<'matrix' | 'table'>('matrix')
  const [hovered, setHovered] = useState<string | null>(null)

  const rows = stats.parentTypes.slice(0, MAX_MATRIX)
  const columns = stats.childTypes.slice(0, MAX_MATRIX)
  const hiddenRows = stats.parentTypes.length - rows.length
  const hiddenColumns = stats.childTypes.length - columns.length

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const link of stats.typeLinks) {
      map.set(`${link.parentTypeId}\u0000${link.childTypeId}`, link.count)
    }
    return map
  }, [stats.typeLinks])

  const max = stats.typeLinks.reduce((peak, link) => Math.max(peak, link.count), 0)

  if (stats.typeLinks.length === 0) {
    return (
      <Card title="What contains what">
        <p className="text-xs text-i3x-text-muted">
          No containment links — every object in this model is a root.
        </p>
      </Card>
    )
  }

  return (
    <Card
      title="What contains what · parent type → child type"
      actions={
        <div className="flex items-center gap-2">
          <InfoHint label="How do I read this?" title="What contains what">
            Each cell counts the objects of the <b className="text-i3x-text">column</b> type that sit
            directly under an object of the <b className="text-i3x-text">row</b> type. Darker means
            more. It's the model's grammar — "a Line holds Machines, a Machine holds Sensors" —
            readable without opening a single node.
            <br />
            <br />
            Built from compositional <span className="font-mono">parentId</span> links only. Switch
            to <b className="text-i3x-text">Table</b> for exact counts of every pair.
          </InfoHint>
          <SegmentedControl
            label="Containment view"
            value={view}
            options={[
              { value: 'matrix', label: 'Matrix' },
              { value: 'table', label: 'Table' },
            ]}
            onChange={setView}
          />
        </div>
      }
    >
      {view === 'table' ? (
        <div className="max-h-[420px] overflow-y-auto overscroll-contain">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-i3x-surface">
              <tr className="text-left text-i3x-text-muted">
                <th className="font-normal py-1 pr-3">Parent type</th>
                <th className="font-normal py-1 pr-3">Child type</th>
                <th className="font-normal py-1 text-right">Objects</th>
              </tr>
            </thead>
            <tbody>
              {stats.typeLinks.map(link => (
                <tr
                  key={`${link.parentTypeId}\u0000${link.childTypeId}`}
                  className="border-t border-i3x-border"
                >
                  <td className="py-1 pr-3 text-i3x-text truncate">{link.parentLabel}</td>
                  <td className="py-1 pr-3 text-i3x-text truncate">{link.childLabel}</td>
                  <td className="py-1 text-right text-i3x-text tabular-nums">
                    {link.count.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          {/* The hovered cell, read out in text — the colour is never the only channel. */}
          <p className="h-4 mb-2 text-[11.5px] text-i3x-text-muted truncate">
            {hovered ?? 'Hover a cell for its count.'}
          </p>

          <div className="overflow-x-auto">
            <div
              className="grid gap-0.5 w-max"
              style={{ gridTemplateColumns: `minmax(90px, 160px) repeat(${columns.length}, 34px)` }}
            >
              <span aria-hidden="true" />
              {columns.map(column => (
                <span
                  key={column.key}
                  title={column.label}
                  className="h-[104px] text-[11px] text-i3x-text-muted flex items-end justify-center"
                >
                  <span
                    className="truncate max-h-[100px]"
                    style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                  >
                    {column.label}
                  </span>
                </span>
              ))}

              {rows.map(row => (
                <MatrixRow
                  key={row.key}
                  row={row}
                  columns={columns}
                  counts={counts}
                  max={max}
                  onHover={setHovered}
                />
              ))}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center gap-2 text-[11px] text-i3x-text-muted">
              <span>Fewer</span>
              {RAMP.map((_, step) => (
                <span
                  key={step}
                  aria-hidden="true"
                  className="w-5 h-3 rounded-sm border border-i3x-border"
                  style={{ background: swatch(step) }}
                />
              ))}
              <span>More · up to {max.toLocaleString()}</span>
            </div>

            {(hiddenRows > 0 || hiddenColumns > 0) && (
              <p className="text-[11px] text-i3x-text-muted">
                Showing the {MAX_MATRIX} heaviest types per axis
                {hiddenRows > 0 && ` · ${hiddenRows} more parent ${plural(hiddenRows, 'type')}`}
                {hiddenColumns > 0 && ` · ${hiddenColumns} more child ${plural(hiddenColumns, 'type')}`}
                . Switch to Table for all {stats.typeLinks.length.toLocaleString()}.
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

function MatrixRow({
  row,
  columns,
  counts,
  max,
  onHover,
}: {
  row: Tally
  columns: Tally[]
  counts: Map<string, number>
  max: number
  onHover: (text: string | null) => void
}) {
  return (
    <>
      <span
        title={row.label}
        className="text-[11.5px] text-i3x-text truncate pr-2 h-[34px] flex items-center"
      >
        {row.label}
      </span>
      {columns.map(column => {
        const count = counts.get(`${row.key}\u0000${column.key}`) ?? 0
        const step = rampStep(count, max)
        const readout =
          count === 0
            ? `${row.label} contains no ${column.label}`
            : `${row.label} → ${column.label} · ${count.toLocaleString()} ${plural(count, 'object')}`

        return (
          <span
            key={column.key}
            title={readout}
            onMouseEnter={() => onHover(readout)}
            onMouseLeave={() => onHover(null)}
            className={`h-[34px] rounded-sm ${
              count === 0 ? 'bg-i3x-bg' : 'ring-1 ring-inset ring-i3x-border/40'
            }`}
            style={{ background: count === 0 ? undefined : swatch(step) }}
          />
        )
      })}
    </>
  )
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}
