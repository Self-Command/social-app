import {
  createPluginRegistryClient,
  getPluginRegistryUrlInfo,
  normalizePluginRegistryUrl,
  PLUGIN_REGISTRY_MAX_BYTES,
  PLUGIN_REGISTRY_PUBLIC_PATH,
  type PluginRegistryFetch,
  type PluginRegistryHttpResponse,
} from './registry-client'
import {
  type CachedPluginRegistry,
  type PluginRegistryEntry,
  type PluginRegistrySnapshot,
} from './registry-types'
import {PLUGIN_REGISTRY_MAX_PLUGINS} from './registry-validation'

jest.mock('react-native-mmkv', () => ({
  MMKV: class MMKVMock {
    private store = new Map<string, string>()

    set(key: string, value: string) {
      this.store.set(key, value)
    }

    getString(key: string) {
      return this.store.get(key)
    }

    delete(key: string) {
      return this.store.delete(key)
    }

    clearAll() {
      this.store.clear()
    }
  },
}))

const ENDPOINT = `https://registry.example.com${PLUGIN_REGISTRY_PUBLIC_PATH}`
const GENERATED_AT = '2026-10-31T12:00:00.000Z'

function entry(
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return {
    id: 'com.example.alpha',
    version: '1.0.0',
    hostApi: 2,
    platforms: ['ios'],
    capabilities: ['feed.read'],
    settings: {count: 5},
    ...overrides,
  }
}

function snapshot(
  revision = 1,
  plugins: PluginRegistryEntry[] = [entry()],
): PluginRegistrySnapshot {
  return {revision, generatedAt: GENERATED_AT, plugins}
}

function httpResponse({
  body = '',
  status = 200,
  etag,
  contentLength,
}: {
  body?: unknown
  status?: number
  etag?: string
  contentLength?: number
}): PluginRegistryHttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const headers = new Map<string, string>()
  if (etag !== undefined) headers.set('etag', etag)
  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength))
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headers.get(name.toLowerCase()) ?? null
      },
    },
    text: jest.fn(() => Promise.resolve(text)),
  }
}

function fakeCache(initial?: CachedPluginRegistry) {
  let value = initial
  const load = jest.fn(() => Promise.resolve(value))
  const save = jest.fn((next: CachedPluginRegistry) => {
    value = next
    return Promise.resolve()
  })
  return {
    cache: {load, save},
    load,
    save,
    get value() {
      return value
    },
  }
}

function client({
  fetchImpl,
  cache,
  url = 'https://registry.example.com',
}: {
  fetchImpl: PluginRegistryFetch
  cache: ReturnType<typeof fakeCache>['cache']
  url?: string
}) {
  return createPluginRegistryClient({url, fetch: fetchImpl, cache})
}

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('registry sync success and caching', () => {
  test('syncs a valid snapshot and caches the last success with its ETag', async () => {
    const snap = snapshot(3)
    const fetchImpl = jest.fn<
      ReturnType<PluginRegistryFetch>,
      Parameters<PluginRegistryFetch>
    >(() =>
      Promise.resolve(httpResponse({body: snap, etag: '"plugin-registry-3"'})),
    )
    const cache = fakeCache()
    const subject = client({fetchImpl, cache: cache.cache})

    const result = await subject.sync()

    expect(result).toMatchObject({
      status: 'updated',
      registry: {
        etag: '"plugin-registry-3"',
        snapshot: snap,
      },
      cacheWriteFailed: false,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(ENDPOINT)
    expect(init.headers).toEqual({Accept: 'application/json'})
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.method).toBe('GET')
    expect(cache.save).toHaveBeenCalledWith({
      etag: '"plugin-registry-3"',
      snapshot: snap,
    })
  })

  test('still applies an update when the cache write fails', async () => {
    const snap = snapshot(2)
    const fetchImpl = jest.fn(() => Promise.resolve(httpResponse({body: snap})))
    const cache = fakeCache()
    cache.save.mockRejectedValueOnce(new Error('disk full'))
    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toMatchObject({status: 'updated', cacheWriteFailed: true})
  })

  test('treats an equal or older revision as not modified', async () => {
    const cached = {etag: '"plugin-registry-5"', snapshot: snapshot(5)}
    const cache = fakeCache(cached)
    const fetchImpl = jest.fn(() =>
      Promise.resolve(httpResponse({body: snapshot(4)})),
    )
    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toEqual({status: 'not-modified', registry: cached})
    expect(cache.save).not.toHaveBeenCalled()
  })
})

describe('registry ETag handling', () => {
  test('sends the cached ETag and keeps state on 304', async () => {
    const cached = {
      etag: '"plugin-registry-3"',
      snapshot: snapshot(3),
    }
    const cache = fakeCache(cached)
    const fetchImpl = jest.fn<
      ReturnType<PluginRegistryFetch>,
      Parameters<PluginRegistryFetch>
    >(() => Promise.resolve(httpResponse({status: 304})))

    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toEqual({status: 'not-modified', registry: cached})
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers['If-None-Match']).toBe('"plugin-registry-3"')
    expect(cache.save).not.toHaveBeenCalled()
  })

  test('loads the cache to seed the ETag when no current state is passed', async () => {
    const cached = {
      etag: '"plugin-registry-2"',
      snapshot: snapshot(2),
    }
    const cache = fakeCache(cached)
    const fetchImpl = jest.fn(() =>
      Promise.resolve(httpResponse({status: 304})),
    )
    await client({fetchImpl, cache: cache.cache}).sync()

    expect(cache.load).toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalled()
  })
})

