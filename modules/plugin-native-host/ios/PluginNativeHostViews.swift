import Foundation

/**
 Registry of native views compiled into this app build. Plugin modules call
 `register` while their `ModuleDefinition` is created; the host queries the
 registry before rendering a `pluginId` + `view` pair.
 */
public final class PluginNativeHostViews {
  public static let shared = PluginNativeHostViews()

  private let queue = DispatchQueue(label: "app.bluesky.pluginNativeHost.views")
  private var viewsByPlugin: [String: Set<String>] = [:]

  private init() {}

  public func register(pluginId: String, view: String) {
    guard !pluginId.isEmpty, !view.isEmpty else {
      return
    }
    queue.sync {
      viewsByPlugin[pluginId, default: []].insert(view)
    }
  }

  public func unregisterPlugin(pluginId: String) {
    guard !pluginId.isEmpty else {
      return
    }
    queue.sync {
      viewsByPlugin[pluginId] = nil
    }
  }

  public func hasView(_ view: String) -> Bool {
    guard !view.isEmpty else {
      return false
    }
    return queue.sync {
      viewsByPlugin.values.contains { registeredViews in
        registeredViews.contains(view)
      }
    }
  }

  public func clear() {
    queue.sync {
      viewsByPlugin.removeAll()
    }
  }
}
