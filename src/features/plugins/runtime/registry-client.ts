import {utf8ByteLength} from './bytes'
import {
  createPluginRegistryCache,
  type PluginRegistryCache,
} from './registry-cache'
import {
  type CachedPluginRegistry,
  type PluginRegistryFailureReason,
  type PluginRegistrySyncResult,
} from './registry-types'
import {
  PLUGIN_REGISTRY_MAX_PLUGINS,
  validatePluginRegistrySnapshot,
} from './registry-validation'

export const PLUGIN_REGISTRY_TIMEOUT_MS = 3000
export const PLUGIN_REGISTRY_MAX_BYTES = 256 * 1024
export const PLUGIN_REGISTRY_PUBLIC_PATH =
  '/xrpc/com.selfcommand.admin.plugin.public'

const MAX_URL_LENGTH = 2048
const MAX_ETAG_LENGTH = 256

export type PluginRegistryUrlInfo =
  {configured: false} | {configured: true; url?: string}

/**
 * Reads and normalizes `EXPO_PUBLIC_PLUGIN_REGISTRY_URL`. Accepts an origin, a
 * base ending in `/xrpc`, or the full public endpoint. Credentials, query
 * strings and fragments are rejected.
 */
export function normalizePluginRegistryUrl(
  raw: string | undefined,
): PluginRegistryUrlInfo {
  if (typeof raw !== 'string') return {configured: false}
  const configured = raw.trim()
  if (!configured) return {configured: false}
  if (configured.length > MAX_URL_LENGTH) return {configured: true}

  let parsed: URL
  try {
    parsed = new URL(configured)
  } catch {
    return {configured: true}
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {configured: true}
  }
  if (parsed.username || parsed.password) return {configured: true}
  if (parsed.search || parsed.hash) return {configured: true}
  if (!parsed.hostname) return {configured: true}

  let pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname.endsWith(PLUGIN_REGISTRY_PUBLIC_PATH)) {
    // Already the full endpoint.
  } else if (pathname === '/xrpc' || pathname.endsWith('/xrpc')) {
    pathname += PLUGIN_REGISTRY_PUBLIC_PATH.slice('/xrpc'.length)
  } else {
    pathname += PLUGIN_REGISTRY_PUBLIC_PATH
  }
  parsed.pathname = pathname
  parsed.search = ''
  parsed.hash = ''

  return {configured: true, url: parsed.toString()}
}

export function getPluginRegistryUrlInfo(): PluginRegistryUrlInfo {
  return normalizePluginRegistryUrl(process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL)
}

export type PluginRegistryHeaders = {
  get: (name: string) => string | null
}

export type PluginRegistryHttpResponse = {
  status: number
  ok: boolean
  headers: PluginRegistryHeaders
  text: () => Promise<string>
}

export type PluginRegistryRequestInit = {
  method: 'GET'
  headers: Record<string, string>
  credentials: 'omit'
  redirect: 'error'
  signal: AbortSignal
}

export type PluginRegistryFetch = (
  url: string,
  init: PluginRegistryRequestInit,
) => Promise<PluginRegistryHttpResponse>

export type PluginRegistryClient = {
  readonly url: string | undefined
  readonly enabled: boolean
  loadCached: () => Promise<CachedPluginRegistry | undefined>
  sync: (current?: CachedPluginRegistry) => Promise<PluginRegistrySyncResult>
}

export type PluginRegistryClientOptions = {
  /**
   * Overrides the environment variable. An empty string disables the client.
   */
  url?: string
  fetch?: PluginRegistryFetch
  cache?: PluginRegistryCache
  timeoutMs?: number
}

class PluginRegistryTimeoutError extends Error {}

