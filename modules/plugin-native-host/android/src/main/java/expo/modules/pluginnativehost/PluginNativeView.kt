package expo.modules.pluginnativehost

import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class PluginNativeView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  var pluginId: String? = null
  var viewName: String? = null
  var heightMode: String? = null

  private val onPluginEvent by EventDispatcher()
  private val onError by EventDispatcher()

  /**
   * Sends a plugin event to the JavaScript container. Events without a plugin
   * id are dropped; the container owns validation and error state.
   */
  fun emitPluginEvent(event: String, payload: Map<String, Any?>) {
    val id = pluginId
    if (id.isNullOrBlank() || event.isBlank()) {
      return
    }
    onPluginEvent(
      mapOf(
        "pluginId" to id,
        "event" to event,
        "payload" to payload,
      ),
    )
  }

  fun emitError(code: String, message: String) {
    onError(
      mapOf(
        "code" to code,
        "message" to message,
      ),
    )
  }
}
