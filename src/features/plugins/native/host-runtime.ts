import {pluginLogger, summarizeError} from '../runtime/log'
import {type PluginCapability, type PluginSettingsValues} from '../sdk/types'
import {
  createNativeFailureTracker,
  type NativeFailureTracker,
  type NativePluginSkip,
  type RecentNativeError,
} from './errors'
import {
  createNativeEventBus,
  createPluginEvents,
  type NativeEventBus,
  type PluginEventsApi,
} from './events'
import {NATIVE_LOCK_VERSION, type NativePluginLock} from './lock'
import {createPluginPermissions, type PluginPermissionHost} from './permissions'
import {type NativePluginRegistryEntry} from './registry'
import {createNativeSurfaceManager} from './surface-manager'
import {
  type NativeAppState,
  type NativeDeactivateReason,
  type NativeEventsApi,
  type NativeHostInfo,
  type NativePermissionApi,
  type NativePermissionKind,
  type NativePluginContext,
  type NativePluginLifecycle,
  type NativeUiApi,
  type PluginNativeHost,
} from './types'

export const NATIVE_LIFECYCLE_TIMEOUT_MS = 2000

export type NativeSyncPlugin = {
  readonly pluginId: string
  readonly lifecycle: Partial<NativePluginLifecycle>
  readonly settings: PluginSettingsValues
  readonly capabilities: readonly PluginCapability[]
  readonly permissions: readonly NativePermissionKind[]
}

export type NativeHostRuntimeOptions = {
  nativeRegistry: readonly NativePluginRegistryEntry[]
  nativeLock?: NativePluginLock
  hostInfo: NativeHostInfo
  permissionHost?: PluginPermissionHost
  now?: () => number
}

export type NativeSyncOptions = {
  plugins: readonly NativeSyncPlugin[]
  accountDid: string | undefined
  revision: number
  appState: NativeAppState
  skips?: readonly NativePluginSkip[]
  /**
   * Deactivation reason for plugins that disappeared from the resolved list.
   * Native gate failures are reported as `disabled`.
   */
  inactiveReasons?: ReadonlyMap<string, NativeDeactivateReason>
}

export type NativeHostDiagnostics = {
  readonly nativeApi: number
  readonly lockVersion: number | null
  readonly lockHash: string | null
  readonly compiled: readonly NativePluginRegistryEntry[]
  readonly loaded: readonly string[]
  readonly skips: readonly NativePluginSkip[]
  readonly recentErrors: readonly RecentNativeError[]
  readonly brokenIds: readonly string[]
}

export type NativeHostRuntime = {
  readonly surfaceManager: ReturnType<typeof createNativeSurfaceManager>
  readonly tracker: NativeFailureTracker
  createHost: (options: {
    pluginId: string
    capabilities: readonly PluginCapability[]
    settings: PluginSettingsValues
    permissions: readonly NativePermissionKind[]
  }) => PluginNativeHost | undefined
  sync: (options: NativeSyncOptions) => void
  setAppState: (state: NativeAppState) => void
  reportFailure: (pluginId: string, error: unknown) => void
  reportSuccess: (pluginId: string) => void
  reportViewDiagnostic: (
    pluginId: string,
    failure: 'native_view_not_found' | 'native_view_load_failed',
  ) => void
  resetBreaker: () => void
  getDiagnostics: () => NativeHostDiagnostics
  subscribe: (listener: () => void) => () => void
  shutdown: () => Promise<void>
  whenIdle: () => Promise<void>
}

type LoadedEntry = {
  plugin: NativeSyncPlugin
  context: NativePluginContext
  settingsKey: string
  capabilitiesKey: string
  activated: boolean
}

function hasLifecycleHooks(lifecycle: Partial<NativePluginLifecycle>): boolean {
  return Object.values(lifecycle).some(hook => typeof hook === 'function')
}

function settingsKey(settings: PluginSettingsValues): string {
  return JSON.stringify(settings)
}

function capabilitiesKey(capabilities: readonly PluginCapability[]): string {
  return [...capabilities].join('\u0000')
}

