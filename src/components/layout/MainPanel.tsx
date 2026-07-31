import { useExplorerStore } from '../../stores/explorer'
import { useDiffStore } from '../../stores/diff'
import { NamespaceDetail } from '../details/NamespaceDetail'
import { ObjectTypeDetail } from '../details/ObjectTypeDetail'
import { DiffView } from '../diff/DiffView'
import { HomeView } from '../main/HomeView'
import { ObjectDetailView } from '../main/ObjectDetailView'
import { SimpleDetailView } from '../main/SimpleDetailView'
import type { Namespace, ObjectType, ObjectInstance } from '../../api/types'

/**
 * The main content panel. Top-level states, driven purely by store state:
 *
 *   diff view open   → snapshot diff (see stores/diff.ts — any navigation closes it)
 *   nothing selected → Home shell (model overview)
 *   object selected  → tabbed element detail
 *
 * Namespace and object-type selections reuse the same header frame without tabs.
 * The panel never imports the tree; both sides share `selectItem`.
 */
export function MainPanel() {
  const selectedItem = useExplorerStore(state => state.selectedItem)
  const diffOpen = useDiffStore(state => state.viewOpen)

  if (diffOpen) {
    return <DiffView />
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
