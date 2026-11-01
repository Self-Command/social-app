import {type ReactElement} from 'react'
import {type Text as RNText} from 'react-native'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native'

import {type DB} from '#/storage/archive/db/types'
import {PluginHostContext} from '../../runtime/plugin-context'
import {PluginSlot} from '../../runtime/PluginSlot'
import {type PluginRegistryEntry} from '../../runtime/registry-types'
import {resolvePlugins} from '../../runtime/resolve'
import {createPluginStorage} from '../../runtime/storage'
import {
  type PluginCapability,
  type PluginStorage,
  type PluginToast,
} from '../../sdk'
import {BookmarksComposerToolbar} from './components/BookmarksComposerToolbar'
import {BookmarksFeedFooter} from './components/BookmarksFeedFooter'
import {BookmarksSettingsSection} from './components/BookmarksSettingsSection'
import {
  type BookmarkCandidate,
  BOOKMARKS_STORAGE_KEY,
  createBookmarkItem,
  getBookmarkStore,
  serializeBookmarks,
} from './data'
import {bookmarksPlugin} from './index'

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

jest.mock('react-native-reanimated', () => {
  const {View} = jest.requireActual<{View: typeof RNText}>('react-native')
  return {
    __esModule: true,
    default: {View},
    useReducedMotion: () => false,
  }
})

jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<{Text: typeof RNText}>('react-native').Text,
}))

// The real ALF barrel boots app-wide Layout, analytics and storage modules.
jest.mock('#/alf', () => ({
  atoms: new Proxy(
    {},
    {
      get: (_target, key) => (key === '__esModule' ? undefined : {}),
    },
  ),
  useTheme: () => ({
    atoms: {
      text: {},
      text_contrast_medium: {},
      bg: {},
      bg_contrast_25: {},
      border_contrast_low: {},
    },
    palette: {primary_500: '#0060E1', negative_500: '#D32F2F'},
  }),
}))

i18n.loadAndActivate({locale: 'zh', messages: {}})

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const PLUGIN_ID = 'com.selfcommand.bookmarks'
const GENERATED_AT = '2026-10-31T12:00:00.000Z'
const CAPABILITIES: PluginCapability[] = [
  'feed.read',
  'composer.insertText',
  'storage.local',
  'toast.show',
]
const SETTINGS = {maxItems: 100}

const CONTEXT = {
  uri: 'at://did:plc:alice/app.bsky.feed.post/post-one',
  cid: 'cid-post-one',
  authorDid: ALICE,
  authorHandle: 'alice.test',
  authorDisplayName: '爱丽丝',
  text: '第一条收藏正文',
  createdAt: '2026-10-31T10:00:00.000Z',
}

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

function candidate(
  overrides: Partial<BookmarkCandidate> = {},
): BookmarkCandidate {
  return {
    uri: CONTEXT.uri,
    cid: CONTEXT.cid,
    authorDid: CONTEXT.authorDid,
    authorHandle: CONTEXT.authorHandle,
    authorDisplayName: CONTEXT.authorDisplayName,
    text: CONTEXT.text,
    createdAt: CONTEXT.createdAt,
    ...overrides,
  }
}

let db: MemoryDb
let storage: PluginStorage
let toastShow: jest.Mock
let toast: PluginToast

beforeEach(() => {
  db = memoryDb()
  storage = createPluginStorage({accountDid: ALICE, pluginId: PLUGIN_ID, db})
  toastShow = jest.fn()
  toast = {show: toastShow}
})

async function flush() {
  await act(async () => {
    for (let index = 0; index < 12; index++) {
      await Promise.resolve()
    }
  })
}

function renderSlot(ui: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>)
}

async function seed(
  entries: {uri: string; text: string; savedAt: string; author?: string}[],
) {
  await storage.set(
    BOOKMARKS_STORAGE_KEY,
    serializeBookmarks(
      entries.map(entry =>
        createBookmarkItem(
          candidate({
            uri: entry.uri,
            text: entry.text,
            authorDisplayName: entry.author ?? '爱丽丝',
          }),
          entry.savedAt,
        ),
      ),
    ),
  )
}

function registry(plugins: PluginRegistryEntry[]) {
  return {
    etag: '"plugin-registry-1"',
    snapshot: {
      revision: 1,
      generatedAt: GENERATED_AT,
      plugins,
    },
  }
}

const REGISTRY_ENTRY: PluginRegistryEntry = {
  id: PLUGIN_ID,
  version: '1.0.0',
  hostApi: 2,
  platforms: ['ios', 'android', 'web'],
  capabilities: CAPABILITIES,
  settings: {maxItems: 100},
}

function resolve(plugins = [REGISTRY_ENTRY]) {
  return resolvePlugins({
    definitions: [bookmarksPlugin],
    registry: registry(plugins),
    platform: 'ios',
    accountDid: ALICE,
    createStorage: options => createPluginStorage({...options, db}),
  })
}

