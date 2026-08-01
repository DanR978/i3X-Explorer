import { Card } from '../main/primitives'
import { InfoHint } from '../main/InfoHint'
import { CheckIcon } from '../common/icons'
import { useElementNavigation } from '../main/navigation'
import { WindowedList } from './WindowedList'
import { conventionText, type Convention } from '../main/insightsReport'

/**
 * The positive findings: the modeling conventions the catalog itself
 * demonstrates. A 100% norm used to be deliberate silence; on a real catalog
 * it's auto-generated documentation — the implicit schema, written down.
 * Near-100% conventions show their exception count; the exceptions themselves
 * live in the Deviations section.
 */
export function ConventionsSection({ conventions }: { conventions: Convention[] }) {
  const { selectType } = useElementNavigation()
  if (conventions.length === 0) return null

  return (
    <Card
      title={`Conventions · ${conventions.length.toLocaleString()}`}
      actions={
        <InfoHint label="What is a convention?" title="Conventions">
          A structural pattern at least 90% of a type's instances follow (8 instances minimum) —
          what the site's modeling actually promises, mined from the data rather than written by
          hand. A convention at 100% has no exceptions; one below 100% has its exceptions listed
          under <b className="text-i3x-text">Deviations</b>.
        </InfoHint>
      }
    >
      <WindowedList
        items={conventions}
        estimateHeight={30}
        className="max-h-80"
        getKey={c => `${c.kind}:${c.typeId}:${c.relatedTypeId ?? c.signature ?? ''}`}
        renderRow={convention => (
          <div className="flex items-center gap-2 px-2 py-1.5 min-w-0">
            <CheckIcon
              size={13}
              className={convention.coverage === 1 ? 'text-i3x-success' : 'text-i3x-text-muted'}
            />
            <button
              type="button"
              onClick={() => selectType(convention.typeId)}
              title={`${convention.typeId} · open this type`}
              className="text-left text-[12.5px] text-i3x-text truncate hover:text-i3x-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary rounded"
            >
              {conventionText(convention)}
            </button>
          </div>
        )}
      />
    </Card>
  )
}
