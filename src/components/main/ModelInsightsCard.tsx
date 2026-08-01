import { useInsightsStore } from '../../stores/insights'
import { InsightIcon } from '../common/icons'
import { Card } from './primitives'
import { InfoHint } from './InfoHint'
import { deviationHeadline, type InsightsReport } from './insightsReport'

/**
 * The Home summary for Model Insights: a health line, the strongest findings
 * as one-liners, and the door to the full page. Deliberately renders whenever
 * a catalog is loaded — unlike the warning strip, the page behind it is
 * positive content (the type atlas, the conventions), so hiding the door on a
 * clean model would hide the feature, not noise.
 *
 * No chip walls and no dead-end "+N more" here by design: real-catalog
 * feedback showed a bare outlier list is lint, not insight. The full page
 * explains every exception and makes every list browsable.
 */

/** Strongest findings shown as one-liners; the page has them all. */
const TOP_FINDINGS = 3

export function ModelInsightsCard({ report }: { report: InsightsReport }) {
  const openView = useInsightsStore(s => s.openView)
  const { summary } = report

  const healthParts = [
    `${summary.conventions.toLocaleString()} ${summary.conventions === 1 ? 'convention' : 'conventions'}`,
    `${summary.deviations.toLocaleString()} ${summary.deviations === 1 ? 'deviation' : 'deviations'}`,
    `${summary.splits.toLocaleString()} ${summary.splits === 1 ? 'split' : 'splits'}`,
    `${summary.dataQualityIssues.toLocaleString()} data-quality ${
      summary.dataQualityIssues === 1 ? 'issue' : 'issues'
    }`,
  ]

  return (
    <Card
      title="Model insights"
      actions={
        <InfoHint label="What lives behind this?" title="Model insights">
          The schema the instances imply — mined per type from compositional{' '}
          <span className="font-mono">parentId</span> links and names: where each kind of data
          lives, the conventions the model follows, the exceptions that break them (explained, not
          just listed), and the types that legitimately split across placements. Exact counts,
          no ML. Open the full page for everything, browsable.
        </InfoHint>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-i3x-text">
          {summary.typesAnalyzed.toLocaleString()} types analyzed · {healthParts.join(' · ')}
        </p>
        <button
          type="button"
          onClick={openView}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-i3x-primary text-white rounded hover:bg-i3x-primary/80 transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
        >
          <InsightIcon size={13} />
          Open model insights
        </button>
      </div>

      {report.deviations.length > 0 && (
        <ul className="mt-3 pt-3 border-t border-i3x-border space-y-1">
          {report.deviations.slice(0, TOP_FINDINGS).map(deviation => (
            <li key={`${deviation.kind}:${deviation.typeId}:${deviation.relatedTypeId ?? deviation.signature ?? ''}`}>
              <button
                type="button"
                onClick={openView}
                title="Open in model insights"
                className="w-full text-left px-2 py-1 rounded-lg text-[12px] text-i3x-text hover:bg-i3x-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary truncate"
              >
                {deviationHeadline(deviation).replace(/ — .*$/, '')}
              </button>
            </li>
          ))}
          {report.deviations.length > TOP_FINDINGS && (
            <li className="px-2 text-[11px] text-i3x-text-muted">
              …and {(report.deviations.length - TOP_FINDINGS).toLocaleString()} more on the full page.
            </li>
          )}
        </ul>
      )}
    </Card>
  )
}
