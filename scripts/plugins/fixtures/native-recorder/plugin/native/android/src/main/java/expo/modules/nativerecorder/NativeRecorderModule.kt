package expo.modules.nativerecorder

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NativeRecorderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NativeRecorder")

    AsyncFunction("isAvailable") {
      true
    }
  }
}
