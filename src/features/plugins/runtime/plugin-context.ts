import {createContext, useContext} from 'react'

import {type NativeHostDiagnostics} from '../native/host-runtime'
import {type PluginPlatform} from '../sdk/types'
import {type ResolvedPlugin} from './resolve'

export type PluginHostContextValue = {
  plugins: readonly ResolvedPlugin[]
  platform: PluginPlatform
  /**
   * Changes whenever the registry revision or account changes. Error
   * boundaries clear their error state when this key changes.
   */
  resetKey: string
  reportFailure: (pluginId: string, error: unknown) => void
  reportSuccess: (pluginId: string) => void
  /**
   * Native lock, compiled plugins, skip reasons and recent errors for the
   * developer tools. Always absent on web.
   */
  nativeDiagnostics?: NativeHostDiagnostics
}

export const PluginHostContext = createContext<
  PluginHostContextValue | undefined
>(undefined)

export function usePluginHost(): PluginHostContextValue | undefined {
  return useContext(PluginHostContext)
}
