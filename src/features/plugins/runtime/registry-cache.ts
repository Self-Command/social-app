import {create} from '#/storage/archive/db'
import {type DB} from '#/storage/archive/db/types'
import {isPlainRecord} from './json'
import {
  type CachedPluginRegistry,
  type PluginRegistrySnapshot,
} from './registry-types'
import {validatePluginRegistrySnapshot} from './registry-validation'

const CACHE_VERSION = 1
const CACHE_DB_ID = 'bsky_plugin_registry'
const CACHE_KEY_PREFIX = 'plugin-registry:v1'
const MAX_ETAG_LENGTH = 256

let defaultDb: DB | undefined

function getDefaultDb(): DB {
  if (!defaultDb) {
    defaultDb = create({id: CACHE_DB_ID})
  }
  return defaultDb
}

export function pluginRegistryCacheKey(url: string): string {
  return `${CACHE_KEY_PREFIX}:${encodeURIComponent(url)}`
}

type CacheRecord = {
  version: typeof CACHE_VERSION
  etag?: string
  snapshot: PluginRegistrySnapshot
}

export type PluginRegistryCache = {
  load: () => Promise<CachedPluginRegistry | undefined>
  save: (registry: CachedPluginRegistry) => Promise<void>
}

function parseRecord(
  raw: string | undefined,
): CachedPluginRegistry | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isPlainRecord(parsed)) return undefined
  if (parsed.version !== CACHE_VERSION) return undefined
  if (
    parsed.etag !== undefined &&
    (typeof parsed.etag !== 'string' ||
      parsed.etag.length === 0 ||
      parsed.etag.length > MAX_ETAG_LENGTH)
  ) {
    return undefined
  }
  const validated = validatePluginRegistrySnapshot(parsed.snapshot)
  if (!validated.ok) return undefined
  return {
    etag: parsed.etag,
    snapshot: validated.snapshot,
  }
}

/**
 * Cross-platform last-success cache (MMKV on native, IndexedDB on web). Keys
 * are scoped by registry URL so pointing the app at a different registry never
 * reuses an old snapshot.
 */
export function createPluginRegistryCache({
  url,
  db,
}: {
  url: string
  db?: DB
}): PluginRegistryCache {
  const key = pluginRegistryCacheKey(url)
  const store = () => db ?? getDefaultDb()

  return {
    async load() {
      const raw = await store().get(key)
      return parseRecord(raw)
    },

    async save(registry) {
      const record: CacheRecord = {
        version: CACHE_VERSION,
        etag: registry.etag,
        snapshot: registry.snapshot,
      }
      await store().set(key, JSON.stringify(record))
    },
  }
}
