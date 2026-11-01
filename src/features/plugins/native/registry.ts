import {type PluginNativeViewHeightMode} from '../sdk/types'

export type NativePluginRegistryView = Readonly<{
  name: string
  heightMode: PluginNativeViewHeightMode
}>

export type NativePluginRegistryEntry = Readonly<{
  id: string
  version: string
  nativeApi: number
  packageName: string
  modules: readonly string[]
  views: readonly NativePluginRegistryView[]
}>
