import { describe, expect, it } from 'vitest'
import { classifyInfoResponse, extractV1BulkResults, extractVQT, normalizeV1Object } from './normalize'

describe('classifyInfoResponse', () => {
  it('classifies a non-OK /info probe as v0', () => {
    expect(classifyInfoResponse({ ok: false, body: undefined })).toEqual({
      version: 'v0',
      capabilities: null,
    })
  })

  it('classifies specVersion >= 1.0 as v1 and captures capabilities', () => {
    const result = classifyInfoResponse({
      ok: true,
      body: { specVersion: '1.0', capabilities: { subscribe: { stream: true } } },
    })
    expect(result.version).toBe('v1')
    expect(result.capabilities).toEqual({ subscribe: { stream: true } })
  })

  it('unwraps the v1 {success, result} envelope', () => {
    expect(
      classifyInfoResponse({ ok: true, body: { success: true, result: { specVersion: '1.2' } } }).version
    ).toBe('v1')
  })

  it('accepts version and apiVersion as fallback field names', () => {
    expect(classifyInfoResponse({ ok: true, body: { version: '1.0' } }).version).toBe('v1')
    expect(classifyInfoResponse({ ok: true, body: { apiVersion: '1.1' } }).version).toBe('v1')
  })

  it('keeps a beta serverVersion on v1-beta even with specVersion 1.0', () => {
    expect(
      classifyInfoResponse({ ok: true, body: { specVersion: '1.0', serverVersion: '1.0.0-BETA' } }).version
    ).toBe('v1-beta')
  })

  it('classifies an OK response with an unusable body as v1-beta', () => {
    expect(classifyInfoResponse({ ok: true, body: undefined }).version).toBe('v1-beta')
    expect(classifyInfoResponse({ ok: true, body: null }).version).toBe('v1-beta')
    expect(classifyInfoResponse({ ok: true, body: {} }).version).toBe('v1-beta')
    expect(classifyInfoResponse({ ok: true, body: { specVersion: 'wat' } }).version).toBe('v1-beta')
  })
})

describe('extractVQT', () => {
  it('reads the standard flat envelope', () => {
    expect(extractVQT({ value: 42, quality: 'Good', timestamp: 't1' })).toEqual({
      value: 42,
      quality: 'Good',
      timestamp: 't1',
    })
  })

  it('unwraps the nested {value: {Data: {Value, Quality, Timestamp}}} form', () => {
    expect(
      extractVQT({ value: { Data: { Value: 7, Quality: 'Bad', Timestamp: 't2' }, Source: {} } })
    ).toEqual({ value: 7, quality: 'Bad', timestamp: 't2' })
  })

  it('leaves a plain object value (no Data key) untouched', () => {
    expect(extractVQT({ value: { a: 1 }, quality: 'Good' })).toEqual({
      value: { a: 1 },
      quality: 'Good',
      timestamp: undefined,
    })
  })
})

describe('normalizeV1Object', () => {
  it('maps typeElementId to typeId and metadata.typeNamespaceUri to namespaceUri', () => {
    const normalized = normalizeV1Object({
      elementId: 'e1',
      displayName: 'E1',
      typeElementId: 'T1',
      metadata: { typeNamespaceUri: 'urn:ns' },
    })
    expect(normalized.typeId).toBe('T1')
    expect(normalized.namespaceUri).toBe('urn:ns')
  })

  it('surfaces both extendedAttributes (beta) and schemaExtensions (1.0) as schemaExtensions', () => {
    expect(
      normalizeV1Object({ elementId: 'e', displayName: 'E', metadata: { extendedAttributes: { a: 1 } } })
        .schemaExtensions
    ).toEqual({ a: 1 })
    expect(
      normalizeV1Object({ elementId: 'e', displayName: 'E', metadata: { schemaExtensions: { b: 2 } } })
        .schemaExtensions
    ).toEqual({ b: 2 })
    // 1.0 name wins when both appear.
    expect(
      normalizeV1Object({
        elementId: 'e',
        displayName: 'E',
        metadata: { schemaExtensions: { b: 2 }, extendedAttributes: { a: 1 } },
      }).schemaExtensions
    ).toEqual({ b: 2 })
  })

  it('defaults the flags and parentId', () => {
    const normalized = normalizeV1Object({ elementId: 'e', displayName: 'E' })
    expect(normalized.parentId).toBeNull()
    expect(normalized.isComposition).toBe(false)
    expect(normalized.isExtended).toBe(false)
    expect(normalized.typeId).toBe('')
    expect(normalized.metadata).toBeUndefined()
  })
})

describe('extractV1BulkResults', () => {
  it('returns the results array', () => {
    expect(
      extractV1BulkResults({ success: true, results: [{ success: true, elementId: 'e', result: 1 }] })
    ).toEqual([{ success: true, elementId: 'e', result: 1 }])
  })

  it('returns [] for garbage shapes', () => {
    expect(extractV1BulkResults(undefined)).toEqual([])
    expect(extractV1BulkResults(null)).toEqual([])
    expect(extractV1BulkResults('nope')).toEqual([])
    expect(extractV1BulkResults({ success: true })).toEqual([])
    expect(extractV1BulkResults({ results: null })).toEqual([])
  })
})
