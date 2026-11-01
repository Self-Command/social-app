import {
  NATIVE_DEACTIVATE_REASONS,
  NATIVE_HOST_EVENTS,
  NATIVE_PERMISSION_KINDS,
  NATIVE_PERMISSION_STATUSES,
  NATIVE_PLUGIN_ERROR_CODES,
  NATIVE_PRESENTATION_MODES,
  NATIVE_SHEET_DETENTS,
  type NativeDeactivateReason,
  type NativeHostEvent,
  type NativePermissionKind,
  type NativePermissionStatus,
  type NativePluginContext,
  type NativePluginErrorCode,
  type NativePluginLifecycle,
  type NativePluginSurfaceProps,
  type NativePluginViewProps,
  type NativePresentationMode,
  type NativeSheetDetent,
  type PluginNativeHost,
} from './types'

const permissionKinds: Record<NativePermissionKind, true> = {
  microphone: true,
  camera: true,
  photoLibrary: true,
  notifications: true,
  locationWhenInUse: true,
}

const permissionStatuses: Record<NativePermissionStatus, true> = {
  granted: true,
  denied: true,
  blocked: true,
  limited: true,
  unavailable: true,
  notDetermined: true,
}

const deactivateReasons: Record<NativeDeactivateReason, true> = {
  app_background: true,
  account_changed: true,
  signed_out: true,
  disabled: true,
  revoked: true,
  registry_changed: true,
  host_shutdown: true,
}

const hostEvents: Record<NativeHostEvent, true> = {
  'app.foreground': true,
  'app.background': true,
  'account.changed': true,
  'theme.changed': true,
  'settings.changed': true,
  'capabilities.changed': true,
  'registry.changed': true,
  'permission.changed': true,
}

const errorCodes: Record<NativePluginErrorCode, true> = {
  permission_denied: true,
  permission_blocked: true,
  unavailable: true,
  cancelled: true,
  invalid_argument: true,
  too_large: true,
  native_error: true,
  host_shutdown: true,
}

const presentationModes: Record<NativePresentationMode, true> = {
  sheet: true,
  fullscreen: true,
}

const sheetDetents: Record<NativeSheetDetent, true> = {
  medium: true,
  large: true,
}

function context(
  overrides: Partial<NativePluginContext> = {},
): NativePluginContext {
  return {
    pluginId: 'com.example.demo',
    nativeApi: 1,
    appVersion: '2.0.0',
    buildNumber: '200',
    channel: 'enterprise',
    platform: 'ios',
    settings: {},
    capabilities: ['native.host'],
    permissions: ['microphone'],
    ...overrides,
  }
}

describe('native contract enumerations', () => {
  test('exposes every declared value with no duplicates', () => {
    const tables: Array<[readonly string[], Readonly<Record<string, true>>]> = [
      [NATIVE_PERMISSION_KINDS, permissionKinds],
      [NATIVE_PERMISSION_STATUSES, permissionStatuses],
      [NATIVE_DEACTIVATE_REASONS, deactivateReasons],
      [NATIVE_HOST_EVENTS, hostEvents],
      [NATIVE_PLUGIN_ERROR_CODES, errorCodes],
      [NATIVE_PRESENTATION_MODES, presentationModes],
      [NATIVE_SHEET_DETENTS, sheetDetents],
    ]

    for (const [values, table] of tables) {
      expect(new Set(values).size).toBe(values.length)
      expect([...values].sort()).toEqual(Object.keys(table).sort())
    }
  })

  test('pins the published contract sizes', () => {
    expect(NATIVE_PERMISSION_KINDS).toHaveLength(5)
    expect(NATIVE_PERMISSION_STATUSES).toHaveLength(6)
    expect(NATIVE_DEACTIVATE_REASONS).toHaveLength(7)
    expect(NATIVE_HOST_EVENTS).toHaveLength(8)
    expect(NATIVE_PLUGIN_ERROR_CODES).toHaveLength(8)
  })
})

