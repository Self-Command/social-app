import ExpoModulesCore
import UIKit

public class PluginNativeHostModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PluginNativeHost")

    Events(["onHostEvent"])

    AsyncFunction("getInfo") { () -> [String: Any] in
      let bundle = Bundle.main
      return [
        "nativeApi": 1,
        "appVersion": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
        "buildNumber": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
        "channel": bundle.object(forInfoDictionaryKey: "PluginNativeHostChannel") as? String ?? "production",
        "platform": "ios"
      ]
    }

    AsyncFunction("getPermissionStatus") { (permission: String, promise: Promise) in
      guard let parsed = PluginNativePermission(rawValue: permission) else {
        promise.reject(PluginNativeHostError.invalidArgument())
        return
      }
      PluginNativePermissionService.shared.getStatus(parsed) { status in
        promise.resolve(status.rawValue)
      }
    }.runOnQueue(DispatchQueue.main)

    AsyncFunction("requestPermission") { (permission: String, promise: Promise) in
      guard let parsed = PluginNativePermission(rawValue: permission) else {
        promise.reject(PluginNativeHostError.invalidArgument())
        return
      }
      PluginNativePermissionService.shared.request(parsed) { result in
        switch result {
        case .success(let status):
          promise.resolve(status.rawValue)
        case .failure(let error):
          promise.reject(error)
        }
      }
    }.runOnQueue(DispatchQueue.main)

    AsyncFunction("openSettings") { (promise: Promise) in
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        promise.reject(PluginNativeHostError.unavailable("当前无法打开系统设置"))
        return
      }
      UIApplication.shared.open(url, options: [:]) { opened in
        if opened {
          promise.resolve()
        } else {
          promise.reject(PluginNativeHostError.unavailable("当前无法打开系统设置"))
        }
      }
    }.runOnQueue(DispatchQueue.main)

    AsyncFunction("hasView") { (view: String) -> Bool in
      return PluginNativeHostViews.shared.hasView(view)
    }

    View(PluginNativeView.self) {
      Events([
        "onPluginEvent",
        "onError"
      ])

      Prop("pluginId") { (view: PluginNativeView, prop: String?) in
        view.pluginId = prop
      }

      Prop("view") { (view: PluginNativeView, prop: String?) in
        view.viewName = prop
      }

      Prop("heightMode") { (view: PluginNativeView, prop: String?) in
        view.heightMode = prop
      }
    }
  }

  public override func didCreate() {
    PluginNativeHostEvents.shared.register(self)
  }

  public override func willDestroy() {
    PluginNativeHostEvents.shared.unregister(self)
  }
}
