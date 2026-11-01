import ExpoModulesCore

public class NativeRecorderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeRecorder")

    AsyncFunction("isAvailable") { () -> Bool in
      return true
    }
  }
}