describe('registry failures fall back to the last success', () => {
  const cached = {
    etag: '"plugin-registry-1"',
    snapshot: snapshot(1),
  }

  test('uses the cache on timeout', async () => {
    jest.useFakeTimers()
    const cache = fakeCache(cached)
    const fetchImpl = jest.fn(
      (_url: string, init: Parameters<PluginRegistryFetch>[1]) =>
        new Promise<PluginRegistryHttpResponse>((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        }),
    ) as PluginRegistryFetch

    const pending = client({fetchImpl, cache: cache.cache}).sync()
    await jest.advanceTimersByTimeAsync(3000)
    const result = await pending

    expect(result).toEqual({
      status: 'failed',
      reason: 'timeout',
      httpStatus: undefined,
      registry: cached,
    })
  })

  test('uses the cache on network errors', async () => {
    const cache = fakeCache(cached)
    const fetchImpl = jest.fn(() => Promise.reject(new Error('offline')))
    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'network',
      registry: cached,
    })
  })

  test('uses the cache on HTTP errors', async () => {
    const cache = fakeCache(cached)
    const fetchImpl = jest.fn(() =>
      Promise.resolve(httpResponse({status: 500, body: 'oops'})),
    )
    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'http-status',
      httpStatus: 500,
      registry: cached,
    })
  })

  test('rejects responses over the byte limit', async () => {
    const cache = fakeCache(cached)
    const fetchImpl = jest.fn(() =>
      Promise.resolve(
        httpResponse({body: 'x'.repeat(PLUGIN_REGISTRY_MAX_BYTES + 1)}),
      ),
    )
    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'too-large',
      registry: cached,
    })
  })

  test('rejects a declared content length over the limit without reading the body', async () => {
    const cache = fakeCache(cached)
    const response = httpResponse({
      body: snapshot(2),
      contentLength: PLUGIN_REGISTRY_MAX_BYTES + 1,
    })
    const fetchImpl = jest.fn(() => Promise.resolve(response))
    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toMatchObject({status: 'failed', reason: 'too-large'})
    expect(response.text).not.toHaveBeenCalled()
  })

  test('rejects more than 50 plugins', async () => {
    const cache = fakeCache(cached)
    const plugins = Array.from(
      {length: PLUGIN_REGISTRY_MAX_PLUGINS + 1},
      (_, index) =>
        entry({id: `com.example.plugin${String(index).padStart(3, '0')}`}),
    )
    const fetchImpl = jest.fn(() =>
      Promise.resolve(httpResponse({body: snapshot(2, plugins)})),
    )
    const result = await client({fetchImpl, cache: cache.cache}).sync()

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'too-many-plugins',
      registry: cached,
    })
  })

  test('rejects invalid JSON and invalid structures', async () => {
    const cache = fakeCache(cached)
    const invalidJson = await client({
      fetchImpl: jest.fn(() => Promise.resolve(httpResponse({body: '{'}))),
      cache: cache.cache,
    }).sync()
    expect(invalidJson).toMatchObject({
      status: 'failed',
      reason: 'invalid-json',
      registry: cached,
    })

    const invalidStructure = await client({
      fetchImpl: jest.fn(() =>
        Promise.resolve(
          httpResponse({
            body: {
              revision: 2,
              generatedAt: GENERATED_AT,
              plugins: [{...entry(), extra: true}],
            },
          }),
        ),
      ),
      cache: cache.cache,
    }).sync()
    expect(invalidStructure).toMatchObject({
      status: 'failed',
      reason: 'invalid-structure',
      registry: cached,
    })
    expect(cache.save).not.toHaveBeenCalled()
  })

  test('returns no registry when invalid and there is no cache', async () => {
    const cache = fakeCache()
    const result = await client({
      fetchImpl: jest.fn(() =>
        Promise.resolve(
          httpResponse({
            body: {revision: 2, generatedAt: 'not-a-date', plugins: []},
          }),
        ),
      ),
      cache: cache.cache,
    }).sync()

    expect(result).toEqual({
      status: 'failed',
      reason: 'invalid-structure',
      httpStatus: undefined,
      registry: undefined,
    })
  })
})

