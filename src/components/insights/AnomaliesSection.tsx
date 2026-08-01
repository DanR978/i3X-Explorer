import { Card } from '../main/primitives'
import { InfoHint } from '../main/InfoHint'
import { useElementNavigation } from '../main/navigation'
import { MIN_ANOMALY_SCORE, type AnomalyEntry } from '../main/insightsReport'

/**
 * The objects that break the most independent norms at once. One violation is
 * an exception; several on the same object is a smell worth a look — this is
 * the interpretable version of an "anomaly score": every point is a named,
 * checkable reason, not model output.
 */
export function AnomaliesSection({ anomalies }: { anomalies: AnomalyEntry[] }) {
  const { selectElement } = useElementNavigation()
  if (anomalies.length === 0) return null

  return (
    <Card
      title={`Most anomalous objects · ${anomalies.length.toLocaleString()}`}
      actions={
        <InfoHint label="How is anomaly scored?" title="Most anomalous objects">
          The score is simply how many independent norms one object breaks (missing an expected
          child, sitting under an unusual parent, a name off the pattern) — objects breaking at
          least {MIN_ANOMALY_SCORE} are listed, worst first. Every point comes with its reason, so
          the score is checkable, not a black box.
        </InfoHint>
      }
    >
      <ul className="space-y-0.5">
        {anomalies.map(anomaly => (
          <li key={anomaly.elementId}>
            <button
              type="button"
              onClick={() => selectElement(anomaly.elementId)}
              title={`${anomaly.elementId} · click to open`}
              className="w-full flex items-baseline gap-3 px-2 py-1.5 rounded-lg text-left hover:bg-i3x-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary min-w-0"
            >
              <span className="shrink-0 w-5 text-center text-[12px] font-semibold text-i3x-warning tabular-nums">
                {anomaly.score}
              </span>
              <span className="text-[13px] text-i3x-text truncate">{anomaly.label}</span>
              <span className="text-[11px] text-i3x-text-muted truncate">{anomaly.typeLabel}</span>
              <span className="ml-auto text-[11px] text-i3x-text-muted truncate max-w-[50%]">
                {anomaly.reasons.join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
