import {type NativePluginLock, type NativePluginLockEntry} from '../native/lock'
import {type NativePluginRegistryEntry} from '../native/registry'
import {
  PLUGIN_NATIVE_API_VERSION,
  type PluginCapability,
  type PluginDefinition,
  type PluginHostApi,
  type PluginNativePermissionKind,
  type PluginPlatform,
  type PluginSettingIssue,
  type PluginSettingsValues,
  type PluginStorage,
  type PluginToast,
} from '../sdk'
import {resolvePluginSettings} from '../sdk/settings'
import {type CachedPluginRegistry} from './registry-types'
import {createPluginStorage, type PluginStorageOptions} from './storage'

export type PluginResolutionIssue = {
  pluginId: string
  reason:
    | 'missing-registry-entry'
    | 'platform-mismatch'
    | 'host_api_mismatch'
    | 'missing-capability'
    | 'settings'
    | 'storage-unavailable'
    | 'native_api_mismatch'
    | 'manifest_mismatch'
    | 'native_not_compiled'
    | 'native_module_missing'
    | 'native_view_missing'
    | 'min_app_version'
}

export type ResolvedPlugin = {
  definition: PluginDefinition
  capabilities: readonly PluginCapability[]
  settings: PluginSettingsValues
  settingsIssues: PluginSettingIssue[]
  host: PluginHostApi
}

export type PluginResolutionResult = {
  plugins: ResolvedPlugin[]
  issues: PluginResolutionIssue[]
}

export type PluginStorageFactory = (
  options: PluginStorageOptions,
) => PluginStorage

export type PluginNativeHostFactory = (options: {
  pluginId: string
  capabilities: readonly PluginCapability[]
  settings: PluginSettingsValues
  permissions: readonly PluginNativePermissionKind[]
}) => PluginHostApi['native']

export type ResolvePluginsOptions = {
  definitions: readonly PluginDefinition[]
  registry: CachedPluginRegistry | undefined
  platform: PluginPlatform
  accountDid: string | undefined
  /**
   * Build lock compiled into this app. Native plugins without an entry are
   * treated as not compiled rather than rendered without native code.
   */
  nativeLock?: NativePluginLock
  /**
   * Generated registry of views compiled into this app. When provided, the
   * manifest, lock and registry must agree before a native plugin renders.
   */
  nativeRegistry?: readonly NativePluginRegistryEntry[]
  /** Current app version, used for the plugin `minAppVersion` gate. */
  appVersion?: string
  createStorage?: PluginStorageFactory
  createToast?: () => PluginToast
  createNativeHost?: PluginNativeHostFactory
}

type ParsedVersion = {
  major: number
  minor: number
  patch: number
  prerelease: string | undefined
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    )
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

function comparePrerelease(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const aPart = left[index]
    const bPart = right[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    const aNumeric = /^\d+$/.test(aPart)
    const bNumeric = /^\d+$/.test(bPart)
    if (aNumeric && bNumeric) {
      const difference = Number(aPart) - Number(bPart)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (aPart !== bPart) return aPart < bPart ? -1 : 1
  }
  return 0
}

/**
 * SemVer ordering. A prerelease sorts below the same stable version, so
 * `2.0.0-beta.1` does not satisfy `minAppVersion: 2.0.0`.
 */
export function comparePluginVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  return comparePrerelease(left.prerelease, right.prerelease)
}

function findNativeLockEntry(
  lock: NativePluginLock | undefined,
  pluginId: string,
): NativePluginLockEntry | undefined {
  return lock?.plugins.find(entry => entry.id === pluginId)
}

