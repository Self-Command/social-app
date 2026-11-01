import {
  NATIVE_PLUGIN_ERROR_CODES,
  type NativePluginError,
  type NativePluginErrorCode,
} from './types'

/**
 * Skip reasons reported for native plugins. They are diagnostic only and are
 * never shown to ordinary users as dialogs.
 */
export const NATIVE_SKIP_REASONS = [
  'native_api_mismatch',
  'host_api_mismatch',
  'manifest_mismatch',
  'native_not_compiled',
  'native_module_missing',
  'native_view_missing',
  'min_app_version',
  'revoked',
  'disabled',
  'circuit_open',
] as const
export type NativeSkipReason = (typeof NATIVE_SKIP_REASONS)[number]

export const NATIVE_FAILURE_THRESHOLD = 3
export const MAX_RECENT_NATIVE_ERRORS = 20

export type NativePluginSkip = {
  readonly pluginId: string
  readonly reason: NativeSkipReason
}

export type RecentNativeError = {
  readonly pluginId: string
  readonly code: NativePluginErrorCode
  readonly at: number
}

const ERROR_MESSAGES: Record<NativePluginErrorCode, string> = {
  permission_denied: '未获得所需权限，无法继续操作。',
  permission_blocked: '权限已被系统阻止，请前往系统设置开启后重试。',
  unavailable: '当前功能不可用，请稍后重试。',
  cancelled: '操作已取消。',
  invalid_argument: '请求参数无效，无法继续操作。',
  too_large: '内容超出允许的大小，请调整后重试。',
  native_error: '系统服务暂时不可用，请稍后重试。',
  host_shutdown: '插件服务已关闭，无法继续操作。',
}

export function nativeErrorMessage(code: NativePluginErrorCode): string {
  return ERROR_MESSAGES[code]
}

function isErrorCode(value: unknown): value is NativePluginErrorCode {
  return (
    typeof value === 'string' &&
    (NATIVE_PLUGIN_ERROR_CODES as readonly string[]).includes(value)
  )
}

/**
 * Creates a plugin-facing error with a stable code and a formal Chinese
 * message.
 *
 * Callers must keep messages free of payloads, tokens and account
 * identifiers; the code is what plugins branch on.
 */
export function createNativePluginError(
  code: NativePluginErrorCode,
  message: string,
): NativePluginError {
  const error = new Error(message) as NativePluginError
  error.name = 'NativePluginError'
  Object.defineProperty(error, 'code', {
    value: code,
    enumerable: true,
    writable: false,
    configurable: false,
  })
  return error
}

/**
 * Narrows unknown thrown values to errors created by the native host. Errors
 * from other sources keep their original semantics.
 */
export function isNativePluginError(
  value: unknown,
): value is NativePluginError {
  if (!(value instanceof Error)) return false
  return isErrorCode((value as {code?: unknown}).code)
}

/**
 * Maps anything a native module or plugin handler may throw onto the fixed
 * error codes. Original messages are never forwarded because they can carry
 * input payloads; the plugin receives a stable code and a formal message.
 */
export function mapNativePluginError(value: unknown): NativePluginError {
  const rawCode =
    typeof value === 'object' && value !== null
      ? (value as {code?: unknown}).code
      : undefined
  const code = isErrorCode(rawCode) ? rawCode : 'native_error'
  return createNativePluginError(code, nativeErrorMessage(code))
}

export type NativeFailureTracker = {
  reportFailure: (
    pluginId: string,
    error?: unknown,
  ) => {failures: number; broken: boolean; error: NativePluginError}
  reportSuccess: (pluginId: string) => void
  recordSkip: (pluginId: string, reason: NativeSkipReason) => void
  isBroken: (pluginId: string) => boolean
  getBrokenIds: () => readonly string[]
  getRecentErrors: () => readonly RecentNativeError[]
  getSkips: () => readonly NativePluginSkip[]
  reset: () => void
}

/**
 * Tracks consecutive failures, skip reasons and the recent error codes used
 * by the developer tools. Only identifiers, codes and timestamps are kept;
 * payloads, audio, images and account data never enter the tracker.
 */
export function createNativeFailureTracker(
  options: {
    threshold?: number
    maxRecentErrors?: number
    now?: () => number
  } = {},
): NativeFailureTracker {
  const threshold = options.threshold ?? NATIVE_FAILURE_THRESHOLD
  const maxRecentErrors = options.maxRecentErrors ?? MAX_RECENT_NATIVE_ERRORS
  const now = options.now ?? Date.now

  const failures = new Map<string, number>()
  const broken = new Set<string>()
  const recentErrors: RecentNativeError[] = []
  const skips = new Map<string, NativeSkipReason>()

  return {
    reportFailure(pluginId, error) {
      const mapped = mapNativePluginError(error)
      const count = (failures.get(pluginId) ?? 0) + 1
      failures.set(pluginId, count)

      recentErrors.unshift({pluginId, code: mapped.code, at: now()})
      if (recentErrors.length > maxRecentErrors) {
        recentErrors.length = maxRecentErrors
      }

      const isBroken = count >= threshold
      if (isBroken) {
        broken.add(pluginId)
        skips.set(pluginId, 'circuit_open')
      }
      return {failures: count, broken: isBroken, error: mapped}
    },

    reportSuccess(pluginId) {
      failures.delete(pluginId)
    },

    recordSkip(pluginId, reason) {
      skips.set(pluginId, reason)
    },

    isBroken(pluginId) {
      return broken.has(pluginId)
    },

    getBrokenIds() {
      return [...broken]
    },

    getRecentErrors() {
      return [...recentErrors]
    },

    getSkips() {
      return [...skips].map(([pluginId, reason]) => ({pluginId, reason}))
    },

    /**
     * Clears every derived state. Called when the registry revision changes,
     * the account switches or the app restarts.
     */
    reset() {
      failures.clear()
      broken.clear()
      recentErrors.length = 0
      skips.clear()
    },
  }
}
