import {type ComponentType} from 'react'
import {type ViewProps} from 'react-native'
import {requireNativeModule, requireNativeViewManager} from 'expo-modules-core'

export type PluginNativeHostInfo = {
  nativeApi: number
  appVersion: string
  buildNumber: string
  channel: string
  platform: 'ios' | 'android'
}

export type PluginNativePermission =
  | 'microphone'
  | 'camera'
  | 'photoLibrary'
  | 'notifications'
  | 'locationWhenInUse'

export type PluginNativePermissionStatus =
  'granted' | 'denied' | 'blocked' | 'limited' | 'unavailable' | 'notDetermined'

export type PluginNativeHostEvent = {
  event: string
  payload: Record<string, unknown>
}

export type PluginNativeHostModule = {
  getInfo: () => Promise<PluginNativeHostInfo>
  getPermissionStatus: (
    permission: PluginNativePermission,
  ) => Promise<PluginNativePermissionStatus>
  requestPermission: (
    permission: PluginNativePermission,
  ) => Promise<PluginNativePermissionStatus>
  openSettings: () => Promise<void>
  hasView: (view: string) => Promise<boolean>
  addListener: (
    event: 'onHostEvent',
    listener: (event: PluginNativeHostEvent) => void,
  ) => {remove: () => void}
}

export type PluginNativeEvent = {
  pluginId: string
  event: string
  payload: unknown
}

export type PluginNativeViewProps = ViewProps & {
  pluginId: string
  view: string
  heightMode?: 'fixed' | 'content'
  /** JSON-serializable plugin props, limited to 64 KB by the JS container. */
  pluginProps?: Record<string, unknown>
  onPluginEvent?: (event: {nativeEvent: PluginNativeEvent}) => void
  onError?: (event: {nativeEvent: {code: string; message: string}}) => void
}

export const PluginNativeHost =
  requireNativeModule<PluginNativeHostModule>('PluginNativeHost')

export const PluginNativeView: ComponentType<PluginNativeViewProps> =
  requireNativeViewManager<PluginNativeViewProps>('PluginNativeHost')
