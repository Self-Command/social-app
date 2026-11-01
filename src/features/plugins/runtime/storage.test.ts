import {type DB} from '#/storage/archive/db/types'
import {
  createPluginStorage,
  PLUGIN_STORAGE_MAX_BYTES,
  PLUGIN_STORAGE_MAX_KEYS,
  PluginStorageError,
} from './storage'

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

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const ALPHA = 'com.example.alpha'
const BETA = 'com.example.beta'

type MemoryDb = DB & {data: Map<string, string>}

function memoryDb(): MemoryDb {
  const data = new Map<string, string>()
  return {
    data,
    get(key) {
      return data.get(key)
    },
    set(key, value) {
      data.set(key, value)
    },
    delete(key) {
      data.delete(key)
    },
    clear() {
      data.clear()
    },
  }
}

function storage(
  db: DB,
  accountDid: string | undefined = ALICE,
  pluginId: string = ALPHA,
) {
  return createPluginStorage({accountDid, pluginId, db})
}

describe('plugin storage isolation', () => {
  test('isolates accounts on the same device', async () => {
    const db = memoryDb()
    const alice = storage(db, ALICE)
    const bob = storage(db, BOB)

    await alice.set('shared', 'alice-value')
    await bob.set('shared', 'bob-value')

    await expect(alice.get('shared')).resolves.toBe('alice-value')
    await expect(bob.get('shared')).resolves.toBe('bob-value')
    await expect(storage(db, 'did:plc:carol').get('shared')).resolves.toBe(
      undefined,
    )
  })

  test('isolates plugins using the same key', async () => {
    const db = memoryDb()
    const alpha = storage(db, ALICE, ALPHA)
    const beta = storage(db, ALICE, BETA)

    await alpha.set('state', {counter: 1})
    await beta.set('state', {counter: 2})

    await expect(alpha.get('state')).resolves.toEqual({counter: 1})
    await expect(beta.get('state')).resolves.toEqual({counter: 2})
    await expect(beta.list()).resolves.toEqual(['state'])
  })

  test('keeps data across storage instances backed by the same store', async () => {
    const db = memoryDb()
    await storage(db, ALICE, ALPHA).set('draft', 'saved')

    // Simulates an app restart: a fresh handle over the same device storage.
    const restarted = storage(db, ALICE, ALPHA)
    await expect(restarted.get('draft')).resolves.toBe('saved')
  })

  test('rejects operations while signed out', async () => {
    const db = memoryDb()
    const loggedOut = createPluginStorage({
      accountDid: undefined,
      pluginId: ALPHA,
      db,
    })

    await expect(loggedOut.get('x')).rejects.toMatchObject({code: 'logged-out'})
    await expect(loggedOut.set('x', 1)).rejects.toMatchObject({
      code: 'logged-out',
    })
    await expect(loggedOut.remove('x')).rejects.toMatchObject({
      code: 'logged-out',
    })
    await expect(loggedOut.list()).rejects.toMatchObject({code: 'logged-out'})
    await expect(loggedOut.clear()).rejects.toMatchObject({code: 'logged-out'})
    expect(db.data.size).toBe(0)
  })

  test('rejects invalid plugin identifiers before touching storage', () => {
    const db = memoryDb()
    expect(() =>
      createPluginStorage({
        accountDid: ALICE,
        pluginId: 'Not A Plugin',
        db,
      }),
    ).toThrow(PluginStorageError)
    expect(db.data.size).toBe(0)
  })
})

describe('plugin storage values', () => {
  test('round-trips JSON values', async () => {
    const db = memoryDb()
    const store = storage(db)
    const value = {
      text: '你好',
      count: 3,
      enabled: false,
      missing: null,
      list: [1, 'two', {deep: true}],
    }

    await store.set('value', value)
    await expect(store.get('value')).resolves.toEqual(value)
    await expect(store.get('missing')).resolves.toBeUndefined()
  })

  test('rejects values that cannot round-trip through JSON', async () => {
    const db = memoryDb()
    const store = storage(db)
    const circular: Record<string, unknown> = {}
    circular.self = circular

    const invalidValues: unknown[] = [
      undefined,
      () => {},
      Symbol('x'),
      BigInt(1),
      NaN,
      Infinity,
      new Date(),
      circular,
    ]

    for (const value of invalidValues) {
      await expect(store.set('key', value as never)).rejects.toMatchObject({
        code: 'invalid-value',
      })
    }
    await expect(store.list()).resolves.toEqual([])
  })

  test('serializes concurrent writes without losing keys', async () => {
    const db = memoryDb()
    const store = storage(db)

    await Promise.all([store.set('a', 1), store.set('b', 2), store.set('c', 3)])

    await expect(store.list()).resolves.toEqual(['a', 'b', 'c'])
    await expect(store.get('a')).resolves.toBe(1)
    await expect(store.get('b')).resolves.toBe(2)
    await expect(store.get('c')).resolves.toBe(3)
  })

  test('supports remove, list and clear', async () => {
    const db = memoryDb()
    const store = storage(db)
    await store.set('b', 2)
    await store.set('a', 1)

    await expect(store.list()).resolves.toEqual(['a', 'b'])
    await store.remove('a')
    await expect(store.list()).resolves.toEqual(['b'])
    await store.clear()
    await expect(store.list()).resolves.toEqual([])
    expect(db.data.size).toBe(0)
  })
})

describe('plugin storage quotas', () => {
  test('rejects writes that exceed 256 KB without changing existing data', async () => {
    const db = memoryDb()
    const store = storage(db)
    await store.set('kept', 'original')

    await expect(
      store.set('large', 'x'.repeat(PLUGIN_STORAGE_MAX_BYTES)),
    ).rejects.toMatchObject({code: 'quota-exceeded'})

    await expect(store.get('kept')).resolves.toBe('original')
    await expect(store.get('large')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual(['kept'])
  })

  test(`rejects the ${PLUGIN_STORAGE_MAX_KEYS + 1}th key`, async () => {
    const db = memoryDb()
    const store = storage(db)

    for (let index = 0; index < PLUGIN_STORAGE_MAX_KEYS; index++) {
      await store.set(`key-${index}`, index)
    }
    await expect(store.set('overflow', true)).rejects.toMatchObject({
      code: 'too-many-keys',
    })
    await expect(store.list()).resolves.toHaveLength(PLUGIN_STORAGE_MAX_KEYS)

    // Overwriting an existing key does not increase the key count.
    await expect(store.set('key-0', 999)).resolves.toBeUndefined()
    await expect(store.get('key-0')).resolves.toBe(999)
  })
})
