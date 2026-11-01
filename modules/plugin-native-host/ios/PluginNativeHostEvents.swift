import Foundation

/// Host events a plugin is allowed to observe. Everything else is dropped.
private let allowedHostEventNames: Set<String> = [
  "app.foreground",
  "app.background",
  "account.changed",
  "theme.changed",
  "settings.changed",
  "capabilities.changed",
  "registry.changed",
  "permission.changed"
]

/**
 Forwards host events to the live module instance. The module registers itself
 on creation and unregisters on destruction so no event reaches JavaScript after
 the bridge is torn down.
 */
public final class PluginNativeHostEvents {
  public static let shared = PluginNativeHostEvents()

  private let lock = NSLock()
  private weak var module: PluginNativeHostModule?

  private init() {}

  func register(_ module: PluginNativeHostModule) {
    lock.lock()
    self.module = module
    lock.unlock()
  }

  func unregister(_ module: PluginNativeHostModule) {
    lock.lock()
    if self.module === module {
      self.module = nil
    }
    lock.unlock()
  }

  public func emit(event: String, payload: [String: Any?]) {
    guard allowedHostEventNames.contains(event) else {
      return
    }

    let compactedPayload: [String: Any] = payload.compactMapValues { value in value }

    lock.lock()
    let target = module
    lock.unlock()

    target?.sendEvent("onHostEvent", [
      "event": event,
      "payload": compactedPayload
    ])
  }
}