function redactLogMessage(message: string): string {
  return message
    .replace(/\bdid:[a-z]+:[A-Za-z0-9._:%-]+/gi, '[已脱敏]')
    .replace(/\beyJ[A-Za-z0-9._-]+/g, '[已脱敏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 200)
}

/**
 * Owns the runtime state shared by every native plugin: lifecycle transitions,
 * the host event bus, permission/UI host groups, the surface manager and the
 * failure tracker. Every mutating entry point is serialised through one queue,
 * so a slow `deactivate` still finishes before the next activation and hosts
 * are torn down in the same order the plugins were loaded.
 */
export function createNativeHostRuntime(
  options: NativeHostRuntimeOptions,
): NativeHostRuntime {
  const tracker = createNativeFailureTracker(
    options.now ? {now: options.now} : {},
  )
  const bus: NativeEventBus = createNativeEventBus({
    onHandlerError(pluginId, event, error) {
      pluginLogger.warn('Native plugin event handler failed', {
        pluginId,
        event,
        error: summarizeError(error),
      })
      tracker.reportFailure(pluginId, error)
      notify()
    },
  })
  const surfaceManager = createNativeSurfaceManager({
    getPlugin(pluginId) {
      return options.nativeRegistry.find(entry => entry.id === pluginId)
    },
    onError(pluginId, error) {
      pluginLogger.warn('Native plugin surface rejected', {
        pluginId,
        code: error.code,
      })
    },
  })

  const listeners = new Set<() => void>()
  const loaded = new Map<string, LoadedEntry>()
  const hosts = new Map<
    string,
    {host: PluginNativeHost; events?: PluginEventsApi}
  >()

  let desired: NativeSyncPlugin[] = []
  let currentAccountDid: string | undefined
  let currentRevision = -1
  let currentAppState: NativeAppState = 'active'
  let initialized = false
  let shuttingDown = false
  let tail: Promise<void> = Promise.resolve()

  function notify() {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        // A broken subscriber must not block diagnostics updates.
      }
    }
  }

  function enqueue(task: () => void | Promise<void>): void {
    tail = tail.then(task).catch(error => {
      pluginLogger.error('Native plugin lifecycle queue failed', {
        error: summarizeError(error),
      })
    })
  }

  function settle(
    label: string,
    pluginId: string,
    run: () => void | Promise<void>,
    reportFailure: boolean,
  ): Promise<void> {
    return new Promise(resolve => {
      let finished = false
      const finish = (timedOut: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (timedOut) {
          pluginLogger.warn('Native plugin lifecycle timed out', {
            pluginId,
            hook: label,
            timeoutMs: NATIVE_LIFECYCLE_TIMEOUT_MS,
          })
        }
        resolve()
      }
      const timer = setTimeout(() => finish(true), NATIVE_LIFECYCLE_TIMEOUT_MS)

      let result: void | Promise<void>
      try {
        result = run()
      } catch (error) {
        handleFailure(error)
        finish(false)
        return
      }
      Promise.resolve(result).then(
        () => finish(false),
        error => {
          handleFailure(error)
          finish(false)
        },
      )

      function handleFailure(error: unknown) {
        if (reportFailure) {
          tracker.reportFailure(pluginId, error)
          notify()
        }
        pluginLogger.warn('Native plugin lifecycle hook failed', {
          pluginId,
          hook: label,
          error: summarizeError(error),
        })
      }
    })
  }

  function buildContext(plugin: NativeSyncPlugin): NativePluginContext {
    return {
      pluginId: plugin.pluginId,
      nativeApi: options.hostInfo.nativeApi,
      appVersion: options.hostInfo.appVersion,
      buildNumber: options.hostInfo.buildNumber,
      channel: options.hostInfo.channel,
      platform: options.hostInfo.platform,
      settings: {...plugin.settings},
      capabilities: [...plugin.capabilities],
      permissions: [...plugin.permissions],
    }
  }

  function activate(entry: LoadedEntry): void {
    const {lifecycle} = entry.plugin
    if (!hasLifecycleHooks(lifecycle)) {
      entry.activated = true
      return
    }
    if (entry.activated) return
    entry.activated = true
    enqueue(() =>
      settle(
        'activate',
        entry.plugin.pluginId,
        () => lifecycle.activate?.(entry.context),
        true,
      ),
    )
  }

  function deactivate(
    pluginId: string,
    entry: LoadedEntry,
    reason: NativeDeactivateReason,
    dispose: boolean,
  ): void {
    const {lifecycle} = entry.plugin
    if (!hasLifecycleHooks(lifecycle)) {
      if (dispose) void lifecycle.dispose?.()
      return
    }
    if (entry.activated) {
      entry.activated = false
      enqueue(() =>
        settle(
          'deactivate',
          pluginId,
          () => lifecycle.deactivate?.(reason),
          false,
        ),
      )
    }
    if (dispose) {
      enqueue(() =>
        settle('dispose', pluginId, () => lifecycle.dispose?.(), false),
      )
    }
  }

  function disposeHost(pluginId: string): void {
    const cached = hosts.get(pluginId)
    if (!cached) return
    cached.events?.dispose()
    hosts.delete(pluginId)
  }

  function unload(pluginId: string, reason: NativeDeactivateReason): void {
    const entry = loaded.get(pluginId)
    if (!entry) return
    loaded.delete(pluginId)
    surfaceManager.dismissPlugin(pluginId)
    deactivate(pluginId, entry, reason, false)
    disposeHost(pluginId)
    bus.clear(pluginId)
  }

  function unloadAll(
    reason: NativeDeactivateReason,
    dispose: boolean,
    disposeHosts: boolean,
  ): void {
    for (const [pluginId, entry] of Array.from(loaded)) {
      loaded.delete(pluginId)
      surfaceManager.dismissPlugin(pluginId)
      deactivate(pluginId, entry, reason, dispose)
      if (disposeHosts) disposeHost(pluginId)
    }
    bus.clear()
  }

  function emit(event: 'app.foreground' | 'app.background'): void {
    try {
      bus.emit(event, {})
    } catch (error) {
      pluginLogger.warn('Native host event rejected', {
        event,
        error: summarizeError(error),
      })
    }
  }

  function activateLoaded(): void {
    for (const entry of loaded.values()) {
      if (!entry.activated) activate(entry)
    }
  }

  function sync(next: NativeSyncOptions): void {
    if (shuttingDown) return
    desired = [...next.plugins]

    const accountChanged = initialized && next.accountDid !== currentAccountDid
    if (accountChanged) {
      const reason: NativeDeactivateReason =
        next.accountDid === undefined ? 'signed_out' : 'account_changed'
      unloadAll(reason, false, false)
      try {
        bus.emit('account.changed', {signedIn: next.accountDid !== undefined})
      } catch {
        // Subscribers are released immediately below.
      }
      bus.clear()
    }
    currentAccountDid = next.accountDid
    currentAppState = next.appState

    if (initialized && next.revision !== currentRevision) {
      try {
        bus.emit('registry.changed', {revision: next.revision})
      } catch (error) {
        pluginLogger.warn('Native registry event rejected', {
          error: summarizeError(error),
        })
      }
    }
    currentRevision = next.revision
    initialized = true

    const desiredById = new Map(
      desired.map(plugin => [plugin.pluginId, plugin]),
    )
    for (const pluginId of Array.from(loaded.keys())) {
      if (!desiredById.has(pluginId)) {
        unload(pluginId, next.inactiveReasons?.get(pluginId) ?? 'disabled')
      }
    }

    for (const plugin of desiredById.values()) {
      const existing = loaded.get(plugin.pluginId)
      if (!existing) {
        const entry: LoadedEntry = {
          plugin,
          context: buildContext(plugin),
          settingsKey: settingsKey(plugin.settings),
          capabilitiesKey: capabilitiesKey(plugin.capabilities),
          activated: false,
        }
        loaded.set(plugin.pluginId, entry)
        if (currentAppState !== 'background') {
          activate(entry)
        }
        continue
      }

      const nextSettingsKey = settingsKey(plugin.settings)
      const nextCapabilitiesKey = capabilitiesKey(plugin.capabilities)
      const settingsChanged = existing.settingsKey !== nextSettingsKey
      const capabilitiesChanged =
        existing.capabilitiesKey !== nextCapabilitiesKey

      existing.plugin = plugin
      existing.context = buildContext(plugin)
      existing.settingsKey = nextSettingsKey
      existing.capabilitiesKey = nextCapabilitiesKey

      if (existing.activated) {
        if (settingsChanged) {
          const {lifecycle} = plugin
          enqueue(() =>
            settle(
              'settingsChanged',
              plugin.pluginId,
              () => lifecycle.settingsChanged?.(plugin.settings),
              true,
            ),
          )
          bus.emit('settings.changed', {pluginId: plugin.pluginId})
        }
        if (capabilitiesChanged) {
          const {lifecycle} = plugin
          enqueue(() =>
            settle(
              'capabilitiesChanged',
              plugin.pluginId,
              () => lifecycle.capabilitiesChanged?.(plugin.capabilities),
              true,
            ),
          )
          bus.emit('capabilities.changed', {pluginId: plugin.pluginId})
        }
      } else if (currentAppState !== 'background') {
        activate(existing)
      }
    }

    for (const skip of next.skips ?? []) {
      tracker.recordSkip(skip.pluginId, skip.reason)
    }
    notify()
  }

  function setAppState(state: NativeAppState): void {
    if (shuttingDown || state === currentAppState) return
    const previous = currentAppState
    currentAppState = state

    if (state === 'background') {
      emit('app.background')
      for (const [pluginId, entry] of loaded) {
        surfaceManager.dismissPlugin(pluginId)
        if (entry.activated) {
          const {lifecycle} = entry.plugin
          enqueue(() =>
            settle(
              'appStateChanged',
              pluginId,
              () => lifecycle.appStateChanged?.('background'),
              false,
            ),
          )
        }
        deactivate(pluginId, entry, 'app_background', false)
      }
      notify()
      return
    }

    if (state === 'inactive') {
      for (const [pluginId, entry] of loaded) {
        if (!entry.activated) continue
        const {lifecycle} = entry.plugin
        enqueue(() =>
          settle(
            'appStateChanged',
            pluginId,
            () => lifecycle.appStateChanged?.('inactive'),
            false,
          ),
        )
      }
      notify()
      return
    }

    if (previous === 'background' || previous === 'inactive') {
      emit('app.foreground')
    }
    activateLoaded()
    for (const [pluginId, entry] of loaded) {
      const {lifecycle} = entry.plugin
      enqueue(() =>
        settle(
          'appStateChanged',
          pluginId,
          () => lifecycle.appStateChanged?.('active'),
          false,
        ),
      )
    }
    notify()
  }

  function createHost({
    pluginId,
    capabilities,
    settings,
    permissions,
  }: {
    pluginId: string
    capabilities: readonly PluginCapability[]
    settings: PluginSettingsValues
    permissions: readonly NativePermissionKind[]
  }): PluginNativeHost | undefined {
    void settings
    const cached = hosts.get(pluginId)
    if (cached) return cached.host

    const host: {
      info?: NativeHostInfo
      permissions?: NativePermissionApi
      ui?: NativeUiApi
      events?: NativeEventsApi
      log?: (message: string) => void
    } = {}
    let events: PluginEventsApi | undefined

    if (capabilities.includes('native.host')) {
      host.info = options.hostInfo
      host.log = message => {
        pluginLogger.info('Native plugin log', {
          pluginId,
          message: redactLogMessage(message),
        })
      }
    }
    if (capabilities.includes('native.permissions') && options.permissionHost) {
      host.permissions = createPluginPermissions({
        declared: permissions,
        host: options.permissionHost,
        onError(error) {
          pluginLogger.warn('Native plugin permission rejected', {
            pluginId,
            code: error.code,
          })
        },
      })
    }
    if (capabilities.includes('native.ui')) {
      host.ui = {
        present: (view, props, presentation) =>
          surfaceManager.present(pluginId, view, props, presentation),
        dismiss: view => surfaceManager.dismiss(pluginId, view),
      }
    }
    if (capabilities.includes('events.subscribe')) {
      events = createPluginEvents({
        pluginId,
        capabilities,
        bus,
        onHandlerError(error) {
          tracker.reportFailure(pluginId, error)
          notify()
        },
      })
      host.events = events
    }

    hosts.set(pluginId, {host, events})
    return host
  }

  function reportFailure(pluginId: string, error: unknown): void {
    tracker.reportFailure(pluginId, error)
    notify()
  }

  function reportSuccess(pluginId: string): void {
    tracker.reportSuccess(pluginId)
  }

  function reportViewDiagnostic(
    pluginId: string,
    _failure: 'native_view_not_found' | 'native_view_load_failed',
  ): void {
    tracker.recordSkip(pluginId, 'native_view_missing')
    notify()
  }

  function resetBreaker(): void {
    tracker.reset()
    notify()
  }

  function getDiagnostics(): NativeHostDiagnostics {
    const lock = options.nativeLock
    return {
      nativeApi: options.hostInfo.nativeApi,
      lockVersion: lock ? NATIVE_LOCK_VERSION : null,
      lockHash: lock?.lockHash ?? null,
      compiled: [...options.nativeRegistry],
      loaded: [...loaded.keys()],
      skips: tracker.getSkips(),
      recentErrors: tracker.getRecentErrors(),
      brokenIds: tracker.getBrokenIds(),
    }
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    for (const [pluginId, entry] of Array.from(loaded)) {
      loaded.delete(pluginId)
      surfaceManager.dismissPlugin(pluginId)
      deactivate(pluginId, entry, 'host_shutdown', true)
    }
    bus.clear()
    for (const pluginId of Array.from(hosts.keys())) {
      disposeHost(pluginId)
    }
    surfaceManager.dispose()
    notify()
    await tail
  }

  return {
    surfaceManager,
    tracker,
    createHost,
    sync,
    setAppState,
    reportFailure,
    reportSuccess,
    reportViewDiagnostic,
    resetBreaker,
    getDiagnostics,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    shutdown,
    whenIdle: () => tail,
  }
}
