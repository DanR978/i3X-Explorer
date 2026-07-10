import { useMemo } from 'react'
import { useExplorerStore } from '../../stores/explorer'
import { OverviewGraph } from '../graph/OverviewGraph'
import { useElementNavigation } from './navigation'

/**
 * View A — the landing state, shown whenever nothing is selected.
 * Drilling into an element happens via the left tree (and, once the follow-up
 * PR lands, by clicking a node in the model map).
 */
export function HomeView() {
  const allObjects = useExplorerStore(state => state.allObjects)
  const namespaces = useExplorerStore(state => state.namespaces)
  const { selectElement } = useElementNavigation()

  // Only the compositional parent/child edges are derivable from what the store
  // already holds. TODO(follow-up): the non-compositional edges come from
  // POST /objects/related, which this presentational PR must not call — the
  // model-map PR will surface the true total.
  const relationshipCount = useMemo(
    () => allObjects.filter(o => o.parentId && o.parentId !== '/').length,
    [allObjects]
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-i3x-bg">
      <header className="px-3 sm:px-5 py-4 bg-i3x-surface border-b border-i3x-border">
        <h1 className="text-base font-semibold text-i3x-text">i3X model overview</h1>
        <p className="text-xs text-i3x-text-muted mt-1">
          Full relationship map ·{' '}
          <span className="font-mono text-i3x-text">{allObjects.length}</span> objects ·{' '}
          <span
            className="font-mono text-i3x-text"
            title="Compositional parent/child edges known to the client"
          >
            {relationshipCount}
          </span>{' '}
          relationships ·{' '}
          <span className="font-mono text-i3x-text">{namespaces.length}</span> namespaces
        </p>
      </header>

      <div className="flex-1 min-h-0 flex flex-col px-3 sm:px-5 pt-4 pb-3">
        <OverviewGraph model={allObjects} onSelectElement={selectElement} />
        <p className="text-[11.5px] text-i3x-text-muted mt-2">
          Drag to pan · scroll to zoom · hover a node to see its links · click a node to open it
        </p>
      </div>
    </div>
  )
}
