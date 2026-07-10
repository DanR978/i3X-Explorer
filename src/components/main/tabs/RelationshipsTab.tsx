import type { ObjectInstance } from '../../../api/types'
import { useExplorerStore } from '../../../stores/explorer'
import { RelationshipTree } from '../../graph/RelationshipTree'
import { RelatedObjects } from '../../graph/RelatedObjects'
import { RelationshipLegend } from '../../graph/RelationshipLegend'
import { Card } from '../primitives'
import { useElementNavigation } from '../navigation'

export function RelationshipsTab({ object }: { object: ObjectInstance }) {
  const childrenCount = useExplorerStore(
    state => state.childrenByParent.get(object.elementId)?.length ?? 0
  )
  const { selectElement, selectObject, showHome } = useElementNavigation()

  const parentLabel = object.parentId && object.parentId !== '/' ? object.parentId : 'none'

  return (
    <div className="space-y-3">
      {/* Compositional hierarchy: parent above, element, children below. */}
      <Card
        title={
          <>
            Parent: <span className="normal-case tracking-normal font-mono">{parentLabel}</span>
            {' · '}
            Children · HasChildren ({childrenCount})
          </>
        }
      >
        <RelationshipTree element={object} onSelectElement={selectElement} />
      </Card>

      {/* Non-compositional relationships (Monitors, SuppliedBy, InheritsFrom…),
          fetched from POST /objects/related. This is what makes the Inherits and
          Other legend buckets reachable. */}
      <Card title="Other relationships">
        <RelatedObjects element={object} onSelect={selectObject} />
      </Card>

      {/* The full key, as the original graph had it: the four relationship
          buckets plus the two node styles. It sits beneath the cards, not inside
          a drawing, so it can never overlap a node and it wraps on a narrow pane. */}
      <RelationshipLegend
        buckets={['parent', 'child', 'inherits', 'other']}
        className="px-1"
      />

      <p className="text-[11.5px] text-i3x-text-muted">
        Want the whole model?{' '}
        <button
          type="button"
          onClick={showHome}
          className="text-i3x-primary hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-i3x-primary"
        >
          Open the overview map
        </button>
        .
      </p>
    </div>
  )
}
