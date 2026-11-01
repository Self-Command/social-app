import {type JsonValue, type PluginStorage} from '../../sdk'

export const BOOKMARKS_STORAGE_KEY = 'items'
export const BOOKMARK_EXCERPT_MAX = 200
export const BOOKMARKS_DEFAULT_MAX_ITEMS = 100
export const BOOKMARKS_MIN_MAX_ITEMS = 10
export const BOOKMARKS_MAX_MAX_ITEMS = 500

export type BookmarkItem = {
  uri: string
  cid: string
  authorDid: string
  authorHandle: string
  authorDisplayName?: string
  textExcerpt: string
  createdAt: string
  savedAt: string
}

export type BookmarkCandidate = {
  uri: string
  cid: string
  authorDid: string
  authorHandle: string
  authorDisplayName?: string
  text: string
  createdAt: string
}

export function toBookmarkExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > BOOKMARK_EXCERPT_MAX
    ? normalized.slice(0, BOOKMARK_EXCERPT_MAX)
    : normalized
}

export function createBookmarkItem(
  candidate: BookmarkCandidate,
  savedAt: string,
): BookmarkItem {
  const item: BookmarkItem = {
    uri: candidate.uri,
    cid: candidate.cid,
    authorDid: candidate.authorDid,
    authorHandle: candidate.authorHandle,
    textExcerpt: toBookmarkExcerpt(candidate.text),
    createdAt: candidate.createdAt,
    savedAt,
  }
  if (candidate.authorDisplayName) {
    item.authorDisplayName = candidate.authorDisplayName
  }
  return item
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isJsonRecord(value: JsonValue): value is {[key: string]: JsonValue} {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBookmarkItem(value: JsonValue): BookmarkItem | undefined {
  if (!isJsonRecord(value)) return undefined
  const {
    uri,
    cid,
    authorDid,
    authorHandle,
    authorDisplayName,
    textExcerpt,
    createdAt,
    savedAt,
  } = value
  if (
    !isNonEmptyString(uri) ||
    !isNonEmptyString(cid) ||
    !isNonEmptyString(authorDid) ||
    !isNonEmptyString(authorHandle) ||
    typeof textExcerpt !== 'string' ||
    !isNonEmptyString(createdAt) ||
    !isNonEmptyString(savedAt)
  ) {
    return undefined
  }
  const item: BookmarkItem = {
    uri,
    cid,
    authorDid,
    authorHandle,
    textExcerpt: toBookmarkExcerpt(textExcerpt),
    createdAt,
    savedAt,
  }
  if (isNonEmptyString(authorDisplayName)) {
    item.authorDisplayName = authorDisplayName
  }
  return item
}

export function sortBookmarks(items: readonly BookmarkItem[]): BookmarkItem[] {
  return [...items].sort((a, b) => {
    if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1
    if (a.uri === b.uri) return 0
    return a.uri < b.uri ? -1 : 1
  })
}

export function parseStoredBookmarks(
  value: JsonValue | undefined,
): BookmarkItem[] {
  if (!Array.isArray(value)) return []
  const items: BookmarkItem[] = []
  for (const entry of value) {
    const item = parseBookmarkItem(entry)
    if (item) items.push(item)
  }
  return sortBookmarks(items)
}

export function serializeBookmarks(items: readonly BookmarkItem[]): JsonValue {
  return items as unknown as JsonValue
}

export function readMaxItems(settings: {
  readonly maxItems?: string | number | boolean
}): number {
  const value = settings.maxItems
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return BOOKMARKS_DEFAULT_MAX_ITEMS
  }
  return Math.min(
    BOOKMARKS_MAX_MAX_ITEMS,
    Math.max(BOOKMARKS_MIN_MAX_ITEMS, Math.floor(value)),
  )
}

const POST_URI_PATTERN =
  /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/

export function postRkey(uri: string): string | undefined {
  return POST_URI_PATTERN.exec(uri)?.[1]
}

export function bookmarksPostLink(item: {
  uri: string
  authorHandle: string
}): string | undefined {
  const rkey = postRkey(item.uri)
  if (!rkey || item.authorHandle.length === 0) return undefined
  return `https://bsky.app/profile/${encodeURIComponent(
    item.authorHandle,
  )}/post/${rkey}`
}

export function formatSavedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function bookmarkAuthorName(item: BookmarkItem): string {
  if (item.authorDisplayName && item.authorDisplayName.length > 0) {
    return item.authorDisplayName
  }
  return `@${item.authorHandle}`
}

export type BookmarkListState = {
  status: 'loading' | 'ready' | 'error'
  items: readonly BookmarkItem[]
}

export type AddBookmarkResult = 'added' | 'exists' | 'limit'

const EMPTY_STATE: BookmarkListState = Object.freeze({
  status: 'loading',
  items: [],
})

export function emptyBookmarkListState(): BookmarkListState {
  return EMPTY_STATE
}

/**
 * Per-storage bookmark state shared by the three slots of one plugin instance.
 * Writes are serialized read-modify-write cycles over a single storage key.
 */
export class BookmarkStore {
  private state: BookmarkListState = EMPTY_STATE
  private readonly listeners = new Set<() => void>()
  private loadPromise: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: PluginStorage) {}

  getSnapshot = (): BookmarkListState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.reload()
    }
    return this.loadPromise
  }

  async reload(): Promise<void> {
    try {
      const raw = await this.storage.get(BOOKMARKS_STORAGE_KEY)
      this.setState({status: 'ready', items: parseStoredBookmarks(raw)})
    } catch {
      this.setState({status: 'error', items: []})
    }
  }

  add(
    candidate: BookmarkCandidate,
    maxItems: number,
  ): Promise<AddBookmarkResult> {
    return this.enqueue(async () => {
      await this.requireReady()
      const items = this.state.items
      if (items.some(item => item.uri === candidate.uri)) return 'exists'
      if (items.length >= maxItems) return 'limit'

      const next = sortBookmarks([
        createBookmarkItem(candidate, new Date().toISOString()),
        ...items,
      ])
      await this.storage.set(BOOKMARKS_STORAGE_KEY, serializeBookmarks(next))
      this.setState({status: 'ready', items: next})
      return 'added'
    })
  }

  remove(uri: string): Promise<void> {
    return this.enqueue(async () => {
      await this.requireReady()
      const next = this.state.items.filter(item => item.uri !== uri)
      if (next.length === this.state.items.length) return
      await this.storage.set(BOOKMARKS_STORAGE_KEY, serializeBookmarks(next))
      this.setState({status: 'ready', items: next})
    })
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.requireReady()
      await this.storage.remove(BOOKMARKS_STORAGE_KEY)
      this.setState({status: 'ready', items: []})
    })
  }

  private async requireReady(): Promise<void> {
    await this.ensureLoaded()
    if (this.state.status !== 'ready') {
      await this.reload()
    }
    if (this.state.status !== 'ready') {
      throw new Error('收藏数据暂时不可用')
    }
  }

  private setState(next: BookmarkListState) {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

const stores = new WeakMap<PluginStorage, BookmarkStore>()

export function getBookmarkStore(storage: PluginStorage): BookmarkStore {
  let store = stores.get(storage)
  if (!store) {
    store = new BookmarkStore(storage)
    stores.set(storage, store)
  }
  return store
}
