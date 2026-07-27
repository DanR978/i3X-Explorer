import type { ObjectInstance, LastKnownValue } from '../../../api/types'
import { Chevron } from '../../common/Chevron'
import { RefreshIcon } from '../../common/icons'
import { JsonViewer } from '../../details/JsonViewer'
import { ValueDisplay } from '../../details/ValueDisplay'
import { Card, Field, SegmentedControl } from '../primitives'

interface OverviewTabProps {
  object: ObjectInstance
  value: LastKnownValue | null
  valueView: 'parsed' | 'raw'
  onValueViewChange: (view: 'parsed' | 'raw') => void
  isLoadingValue: boolean
  valueError: string | null
  onRefresh: () => void
}

export function OverviewTab({
  object,
  value,
  valueView,
  onValueViewChange,
  isLoadingValue,
  valueError,
  onRefresh,
}: OverviewTabProps) {
  const sourceTypeId =
    object.metadata?.sourceTypeId != null ? String(object.metadata.sourceTypeId) : null

  return (
    <div className="space-y-4">
      <Card title="Description">
        {object.description ? (
          <p className="text-[13.5px] leading-relaxed text-i3x-text">{object.description}</p>
        ) : (
          <p className="text-[13.5px] text-i3x-text-muted">No description provided.</p>
        )}
      </Card>

      <Card title="Identity">
        <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
          <Field label="Element ID" value={object.elementId} />
          <Field label="Type ID" value={object.typeId} />
          <Field label="Parent ID" value={object.parentId} />
          <Field label="Namespace URI" value={object.namespaceUri} />
          <Field label="Source Type ID" value={sourceTypeId} />
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3.5 text-[13px] text-i3x-text-muted">
          <span>
            Composition:{' '}
            <b className="font-medium text-i3x-text">{object.isComposition ? 'Yes' : 'No'}</b>
          </span>
          <span>
            Extended:{' '}
            <b className="font-medium text-i3x-text">{object.isExtended ? 'Yes' : 'No'}</b>
          </span>
        </div>
      </Card>

      <Card
        title="Current Value"
        actions={
          <>
            <SegmentedControl
              label="Value format"
              value={valueView}
              onChange={onValueViewChange}
              options={[
                { value: 'parsed', label: 'Parsed' },
                { value: 'raw', label: 'Raw' },
              ]}
            />
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoadingValue}
              className="flex items-center gap-1 text-xs text-i3x-primary hover:text-i3x-primary/80 disabled:opacity-50 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
            >
              {isLoadingValue ? 'Loading…' : <><RefreshIcon size={11} /> Refresh</>}
            </button>
          </>
        }
      >
        {valueError ? (
          <div className="px-3 py-2 bg-i3x-error/10 border border-i3x-error/20 rounded-lg text-sm text-i3x-error">
            {valueError}
          </div>
        ) : value ? (
          <ValueDisplay value={value} view={valueView} />
        ) : (
          <div className="px-3 py-2 bg-i3x-bg border border-i3x-border rounded-lg text-sm text-i3x-text-muted">
            {isLoadingValue ? 'Loading…' : 'No value available'}
          </div>
        )}

        <ObjectDataDisclosure object={object} />
      </Card>
    </div>
  )
}

/**
 * The raw / relationships / metadata JSON views from the pre-refactor detail
 * panel, re-homed beneath Current Value. `<details>` gives keyboard toggling and
 * expanded-state semantics for free.
 */
function ObjectDataDisclosure({ object }: { object: ObjectInstance }) {
  const extraMetadata = (() => {
    if (!object.metadata) return null
    const {
      relationships: _relationships,
      typeNamespaceUri: _typeNamespaceUri,
      description: _description,
      sourceTypeId: _sourceTypeId,
      ...rest
    } = object.metadata as Record<string, unknown>
    return Object.keys(rest).length > 0 ? rest : null
  })()

  return (
    <details className="mt-4 border border-i3x-border rounded-lg group">
      {/* No `open` prop: inside `<details className="group">` the browser owns the
          state and `group-open:rotate-90` turns the mark. */}
      <summary className="px-3 py-2 flex items-center gap-2 cursor-pointer text-xs font-medium text-i3x-text hover:bg-i3x-bg/50 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary">
        <Chevron />
        Object Data
      </summary>

      <div className="border-t border-i3x-border p-3 space-y-3">
        {object.relationships && (
          <div>
            <label className="block text-xs text-i3x-text-muted mb-1">Relationships</label>
            <JsonViewer data={object.relationships} />
          </div>
        )}
        {extraMetadata && (
          <div>
            <label className="block text-xs text-i3x-text-muted mb-1">Metadata</label>
            <JsonViewer data={extraMetadata} />
          </div>
        )}
        <div>
          <label className="block text-xs text-i3x-text-muted mb-1">Raw Object</label>
          <JsonViewer data={object} />
        </div>
      </div>
    </details>
  )
}
