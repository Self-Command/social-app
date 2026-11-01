import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {type AppStateStatus, Platform} from 'react-native'
import {nativeBuildVersion} from 'expo-application'

import {useSession} from '#/state/session'
import {ENV, RELEASE_VERSION} from '#/env'
import {NATIVE_PLUGIN_REGISTRY} from '../generated/native-registry'
import {type NativePluginSkip, type NativeSkipReason} from '../native/errors'
import {
  createNativeHostRuntime,
  type NativeHostDiagnostics,
  type NativeSyncPlugin,
} from '../native/host-runtime'
import {type NativePluginLock} from '../native/lock'
import {NativePluginSurfaceHost} from '../native/NativePluginSurface'
import {loadPermissionHost} from '../native/permission-host'
import {type PluginPermissionHost} from '../native/permissions'
import {type NativePluginRegistryEntry} from '../native/registry'
import {NativePluginViewProvider} from '../native/registry-context'
import {
  type NativeAppState,
  type NativeDeactivateReason,
  type NativeHostInfo,
  type NativePluginError,
} from '../native/types'
import {
  isPluginPlatform,
  PLUGIN_NATIVE_API_VERSION,
  type PluginDefinition,
  type PluginPlatform,
  type PluginToast,
  validatePluginDefinitions,
} from '../sdk'
import {
  defaultPluginAppStateSource,
  type PluginAppStateSource,
} from './app-state'
import {pluginLogger, summarizeError} from './log'
import {PluginHostContext, type PluginHostContextValue} from './plugin-context'
import {
  createPluginRegistryClient,
  type PluginRegistryClient,
} from './registry-client'
import {type CachedPluginRegistry} from './registry-types'
import {
  type PluginNativeHostFactory,
  type PluginResolutionIssue,
  type PluginStorageFactory,
  resolvePlugins,
} from './resolve'

export const PLUGIN_REFRESH_INTERVAL_MS = 60_000
export const PLUGIN_FAILURE_THRESHOLD = 3

const EMPTY_DEFINITIONS: readonly PluginDefinition[] = []

export type PluginProviderNativeOptions = {
  /** Generated registry of native modules compiled into this build. */
  registry?: readonly NativePluginRegistryEntry[]
  /** Build lock for this app version. Without it native plugins stay unloaded. */
  lock?: NativePluginLock
  hostInfo?: NativeHostInfo
  permissionHost?: PluginPermissionHost
}

export type PluginProviderProps = {
  children: ReactNode
  /** Plugins compiled into this build. */
  plugins: readonly PluginDefinition[]
  registryClient?: PluginRegistryClient
  appStateSource?: PluginAppStateSource
  platform?: PluginPlatform
  createStorage?: PluginStorageFactory
  createToast?: () => PluginToast
  refreshIntervalMs?: number
  /**
   * Build-time native configuration. Keep this object stable; changing it
   * recreates the native host runtime.
   */
  native?: PluginProviderNativeOptions
}

function detectPlatform(): PluginPlatform {
  return isPluginPlatform(Platform.OS) ? Platform.OS : 'web'
}

function toNativeAppState(state: AppStateStatus | null): NativeAppState {
  if (state === 'background') return 'background'
  if (state === 'inactive') return 'inactive'
  return 'active'
}

function toNativeSkipReason(
  reason: PluginResolutionIssue['reason'],
): NativeSkipReason {
  switch (reason) {
    case 'native_api_mismatch':
    case 'host_api_mismatch':
    case 'manifest_mismatch':
    case 'native_not_compiled':
    case 'native_module_missing':
    case 'native_view_missing':
    case 'min_app_version':
      return reason
    default:
      return 'disabled'
  }
}

/**
 * Plugin host. Owns registry synchronization, plugin resolution and the
 * per-plugin circuit breaker. Registry problems never block children: the
 * provider simply exposes an empty plugin list.
 */
