package expo.modules.pluginnativehost

import java.lang.ref.WeakReference

/**
 * Forwards whitelisted host events to the module's JavaScript listener. The
 * module registers itself on create and unregisters on destroy.
 */
object PluginNativeHostEvents {
  const val EVENT_NAME = "onHostEvent"

  private val allowedEvents =
    setOf(
      "app.foreground",
      "app.background",
      "account.changed",
      "theme.changed",
      "settings.changed",
      "capabilities.changed",
      "registry.changed",
      "permission.changed",
    )

  private var moduleRef: WeakReference<PluginNativeHostModule>? = null

  @Synchronized
  fun register(module: PluginNativeHostModule) {
    moduleRef = WeakReference(module)
  }

  @Synchronized
  fun unregister(module: PluginNativeHostModule) {
    if (moduleRef?.get() === module) {
      moduleRef = null
    }
  }

  fun emit(event: String, payload: Map<String, Any?>) {
    if (event !in allowedEvents) {
      return
    }
    val module = synchronized(this) { moduleRef?.get() } ?: return
    module.sendEvent(
      EVENT_NAME,
      mapOf(
        "event" to event,
        "payload" to payload,
      ),
    )
  }
}
