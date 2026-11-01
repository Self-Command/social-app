import {type PluginCapability} from '../catalog/capabilities'

export const NATIVE_PERMISSION_KINDS = [
  'microphone',
  'camera',
  'photoLibrary',
  'notifications',
  'locationWhenInUse',
] as const
export type NativePermissionKind = (typeof NATIVE_PERMISSION_KINDS)[number]

export const NATIVE_PERMISSION_STATUSES = [
  'granted',
  'denied',
  'blocked',
  'limited',
  'unavailable',
  'notDetermined',
] as const
export type NativePermissionStatus = (typeof NATIVE_PERMISSION_STATUSES)[number]

export const NATIVE_DEACTIVATE_REASONS = [
  'app_background',
  'account_changed',
  'signed_out',
  'disabled',
  'revoked',
  'registry_changed',
  'host_shutdown',
] as const
export type NativeDeactivateReason = (typeof NATIVE_DEACTIVATE_REASONS)[number]

export type NativeAppState = 'active' | 'inactive' | 'background'

export type NativeSettingsValues = Readonly<
  Record<string, string | number | boolean>
>

export type NativePluginContext = {
  readonly pluginId: string
  readonly nativeApi: number
  readonly appVersion: string
  readonly buildNumber: string
  readonly channel: string
  readonly platform: 'ios' | 'android'
  readonly settings: NativeSettingsValues
  readonly capabilities: readonly PluginCapability[]
  readonly permissions: readonly NativePermissionKind[]
}

/**
 * Lifecycle every compiled native plugin implements. Hooks must settle
 * quickly; long work belongs in a plugin-owned queue.
 */
export type NativePluginLifecycle = {
  activate: (context: NativePluginContext) => void | Promise<void>
  deactivate: (reason: NativeDeactivateReason) => void | Promise<void>
  settingsChanged: (settings: NativeSettingsValues) => void | Promise<void>
  capabilitiesChanged: (
    capabilities: readonly PluginCapability[],
  ) => void | Promise<void>
  appStateChanged: (state: NativeAppState) => void | Promise<void>
  dispose: () => void | Promise<void>
}

export const NATIVE_HOST_EVENTS = [
  'app.foreground',
  'app.background',
  'account.changed',
  'theme.changed',
  'settings.changed',
  'capabilities.changed',
  'registry.changed',
  'permission.changed',
] as const
export type NativeHostEvent = (typeof NATIVE_HOST_EVENTS)[number]

/**
 * Event payloads stay free of account identifiers, tokens and host objects.
 */
export type NativeHostEventPayloads = {
  'app.foreground': Record<string, never>
  'app.background': Record<string, never>
  'account.changed': {readonly signedIn: boolean}
  'theme.changed': {readonly scheme: 'light' | 'dark'}
  'settings.changed': {readonly pluginId: string}
  'capabilities.changed': {readonly pluginId: string}
  'registry.changed': {readonly revision: number}
  'permission.changed': {
    readonly permission: NativePermissionKind
    readonly status: NativePermissionStatus
  }
}

export const NATIVE_PRESENTATION_MODES = ['sheet', 'fullscreen'] as const
export type NativePresentationMode = (typeof NATIVE_PRESENTATION_MODES)[number]

export const NATIVE_SHEET_DETENTS = ['medium', 'large'] as const
export type NativeSheetDetent = (typeof NATIVE_SHEET_DETENTS)[number]

export type NativePresentationOptions = {
  readonly mode?: NativePresentationMode
  readonly detents?: readonly NativeSheetDetent[]
  readonly title?: string
}

export type NativeHostInfo = {
  readonly nativeApi: number
  readonly appVersion: string
  readonly buildNumber: string
  readonly channel: string
  readonly platform: 'ios' | 'android'
}

export type NativePermissionApi = {
  getStatus: (
    permission: NativePermissionKind,
  ) => Promise<NativePermissionStatus>
  request: (permission: NativePermissionKind) => Promise<NativePermissionStatus>
  openSettings: () => Promise<void>
}

export type NativeUiApi = {
  present: (
    view: string,
    props?: Readonly<Record<string, unknown>>,
    options?: NativePresentationOptions,
  ) => Promise<void>
  dismiss: (view?: string) => Promise<void>
}

export type NativeEventsApi = {
  subscribe: <E extends NativeHostEvent>(
    event: E,
    handler: (payload: NativeHostEventPayloads[E]) => void,
  ) => () => void
}

/**
 * Native host object exposed to an authorized plugin. Groups whose capability
 * is not granted are omitted rather than stubbed.
 */
export type PluginNativeHost = {
  readonly info?: NativeHostInfo
  readonly permissions?: NativePermissionApi
  readonly ui?: NativeUiApi
  readonly events?: NativeEventsApi
  log?: (message: string) => void
}

export const NATIVE_PLUGIN_ERROR_CODES = [
  'permission_denied',
  'permission_blocked',
  'unavailable',
  'cancelled',
  'invalid_argument',
  'too_large',
  'native_error',
  'host_shutdown',
] as const
export type NativePluginErrorCode = (typeof NATIVE_PLUGIN_ERROR_CODES)[number]

export type NativePluginError = Error & {
  readonly code: NativePluginErrorCode
}

export type NativePluginViewEventPayload = Readonly<Record<string, unknown>>

export type NativePluginViewProps = {
  readonly pluginId: string
  readonly view: string
  readonly heightMode?: 'fixed' | 'content'
  readonly props?: Readonly<Record<string, unknown>>
  readonly accessibilityLabel?: string
  readonly accessibilityHint?: string
  readonly onEvent?: (
    name: string,
    payload: NativePluginViewEventPayload,
  ) => void
  readonly onResize?: (height: number) => void
  readonly onError?: (code: NativePluginErrorCode, message: string) => void
}

export type NativePluginSurfaceProps = NativePluginViewProps & {
  readonly visible: boolean
  readonly presentation?: NativePresentationOptions
  readonly onDismiss: () => void
}