export function PluginProvider({
  children,
  plugins,
  registryClient,
  appStateSource = defaultPluginAppStateSource,
  platform: platformProp,
  createStorage,
  createToast,
  refreshIntervalMs = PLUGIN_REFRESH_INTERVAL_MS,
  native: nativeOptions,
}: PluginProviderProps) {
  const {currentAccount} = useSession()
  const accountDid = currentAccount?.did
  const platform = platformProp ?? detectPlatform()

  const nativeRegistry = nativeOptions?.registry ?? NATIVE_PLUGIN_REGISTRY
  const nativeLock = nativeOptions?.lock
  const nativeHostInfo = nativeOptions?.hostInfo
  const nativePermissionHost = nativeOptions?.permissionHost
  const nativePlatform =
    platform === 'ios' || platform === 'android' ? platform : undefined

  const nativeRuntime = useMemo(() => {
    if (!nativePlatform) return undefined
    return createNativeHostRuntime({
      nativeRegistry,
      nativeLock,
      hostInfo: nativeHostInfo ?? {
        nativeApi: PLUGIN_NATIVE_API_VERSION,
        appVersion: RELEASE_VERSION,
        buildNumber: nativeBuildVersion ?? '0',
        channel: ENV || 'production',
        platform: nativePlatform,
      },
      permissionHost: nativePermissionHost ?? loadPermissionHost(),
    })
  }, [
    nativeHostInfo,
    nativeLock,
    nativePermissionHost,
    nativePlatform,
    nativeRegistry,
  ])

  const client = useMemo(
    () => registryClient ?? createPluginRegistryClient(),
    [registryClient],
  )

  const validation = useMemo(
    () => validatePluginDefinitions(plugins),
    [plugins],
  )
  const definitions = validation.ok ? validation.definitions : EMPTY_DEFINITIONS

  useEffect(() => {
    if (!validation.ok) {
      pluginLogger.error('Plugin catalog rejected', {
        errors: validation.errors,
      })
    }
  }, [validation])

  const [registry, setRegistry] = useState<CachedPluginRegistry | undefined>()
  const registryRef = useRef<CachedPluginRegistry | undefined>(undefined)
  const mountedRef = useRef(true)

  const failuresRef = useRef<Map<string, number>>(new Map())
  const brokenRef = useRef<Set<string>>(new Set())
  const [brokenIds, setBrokenIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const resetBreaker = useCallback(() => {
    const hadBroken = brokenRef.current.size > 0
    failuresRef.current.clear()
    brokenRef.current.clear()
    if (hadBroken) setBrokenIds(new Set())
  }, [])

  const acceptRegistry = useCallback((next: CachedPluginRegistry) => {
    const current = registryRef.current
    if (current && next.snapshot.revision <= current.snapshot.revision) {
      return false
    }
    registryRef.current = next
    setRegistry(next)
    return true
  }, [])

  const reportFailure = useCallback((pluginId: string, error: unknown) => {
    const failures = (failuresRef.current.get(pluginId) ?? 0) + 1
    failuresRef.current.set(pluginId, failures)
    pluginLogger.error('Plugin render failed', {
      pluginId,
      failures,
      error: summarizeError(error),
    })
    if (
      failures >= PLUGIN_FAILURE_THRESHOLD &&
      !brokenRef.current.has(pluginId)
    ) {
      brokenRef.current.add(pluginId)
      pluginLogger.warn('Plugin disabled by circuit breaker', {
        pluginId,
        failures,
      })
      setBrokenIds(new Set(brokenRef.current))
    }
  }, [])

  const reportSuccess = useCallback((pluginId: string) => {
    failuresRef.current.delete(pluginId)
  }, [])

  const syncRegistry = useCallback(
    async (seed?: CachedPluginRegistry) => {
      try {
        const result = await client.sync(seed ?? registryRef.current)
        if (!mountedRef.current) return

        switch (result.status) {
          case 'updated': {
            const accepted = acceptRegistry(result.registry)
            if (accepted) {
              resetBreaker()
            }
            if (result.cacheWriteFailed) {
              pluginLogger.warn('Plugin registry cache write failed', {
                revision: result.registry.snapshot.revision,
              })
            }
            break
          }
          case 'not-modified':
          case 'failed': {
            if (result.registry) {
              acceptRegistry(result.registry)
            }
            if (result.status === 'failed') {
              pluginLogger.warn('Plugin registry sync failed', {
                reason: result.reason,
                httpStatus: result.httpStatus,
              })
            }
            break
          }
          case 'disabled': {
            pluginLogger.info('Plugin registry disabled', {
              reason: result.reason,
            })
            break
          }
        }
      } catch (error) {
        if (mountedRef.current) {
          pluginLogger.error('Plugin registry sync crashed', {
            error: summarizeError(error),
          })
        }
      }
    },
    [acceptRegistry, client, resetBreaker],
  )

  // Startup: load the last successful cache, then sync (ETag comes from cache).
  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    void (async () => {
      const cached = await client.loadCached()
      if (cancelled || !mountedRef.current) return
      if (cached) {
        acceptRegistry(cached)
      }
      await syncRegistry(cached)
    })()
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [acceptRegistry, client, syncRegistry])

  // Foreground polling: sync on activation and every interval while active.
  useEffect(() => {
    if (!client.enabled) return

    let interval: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (interval === undefined) {
        interval = setInterval(() => {
          void syncRegistry()
        }, refreshIntervalMs)
      }
    }
    const stop = () => {
      if (interval !== undefined) {
        clearInterval(interval)
        interval = undefined
      }
    }

    const initial = appStateSource.getCurrentState()
    if (initial == null || initial === 'active') {
      start()
    }

    const unsubscribe = appStateSource.subscribe(state => {
      if (state === 'active') {
        void syncRegistry()
        start()
      } else {
        stop()
      }
    })

    return () => {
      unsubscribe()
      stop()
    }
  }, [appStateSource, client.enabled, refreshIntervalMs, syncRegistry])

  // A plugin failure streak belongs to the account whose data was rendered.
  useEffect(() => {
    resetBreaker()
  }, [accountDid, resetBreaker])

  const createNativeHost = useMemo<PluginNativeHostFactory | undefined>(() => {
    if (!nativeRuntime) return undefined
    return options => nativeRuntime.createHost(options)
  }, [nativeRuntime])

  const resolved = useMemo(
    () =>
      resolvePlugins({
        definitions,
        registry,
        platform,
        accountDid,
        nativeLock,
        nativeRegistry,
        appVersion: RELEASE_VERSION,
        createStorage,
        createToast,
        createNativeHost,
      }),
    [
      accountDid,
      createNativeHost,
      createStorage,
      createToast,
      definitions,
      nativeLock,
      nativeRegistry,
      platform,
      registry,
    ],
  )

  useEffect(() => {
    for (const issue of resolved.issues) {
      pluginLogger.warn('Plugin skipped', {
        pluginId: issue.pluginId,
        reason: issue.reason,
      })
    }
    for (const plugin of resolved.plugins) {
      for (const issue of plugin.settingsIssues) {
        pluginLogger.warn('Plugin setting rejected; using default', {
          pluginId: plugin.definition.manifest.id,
          key: issue.key,
          reason: issue.reason,
        })
      }
    }
  }, [resolved])

  const [nativeDiagnostics, setNativeDiagnostics] = useState<
    NativeHostDiagnostics | undefined
  >()

  useEffect(() => {
    if (!nativeRuntime) {
      setNativeDiagnostics(undefined)
      return
    }
    setNativeDiagnostics(nativeRuntime.getDiagnostics())
    return nativeRuntime.subscribe(() => {
      setNativeDiagnostics(nativeRuntime.getDiagnostics())
    })
  }, [nativeRuntime])

  const nativeBrokenKey = nativeDiagnostics?.brokenIds.join('\u0000') ?? ''
  const nativeBrokenIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set(nativeBrokenKey ? nativeBrokenKey.split('\u0000') : [])
    for (const pluginId of brokenIds) {
      ids.add(pluginId)
    }
    return ids
  }, [brokenIds, nativeBrokenKey])

  // A tripped plugin is removed from the rendered list and unloaded below.
  const visiblePlugins = useMemo(
    () =>
      resolved.plugins.filter(
        plugin => !nativeBrokenIds.has(plugin.definition.manifest.id),
      ),
    [resolved.plugins, nativeBrokenIds],
  )

  const nativeDefinitionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const definition of definitions) {
      if (definition.manifest.native) ids.add(definition.manifest.id)
    }
    return ids
  }, [definitions])

  const nativeSkips = useMemo<NativePluginSkip[]>(() => {
    if (!nativeRuntime) return []
    const skips: NativePluginSkip[] = []
    for (const issue of resolved.issues) {
      if (!nativeDefinitionIds.has(issue.pluginId)) continue
      skips.push({
        pluginId: issue.pluginId,
        reason: toNativeSkipReason(issue.reason),
      })
    }
    for (const pluginId of nativeBrokenIds) {
      if (
        !nativeDefinitionIds.has(pluginId) ||
        skips.some(skip => skip.pluginId === pluginId)
      ) {
        continue
      }
      skips.push({pluginId, reason: 'circuit_open'})
    }
    return skips
  }, [nativeBrokenIds, nativeDefinitionIds, nativeRuntime, resolved.issues])

  const nativeInactiveReasons = useMemo(() => {
    const reasons = new Map<string, NativeDeactivateReason>()
    for (const issue of resolved.issues) {
      if (nativeDefinitionIds.has(issue.pluginId)) {
        reasons.set(issue.pluginId, 'disabled')
      }
    }
    for (const pluginId of nativeBrokenIds) {
      if (nativeDefinitionIds.has(pluginId)) {
        reasons.set(pluginId, 'disabled')
      }
    }
    return reasons
  }, [nativeBrokenIds, nativeDefinitionIds, resolved.issues])

  const nativeSyncPlugins = useMemo<NativeSyncPlugin[]>(() => {
    if (!nativeRuntime) return []
    const plugins: NativeSyncPlugin[] = []
    for (const plugin of visiblePlugins) {
      const native = plugin.definition.manifest.native
      if (!native) continue
      plugins.push({
        pluginId: plugin.definition.manifest.id,
        lifecycle: plugin.definition.native ?? {},
        settings: plugin.settings,
        capabilities: plugin.capabilities,
        permissions: native.permissions.map(permission => permission.name),
      })
    }
    return plugins
  }, [nativeRuntime, visiblePlugins])

  const nativeBreakerKey = `${accountDid ?? 'anonymous'}:${
    registry?.snapshot.revision ?? -1
  }`
  const nativeBreakerKeyRef = useRef<string | undefined>(undefined)

  // A new account or registry revision clears circuit state before the sync
  // below records the current skips.
  useEffect(() => {
    if (!nativeRuntime) return
    if (nativeBreakerKeyRef.current === nativeBreakerKey) return
    const isFirstRun = nativeBreakerKeyRef.current === undefined
    nativeBreakerKeyRef.current = nativeBreakerKey
    if (!isFirstRun) nativeRuntime.resetBreaker()
  }, [nativeBreakerKey, nativeRuntime])

  useEffect(() => {
    if (!nativeRuntime) return
    nativeRuntime.sync({
      plugins: nativeSyncPlugins,
      accountDid,
      revision: registry?.snapshot.revision ?? -1,
      appState: toNativeAppState(appStateSource.getCurrentState()),
      skips: nativeSkips,
      inactiveReasons: nativeInactiveReasons,
    })
  }, [
    accountDid,
    appStateSource,
    nativeInactiveReasons,
    nativeRuntime,
    nativeSkips,
    nativeSyncPlugins,
    registry,
  ])

  useEffect(() => {
    if (!nativeRuntime) return
    nativeRuntime.setAppState(
      toNativeAppState(appStateSource.getCurrentState()),
    )
    return appStateSource.subscribe(state => {
      nativeRuntime.setAppState(toNativeAppState(state))
    })
  }, [appStateSource, nativeRuntime])

  useEffect(() => {
    if (!nativeRuntime) return
    return () => {
      void nativeRuntime.shutdown()
    }
  }, [nativeRuntime])

  const reportViewDiagnostic = useCallback(
    (
      pluginId: string,
      reason: 'native_view_not_found' | 'native_view_load_failed',
    ) => {
      nativeRuntime?.reportViewDiagnostic(pluginId, reason)
    },
    [nativeRuntime],
  )

  const reportNativeError = useCallback(
    (pluginId: string, error: NativePluginError) => {
      nativeRuntime?.reportFailure(pluginId, error)
    },
    [nativeRuntime],
  )

  const reportNativeSuccess = useCallback(
    (pluginId: string) => {
      nativeRuntime?.reportSuccess(pluginId)
    },
    [nativeRuntime],
  )

  const resetKey = nativeBreakerKey

  const contextValue: PluginHostContextValue = {
    plugins: visiblePlugins,
    platform,
    resetKey,
    reportFailure,
    reportSuccess,
    nativeDiagnostics,
  }

  return (
    <PluginHostContext.Provider value={contextValue}>
      <NativePluginViewProvider
        entries={nativeRegistry}
        reportDiagnostic={reportViewDiagnostic}
        reportError={reportNativeError}
        reportSuccess={reportNativeSuccess}>
        {children}
        {nativeRuntime ? (
          <NativePluginSurfaceHost manager={nativeRuntime.surfaceManager} />
        ) : null}
      </NativePluginViewProvider>
    </PluginHostContext.Provider>
  )
}
