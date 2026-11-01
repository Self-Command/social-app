package expo.modules.pluginnativehost

import android.Manifest
import android.os.Build
import android.os.Bundle
import expo.modules.interfaces.permissions.Permissions
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus

/**
 * Maps the plugin permission names exposed to JavaScript to Android runtime
 * permissions and normalizes the permissions manager result.
 */
internal object PluginNativeHostPermissions {
  const val GRANTED = "granted"
  const val DENIED = "denied"
  const val BLOCKED = "blocked"
  const val UNAVAILABLE = "unavailable"
  const val NOT_DETERMINED = "notDetermined"

  private const val MICROPHONE = "microphone"
  private const val CAMERA = "camera"
  private const val PHOTO_LIBRARY = "photoLibrary"
  private const val NOTIFICATIONS = "notifications"
  private const val LOCATION_WHEN_IN_USE = "locationWhenInUse"

  /**
   * The Android permission to query, or the reason why no runtime request is
   * possible or required.
   */
  sealed class Lookup {
    data class Runtime(val permission: String) : Lookup()
    object NotRequired : Lookup()
    object Unavailable : Lookup()
    object Unknown : Lookup()
  }

  fun lookup(permission: String, manager: Permissions?): Lookup =
    when (permission) {
      MICROPHONE -> runtime(Manifest.permission.RECORD_AUDIO, manager)
      CAMERA -> runtime(Manifest.permission.CAMERA, manager)
      PHOTO_LIBRARY -> runtime(photoLibraryPermission(), manager)
      NOTIFICATIONS ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          runtime(Manifest.permission.POST_NOTIFICATIONS, manager)
        } else {
          // Notification permission does not exist before Android 13.
          Lookup.NotRequired
        }
      LOCATION_WHEN_IN_USE -> location(manager)
      else -> Lookup.Unknown
    }

  /**
   * Converts the permissions manager result into plugin status values.
   */
  fun status(result: Any?): String {
    val bundle = result as? Bundle ?: return UNAVAILABLE
    val status = bundle.getString(PermissionsResponse.STATUS_KEY)
    val granted = bundle.getBoolean(PermissionsResponse.GRANTED_KEY, false)
    val canAskAgain =
      bundle.getBoolean(PermissionsResponse.CAN_ASK_AGAIN_KEY, true)
    return when {
      granted || status == PermissionsStatus.GRANTED.status -> GRANTED
      status == PermissionsStatus.DENIED.status ->
        if (canAskAgain) DENIED else BLOCKED
      else -> NOT_DETERMINED
    }
  }

  private fun photoLibraryPermission(): String =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      Manifest.permission.READ_MEDIA_IMAGES
    } else {
      Manifest.permission.READ_EXTERNAL_STORAGE
    }

  private fun location(manager: Permissions?): Lookup {
    val permission =
      listOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
      ).firstOrNull { manager?.isPermissionPresentInManifest(it) == true }
    return if (permission == null) {
      Lookup.Unavailable
    } else {
      Lookup.Runtime(permission)
    }
  }

  private fun runtime(permission: String, manager: Permissions?): Lookup =
    if (manager?.isPermissionPresentInManifest(permission) == true) {
      Lookup.Runtime(permission)
    } else {
      Lookup.Unavailable
    }
}
