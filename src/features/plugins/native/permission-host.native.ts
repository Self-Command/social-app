import {PluginNativeHost} from '../../../../modules/plugin-native-host'
import {type PluginPermissionHost} from './permissions'

export function loadPermissionHost(): PluginPermissionHost | undefined {
  return PluginNativeHost
}
