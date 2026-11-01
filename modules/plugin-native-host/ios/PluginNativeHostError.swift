import ExpoModulesCore

/**
 Failures surfaced to plugins. Error codes are fixed by the plugin host
 contract, so the derived `ERR_*` naming of `Exception` is overridden.
 */
final class PluginNativeHostError: Exception {
  init(code: String, message: String) {
    super.init(name: "PluginNativeHostError", description: message, code: code)
  }

  static func invalidArgument(_ message: String = "权限参数无效") -> PluginNativeHostError {
    return PluginNativeHostError(code: "invalid_argument", message: message)
  }

  static func unavailable(_ message: String = "当前功能不可用") -> PluginNativeHostError {
    return PluginNativeHostError(code: "unavailable", message: message)
  }

  static func nativeError(_ message: String = "系统服务暂时不可用，请稍后重试") -> PluginNativeHostError {
    return PluginNativeHostError(code: "native_error", message: message)
  }
}
