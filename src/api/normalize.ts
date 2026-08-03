import type { ObjectInstance, ServerCapabilities } from './types'

/**
 * Pure response-normalization helpers for the multi-version I3X client.
 * Extracted from client.ts so the most regression-prone logic in the app,
 * keeping three wire formats straight, is unit-testable without a network.
 */

// v0 = Alpha, v1-beta = v1 Beta, v1 = v1 Release (1.0+)
export type ApiVersion = 'v0' | 'v1-beta' | 'v1'

// #TODO: Discuss this nested payload format suggested by Dylan DuFresne as a potential alternative
// Extracts value/quality/timestamp from either standard format or nested Data.Value format
// Standard: { value: X, quality: Y, timestamp: Z }
// Nested value: { value: { Data: { Value: X, Quality: Y, Timestamp: Z }, Source: {...} } }
export function extractVQT(payload: Record<string, unknown>): { value: unknown; quality?: string; timestamp?: string } {
  if (payload.value && typeof payload.value === 'object' && payload.value !== null) {
    const valueObj = payload.value as Record<string, unknown>
    if (valueObj.Data && typeof valueObj.Data === 'object') {
      const data = valueObj.Data as Record<string, unknown>
      return {
        value: data.Value,
        quality: data.Quality as string | undefined,
        timestamp: data.Timestamp as string | undefined
      }
    }
  }
  return {
    value: payload.value,
    quality: payload.quality as string | undefined,
    timestamp: payload.timestamp as string | undefined
  }
}

// v1 object instances use typeElementId instead of typeId, and may omit namespaceUri.
// As of commit 27f15c7, metadata fields (typeNamespaceUri, relationships, etc.) are
// nested under raw.metadata rather than being flat on the object.
// Normalize to the ObjectInstance shape used throughout the app.
export function normalizeV1Object(raw: Record<string, unknown>): ObjectInstance {
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>
  // Beta called this extendedAttributes; 1.0 renamed it schemaExtensions. Accept both.
  const schemaExtensions = (
    metadata.schemaExtensions ?? metadata.extendedAttributes ??
    raw.schemaExtensions ?? raw.extendedAttributes
  ) as Record<string, unknown> | undefined
  return {
    elementId: raw.elementId as string,
    displayName: raw.displayName as string,
    typeId: ((raw.typeElementId ?? raw.typeId) as string) ?? '',
    parentId: (raw.parentId as string | null) ?? null,
    isComposition: (raw.isComposition as boolean) ?? false,
    isExtended: (raw.isExtended as boolean) ?? false,
    namespaceUri: ((raw.namespaceUri ?? metadata.typeNamespaceUri) as string) ?? '',
    description: (metadata.description as string) ?? undefined,
    relationships: (metadata.relationships ?? raw.relationships) as Record<string, unknown> | undefined,
    sourceRelationship: raw.sourceRelationship as string | undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    ...(schemaExtensions ? { schemaExtensions } : {})
  }
}

// v1 POST bulk responses: {success, results: [{success, elementId, result: T}]}
// Returns the results array, or empty array if the shape doesn't match.
export function extractV1BulkResults<T>(raw: unknown): Array<{ success: boolean; elementId: string; result: T }> {
  if (raw && typeof raw === 'object' && 'results' in (raw as object)) {
    return ((raw as Record<string, unknown>).results as Array<{ success: boolean; elementId: string; result: T }>) ?? []
  }
  return []
}

export interface InfoClassification {
  version: ApiVersion
  capabilities: ServerCapabilities | null
}

/**
 * Interprets the GET /info probe. Non-OK → v0 (genuine absence of /info).
 * OK with a parseable specVersion/version/apiVersion ≥ 1.0 and no "beta"
 * serverVersion → v1 (Release). Any other OK response, including an
 * unusable body (pass `body: undefined` when parsing failed) → v1-beta.
 */
export function classifyInfoResponse(input: { ok: boolean; body: unknown }): InfoClassification {
  if (!input.ok) return { version: 'v0', capabilities: null }
  try {
    const body = input.body as Record<string, unknown>
    // v1 wraps the payload: {success, result: {...}}; also accept unwrapped bodies
    const info = (body.result ?? body) as Record<string, unknown>
    // Capture the capabilities matrix (mandatory in 1.0 ServerInfo).
    const capabilities =
      info.capabilities && typeof info.capabilities === 'object'
        ? (info.capabilities as ServerCapabilities)
        : null
    const serverVersion = String(info.serverVersion ?? '').toLowerCase()
    const specRaw = (info.specVersion ?? info.version ?? info.apiVersion ?? '') as string
    const specMajor = parseFloat(specRaw)
    const isRelease = !isNaN(specMajor) && specMajor >= 1.0 && !serverVersion.includes('beta')
    return { version: isRelease ? 'v1' : 'v1-beta', capabilities }
  } catch {
    // /info responded OK but the body isn't useful, treat as Beta
    return { version: 'v1-beta', capabilities: null }
  }
}
