import { afterEach, describe, expect, it, vi } from 'vitest'
import { I3XClient } from './client'

type StubResponse = {
  ok: boolean
  status: number
  statusText?: string
  redirected?: boolean
  url?: string
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

// Route stubbed responses by "METHOD path". 204s and empty bodies must not
// throw SyntaxError out of requestRaw (a 204 /sync on an idle queue used to
// kill live updates via the transport's error handler).
function stubFetch(routes: Record<string, StubResponse>) {
  const fetchStub = vi.fn(async (url: string, options?: RequestInit) => {
    const path = new URL(url).pathname
    const key = `${options?.method ?? 'GET'} ${path}`
    const route = routes[key]
    if (!route) throw new Error(`No stub for ${key}`)
    return route as unknown as Response
  })
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

function jsonResponse(body: unknown, status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const emptyBody = (status: number): StubResponse => ({
  ok: true,
  status,
  text: async () => '',
})

describe('I3XClient empty-body handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('v0 sync resolves [] on 204 No Content', async () => {
    stubFetch({ 'POST /subscriptions/sub1/sync': emptyBody(204) })
    const client = new I3XClient('http://server')
    await expect(client.sync('sub1')).resolves.toEqual([])
  })

  it('v0 sync resolves [] on an empty 200 body', async () => {
    stubFetch({
      'POST /subscriptions/sub1/sync': { ok: true, status: 200, text: async () => '  ' },
    })
    const client = new I3XClient('http://server')
    await expect(client.sync('sub1')).resolves.toEqual([])
  })

  it('v1 sync resolves [] on 204 after version detection', async () => {
    stubFetch({
      'GET /info': jsonResponse({ specVersion: '1.0', capabilities: {} }),
      'GET /namespaces': jsonResponse({ success: true, result: [] }),
      'POST /subscriptions/sync': emptyBody(204),
    })
    const client = new I3XClient('http://server')
    await expect(client.testConnection()).resolves.toBe(true)
    expect(client.getApiVersion()).toBe('v1')
    await expect(client.sync('sub1')).resolves.toEqual([])
  })

  it('still surfaces malformed non-empty bodies as errors', async () => {
    stubFetch({
      'POST /subscriptions/sub1/sync': { ok: true, status: 200, text: async () => 'not json' },
    })
    const client = new I3XClient('http://server')
    await expect(client.sync('sub1')).rejects.toThrow()
  })
})
