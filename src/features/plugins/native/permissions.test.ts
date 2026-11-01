import {isNativePluginError} from './errors'
import {createPluginPermissions} from './permissions'
import {
  NATIVE_PERMISSION_KINDS,
  NATIVE_PERMISSION_STATUSES,
  type NativePermissionKind,
  type NativePermissionStatus,
  type NativePluginError,
} from './types'

const CHINESE_TEXT = /[\u4e00-\u9fff]/

function createHost() {
  return {
    getPermissionStatus: jest
      .fn<Promise<NativePermissionStatus>, [NativePermissionKind]>()
      .mockResolvedValue('granted'),
    requestPermission: jest
      .fn<Promise<NativePermissionStatus>, [NativePermissionKind]>()
      .mockResolvedValue('granted'),
    openSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  }
}

async function captureRejection(
  promise: Promise<unknown>,
): Promise<NativePluginError> {
  try {
    await promise
  } catch (error) {
    if (!isNativePluginError(error)) {
      throw new Error('expected a NativePluginError rejection')
    }
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('plugin native permissions', () => {
  test('passes through all six host statuses without caching', async () => {
    const host = createHost()
    const onError = jest.fn()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
      onError,
    })

    for (const status of NATIVE_PERMISSION_STATUSES) {
      host.getPermissionStatus.mockResolvedValueOnce(status)
      await expect(permissions.getStatus('camera')).resolves.toBe(status)
    }

    expect(host.getPermissionStatus).toHaveBeenCalledTimes(
      NATIVE_PERMISSION_STATUSES.length,
    )
    expect(onError).not.toHaveBeenCalled()
  })

  test('queries the host on every read', async () => {
    const host = createHost()
    const permissions = createPluginPermissions({
      declared: ['microphone'],
      host,
    })

    await permissions.getStatus('microphone')
    await permissions.getStatus('microphone')

    expect(host.getPermissionStatus).toHaveBeenCalledTimes(2)
    expect(host.getPermissionStatus).toHaveBeenNthCalledWith(1, 'microphone')
    expect(host.getPermissionStatus).toHaveBeenNthCalledWith(2, 'microphone')
  })

  test('does not request or query anything when the API is created', () => {
    const host = createHost()

    createPluginPermissions({declared: NATIVE_PERMISSION_KINDS, host})

    expect(host.requestPermission).not.toHaveBeenCalled()
    expect(host.getPermissionStatus).not.toHaveBeenCalled()
  })

  test('requests only when explicitly called and returns the real status', async () => {
    const host = createHost()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
    })
    host.requestPermission.mockResolvedValueOnce('granted')

    await expect(permissions.request('microphone')).resolves.toBe('granted')

    expect(host.requestPermission).toHaveBeenCalledTimes(1)
    expect(host.requestPermission).toHaveBeenCalledWith('microphone')
    expect(host.getPermissionStatus).not.toHaveBeenCalled()
  })

  test('returns blocked without asking the host a second time', async () => {
    const host = createHost()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
    })
    host.requestPermission.mockResolvedValueOnce('blocked')

    await expect(permissions.request('camera')).resolves.toBe('blocked')

    expect(host.requestPermission).toHaveBeenCalledTimes(1)
    expect(host.getPermissionStatus).not.toHaveBeenCalled()
  })

  test('rejects an undeclared permission without calling the host', async () => {
    const host = createHost()
    const onError = jest.fn()
    const permissions = createPluginPermissions({
      declared: ['camera'],
      host,
      onError,
    })

    const error = await captureRejection(permissions.getStatus('microphone'))

    expect(error.code).toBe('permission_denied')
    expect(error.message).toMatch(CHINESE_TEXT)
    expect(host.getPermissionStatus).not.toHaveBeenCalled()
    expect(host.requestPermission).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
  })

  test('rejects an undeclared request without showing a system dialog', async () => {
    const host = createHost()
    const onError = jest.fn()
    const permissions = createPluginPermissions({
      declared: ['camera'],
      host,
      onError,
    })

    const error = await captureRejection(permissions.request('microphone'))

    expect(error.code).toBe('permission_denied')
    expect(host.requestPermission).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test('rejects an unknown permission kind as invalid_argument', async () => {
    const host = createHost()
    const onError = jest.fn()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
      onError,
    })

    const error = await captureRejection(
      permissions.getStatus('contacts' as NativePermissionKind),
    )

    expect(error.code).toBe('invalid_argument')
    expect(error.message).toMatch(CHINESE_TEXT)
    expect(host.getPermissionStatus).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
  })

  test('rejects an unknown permission kind on request too', async () => {
    const host = createHost()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
    })

    const error = await captureRejection(
      permissions.request('calendar' as NativePermissionKind),
    )

    expect(error.code).toBe('invalid_argument')
    expect(host.requestPermission).not.toHaveBeenCalled()
  })

  test('treats an unknown host status as unavailable and reports it', async () => {
    const host = createHost()
    const onError = jest.fn()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
      onError,
    })
    host.getPermissionStatus.mockResolvedValueOnce(
      'maybe' as NativePermissionStatus,
    )

    const error = await captureRejection(permissions.getStatus('photoLibrary'))

    expect(error.code).toBe('unavailable')
    expect(error.message).toMatch(CHINESE_TEXT)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
  })

  test('maps a failing host read to native_error without leaking details', async () => {
    const host = createHost()
    const onError = jest.fn()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
      onError,
    })
    host.getPermissionStatus.mockRejectedValueOnce(
      new Error('native stack detail'),
    )

    const error = await captureRejection(permissions.getStatus('camera'))

    expect(error.code).toBe('native_error')
    expect(error.message).toMatch(CHINESE_TEXT)
    expect(error.message).not.toContain('native stack detail')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
  })

  test('opens system settings through the host', async () => {
    const host = createHost()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
    })

    await expect(permissions.openSettings()).resolves.toBeUndefined()

    expect(host.openSettings).toHaveBeenCalledTimes(1)
  })

  test('maps an openSettings failure to unavailable and reports it', async () => {
    const host = createHost()
    const onError = jest.fn()
    const permissions = createPluginPermissions({
      declared: NATIVE_PERMISSION_KINDS,
      host,
      onError,
    })
    host.openSettings.mockRejectedValueOnce(new Error('activity missing'))

    const error = await captureRejection(permissions.openSettings())

    expect(error.code).toBe('unavailable')
    expect(error.message).toMatch(CHINESE_TEXT)
    expect(error.message).not.toContain('activity missing')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
  })
})