describe('registry configuration', () => {
  test('does not request or cache when the URL is not configured', async () => {
    const fetchImpl = jest.fn() as unknown as PluginRegistryFetch
    const cache = fakeCache()
    const subject = client({fetchImpl, cache: cache.cache, url: ''})

    expect(subject.enabled).toBe(false)
    await expect(subject.sync()).resolves.toEqual({
      status: 'disabled',
      reason: 'not-configured',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cache.load).not.toHaveBeenCalled()
  })

  test('disables an invalid URL', async () => {
    const fetchImpl = jest.fn() as unknown as PluginRegistryFetch
    const subject = client({
      fetchImpl,
      cache: fakeCache().cache,
      url: 'ftp://registry.example.com',
    })

    expect(subject.enabled).toBe(false)
    await expect(subject.sync()).resolves.toEqual({
      status: 'disabled',
      reason: 'invalid-url',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('normalizes origins, /xrpc bases and full endpoints', () => {
    expect(normalizePluginRegistryUrl('https://registry.example.com/')).toEqual(
      {configured: true, url: ENDPOINT},
    )
    expect(
      normalizePluginRegistryUrl(' https://registry.example.com/xrpc/ '),
    ).toEqual({configured: true, url: ENDPOINT})
    expect(normalizePluginRegistryUrl(ENDPOINT)).toEqual({
      configured: true,
      url: ENDPOINT,
    })
    expect(normalizePluginRegistryUrl('  ')).toEqual({configured: false})
  })

  test('rejects credentials, query strings, hashes and unsupported schemes', () => {
    expect(
      normalizePluginRegistryUrl('https://user:pass@registry.example.com'),
    ).toEqual({configured: true})
    expect(
      normalizePluginRegistryUrl('https://registry.example.com/?a=1'),
    ).toEqual({configured: true})
    expect(
      normalizePluginRegistryUrl('https://registry.example.com/#x'),
    ).toEqual({configured: true})
    expect(normalizePluginRegistryUrl('file:///etc/passwd')).toEqual({
      configured: true,
    })
  })

  test('reads the registry URL from the environment', () => {
    const previous = process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL
    process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL = 'https://env.example.com/xrpc'
    try {
      expect(getPluginRegistryUrlInfo()).toEqual({
        configured: true,
        url: `https://env.example.com${PLUGIN_REGISTRY_PUBLIC_PATH}`,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL
      } else {
        process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL = previous
      }
    }
  })
})
