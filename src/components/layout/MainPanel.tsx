import { useExplorerStore } from '../../stores/explorer'
import { useDiffStore } from '../../stores/diff'
import { useInsightsStore } from '../../stores/insights'
import { NamespaceDetail } from '../details/NamespaceDetail'
import { ObjectTypeDetail } from '../details/ObjectTypeDetail'
import { DiffView } from '../diff/DiffView'
import { InsightsView } from '../insights/InsightsView'
import { HomeView } from '../main/HomeView'
import { ObjectDetailView } from '../main/ObjectDetailView'
import { SimpleDetailView } from '../main/SimpleDetailView'
import type { Namespace, ObjectType, ObjectInstance } from '../../api/types'

/**
 * The main content panel. Top-level states, driven purely by store state:
 *
 *   diff view open     → snapshot diff (stores/diff.ts — any navigation closes it)
 *   insights view open → model insights (stores/insights.ts — same lifecycle)
 *   nothing selected   → Home shell (model overview)
 *   object selected    → tabbed element detail
 *
 * The two full-panel views are mutually exclusive — each store closes the
 * other on open, so the order of the first two branches is belt-and-braces.
 * Namespace and object-type selections reuse the same header frame without
 * tabs. The panel never imports the tree; both sides share `selectItem`.
 */
export function MainPanel() {
  const selectedItem = useExplorerStore(state => state.selectedItem)
  const diffOpen = useDiffStore(state => state.viewOpen)
  const insightsOpen = useInsightsStore(state => state.viewOpen)

  if (diffOpen) {
    return <DiffView />
  }

  if (insightsOpen) {
    return <InsightsView />
  }

  if (!selectedItem) {
    return <HomeView />
  }

  if (selectedItem.type === 'object') {
    const object = selectedItem.data as ObjectInstance
    // Re-key on the element so per-element view state (active tab, loaded value,
    // history range) starts fresh instead of bleeding across selections.
    return <ObjectDetailView key={object.elementId} object={object} />
  }

  if (selectedItem.type === 'namespace') {
    const namespace = selectedItem.data as Namespace
    return (
      <SimpleDetailView label={namespace.displayName} kind="Namespace">
        <NamespaceDetail namespace={namespace} />
      </SimpleDetailView>
    )
  }

  if (selectedItem.type === 'objectType') {
    const objectType = selectedItem.data as ObjectType
    return (
      <SimpleDetailView label={objectType.displayName} kind="Object Type">
        <ObjectTypeDetail objectType={objectType} />
      </SimpleDetailView>
    )
  }

  return <HomeView />
}
