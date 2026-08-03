import { create } from 'zustand'
import { useExplorerStore } from './explorer'
import { useDiffStore } from './diff'

/**
 * Open/closed state for the Model Insights page, nothing else. The report
 * itself lives in the `getInsightsReport` module memo (keyed on the explorer
 * store's array identities), so closing the view frees no data and reopening
 * is instant; there is deliberately no content in this store.
 *
 * Same lifecycle as the diff view (stores/diff.ts): any navigation leaves the
 * page, and the two full-panel views are mutually exclusive, whichever
 * opened last wins. The import is one-way (insights → diff), so there is no
 * module cycle.
 */

interface InsightsViewState {
  viewOpen: boolean
  openView: () => void
  closeView: () => void
}

export const useInsightsStore = create<InsightsViewState>(set => ({
  viewOpen: false,
  openView: () => {
    // Mutual exclusion with the diff panel: last-opened wins.
    useDiffStore.getState().closeView()
    set({ viewOpen: true })
  },
  closeView: () => set({ viewOpen: false }),
}))

// Navigating anywhere (an atlas row, the tree, search, Back/Forward) leaves
// the page: the main panel shows one thing at a time and the selection is the
// source of truth for what that is.
useExplorerStore.subscribe((state, prev) => {
  if (state.selectedItem !== prev.selectedItem || state.historyIndex !== prev.historyIndex) {
    const insights = useInsightsStore.getState()
    if (insights.viewOpen) insights.closeView()
  }
})

// The diff view opening (toolbar Snapshot menu, or a baseline file load, which
// sets viewOpen directly without calling openView) also displaces this page.
useDiffStore.subscribe((state, prev) => {
  if (state.viewOpen && !prev.viewOpen) {
    const insights = useInsightsStore.getState()
    if (insights.viewOpen) insights.closeView()
  }
})
