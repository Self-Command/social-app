import {bookmarksPlugin} from './com.selfcommand.bookmarks'

export {bookmarksPlugin}
export {BOOKMARKS_PLUGIN_ID} from './com.selfcommand.bookmarks'

/**
 * Plugins compiled into this build. The registry only enables or configures
 * these entries; it cannot add code.
 */
export const pluginCatalog = [bookmarksPlugin] as const
