import {create} from '#/storage/archive/db'
import {type DB} from '#/storage/archive/db/types'
import {isPluginId} from '../sdk/manifest'
import {type JsonValue, type PluginStorage} from '../sdk/types'
import {jsonByteLength} from './bytes'
import {isJsonSerializable, isPlainRecord} from './json'

/**
 * Maximum serialized size of a single plugin namespace, including all keys.
 */
export const PLUGIN_STORAGE_MAX_BYTES = 256 * 1024

/**
 * Maximum number of keys a single plugin namespace may hold.
 */
export const PLUGIN_STORAGE_MAX_KEYS = 200

const STORAGE_VERSION = 1
const NAMESPACE_PREFIX = 'plugin-storage:v1'
const DEFAULT_DB_ID = 'bsky_plugin_storage'

export type PluginStorageErrorCode =
  | 'logged-out'
  | 'invalid-plugin'
  | 'invalid-key'
  | 'invalid-value'
  | 'quota-exceeded'
  | 'too-many-keys'

export class PluginStorageError extends Error {
  readonly code: PluginStorageErrorCode

  constructor(code: PluginStorageErrorCode, message: string) {
    super(message)
    this.name = 'PluginStorageError'
    this.code = code
  }
}

type StoredNamespace = {
  version: typeof STORAGE_VERSION
  values: Record<string, JsonValue>
}

let defaultDb: DB | undefined

function getDefaultDb(): DB {
  if (!defaultDb) {
    defaultDb = create({id: DEFAULT_DB_ID})
  }
  return defaultDb
}

/**
 * Storage namespace for one account and plugin. The DID is URI-encoded so it
 * cannot collide with another account/plugin pair, and plugin data for
 * different accounts never shares an envelope.
 */
export function pluginStorageNamespace(
  accountDid: string,
  pluginId: string,
): string {
  return `${NAMESPACE_PREFIX}:${encodeURIComponent(accountDid)}:${pluginId}`
}

function parseNamespace(raw: string | undefined): StoredNamespace | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainRecord(parsed)) return undefined
    if (parsed.version !== STORAGE_VERSION) return undefined
    if (!isPlainRecord(parsed.values)) return undefined
    return {
      version: STORAGE_VERSION,
      values: parsed.values as Record<string, JsonValue>,
    }
  } catch {
    return undefined
  }
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new PluginStorageError(
      'invalid-key',
      'Plugin storage keys must be non-empty strings',
    )
  }
}

export type PluginStorageOptions = {
  /**
   * DID of the signed-in account. When absent every operation is rejected.
   */
  accountDid: string | undefined
  pluginId: string
  /**
   * Backend override for tests. Production uses the shared cross-platform
   * archive database (MMKV on native, IndexedDB on web).
   */
  db?: DB
}

/**
 * Creates the storage handle exposed to one plugin for the current account.
 * Values are kept in a single JSON envelope per account/plugin namespace so
 * quotas can be enforced on both MMKV and IndexedDB, neither of which exposes
 * portable key enumeration.
 */
export function createPluginStorage({
  accountDid,
  pluginId,
  db,
}: PluginStorageOptions): PluginStorage {
  if (!isPluginId(pluginId)) {
    throw new PluginStorageError(
      'invalid-plugin',
      `Invalid plugin id "${String(pluginId)}"`,
    )
  }

  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function requireAccount(): string {
    if (!accountDid) {
      throw new PluginStorageError(
        'logged-out',
        'Plugin storage is unavailable while signed out',
      )
    }
    return accountDid
  }

  function store(): DB {
    requireAccount()
    return db ?? getDefaultDb()
  }

  function namespace(): string {
    return pluginStorageNamespace(requireAccount(), pluginId)
  }

  async function read(): Promise<StoredNamespace> {
    const raw = await store().get(namespace())
    return parseNamespace(raw) ?? {version: STORAGE_VERSION, values: {}}
  }

  async function write(values: Record<string, JsonValue>): Promise<void> {
    const envelope: StoredNamespace = {version: STORAGE_VERSION, values}
    if (jsonByteLength(envelope) > PLUGIN_STORAGE_MAX_BYTES) {
      throw new PluginStorageError(
        'quota-exceeded',
        'Plugin storage exceeds the 256 KB limit',
      )
    }
    await store().set(namespace(), JSON.stringify(envelope))
  }

  return {
    get(key) {
      return enqueue(async () => {
        assertKey(key)
        const {values} = await read()
        return Object.prototype.hasOwnProperty.call(values, key)
          ? values[key]
          : undefined
      })
    },

    set(key, value) {
      return enqueue(async () => {
        assertKey(key)
        if (!isJsonSerializable(value)) {
          throw new PluginStorageError(
            'invalid-value',
            'Plugin storage values must be JSON-serializable',
          )
        }
        const {values} = await read()
        const isNewKey = !Object.prototype.hasOwnProperty.call(values, key)
        if (isNewKey && Object.keys(values).length >= PLUGIN_STORAGE_MAX_KEYS) {
          throw new PluginStorageError(
            'too-many-keys',
            `Plugin storage supports at most ${PLUGIN_STORAGE_MAX_KEYS} keys`,
          )
        }
        await write({...values, [key]: value})
      })
    },

    remove(key) {
      return enqueue(async () => {
        assertKey(key)
        const {values} = await read()
        if (!Object.prototype.hasOwnProperty.call(values, key)) {
          return
        }
        const next = {...values}
        delete next[key]
        if (Object.keys(next).length === 0) {
          await store().delete(namespace())
          return
        }
        await write(next)
      })
    },

    list() {
      return enqueue(async () => {
        const {values} = await read()
        return Object.keys(values).sort()
      })
    },

    clear() {
      return enqueue(async () => {
        await store().delete(namespace())
      })
    },
  }
}
