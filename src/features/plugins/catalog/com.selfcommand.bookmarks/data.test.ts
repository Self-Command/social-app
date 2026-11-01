import {type DB} from '#/storage/archive/db/types'
import {createPluginStorage} from '../../runtime/storage'
import {
  BOOKMARK_EXCERPT_MAX,
  bookmarkAuthorName,
  type BookmarkCandidate,
  BOOKMARKS_STORAGE_KEY,
  bookmarksPostLink,
  createBookmarkItem,
  formatSavedAt,
  getBookmarkStore,
  parseStoredBookmarks,
  postRkey,
  readMaxItems,
  serializeBookmarks,
  toBookmarkExcerpt,
} from './data'

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

const PLUGIN_ID = 'com.selfcommand.bookmarks'
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const SAVED_AT = '2026-10-31T12:00:00.000Z'

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

function makeStorage(db: DB, accountDid: string = ALICE) {
  return createPluginStorage({accountDid, pluginId: PLUGIN_ID, db})
}

function postUri(rkey: string): string {
  return `at://did:plc:alice/app.bsky.feed.post/${rkey}`
}

function candidate(
  overrides: Partial<BookmarkCandidate> = {},
): BookmarkCandidate {
  return {
    uri: postUri('3kabc'),
    cid: 'cid-3kabc',
    authorDid: 'did:plc:alice',
    authorHandle: 'alice.test',
    authorDisplayName: '爱丽丝',
    text: '收藏的正文',
    createdAt: '2026-10-31T10:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(SAVED_AT))
})

afterEach(() => {
  jest.useRealTimers()
})

describe('bookmark data model', () => {
  test('normalizes and truncates the text excerpt', () => {
    expect(toBookmarkExcerpt('  第一行\n\n第二行  ')).toBe('第一行 第二行')
    expect(
      toBookmarkExcerpt('x'.repeat(BOOKMARK_EXCERPT_MAX + 20)),
    ).toHaveLength(BOOKMARK_EXCERPT_MAX)
  })

  test('builds a plain text post link from the at-uri', () => {
    expect(postRkey(postUri('3kabc'))).toBe('3kabc')
    expect(postRkey('https://bsky.app/profile/alice.test/post/3kabc')).toBe(
      undefined,
    )
    expect(
      bookmarksPostLink({uri: postUri('3kabc'), authorHandle: 'alice.test'}),
    ).toBe('https://bsky.app/profile/alice.test/post/3kabc')
    expect(
      bookmarksPostLink({uri: 'not-an-at-uri', authorHandle: 'alice.test'}),
    ).toBe(undefined)
  })

  test('saves only the public fields and the excerpt', () => {
    const item = createBookmarkItem(candidate(), SAVED_AT)
    expect(item).toEqual({
      uri: postUri('3kabc'),
      cid: 'cid-3kabc',
      authorDid: 'did:plc:alice',
      authorHandle: 'alice.test',
      authorDisplayName: '爱丽丝',
      textExcerpt: '收藏的正文',
      createdAt: '2026-10-31T10:00:00.000Z',
      savedAt: SAVED_AT,
    })
  })

  test('drops invalid stored entries and sorts by saved time desc', () => {
    const items = parseStoredBookmarks([
      {
        ...createBookmarkItem(candidate({uri: postUri('older')}), SAVED_AT),
        savedAt: '2026-10-30T12:00:00.000Z',
      },
      {uri: 1, cid: 'x'},
      createBookmarkItem(candidate({uri: postUri('newer')}), SAVED_AT),
    ])
    expect(items.map(item => item.uri)).toEqual([
      postUri('newer'),
      postUri('older'),
    ])
  })

  test('clamps the maxItems setting to the declared range', () => {
    expect(readMaxItems({})).toBe(100)
    expect(readMaxItems({maxItems: '5'})).toBe(100)
    expect(readMaxItems({maxItems: 5})).toBe(10)
    expect(readMaxItems({maxItems: 42.7})).toBe(42)
    expect(readMaxItems({maxItems: 9000})).toBe(500)
  })

  test('formats the saved time and falls back to the handle', () => {
    const local = new Date(SAVED_AT)
    const pad = (value: number) => String(value).padStart(2, '0')
    expect(formatSavedAt(SAVED_AT)).toBe(
      `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(
        local.getDate(),
      )} ${pad(local.getHours())}:${pad(local.getMinutes())}`,
    )
    expect(formatSavedAt(SAVED_AT)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatSavedAt('not-a-date')).toBe('')
    expect(bookmarkAuthorName(createBookmarkItem(candidate(), SAVED_AT))).toBe(
      '爱丽丝',
    )
    expect(
      bookmarkAuthorName(
        createBookmarkItem(candidate({authorDisplayName: undefined}), SAVED_AT),
      ),
    ).toBe('@alice.test')
  })
})

