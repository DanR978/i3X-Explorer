import { beforeEach, describe, expect, it } from 'vitest'
import { useExplorerStore, type SelectedItem } from './explorer'
import type { ObjectInstance } from '../api/types'

/**
 * Navigation history. The stack holds *pages*, not selections: a stop is an
 * item plus the detail tab plus the full-panel page, so Back returns to the
 * exact thing you were looking at, including the Relationships tab of an object
 * or the insights page.
 */

function object(elementId: string, parentId?: string): ObjectInstance {
  return {
    elementId,
    displayName: elementId,
    typeId: 'Type',
    namespaceUri: 'ns',
    parentId,
  } as ObjectInstance
}

function item(elementId: string): SelectedItem {
  return { type: 'object', id: `hier:${elementId}`, data: object(elementId) }
}

const state = () => useExplorerStore.getState()

describe('navigation history', () => {
  beforeEach(() => {
    state().reset()
  })

  it('starts on Home, with nowhere to go', () => {
    expect(state().selectedItem).toBeNull()
    expect(state().activePage).toBeNull()
    expect(state().historyIndex).toBe(0)
    expect(state().history).toHaveLength(1)
  })

  it('treats a tab switch as its own stop', () => {
    state().selectItem(item('pump'))
    state().setDetailTab('relationships')
    state().setDetailTab('subtree')

    expect(state().detailTab).toBe('subtree')

    state().goBack()
    expect(state().detailTab).toBe('relationships')
    expect(state().selectedItem?.id).toBe('hier:pump')

    state().goForward()
    expect(state().detailTab).toBe('subtree')
  })

  it('returns to the tab it left, not to Overview', () => {
    state().selectItem(item('pump'))
    state().setDetailTab('subtree')
    state().selectItem(item('valve'))

    expect(state().detailTab).toBe('overview')

    state().goBack()
    expect(state().selectedItem?.id).toBe('hier:pump')
    expect(state().detailTab).toBe('subtree')
  })

  it('opens an element straight onto a tab (a menu deep-link)', () => {
    state().selectItem(item('pump'), 'history')
    expect(state().detailTab).toBe('history')
  })

  it('keeps the tab when the element you are on is re-selected', () => {
    state().selectItem(item('pump'))
    state().setDetailTab('relationships')
    const before = state().history.length

    // The tree re-selecting the row you are already on (a poll refresh, a click).
    state().selectItem(item('pump'))

    expect(state().detailTab).toBe('relationships')
    expect(state().history).toHaveLength(before)
  })

  it('makes a full-panel page a stop of its own', () => {
    state().selectItem(item('pump'))
    state().setDetailTab('relationships')
    state().openPage('insights')

    expect(state().activePage).toBe('insights')

    state().goBack()
    expect(state().activePage).toBeNull()
    expect(state().detailTab).toBe('relationships')

    state().goForward()
    expect(state().activePage).toBe('insights')
  })

  it('leaves the page on any navigation, and comes back to it', () => {
    state().openPage('diff')
    state().selectItem(item('pump'))

    expect(state().activePage).toBeNull()

    state().goBack()
    expect(state().activePage).toBe('diff')
  })

  it('leaves the page even when the selection underneath is unchanged', () => {
    // Insights is opened from Home, so its selection is null throughout: the
    // Home button has to still be a navigation.
    state().openPage('insights')
    state().selectItem(null)

    expect(state().activePage).toBeNull()
    expect(state().selectedItem).toBeNull()
  })

  it('only allows one page at a time', () => {
    state().openPage('insights')
    state().openPage('diff')
    expect(state().activePage).toBe('diff')
  })

  it('ignores a repeat of the stop it is already on', () => {
    state().selectItem(item('pump'))
    state().setDetailTab('history')
    state().openPage('diff')

    const length = state().history.length
    state().openPage('diff')
    expect(state().history).toHaveLength(length)

    // Re-asking for the tab you're on is a no-op too, but only once the page is
    // gone: while one is open, naming a tab means "leave this, show me that".
    state().closePage()
    const afterClose = state().history.length
    state().setDetailTab('history')
    expect(state().history).toHaveLength(afterClose)
  })

  it('discards the forward entries once you navigate again', () => {
    state().selectItem(item('a'))
    state().selectItem(item('b'))
    state().goBack()
    state().selectItem(item('c'))

    expect(state().history.map(entry => entry.item?.id)).toEqual([
      undefined,
      'hier:a',
      'hier:c',
    ])
    state().goForward()
    expect(state().selectedItem?.id).toBe('hier:c')
  })

  it('reveals the tree path to whatever it lands on', () => {
    const child = object('child', 'parent')
    useExplorerStore.getState().setAllObjects([object('parent'), child])

    state().selectItem({ type: 'object', id: 'hier:child', data: child })
    state().selectItem(null)
    useExplorerStore.setState({ expandedNodes: new Set() })

    state().goBack()
    expect(state().expandedNodes.has('folder:hierarchical')).toBe(true)
    expect(state().expandedNodes.has('hier:parent')).toBe(true)
  })
})
