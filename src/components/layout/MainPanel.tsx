import { useExplorerStore } from '../../stores/explorer'
import { NamespaceDetail } from '../details/NamespaceDetail'
import { ObjectTypeDetail } from '../details/ObjectTypeDetail'
import { HomeView } from '../main/HomeView'
import { ObjectDetailView } from '../main/ObjectDetailView'
import { SimpleDetailView } from '../main/SimpleDetailView'
import type { Namespace, ObjectType, ObjectInstance } from '../../api/types'

/**
 * The main content panel. Two top-level states, driven purely by `selectedItem`
 * in the explorer store:
 *
 *   nothing selected → Home shell (model overview)
 *   object selected  → tabbed element detail
 *
 * Namespace and object-type selections reuse the same header frame without tabs.
 * The panel never imports the tree; both sides share `selectItem`.
 */
export function MainPanel() {
  const selectedItem = useExplorerStore(state => state.selectedItem)

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