function renderSlotTree(plugins: ReturnType<typeof resolve>['plugins']) {
  return renderSlot(
    <PluginHostContext.Provider
      value={{
        plugins,
        platform: 'ios',
        resetKey: 'rev-1',
        reportFailure: jest.fn(),
        reportSuccess: jest.fn(),
      }}>
      <PluginSlot id="feed.item.footer" context={CONTEXT} />
    </PluginHostContext.Provider>,
  )
}

describe('bookmark feed footer', () => {
  test('saves a post, shows the saved state and confirms with a toast', async () => {
    renderSlot(
      <BookmarksFeedFooter
        context={CONTEXT}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
    await flush()

    fireEvent.press(screen.getByLabelText('收藏帖子'))
    await flush()

    expect(toastShow).toHaveBeenCalledWith('已收藏该帖子。')
    expect(screen.getByLabelText('取消收藏')).toBeTruthy()
    expect(screen.getByText('已收藏')).toBeTruthy()
    await expect(storage.get(BOOKMARKS_STORAGE_KEY)).resolves.toEqual([
      expect.objectContaining({
        uri: CONTEXT.uri,
        textExcerpt: '第一条收藏正文',
      }),
    ])
  })

  test('removes the bookmark when pressed again', async () => {
    await seed([{uri: CONTEXT.uri, text: CONTEXT.text, savedAt: GENERATED_AT}])
    renderSlot(
      <BookmarksFeedFooter
        context={CONTEXT}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
    await flush()

    fireEvent.press(screen.getByLabelText('取消收藏'))
    await flush()

    expect(toastShow).toHaveBeenCalledWith('已取消收藏。')
    expect(screen.getByLabelText('收藏帖子')).toBeTruthy()
    await expect(storage.get(BOOKMARKS_STORAGE_KEY)).resolves.toEqual([])
  })

  test('rejects a new bookmark at the limit and keeps existing data', async () => {
    const items = Array.from({length: 10}, (_, index) => ({
      uri: `at://did:plc:alice/app.bsky.feed.post/item${String(index)}`,
      text: `收藏正文 ${String(index)}`,
      savedAt: GENERATED_AT,
    }))
    await seed(items)
    renderSlot(
      <BookmarksFeedFooter
        context={CONTEXT}
        settings={{maxItems: 10}}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
    await flush()

    fireEvent.press(screen.getByLabelText('收藏帖子'))
    await flush()

    expect(toastShow).toHaveBeenCalledWith(
      '收藏数量已达上限（10 条）。请先在设置中删除部分收藏后再试。',
    )
    expect(screen.getByLabelText('收藏帖子')).toBeTruthy()
    const stored = await storage.get(BOOKMARKS_STORAGE_KEY)
    expect(stored).toHaveLength(10)
  })

  test('shows a formal message when saving fails', async () => {
    const failing: PluginStorage = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('磁盘不可用')),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      clear: () => Promise.resolve(),
    }
    renderSlot(
      <BookmarksFeedFooter
        context={CONTEXT}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage: failing, toast}}
      />,
    )
    await flush()

    fireEvent.press(screen.getByLabelText('收藏帖子'))
    await flush()

    expect(toastShow).toHaveBeenCalledWith('收藏操作失败，请稍后重试。')
    expect(screen.getByLabelText('收藏帖子')).toBeTruthy()
  })

  test('shows another account no saved state for the same post', async () => {
    await getBookmarkStore(storage).add(candidate(), 100)
    const bobStorage = createPluginStorage({
      accountDid: BOB,
      pluginId: PLUGIN_ID,
      db,
    })

    renderSlot(
      <BookmarksFeedFooter
        context={CONTEXT}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage: bobStorage, toast}}
      />,
    )
    await flush()

    expect(screen.getByLabelText('收藏帖子')).toBeTruthy()
  })
})