function getNativeSkipReason(
  definition: PluginDefinition,
  registryVersion: string,
  lock: NativePluginLock | undefined,
  nativeRegistry: readonly NativePluginRegistryEntry[] | undefined,
  appVersion: string | undefined,
): PluginResolutionIssue['reason'] | undefined {
  const {manifest} = definition
  const native = manifest.native
  if (!native) return undefined

  const entry = findNativeLockEntry(lock, manifest.id)
  if (!entry) return 'native_not_compiled'

  if (
    entry.version !== manifest.version ||
    registryVersion !== manifest.version
  ) {
    return 'manifest_mismatch'
  }
  if (entry.hostApi !== manifest.hostApi) return 'host_api_mismatch'
  if (
    !manifest.nativeApi ||
    manifest.nativeApi !== PLUGIN_NATIVE_API_VERSION ||
    entry.nativeApi !== manifest.nativeApi
  ) {
    return 'native_api_mismatch'
  }

  const lockedModules = new Set(entry.modules)
  for (const moduleName of native.modules) {
    if (!lockedModules.has(moduleName)) return 'native_module_missing'
  }

  const lockedViews = new Map(entry.views.map(view => [view.name, view]))
  for (const view of native.views) {
    const locked = lockedViews.get(view.name)
    if (!locked) return 'native_view_missing'
    if (locked.heightMode !== view.heightMode) return 'manifest_mismatch'
  }

  if (nativeRegistry) {
    const compiled = nativeRegistry.find(
      candidate => candidate.id === manifest.id,
    )
    if (!compiled) return 'native_not_compiled'
    if (compiled.packageName !== native.package) return 'manifest_mismatch'
    if (
      compiled.version !== entry.version ||
      compiled.nativeApi !== entry.nativeApi
    ) {
      return compiled.nativeApi === entry.nativeApi
        ? 'manifest_mismatch'
        : 'native_api_mismatch'
    }

    const compiledModules = new Set(compiled.modules)
    for (const moduleName of entry.modules) {
      if (!compiledModules.has(moduleName)) return 'native_module_missing'
    }
    for (const moduleName of native.modules) {
      if (!compiledModules.has(moduleName)) return 'native_module_missing'
    }

    const compiledViews = new Map(
      compiled.views.map(view => [view.name, view.heightMode]),
    )
    for (const view of entry.views) {
      const heightMode = compiledViews.get(view.name)
      if (!heightMode) return 'native_view_missing'
      if (heightMode !== view.heightMode) return 'manifest_mismatch'
    }
  }

  if (
    appVersion &&
    comparePluginVersions(appVersion, native.minAppVersion) < 0
  ) {
    return 'min_app_version'
  }

  return undefined
}

/**
 * Capabilities available to a plugin are exactly the manifest declaration
 * intersected with the registry grant. A plugin missing any declared
 * capability is not rendered.
 */
export function getEffectiveCapabilities(
  definition: PluginDefinition,
  granted: readonly PluginCapability[],
): PluginCapability[] | undefined {
  const available = new Set(granted)
  for (const capability of definition.manifest.capabilities) {
    if (!available.has(capability)) return undefined
  }
  return [...definition.manifest.capabilities]
}

/**
 * Pure resolution of compiled plugins against the current registry snapshot.
 * Unknown registry entries are ignored, matching the "registry controls
 * compiled-in plugins only" contract.
 */
export function resolvePlugins({
  definitions,
  registry,
  platform,
  accountDid,
  nativeLock,
  nativeRegistry,
  appVersion,
  createStorage = createPluginStorage,
  createToast,
  createNativeHost,
}: ResolvePluginsOptions): PluginResolutionResult {
  const plugins: ResolvedPlugin[] = []
  const issues: PluginResolutionIssue[] = []
  if (!registry || !accountDid) {
    return {plugins, issues}
  }

  const entries = new Map(
    registry.snapshot.plugins.map(entry => [entry.id, entry]),
  )

  for (const definition of definitions) {
    const {manifest} = definition
    const entry = entries.get(manifest.id)
    if (!entry) {
      issues.push({pluginId: manifest.id, reason: 'missing-registry-entry'})
      continue
    }
    if (!manifest.platforms.includes(platform)) {
      issues.push({pluginId: manifest.id, reason: 'platform-mismatch'})
      continue
    }
    if (entry.hostApi !== manifest.hostApi) {
      issues.push({pluginId: manifest.id, reason: 'host_api_mismatch'})
      continue
    }

    const nativeSkipReason = getNativeSkipReason(
      definition,
      entry.version,
      nativeLock,
      nativeRegistry,
      appVersion,
    )
    if (nativeSkipReason) {
      issues.push({pluginId: manifest.id, reason: nativeSkipReason})
      continue
    }

    const capabilities = getEffectiveCapabilities(
      definition,
      entry.capabilities,
    )
    if (!capabilities) {
      issues.push({pluginId: manifest.id, reason: 'missing-capability'})
      continue
    }

    const settingsResult = resolvePluginSettings(
      manifest.settings,
      entry.settings,
    )
    const host: PluginHostApi = {}
    if (capabilities.includes('storage.local')) {
      try {
        host.storage = createStorage({
          accountDid,
          pluginId: manifest.id,
        })
      } catch {
        issues.push({pluginId: manifest.id, reason: 'storage-unavailable'})
        continue
      }
    }
    if (capabilities.includes('toast.show') && createToast) {
      host.toast = createToast()
    }
    if (manifest.native && createNativeHost) {
      host.native = createNativeHost({
        pluginId: manifest.id,
        capabilities,
        settings: settingsResult.values,
        permissions: manifest.native.permissions.map(
          permission => permission.name,
        ),
      })
    }

    plugins.push({
      definition,
      capabilities,
      settings: settingsResult.values,
      settingsIssues: settingsResult.issues,
      host,
    })
  }

  return {plugins, issues}
}
