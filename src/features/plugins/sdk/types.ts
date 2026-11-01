import {type ComponentType} from 'react'

import {
  PLUGIN_CAPABILITY_IDS,
  type PluginCapability,
} from '../catalog/capabilities'
import {
  PLUGIN_PLATFORMS,
  PLUGIN_SLOT_IDS,
  type PluginPlatform,
  type PluginSlotId,
} from '../catalog/slots'
import {
  NATIVE_PERMISSION_KINDS,
  type NativePermissionKind,
  type NativePluginLifecycle,
  type PluginNativeHost,
} from '../native/types'

export {PLUGIN_CAPABILITY_IDS, PLUGIN_PLATFORMS, PLUGIN_SLOT_IDS}
export type {PluginCapability, PluginPlatform, PluginSlotId}

/**
 * Version of the plugin manifest contract understood by this host.
 */
export const PLUGIN_SCHEMA_VERSION = 2

/**
 * Version of the JS host API. Plugins declaring a different version are
 * skipped.
 */
export const PLUGIN_HOST_API_VERSION = 2

/**
 * Version of the native host contract: registration, lifecycle, events,
 * permissions and UI containers. Native plugins declare it next to `hostApi`.
 */
export const PLUGIN_NATIVE_API_VERSION = 1

/**
 * Required prefix for the npm package exported by a native plugin.
 */
export const PLUGIN_NATIVE_PACKAGE_PREFIX = '@community-plugins/'

/**
 * Native permissions a plugin can declare. The host grants nothing else.
 */
export const PLUGIN_NATIVE_PERMISSION_KINDS: readonly NativePermissionKind[] =
  NATIVE_PERMISSION_KINDS
export type PluginNativePermissionKind = NativePermissionKind

export const PLUGIN_NATIVE_VIEW_HEIGHT_MODES = ['fixed', 'content'] as const
export type PluginNativeViewHeightMode =
  (typeof PLUGIN_NATIVE_VIEW_HEIGHT_MODES)[number]

export type PluginNativeViewDeclaration = {
  name: string
  heightMode: PluginNativeViewHeightMode
}

export type PluginNativePermissionDeclaration = {
  name: PluginNativePermissionKind
  /**
   * User-facing Chinese explanation merged into the platform manifest.
   */
  reason: string
}

export type PluginNativeNetworkDeclaration = {
  /**
   * HTTPS origins the host proxy may reach on behalf of the plugin.
   */
  outbound: string[]
}

/**
 * Native build-time declaration. Only native plugins may have this block; it
 * is validated against the compiled native modules at startup.
 */
export type PluginNativeManifest = {
  package: string
  modules: string[]
  views: PluginNativeViewDeclaration[]
  permissions: PluginNativePermissionDeclaration[]
  minAppVersion: string
  network: PluginNativeNetworkDeclaration
}

/**
 * Values accepted by plugin storage capable of round-tripping through JSON.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue}

export type PluginSettingValue = string | number | boolean

/**
 * Manifest defaults merged with the registry values for one plugin.
 */
export type PluginSettingsValues = Readonly<Record<string, PluginSettingValue>>

export type PluginStringSettingField = {
  key: string
  type: 'string'
  label: string
  description: string
  default: string
  minLength?: number
  maxLength?: number
}

export type PluginNumberSettingField = {
  key: string
  type: 'number'
  label: string
  description: string
  default: number
  min?: number
  max?: number
}

export type PluginBooleanSettingField = {
  key: string
  type: 'boolean'
  label: string
  description: string
  default: boolean
}

export type PluginSelectSettingField = {
  key: string
  type: 'select'
  label: string
  description: string
  default: string
  options: string[]
}

export type PluginSettingField =
  | PluginStringSettingField
  | PluginNumberSettingField
  | PluginBooleanSettingField
  | PluginSelectSettingField

export type PluginSlotDeclaration = {
  id: PluginSlotId
  /**
   * Sort position within the slot. Lower values render first; ties are broken
   * by plugin id.
   */
  order: number
}

/**
 * Static description of a plugin. This is the single source of truth for the
 * plugin id, version, host compatibility, slots, capabilities and settings.
 */
export type PluginManifest = {
  schemaVersion: typeof PLUGIN_SCHEMA_VERSION
  id: string
  name: string
  description: string
  version: string
  hostApi: typeof PLUGIN_HOST_API_VERSION
  /**
   * Present exactly when `native` is present; must match the host value.
   */
  nativeApi?: typeof PLUGIN_NATIVE_API_VERSION
  platforms: PluginPlatform[]
  slots: PluginSlotDeclaration[]
  capabilities: PluginCapability[]
  settings: PluginSettingField[]
  native?: PluginNativeManifest
}

export type ComposerToolbarContext = {
  /**
   * Inserts plain text at the current cursor position. Requires the
   * `composer.insertText` capability.
   */
  insertText: (text: string) => void
  getText: () => string
  closeComposer: () => void
}

/**
 * Public fields of the post currently being rendered. Requires `feed.read`.
 */
export type FeedItemFooterContext = {
  uri: string
  cid: string
  authorDid: string
  authorHandle: string
  authorDisplayName?: string
  text: string
  createdAt: string
}

export type SettingsSectionContext = Record<string, never>

/**
 * Contexts implemented by the host. Slots outside this map receive the
 * minimal base context until their host-side data source lands.
 */
export type ConcretePluginSlotContexts = {
  'composer.toolbar': ComposerToolbarContext
  'feed.item.footer': FeedItemFooterContext
  'settings.main.section': SettingsSectionContext
}

export type BasePluginSlotContext = Readonly<{slotId: PluginSlotId}>

export type PluginSlotContextMap = ConcretePluginSlotContexts & {
  [
    S in Exclude<PluginSlotId, keyof ConcretePluginSlotContexts>
  ]: BasePluginSlotContext
}

/**
 * Storage handle scoped to the current account and plugin. Only present when
 * both the manifest and the registry grant `storage.local`.
 */
export type PluginStorage = {
  get: (key: string) => Promise<JsonValue | undefined>
  set: (key: string, value: JsonValue) => Promise<void>
  remove: (key: string) => Promise<void>
  list: () => Promise<string[]>
  clear: () => Promise<void>
}

/**
 * Short, formal status messages. Requires the `toast.show` capability.
 */
export type PluginToast = {
  show: (message: string) => void
}

/**
 * Objects the host exposes to an authorized plugin. Unauthorized capabilities
 * are omitted rather than stubbed.
 */
export type PluginHostApi = {
  storage?: PluginStorage
  toast?: PluginToast
  native?: PluginNativeHost
}

export type PluginSlotProps<S extends PluginSlotId> = {
  settings: PluginSettingsValues
  /**
   * The manifest capabilities. Every value is also granted by the registry;
   * otherwise the plugin is not rendered at all.
   */
  capabilities: readonly PluginCapability[]
  context: PluginSlotContextMap[S]
  host: PluginHostApi
}

export type PluginSlotComponent<S extends PluginSlotId> = ComponentType<
  PluginSlotProps<S>
>

export type PluginSlotComponents = {
  [S in PluginSlotId]?: PluginSlotComponent<S>
}

/**
 * A plugin compiled into the host bundle together with its manifest.
 */
export type PluginDefinition = {
  manifest: PluginManifest
  slots: PluginSlotComponents
  /**
   * Compiled native lifecycle. Only consulted for plugins with a native block.
   */
  native?: Partial<NativePluginLifecycle>
}
