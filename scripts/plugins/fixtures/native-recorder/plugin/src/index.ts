import {parsePluginManifest, type PluginDefinition} from '../../sdk'
import manifestJson from './manifest.json'

function NativeRecorderToolbar() {
  return null
}

function NativeRecorderFeedFooter() {
  return null
}

export const nativeRecorderManifest = parsePluginManifest(manifestJson)

export const plugin: PluginDefinition = {
  manifest: nativeRecorderManifest,
  slots: {
    'composer.toolbar': NativeRecorderToolbar,
    'feed.item.footer': NativeRecorderFeedFooter,
  },
}