describe('bookmark settings section', () => {
  test('lists bookmarks newest first with the current count and limit', async () => {
    await seed([
      {
        uri: 'at://did:plc:alice/app.bsky.feed.post/older',
        text: '较早的收藏正文',
        savedAt: '2026-10-30T09:00:00.000Z',
        author: '爱丽丝',
      },
      {
        uri: 'at://did:plc:bob/app.bsky.feed.post/newer',
        text: '较新的收藏正文',
        savedAt: '2026-10-31T09:00:00.000Z',
        author: '鲍勃',
      },
    ])

    renderSlot(
      <BookmarksSettingsSection
        context={{}}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
    await flush()

    expect(screen.getByText(/已收藏 2 条，上限 100 条/)).toBeTruthy()
    const rows = screen.getAllByTestId('bookmarks-item')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('较新的收藏正文')).toBeTruthy()
    expect(within(rows[0]).getByText('鲍勃')).toBeTruthy()
    expect(within(rows[1]).getByText('较早的收藏正文')).toBeTruthy()
  })

  test('deletes one bookmark and keeps the rest', async () => {
    await seed([
      {
        uri: 'at://did:plc:alice/app.bsky.feed.post/one',
        text: '第一条',
        savedAt: GENERATED_AT,
        author: '爱丽丝',
      },
      {
        uri: 'at://did:plc:bob/app.bsky.feed.post/two',
        text: '第二条',
        savedAt: GENERATED_AT,
        author: '鲍勃',
      },
    ])
    renderSlot(
      <BookmarksSettingsSection
        context={{}}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
    await flush()

    fireEvent.press(screen.getByLabelText('删除收藏：爱丽丝'))
    await flush()

    expect(toastShow).toHaveBeenCalledWith('已删除该收藏。')
    expect(screen.queryByText('第一条')).toBeNull()
    expect(screen.getByText('第二条')).toBeTruthy()
    await expect(storage.get(BOOKMARKS_STORAGE_KEY)).resolves.toEqual([
      expect.objectContaining({
        uri: 'at://did:plc:bob/app.bsky.feed.post/two',
      }),
    ])
  })

  test('clears every bookmark after confirmation', async () => {
    await seed([
      {
        uri: 'at://did:plc:alice/app.bsky.feed.post/one',
        text: '第一条',
        savedAt: GENERATED_AT,
      },
    ])
    renderSlot(
      <BookmarksSettingsSection
        context={{}}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
    await flush()

    fireEvent.press(screen.getByLabelText('清空全部收藏'))
    expect(screen.getByText('确认清空全部收藏？此操作不可撤销。')).toBeTruthy()

    fireEvent.press(screen.getByLabelText('确认清空收藏'))
    await flush()

    expect(toastShow).toHaveBeenCalledWith('已清空全部收藏。')
    expect(screen.getByText(/暂无收藏/)).toBeTruthy()
    await expect(storage.get(BOOKMARKS_STORAGE_KEY)).resolves.toBe(undefined)
  })

  test('shows a formal empty state without placeholder data', async () => {
    renderSlot(
      <BookmarksSettingsSection
        context={{}}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
    await flush()

    expect(
      screen.getByText(
        '暂无收藏。在帖子底部点击“收藏”，即可将帖子保存在当前账号中。',
      ),
    ).toBeTruthy()
    expect(screen.queryAllByTestId('bookmarks-item')).toHaveLength(0)
  })

  test('shows a retry action when the stored data cannot be read', async () => {
    const failing: PluginStorage = {
      get: () => Promise.reject(new Error('读取失败')),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      clear: () => Promise.resolve(),
    }
    renderSlot(
      <BookmarksSettingsSection
        context={{}}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage: failing, toast}}
      />,
    )
    await flush()

    expect(screen.getByText('收藏读取失败，请稍后重试。')).toBeTruthy()
    expect(screen.getByLabelText('重新加载收藏')).toBeTruthy()
  })
})

describe('bookmark composer toolbar', () => {
  function renderToolbar(insertText: jest.Mock, closeComposer = jest.fn()) {
    return renderSlot(
      <BookmarksComposerToolbar
        context={{
          insertText,
          getText: () => '已有正文',
          closeComposer,
        }}
        settings={SETTINGS}
        capabilities={CAPABILITIES}
        host={{storage, toast}}
      />,
    )
  }

  test('inserts the plain text post link and keeps composing', async () => {
    await seed([{uri: CONTEXT.uri, text: CONTEXT.text, savedAt: GENERATED_AT}])
    const insertText = jest.fn()
    const closeComposer = jest.fn()
    renderToolbar(insertText, closeComposer)
    await flush()

    fireEvent.press(screen.getByLabelText('插入收藏'))
    fireEvent.press(screen.getByLabelText('插入收藏链接：爱丽丝'))

    expect(insertText).toHaveBeenCalledTimes(1)
    expect(insertText).toHaveBeenCalledWith(
      'https://bsky.app/profile/alice.test/post/post-one',
    )
    expect(closeComposer).not.toHaveBeenCalled()
  })

  test('explains the empty state and inserts nothing', async () => {
    const insertText = jest.fn()
    renderToolbar(insertText)
    await flush()

    fireEvent.press(screen.getByLabelText('插入收藏'))

    expect(
      screen.getByText('暂无收藏。收藏帖子后即可在发帖时插入链接。'),
    ).toBeTruthy()
    expect(insertText).not.toHaveBeenCalled()
  })
})

describe('bookmark plugin lifecycle', () => {
  test('keeps data hidden while disabled and restores it when enabled again', async () => {
    const enabled = resolve()
    expect(enabled.plugins).toHaveLength(1)

    const first = renderSlotTree(enabled.plugins)
    await flush()
    fireEvent.press(screen.getByLabelText('收藏帖子'))
    await flush()
    expect(screen.getByLabelText('取消收藏')).toBeTruthy()
    expect(await storage.get(BOOKMARKS_STORAGE_KEY)).toHaveLength(1)
    first.unmount()

    const disabled = resolve([])
    expect(disabled.plugins).toHaveLength(0)
    const hidden = renderSlotTree(disabled.plugins)
    expect(hidden.toJSON()).toBeNull()
    expect(await storage.get(BOOKMARKS_STORAGE_KEY)).toHaveLength(1)
    hidden.unmount()

    const reenabled = resolve()
    expect(reenabled.plugins).toHaveLength(1)
    renderSlotTree(reenabled.plugins)
    await flush()
    expect(screen.getByLabelText('取消收藏')).toBeTruthy()
  })
})