async function fetchWithTimeout(
  fetchImpl: PluginRegistryFetch,
  url: string,
  init: PluginRegistryRequestInit,
  timeoutMs: number,
): Promise<PluginRegistryHttpResponse> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new PluginRegistryTimeoutError('Registry request timed out'))
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      fetchImpl(url, {...init, signal: controller.signal}),
      timeout,
    ])
  } catch (error) {
    if (timedOut)
      throw new PluginRegistryTimeoutError('Registry request timed out')
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function readEtag(response: PluginRegistryHttpResponse): string | undefined {
  const raw = response.headers.get('etag')
  if (!raw) return undefined
  const etag = raw.trim()
  if (!etag || etag.length > MAX_ETAG_LENGTH) return undefined
  return etag
}

function failed(
  reason: PluginRegistryFailureReason,
  registry: CachedPluginRegistry | undefined,
  httpStatus?: number,
): PluginRegistrySyncResult {
  return {status: 'failed', reason, httpStatus, registry}
}

/**
 * Public registry client. It never throws for network/response problems: the
 * caller always receives a result, plus the last successful cache when one
 * exists.
 */
export function createPluginRegistryClient({
  url,
  fetch: fetchImpl,
  cache: providedCache,
  timeoutMs = PLUGIN_REGISTRY_TIMEOUT_MS,
}: PluginRegistryClientOptions = {}): PluginRegistryClient {
  const urlInfo =
    url === undefined
      ? getPluginRegistryUrlInfo()
      : normalizePluginRegistryUrl(url)
  const endpoint = urlInfo.configured ? urlInfo.url : undefined
  const doFetch: PluginRegistryFetch =
    fetchImpl ??
    (async (requestUrl, init) => {
      const response = await fetch(requestUrl, init)
      return response
    })

  let cache: PluginRegistryCache | undefined = providedCache
  function getCache(): PluginRegistryCache | undefined {
    if (!endpoint) return undefined
    if (!cache) cache = createPluginRegistryCache({url: endpoint})
    return cache
  }

  async function loadCached(): Promise<CachedPluginRegistry | undefined> {
    const currentCache = getCache()
    if (!currentCache) return undefined
    try {
      return await currentCache.load()
    } catch {
      return undefined
    }
  }

  return {
    url: endpoint,
    enabled: Boolean(endpoint),

    loadCached,

    async sync(current) {
      if (!urlInfo.configured) {
        return {status: 'disabled', reason: 'not-configured'}
      }
      if (!endpoint) {
        return {status: 'disabled', reason: 'invalid-url'}
      }

      let cached = current
      if (!cached) {
        cached = await loadCached()
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
      }
      if (cached?.etag) {
        headers['If-None-Match'] = cached.etag
      }

      let response: PluginRegistryHttpResponse
      try {
        response = await fetchWithTimeout(
          doFetch,
          endpoint,
          {
            method: 'GET',
            headers,
            credentials: 'omit',
            redirect: 'error',
            signal: new AbortController().signal,
          },
          timeoutMs,
        )
      } catch (error) {
        return failed(
          error instanceof PluginRegistryTimeoutError ? 'timeout' : 'network',
          cached,
        )
      }

      if (response.status === 304) {
        return {status: 'not-modified', registry: cached}
      }
      if (!response.ok) {
        return failed('http-status', cached, response.status)
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength) {
        const declared = Number(contentLength)
        if (Number.isFinite(declared) && declared > PLUGIN_REGISTRY_MAX_BYTES) {
          return failed('too-large', cached)
        }
      }

      let text: string
      try {
        text = await response.text()
      } catch {
        return failed('network', cached)
      }
      if (utf8ByteLength(text) > PLUGIN_REGISTRY_MAX_BYTES) {
        return failed('too-large', cached)
      }

      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return failed('invalid-json', cached)
      }

      const validated = validatePluginRegistrySnapshot(body)
      if (!validated.ok) {
        return failed(
          validated.reason === 'too-many-plugins'
            ? 'too-many-plugins'
            : 'invalid-structure',
          cached,
        )
      }

      // A stale or repeated revision must not rebuild plugin state.
      if (cached && validated.snapshot.revision <= cached.snapshot.revision) {
        return {status: 'not-modified', registry: cached}
      }

      const registry: CachedPluginRegistry = {
        etag: readEtag(response),
        snapshot: validated.snapshot,
      }

      let cacheWriteFailed = false
      const currentCache = getCache()
      if (currentCache) {
        try {
          await currentCache.save(registry)
        } catch {
          cacheWriteFailed = true
        }
      } else {
        cacheWriteFailed = true
      }

      return {status: 'updated', registry, cacheWriteFailed}
    },
  }
}

/**
 * Helpers shared by tests and callers that need the same limits.
 */
export const pluginRegistryLimits = {
  timeoutMs: PLUGIN_REGISTRY_TIMEOUT_MS,
  maxBytes: PLUGIN_REGISTRY_MAX_BYTES,
  maxPlugins: PLUGIN_REGISTRY_MAX_PLUGINS,
} as const
