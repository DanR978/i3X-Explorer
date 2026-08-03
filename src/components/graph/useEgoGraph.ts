import { useEffect, useRef, useState } from 'react'
import { getClient } from '../../api/client'
import type { ObjectInstance } from '../../api/types'
import { useExplorerStore } from '../../stores/explorer'
import { expandEgoGraph, type EgoGraph } from './egoGraph'

export interface EgoGraphState {
  graph: EgoGraph | null
  isLoading: boolean
  error: string | null
}

/**
 * One walk, shared by everything that draws it.
 *
 * The list and the map used to fetch separately, the list a single
 * /objects/related on the selected element, each canvas its own depth-N walk,
 * so the list could only ever show one hop, and the two panes could disagree.
 * Owning the walk one level up means one round trip per hop for the whole tab
 * and no way for the surfaces to fall out of step.
 *
 * The previous result is deliberately kept while a new walk runs: raising the
 * depth should extend what you're looking at, not blank it.
 */
export function useEgoGraph(
  root: ObjectInstance,
  depth: number,
  descendantsOnly = false
): EgoGraphState {
  const objectIndex = useExplorerStore(state => state.objectIndex)
  const childrenByParent = useExplorerStore(state => state.childrenByParent)

  const [graph, setGraph] = useState<EgoGraph | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The walk reads the store, but a change to allObjects (the 30s poll) must not
  // re-trigger it. Only the root and the depth do. Refs keep the effect's deps honest.
  const storeRef = useRef({ objectIndex, childrenByParent })
  storeRef.current = { objectIndex, childrenByParent }

  useEffect(() => {
    const client = getClient()
    if (!client) {
      setError('Not connected.')
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    expandEgoGraph({
      client,
      root,
      depth,
      store: storeRef.current,
      descendantsOnly,
      cancelled: () => cancelled,
    })
      .then(result => {
        if (!cancelled) setGraph(result)
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to walk relationships')
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [root, depth, descendantsOnly])

  return { graph, isLoading, error }
}
