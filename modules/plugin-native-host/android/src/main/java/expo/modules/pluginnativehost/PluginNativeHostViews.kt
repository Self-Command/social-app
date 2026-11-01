package expo.modules.pluginnativehost

import java.util.concurrent.ConcurrentHashMap

/**
 * Process-wide registry of native views compiled into this build. Plugin
 * modules register their views when their module definition is initialized;
 * the JavaScript host checks this registry before rendering.
 */
object PluginNativeHostViews {
  private val viewsByPlugin = ConcurrentHashMap<String, Set<String>>()

  fun register(pluginId: String, view: String) {
    if (pluginId.isBlank() || view.isBlank()) {
      return
    }
    viewsByPlugin.compute(pluginId) { _, current ->
      if (current == null) setOf(view) else current + view
    }
  }

  fun unregisterPlugin(pluginId: String) {
    viewsByPlugin.remove(pluginId)
  }

  fun hasView(view: String): Boolean =
    view.isNotBlank() && viewsByPlugin.values.any { view in it }

  fun clear() {
    viewsByPlugin.clear()
  }
}
