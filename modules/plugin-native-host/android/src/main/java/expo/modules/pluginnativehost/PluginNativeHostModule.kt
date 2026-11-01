package expo.modules.pluginnativehost

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.launch

private const val CHANNEL_METADATA_KEY =
  "expo.modules.pluginnativehost.CHANNEL"
private const val DEFAULT_CHANNEL = "production"
private const val NATIVE_API_VERSION = 1
private const val INVALID_ARGUMENT = "invalid_argument"
private const val INVALID_PERMISSION_MESSAGE = "权限参数无效"
private const val SETTINGS_UNAVAILABLE_MESSAGE = "当前无法打开系统设置"

class PluginNativeHostModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("PluginNativeHost")

      Events(PluginNativeHostEvents.EVENT_NAME)

      OnCreate {
        PluginNativeHostEvents.register(this@PluginNativeHostModule)
      }

      OnDestroy {
        PluginNativeHostEvents.unregister(this@PluginNativeHostModule)
      }

      AsyncFunction("getInfo") {
        readInfo()
      }

      AsyncFunction("getPermissionStatus") {
        permission: String, promise: Promise ->
        readPermissionStatus(permission, promise)
      }

      AsyncFunction("requestPermission") {
        permission: String, promise: Promise ->
        requestPermission(permission, promise)
      }

      AsyncFunction("openSettings") { promise: Promise ->
        openAppSettings(promise)
      }

      AsyncFunction("hasView") { view: String ->
        PluginNativeHostViews.hasView(view)
      }

      View(PluginNativeView::class) {
        Events(arrayOf("onPluginEvent", "onError"))

        Prop("pluginId") { view: PluginNativeView, prop: String? ->
          view.pluginId = prop
        }

        Prop("view") { view: PluginNativeView, prop: String? ->
          view.viewName = prop
        }

        Prop("heightMode") { view: PluginNativeView, prop: String? ->
          view.heightMode = prop
        }
      }
    }

  private fun readInfo(): Map<String, Any?> {
    val context =
      appContext.reactContext?.applicationContext ?: return emptyInfo()
    val packageInfo = readPackageInfo(context)
    return mapOf(
      "nativeApi" to NATIVE_API_VERSION,
      "appVersion" to (packageInfo?.versionName ?: ""),
      "buildNumber" to readBuildNumber(packageInfo),
      "channel" to readChannel(context),
      "platform" to "android",
    )
  }

  private fun emptyInfo(): Map<String, Any?> =
    mapOf(
      "nativeApi" to NATIVE_API_VERSION,
      "appVersion" to "",
      "buildNumber" to "0",
      "channel" to DEFAULT_CHANNEL,
      "platform" to "android",
    )

  @Suppress("DEPRECATION")
  private fun readPackageInfo(context: Context): PackageInfo? =
    try {
      val packageManager = context.packageManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager.getPackageInfo(
          context.packageName,
          PackageManager.PackageInfoFlags.of(0L),
        )
      } else {
        packageManager.getPackageInfo(context.packageName, 0)
      }
    } catch (_: PackageManager.NameNotFoundException) {
      null
    }

  @Suppress("DEPRECATION")
  private fun readBuildNumber(packageInfo: PackageInfo?): String {
    if (packageInfo == null) {
      return "0"
    }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.longVersionCode.toString()
    } else {
      packageInfo.versionCode.toString()
    }
  }

  @Suppress("DEPRECATION")
  private fun readChannel(context: Context): String {
    val metaData =
      try {
        val packageManager = context.packageManager
        val flags = PackageManager.GET_META_DATA
        val applicationInfo =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getApplicationInfo(
              context.packageName,
              PackageManager.ApplicationInfoFlags.of(flags.toLong()),
            )
          } else {
            packageManager.getApplicationInfo(context.packageName, flags)
          }
        applicationInfo.metaData
      } catch (_: PackageManager.NameNotFoundException) {
        null
      }

    return metaData
      ?.getString(CHANNEL_METADATA_KEY)
      ?.takeIf { it.isNotBlank() }
      ?: DEFAULT_CHANNEL
  }

  /**
   * Queries the current status. Never requests a permission.
   */
  private fun readPermissionStatus(permission: String, promise: Promise) {
    val manager = appContext.permissions
    val lookup = PluginNativeHostPermissions.lookup(permission, manager)
    when (lookup) {
      is PluginNativeHostPermissions.Lookup.Runtime -> {
        if (manager == null) {
          promise.resolve(PluginNativeHostPermissions.UNAVAILABLE)
          return
        }
        appContext.mainQueue.launch {
          Permissions.getPermissionsWithPermissionsManager(
            manager,
            statusPromise(promise),
            lookup.permission,
          )
        }
      }
      PluginNativeHostPermissions.Lookup.NotRequired ->
        promise.resolve(PluginNativeHostPermissions.GRANTED)
      PluginNativeHostPermissions.Lookup.Unavailable ->
        promise.resolve(PluginNativeHostPermissions.UNAVAILABLE)
      PluginNativeHostPermissions.Lookup.Unknown ->
        promise.reject(INVALID_ARGUMENT, INVALID_PERMISSION_MESSAGE, null)
    }
  }

  /**
   * Requests a permission only when JavaScript explicitly calls this
   * function. The result is read back from the system, never cached here.
   */
  private fun requestPermission(permission: String, promise: Promise) {
    val manager = appContext.permissions
    val lookup = PluginNativeHostPermissions.lookup(permission, manager)
    when (lookup) {
      is PluginNativeHostPermissions.Lookup.Runtime -> {
        if (manager == null) {
          promise.resolve(PluginNativeHostPermissions.UNAVAILABLE)
          return
        }
        appContext.mainQueue.launch {
          Permissions.askForPermissionsWithPermissionsManager(
            manager,
            statusPromise(promise),
            lookup.permission,
          )
        }
      }
      PluginNativeHostPermissions.Lookup.NotRequired ->
        promise.resolve(PluginNativeHostPermissions.GRANTED)
      PluginNativeHostPermissions.Lookup.Unavailable ->
        promise.resolve(PluginNativeHostPermissions.UNAVAILABLE)
      PluginNativeHostPermissions.Lookup.Unknown ->
        promise.reject(INVALID_ARGUMENT, INVALID_PERMISSION_MESSAGE, null)
    }
  }

  private fun statusPromise(promise: Promise): Promise =
    object : Promise {
      override fun resolve(value: Any?) {
        promise.resolve(PluginNativeHostPermissions.status(value))
      }

      override fun reject(
        code: String?,
        message: String?,
        cause: Throwable?,
      ) {
        promise.reject(code, message, cause)
      }
    }

  private fun openAppSettings(promise: Promise) {
    appContext.mainQueue.launch {
      val activity = appContext.currentActivity
      val context: Context? =
        activity ?: appContext.reactContext?.applicationContext
      if (context == null) {
        promise.reject(
          PluginNativeHostPermissions.UNAVAILABLE,
          SETTINGS_UNAVAILABLE_MESSAGE,
          null,
        )
        return@launch
      }

      val intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.fromParts("package", context.packageName, null)
        }
      try {
        if (activity == null) {
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        promise.resolve()
      } catch (_: ActivityNotFoundException) {
        promise.reject(
          PluginNativeHostPermissions.UNAVAILABLE,
          SETTINGS_UNAVAILABLE_MESSAGE,
          null,
        )
      }
    }
  }
}
