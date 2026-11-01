import {type PluginNativeHostModule} from '../../../../modules/plugin-native-host'
import {createNativePluginError} from './errors'
import {
  NATIVE_PERMISSION_KINDS,
  NATIVE_PERMISSION_STATUSES,
  type NativePermissionApi,
  type NativePermissionKind,
  type NativePermissionStatus,
  type NativePluginError,
  type NativePluginErrorCode,
} from './types'

export type PluginPermissionHost = Pick<
  PluginNativeHostModule,
  'getPermissionStatus' | 'requestPermission' | 'openSettings'
>

function isNativePermissionKind(value: unknown): value is NativePermissionKind {
  return (
    typeof value === 'string' &&
    (NATIVE_PERMISSION_KINDS as readonly string[]).includes(value)
  )
}

function isNativePermissionStatus(
  value: unknown,
): value is NativePermissionStatus {
  return (
    typeof value === 'string' &&
    (NATIVE_PERMISSION_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * Builds the permission API for one plugin.
 *
 * The API is a thin, non-caching view over the native host: every status is
 * read from the system, and no dialog is shown until the plugin explicitly
 * calls `request`. Permissions missing from the plugin manifest are rejected
 * before the host is touched.
 */
export function createPluginPermissions(options: {
  declared: readonly NativePermissionKind[]
  host: PluginPermissionHost
  onError?: (error: NativePluginError) => void
}): NativePermissionApi {
  const declared = new Set<NativePermissionKind>(
    options.declared.filter(isNativePermissionKind),
  )

  function report(error: NativePluginError) {
    try {
      options.onError?.(error)
    } catch {
      /*
       * A failing reporter must not change the result the plugin observes.
       */
    }
  }

  function rejectPermission(
    code: NativePluginErrorCode,
    message: string,
  ): Promise<never> {
    const error = createNativePluginError(code, message)
    report(error)
    return Promise.reject(error)
  }

  async function readPermission(
    permission: NativePermissionKind,
    read: (kind: NativePermissionKind) => Promise<unknown>,
  ): Promise<NativePermissionStatus> {
    if (!isNativePermissionKind(permission)) {
      return rejectPermission(
        'invalid_argument',
        '系统不支持该权限类型，本次请求已被拒绝。',
      )
    }

    if (!declared.has(permission)) {
      return rejectPermission(
        'permission_denied',
        '该权限未在插件清单中声明，无法使用。',
      )
    }

    let status: unknown
    try {
      status = await read(permission)
    } catch {
      return rejectPermission(
        'native_error',
        '系统权限服务暂时不可用，请稍后重试。',
      )
    }

    if (!isNativePermissionStatus(status)) {
      return rejectPermission(
        'unavailable',
        '系统返回的权限状态无法识别，本次请求已结束。',
      )
    }

    return status
  }

  return {
    getStatus(permission) {
      return readPermission(permission, kind =>
        options.host.getPermissionStatus(kind),
      )
    },

    request(permission) {
      return readPermission(permission, kind =>
        options.host.requestPermission(kind),
      )
    },

    async openSettings() {
      try {
        await options.host.openSettings()
      } catch {
        return rejectPermission('unavailable', '无法打开系统设置，请稍后重试。')
      }
    },
  }
}
