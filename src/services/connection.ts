import { createClient, destroyClient, getClient } from '../api/client'
import { useConnectionStore } from '../stores/connection'
import { useExplorerStore } from '../stores/explorer'
import { useSubscriptionsStore } from '../stores/subscriptions'

/**
 * The connect/disconnect flows, extracted from the Toolbar so the connection
 * dialog can re-run them when Save changes the URL or credentials while
 * connected. All state goes through getState(), no hooks, callable anywhere.
 * Modal outcomes (redirect notice, v0 block) are store fields the Toolbar
 * renders.
 */
export async function performConnect(): Promise<void> {
  const connection = useConnectionStore.getState()
  if (connection.isConnecting) return
  const { serverUrl } = connection

  connection.setConnecting(true)
  connection.setError(null)
  connection.setRedirectNotice(null)

  // Use saved credentials if none are currently set
  const activeCredentials = connection.credentials ?? connection.getCredentialsForUrl(serverUrl)
  if (activeCredentials && !connection.credentials) {
    connection.setCredentials(activeCredentials)
  }

  const explorer = useExplorerStore.getState()

  try {
    const client = createClient(serverUrl, activeCredentials)
    const success = await client.testConnection()

    if (success) {
      if (client.getApiVersion() === 'v0') {
        destroyClient()
        connection.setConnecting(false)
        connection.setV0Blocked(true)
        return
      }
      // Flips true before the initial namespace/type load on purpose: the
      // sidebar checks isConnected before isLoading, so flipping it later
      // would show "Connect to a server to browse" instead of the loading
      // skeleton during a normal connect. The catch below un-flips it on
      // failure.
      connection.setConnected(true)

      // The server may have redirected during version detection (e.g. http → https);
      // the client adopted the final URL. Sync it back to the store so the toolbar
      // shows the real URL, future connects skip the redirect, and saved credentials
      // follow the new URL. Compare against the trailing-slash-stripped input since
      // the client constructor strips it too.
      const finalUrl = client.getBaseUrl()
      if (finalUrl !== serverUrl.replace(/\/$/, '')) {
        connection.setServerUrl(finalUrl)
        if (activeCredentials) {
          connection.saveCredentialsForUrl(finalUrl, activeCredentials)
        }
        connection.setRedirectNotice({ from: serverUrl, to: finalUrl })
      }
      connection.addRecentUrl(finalUrl)

      // Load initial data
      explorer.setLoading(true)
      const [namespaces, objectTypes] = await Promise.all([
        client.getNamespaces(),
        client.getObjectTypes()
      ])
      explorer.setNamespaces(namespaces)
      explorer.setObjectTypes(objectTypes)

      // Fire-and-forget: prefetch flat object list + hierarchy roots so the
      // tree's [count] indicators show before the user expands those folders.
      // Doesn't block the connect flow; expansion later refetches with
      // composition resolution, so chevron accuracy isn't affected.
      //
      // isLoading stays true until this prefetch settles: the sidebar and
      // overview skeletons key off it, and clearing it after namespaces/types
      // (but before the object list) left a window where the skeletons gave
      // way to empty states that the arriving model then replaced.
      client.getObjects().then(explorer.setAllObjects).catch(err => {
        // A failure here means a silently empty Objects/Hierarchy tree, say so.
        console.warn('Object list prefetch failed:', err)
        useConnectionStore.getState().setError(
          `Connected, but loading the object list failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }).finally(() => {
        explorer.setLoading(false)
      })
      client.getObjects(undefined, false, true).then(explorer.setHierarchicalRoots).catch(err => {
        // Redundant with expansion-time refetch, so a log is enough.
        console.warn('Hierarchy roots prefetch failed:', err)
      })
      // The declared relationship vocabulary, used to label the groups in the
      // sidebar's relationship walk ("Feeds to" rather than a raw elementId).
      // Purely cosmetic, so a server that doesn't serve it degrades to derived
      // labels instead of failing the connect.
      client.getRelationshipTypes().then(explorer.setRelationshipTypes).catch(err => {
        console.warn('Relationship types prefetch failed:', err)
      })
    } else {
      connection.setError('Failed to connect to server')
      destroyClient()
    }
  } catch (err) {
    explorer.setLoading(false)
    connection.setError(err instanceof Error ? err.message : 'Connection failed')
    // setError only clears isConnecting. Without this, a failed initial load
    // left the UI green-"Connected" over a destroyed client.
    connection.setConnected(false)
    destroyClient()
  }
}

export async function performDisconnect(): Promise<void> {
  const client = getClient()
  if (client) {
    const ids = Array.from(useSubscriptionsStore.getState().subscriptions.keys())
    await Promise.allSettled(ids.map(id => client.deleteSubscription(id)))
  }

  destroyClient()
  useConnectionStore.getState().disconnect()
  useExplorerStore.getState().reset()
  useSubscriptionsStore.getState().clearAll()
  useConnectionStore.getState().setRedirectNotice(null)
}