describe('native host interfaces', () => {
  test('a lifecycle implementation covers every hook', async () => {
    const calls: string[] = []
    const lifecycle: NativePluginLifecycle = {
      activate: value => {
        calls.push(`activate:${value.nativeApi}`)
      },
      deactivate: reason => {
        calls.push(`deactivate:${reason}`)
      },
      settingsChanged: settings => {
        calls.push(`settings:${String(settings.mode)}`)
      },
      capabilitiesChanged: capabilities => {
        calls.push(`capabilities:${capabilities.length}`)
      },
      appStateChanged: state => {
        calls.push(`appState:${state}`)
      },
      dispose: () => {
        calls.push('dispose')
      },
    }

    await lifecycle.activate(context())
    void lifecycle.deactivate('app_background')
    void lifecycle.settingsChanged({mode: 'compact'})
    void lifecycle.capabilitiesChanged(['native.ui'])
    void lifecycle.appStateChanged('background')
    void lifecycle.dispose()

    expect(calls).toEqual([
      'activate:1',
      'deactivate:app_background',
      'settings:compact',
      'capabilities:1',
      'appState:background',
      'dispose',
    ])
  })

  test('host capability groups are omitted rather than stubbed', () => {
    const host: PluginNativeHost = {}
    expect(host.info).toBeUndefined()
    expect(host.permissions).toBeUndefined()
    expect(host.ui).toBeUndefined()
    expect(host.events).toBeUndefined()
  })

  test('permission and event calls follow the contract', async () => {
    const received: string[] = []
    const host: PluginNativeHost = {
      info: {
        nativeApi: 1,
        appVersion: '2.0.0',
        buildNumber: '200',
        channel: 'enterprise',
        platform: 'android',
      },
      permissions: {
        getStatus: permission => {
          received.push(`status:${permission}`)
          return Promise.resolve<NativePermissionStatus>('notDetermined')
        },
        request: permission => {
          received.push(`request:${permission}`)
          return Promise.resolve<NativePermissionStatus>('granted')
        },
        openSettings: () => {
          received.push('openSettings')
          return Promise.resolve()
        },
      },
      ui: {
        present: (view, props, options) => {
          const maxDurationSeconds = props?.maxDurationSeconds
          received.push(
            `present:${view}:${
              typeof maxDurationSeconds === 'number' ? maxDurationSeconds : 0
            }:${options?.mode ?? 'sheet'}`,
          )
          return Promise.resolve()
        },
        dismiss: view => {
          received.push(`dismiss:${view ?? 'all'}`)
          return Promise.resolve()
        },
      },
      events: {
        subscribe: (event, handler) => {
          received.push(`subscribe:${event}`)
          if (event === 'permission.changed') {
            // The mock implements the generic subscribe signature; the event
            // name above narrows the payload this handler expects at runtime.
            const emit = handler as (payload: {
              permission: NativePermissionKind
              status: NativePermissionStatus
            }) => void
            emit({permission: 'camera', status: 'granted'})
          }
          return () => {
            received.push(`unsubscribe:${event}`)
          }
        },
      },
    }

    await expect(host.permissions?.getStatus('microphone')).resolves.toBe(
      'notDetermined',
    )
    await expect(host.permissions?.request('microphone')).resolves.toBe(
      'granted',
    )
    await host.permissions?.openSettings()
    await host.ui?.present(
      'VoiceRecorderView',
      {maxDurationSeconds: 60},
      {
        mode: 'fullscreen',
        title: '语音评论',
      },
    )
    await host.ui?.dismiss('VoiceRecorderView')
    const unsubscribe = host.events?.subscribe(
      'permission.changed',
      payload => {
        received.push(`event:${payload.permission}:${payload.status}`)
      },
    )
    unsubscribe?.()

    expect(received).toEqual([
      'status:microphone',
      'request:microphone',
      'openSettings',
      'present:VoiceRecorderView:60:fullscreen',
      'dismiss:VoiceRecorderView',
      'subscribe:permission.changed',
      'event:camera:granted',
      'unsubscribe:permission.changed',
    ])
  })

  test('container props carry view identity and diagnostics only', () => {
    const view: NativePluginViewProps = {
      pluginId: 'com.example.demo',
      view: 'DemoView',
      heightMode: 'content',
      props: {prompt: '轻触开始录音'},
      onError: (code, message) => {
        expect(code).toBe('native_error')
        expect(message).toBe('系统服务暂时不可用，请稍后重试。')
      },
    }
    const surface: NativePluginSurfaceProps = {
      ...view,
      visible: true,
      presentation: {mode: 'sheet', detents: ['medium', 'large']},
      onDismiss: () => {},
    }

    view.onError?.('native_error', '系统服务暂时不可用，请稍后重试。')
    expect(surface.visible).toBe(true)
    expect(surface.presentation?.detents).toEqual(['medium', 'large'])
  })
})
