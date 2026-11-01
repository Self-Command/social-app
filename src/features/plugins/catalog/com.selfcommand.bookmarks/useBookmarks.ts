import {useEffect, useMemo, useSyncExternalStore} from 'react'

import {type PluginStorage} from '../../sdk'
import {
  type BookmarkListState,
  type BookmarkStore,
  emptyBookmarkListState,
  getBookmarkStore,
} from './data'

const noopSubscribe = () => () => {}

export type UseBookmarksResult = {
  store: BookmarkStore | undefined
  state: BookmarkListState
}

/**
 * Subscribes a slot to the bookmark state shared by every slot of the same
 * plugin instance and account.
 */
export function useBookmarks(
  storage: PluginStorage | undefined,
): UseBookmarksResult {
  const store = useMemo(
    () => (storage ? getBookmarkStore(storage) : undefined),
    [storage],
  )
  const state = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptyBookmarkListState,
    store ? store.getSnapshot : emptyBookmarkListState,
  )

  useEffect(() => {
    if (store) void store.ensureLoaded()
  }, [store])

  return {store, state}
}
