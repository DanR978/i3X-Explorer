/**
 * A one-shot "find this node" request for the relationship map: the search box
 * issues one when a suggestion is picked, and the active view answers by
 * centring and zooming on that node (if it is drawn).
 */
export interface LocateRequest {
  elementId: string
  /** Monotonic per request, so picking the same element twice zooms twice. */
  token: number
}
