import {
  createNativeFailureTracker,
  createNativePluginError,
  isNativePluginError,
  mapNativePluginError,
  NATIVE_SKIP_REASONS,
  nativeErrorMessage,
} from './errors'
import {NATIVE_PLUGIN_ERROR_CODES, type NativePluginErrorCode} from './types'

const CHINESE_TEXT = /[\u4e00-\u9fff]/

describe('native plugin errors', () => {
  test('provides a formal Chinese message for every error code', () => {
    expect(NATIVE_PLUGIN_ERROR_CODES).toHaveLength(8)
    for (const code of NATIVE_PLUGIN_ERROR_CODES) {
      const message = nativeErrorMessage(code)
      expect(message.length).toBeGreaterThan(0)
      expect(message).toMatch(CHINESE_TEXT)
    }
  })

  test('creates an error with an immutable code', () => {
    const error = createNativePluginError(
      'permission_blocked',
      '权限已被系统阻止，请前往系统设置开启后重试。',
    )
    expect(isNativePluginError(error)).toBe(true)
    expect(error.code).toBe('permission_blocked')
    expect(Object.keys(error)).toContain('code')
    expect(Object.getOwnPropertyDescriptor(error, 'code')).toMatchObject({
      writable: false,
      configurable: false,
    })
    try {
      ;(error as {code: string}).code = 'native_error'
    } catch {
      // Strict mode rejects the write; sloppy mode silently ignores it.
    }
    expect(error.code).toBe('permission_blocked')
  })

  test('keeps a known native code but replaces the original message', () => {
    const original = Object.assign(new Error('录音失败：/private/path.wav'), {
      code: 'native_error',
    })
    const mapped = mapNativePluginError(original)
    expect(mapped.code).toBe('native_error')
    expect(mapped.message).not.toContain('/private/path.wav')
    expect(mapped.message).toBe(nativeErrorMessage('native_error'))
  })

  test('maps an unknown code to native_error', () => {
    const mapped = mapNativePluginError({code: 'ERR_SOMETHING_ELSE'})
    expect(mapped.code).toBe('native_error')
  })

  test('maps non-error values to native_error without leaking them', () => {
    for (const value of [undefined, null, 'boom', 42, {reason: 'boom'}]) {
      const mapped = mapNativePluginError(value)
      expect(mapped.code).toBe('native_error')
      expect(mapped.message).not.toContain('boom')
    }
  })

  test('rejects values whose code is not part of the contract', () => {
    expect(isNativePluginError(new Error('boom'))).toBe(false)
    expect(
      isNativePluginError(
        Object.assign(new Error('boom'), {code: 'not_a_code'}),
      ),
    ).toBe(false)
  })
})

describe('native failure tracker', () => {
  test('breaks after three consecutive failures and records the skip', () => {
    let now = 100
    const tracker = createNativeFailureTracker({now: () => now++})

    expect(tracker.reportFailure('com.example.demo').broken).toBe(false)
    expect(tracker.reportFailure('com.example.demo').broken).toBe(false)
    const third = tracker.reportFailure('com.example.demo', {
      code: 'native_error',
    })

    expect(third.failures).toBe(3)
    expect(third.broken).toBe(true)
    expect(tracker.isBroken('com.example.demo')).toBe(true)
    expect(tracker.getBrokenIds()).toEqual(['com.example.demo'])
    expect(tracker.getSkips()).toEqual([
      {pluginId: 'com.example.demo', reason: 'circuit_open'},
    ])
  })

  test('a success resets the consecutive failure streak', () => {
    const tracker = createNativeFailureTracker()

    tracker.reportFailure('plugin.one')
    tracker.reportFailure('plugin.one')
    tracker.reportSuccess('plugin.one')
    tracker.reportFailure('plugin.one')
    tracker.reportFailure('plugin.one')

    expect(tracker.isBroken('plugin.one')).toBe(false)
    expect(tracker.reportFailure('plugin.one').broken).toBe(true)
  })

  test('tracks plugins independently', () => {
    const tracker = createNativeFailureTracker()

    tracker.reportFailure('plugin.one')
    tracker.reportFailure('plugin.one')
    tracker.reportFailure('plugin.two')
    tracker.reportFailure('plugin.one')

    expect(tracker.getBrokenIds()).toEqual(['plugin.one'])
    expect(tracker.isBroken('plugin.two')).toBe(false)
  })

  test('records only identifiers, codes and timestamps', () => {
    const tracker = createNativeFailureTracker({now: () => 1234})

    tracker.reportFailure('plugin.one', {
      code: 'invalid_argument',
      message: 'bad payload with token',
      payload: {token: 'secret'},
    })

    expect(tracker.getRecentErrors()).toEqual([
      {pluginId: 'plugin.one', code: 'invalid_argument', at: 1234},
    ])
    const [entry] = tracker.getRecentErrors()
    expect(Object.keys(entry).sort()).toEqual(['at', 'code', 'pluginId'])
  })

  test('caps the recent error list', () => {
    let now = 0
    const tracker = createNativeFailureTracker({
      maxRecentErrors: 3,
      now: () => now++,
    })

    for (let index = 0; index < 5; index++) {
      tracker.reportFailure(`plugin.${index}`)
    }

    expect(tracker.getRecentErrors()).toHaveLength(3)
    expect(tracker.getRecentErrors()[0]?.pluginId).toBe('plugin.4')
  })

  test('keeps the latest skip reason per plugin', () => {
    const tracker = createNativeFailureTracker()

    tracker.recordSkip('plugin.one', 'native_not_compiled')
    tracker.recordSkip('plugin.one', 'min_app_version')
    tracker.recordSkip('plugin.two', 'disabled')

    expect(tracker.getSkips()).toEqual([
      {pluginId: 'plugin.one', reason: 'min_app_version'},
      {pluginId: 'plugin.two', reason: 'disabled'},
    ])
  })

  test('accepts every published skip reason', () => {
    const tracker = createNativeFailureTracker()
    expect(NATIVE_SKIP_REASONS).toHaveLength(10)
    NATIVE_SKIP_REASONS.forEach((reason, index) => {
      tracker.recordSkip(`plugin.${index}`, reason)
    })
    expect(tracker.getSkips().map(skip => skip.reason)).toEqual([
      ...NATIVE_SKIP_REASONS,
    ])
  })

  test('reset clears failures, breaker, recent errors and skips', () => {
    const tracker = createNativeFailureTracker()

    tracker.reportFailure('plugin.one')
    tracker.reportFailure('plugin.one')
    tracker.reportFailure('plugin.one')
    tracker.recordSkip('plugin.two', 'disabled')

    tracker.reset()

    expect(tracker.isBroken('plugin.one')).toBe(false)
    expect(tracker.getBrokenIds()).toEqual([])
    expect(tracker.getRecentErrors()).toEqual([])
    expect(tracker.getSkips()).toEqual([])
    expect(tracker.reportFailure('plugin.one').failures).toBe(1)
  })
})

// Keeps the compiler honest when new codes are added to the contract.
const allCodes: Record<NativePluginErrorCode, true> = {
  permission_denied: true,
  permission_blocked: true,
  unavailable: true,
  cancelled: true,
  invalid_argument: true,
  too_large: true,
  native_error: true,
  host_shutdown: true,
}
void allCodes
