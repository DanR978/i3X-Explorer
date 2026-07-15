import type { ObjectInstance } from '../../api/types'
import { useExplorerStore } from '../../stores/explorer'
import { RadialGraph } from './RadialGraph'
import { TreeGraph } from './TreeGraph'

// Re-exported so existing importers (the list's drag source) keep working.
export { ELEMENT_DRAG_TYPE } from './dragType'

export interface RelationshipGraphProps {
  /** The element at the root/center: the selected object, or whatever was dropped in. */
  root: ObjectInstance
  depth: number
  /** Element dropped onto the canvas: re-root here without navigating away. */
  onFocusElement: (elementId: string) => void
  /** Clicking a node opens it in the detail view. */
  onSelectElement: (elementId: string) => void
  /** An element hovered outside the map (e.g. a list row) — highlighted as if hovered here. */
  externalHoverId?: string | null
}

/**
 * The relationship map. Two views of the same ego graph share this entry point:
 * a left-to-right tree (parents left, children right, one node per row) and the
 * radial rings map (distance from the center is the hop count). Which one shows is
 * a toggle in the card header; the choice lives in the explorer store, so it
 * persists across element selections for the session.
 */
export function RelationshipGraph(props: RelationshipGraphProps) {
  const view = useExplorerStore(state => state.relationshipView)
  return view === 'radial' ? <RadialGraph {...props} /> : <TreeGraph {...props} />
}
