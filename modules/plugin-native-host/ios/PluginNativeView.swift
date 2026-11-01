import ExpoModulesCore
import UIKit

/**
 Host container for plugin supplied native views. The view never creates its own
 window or view controller; it renders inside the app hierarchy and follows the
 system color scheme.
 */
class PluginNativeView: ExpoView {
  var pluginId: String?
  var viewName: String?
  var heightMode: String?

  private let onPluginEvent = EventDispatcher()
  private let onError = EventDispatcher()
  private var hasLeftWindow = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .systemBackground
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    hasLeftWindow = newWindow == nil
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    let insets = safeAreaInsets
    layoutMargins = UIEdgeInsets(
      top: insets.top,
      left: insets.left,
      bottom: insets.bottom,
      right: insets.right
    )
  }

  func emitPluginEvent(event: String, payload: [String: Any]) {
    emit([
      "pluginId": pluginId ?? "",
      "event": event,
      "payload": payload
    ]) { view, body in
      view.onPluginEvent(body)
    }
  }

  func emitError(code: String, message: String) {
    emit([
      "code": code,
      "message": message
    ]) { view, body in
      view.onError(body)
    }
  }

  /// Events are only delivered while the view is mounted, so a torn down view
  /// never calls back into JavaScript.
  private func emit(_ body: [String: Any], sender: @escaping (PluginNativeView, [String: Any]) -> Void) {
    let dispatch = { [weak self] in
      guard let self, !self.hasLeftWindow else {
        return
      }
      sender(self, body)
    }

    if Thread.isMainThread {
      dispatch()
    } else {
      DispatchQueue.main.async(execute: dispatch)
    }
  }
}
