import { useExplorerStore } from '../../stores/explorer'
import { useInsightsStore } from '../../stores/insights'
import { getInsightsReport, type InsightsSummary } from '../main/insightsReport'
import { InfoHint } from '../main/InfoHint'
import { CloseIcon } from '../common/icons'
import { TypeAtlas } from './TypeAtlas'
import { ConventionsSection } from './ConventionsSection'
import { DeviationsSection } from './DeviationsSection'
import { SplitsSection } from './SplitsSection'
import { DataQualitySection } from './DataQualitySection'
import { AnomaliesSection } from './AnomaliesSection'

/**
 * The Model Insights page: a main-panel state alongside Home, element detail
 * and the diff view. Organized around the questions an engineer brings to a
 * single source of truth — where does this kind of data live (type atlas),
 * what does the model promise (conventions), what breaks the promises
 * (deviations, explained), where is the model genuinely two things (splits),
 * and what can't be trusted (data quality).
 *
 * The report comes from the getInsightsReport memo, so rendering this page
 * after the Home card never recomputes; any navigation closes the page
 * (stores/insights.ts).
 */

/** Section anchors, shared by the tiles and the section wrappers. */
const SECTION_IDS = {
  atlas: 'insights-atlas',
  conventions: 'insights-conventions',
  deviations: 'insights-deviations',
  splits: 'insights-splits',
  quality: 'insights-quality',
} as const

export function InsightsView() {
  const closeView = useInsightsStore(s => s.closeView)
  const allObjects = useExplorerStore(s => s.allObjects)
  const objectTypes = useExplorerStore(s => s.objectTypes)
  const namespaceCount = useExplorerStore(s => s.namespaces.length)

  const { report } = getInsightsReport(allObjects, objectTypes, namespaceCount)

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-i3x-bg">
      <header className="px-3 sm:px-5 py-4 bg-i3x-surface border-b border-i3x-border flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-i3x-text flex items-center gap-2">
            Model insights
            <InfoHint label="How is this computed?" title="Model insights">
              Everything here is an exact count over the loaded catalog — no sampling, no machine
              learning, no requests. Structure derives from compositional{' '}
              <span className="font-mono">parentId</span> links and display names, the only facts
              knowable without asking the server about each object one at a time. A norm needs at
              least 8 instances agreeing at 90%; findings are ranked by a Wilson lower bound, so
              990 of 1,000 outranks 9 of 10.
            </InfoHint>
          </h1>
          <p className="text-xs text-i3x-text-muted mt-1">
            The schema the instances imply: conventions the model follows, the exceptions that
            break them, and where the data actually lives.
          </p>
        </div>
        <button
          onClick={closeView}
          title="Close model insights"
          aria-label="Close model insights"
          className="p-1.5 rounded text-i3x-text-muted hover:text-i3x-text hover:bg-i3x-bg transition-colors motion-reduce:transition-none shrink-0"
        >
          <CloseIcon size={15} />
        </button>
      </header>

      {allObjects.length === 0 ? (
        <div className="flex-1 grid place-items-center p-6 text-center">
          <div>
            <p className="text-sm text-i3x-text-muted">No model loaded</p>
            <p className="text-xs text-i3x-text-muted/70 mt-1">
              Connect to a server to analyze its catalog.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-3">
          <SummaryTiles summary={report.summary} />

          <section id={SECTION_IDS.atlas}>
            <TypeAtlas profiles={report.profiles} />
          </section>

          <section id={SECTION_IDS.conventions}>
            <ConventionsSection conventions={report.conventions} />
          </section>

          <section id={SECTION_IDS.deviations}>
            <DeviationsSection deviations={report.deviations} />
          </section>

          <section id={SECTION_IDS.splits}>
            <SplitsSection splits={report.splits} />
          </section>

          <section id={SECTION_IDS.quality}>
            <DataQualitySection quality={report.dataQuality} />
          </section>

          <AnomaliesSection anomalies={report.anomalies} />
        </div>
      )}
    </div>
  )
}

function SummaryTiles({ summary }: { summary: InsightsSummary }) {
  const tiles: { label: string; value: number; target: string }[] = [
    { label: 'Types analyzed', value: summary.typesAnalyzed, target: SECTION_IDS.atlas },
    { label: 'Conventions', value: summary.conventions, target: SECTION_IDS.conventions },
    { label: 'Deviations', value: summary.deviations, target: SECTION_IDS.deviations },
    { label: 'Splits', value: summary.splits, target: SECTION_IDS.splits },
    { label: 'Data-quality issues', value: summary.dataQualityIssues, target: SECTION_IDS.quality },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
      {tiles.map(tile => (
        <button
          key={tile.label}
          type="button"
          onClick={() =>
            document.getElementById(tile.target)?.scrollIntoView({
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'auto'
                : 'smooth',
              block: 'start',
            })
          }
          className="bg-i3x-surface border border-i3x-border rounded-xl px-4 py-3 text-left hover:border-i3x-primary transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
        >
          <div className="text-2xl font-semibold text-i3x-text leading-tight tabular-nums">
            {tile.value.toLocaleString()}
          </div>
          <div className="text-[11px] text-i3x-text-muted mt-0.5">{tile.label}</div>
        </button>
      ))}
    </div>
  )
}
