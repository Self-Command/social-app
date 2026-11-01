import {parsePluginManifest, type PluginDefinition} from '../../sdk'
import {BookmarksComposerToolbar} from './components/BookmarksComposerToolbar'
import {BookmarksFeedFooter} from './components/BookmarksFeedFooter'
import {BookmarksSettingsSection} from './components/BookmarksSettingsSection'
import manifestJson from './manifest.json'

export const BOOKMARKS_PLUGIN_ID = 'com.selfcommand.bookmarks'

export const bookmarksManifest = parsePluginManifest(manifestJson)

export const bookmarksPlugin: PluginDefinition = {
  manifest: bookmarksManifest,
  slots: {
    'composer.toolbar': BookmarksComposerToolbar,
    'feed.item.footer': BookmarksFeedFooter,
    'settings.main.section': BookmarksSettingsSection,
  },
}