describe('bookmark store', () => {
  test('adds newest first, persists to the account namespace and rejects duplicates', async () => {
    const db = memoryDb()
    const storage = makeStorage(db)
    const store = getBookmarkStore(storage)

    await expect(store.add(candidate(), 100)).resolves.toBe('added')
    jest.setSystemTime(new Date('2026-10-31T12:01:00.000Z'))
    await expect(
      store.add(candidate({uri: postUri('3kdef'), text: '较新的收藏'}), 100),
    ).resolves.toBe('added')
    await expect(store.add(candidate(), 100)).resolves.toBe('exists')

    expect(store.getSnapshot().items.map(item => item.uri)).toEqual([
      postUri('3kdef'),
      postUri('3kabc'),
    ])
    await expect(makeStorage(db).get(BOOKMARKS_STORAGE_KEY)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({uri: postUri('3kabc')}),
        expect.objectContaining({uri: postUri('3kdef')}),
      ]),
    )
  })

  test('keeps data across restarts and isolates accounts', async () => {
    const db = memoryDb()
    const alice = makeStorage(db)
    await getBookmarkStore(alice).add(candidate(), 100)

    const restarted = makeStorage(db)
    const restored = getBookmarkStore(restarted)
    await restored.ensureLoaded()
    expect(restored.getSnapshot().items).toHaveLength(1)

    const bob = makeStorage(db, BOB)
    const bobStore = getBookmarkStore(bob)
    await bobStore.ensureLoaded()
    expect(bobStore.getSnapshot().items).toHaveLength(0)
  })

  test('rejects new bookmarks at the limit and keeps existing ones', async () => {
    const db = memoryDb()
    const store = getBookmarkStore(makeStorage(db))

    for (let index = 0; index < 10; index++) {
      await store.add(candidate({uri: postUri(`item${String(index)}`)}), 10)
    }
    await expect(
      store.add(candidate({uri: postUri('overflow')}), 10),
    ).resolves.toBe('limit')
    expect(store.getSnapshot().items).toHaveLength(10)
  })

  test('removes a single bookmark and clears everything', async () => {
    const db = memoryDb()
    const storage = makeStorage(db)
    const store = getBookmarkStore(storage)

    await store.add(candidate({uri: postUri('one')}), 100)
    await store.add(candidate({uri: postUri('two')}), 100)
    await store.remove(postUri('one'))
    expect(store.getSnapshot().items.map(item => item.uri)).toEqual([
      postUri('two'),
    ])

    await store.clear()
    expect(store.getSnapshot().items).toHaveLength(0)
    await expect(storage.get(BOOKMARKS_STORAGE_KEY)).resolves.toBe(undefined)
  })

  test('loads stored data and exposes a shared snapshot to subscribers', async () => {
    const db = memoryDb()
    const storage = makeStorage(db)
    await storage.set(
      BOOKMARKS_STORAGE_KEY,
      serializeBookmarks([createBookmarkItem(candidate(), SAVED_AT)]),
    )

    const store = getBookmarkStore(storage)
    const listener = jest.fn()
    const unsubscribe = store.subscribe(listener)
    await store.ensureLoaded()
    expect(store.getSnapshot().status).toBe('ready')
    expect(store.getSnapshot().items).toHaveLength(1)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })
})
