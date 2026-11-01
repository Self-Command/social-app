import {createContext, type ReactNode, useContext, useMemo} from 'react'

import {NATIVE_PLUGIN_REGISTRY} from '../generated/native-registry'
import {pluginLogger, summarizeError} from '../runtime/log'
import {type NativeViewLoadFailure} from './native-view-resolver'
import {type NativePluginRegistryEntry} from './registry'
import {type NativePluginError} from './types'

export type NativeViewDiagnostic = NativeViewLoadFailure

export type NativePluginViewContextValue = {
  readonly entries: readonly NativePluginRegistryEntry[]
  readonly reportDiagnostic: (
    pluginId: string,
    reason: NativeViewDiagnostic,
  ) => void
  readonly reportError: (pluginId: string, error: NativePluginError) => void
  readonly reportSuccess?: (pluginId: string) => void
}

const DEFAULT_CONTEXT: NativePluginViewContextValue = {
  entries: NATIVE_PLUGIN_REGISTRY,
  reportDiagnostic(pluginId, reason) {
    pluginLogger.warn('Native plugin view skipped', {pluginId, reason})
  },
  reportError(pluginId, error) {
    pluginLogger.error('Native plugin view failed', {
      pluginId,
      code: error.code,
      error: summarizeError(error),
    })
  },
}

const NativePluginViewContext =
  createContext<NativePluginViewContextValue>(DEFAULT_CONTEXT)

export function useNativePluginViewContext(): NativePluginViewContextValue {
  return useContext(NativePluginViewContext)
}

export function NativePluginViewProvider({
  children,
  entries,
  reportDiagnostic,
  reportError,
  reportSuccess,
}: {
  children: ReactNode
  entries?: readonly NativePluginRegistryEntry[]
  reportDiagnostic?: NativePluginViewContextValue['reportDiagnostic']
  reportError?: NativePluginViewContextValue['reportError']
  reportSuccess?: NativePluginViewContextValue['reportSuccess']
}) {
  const value = useMemo<NativePluginViewContextValue>(
    () => ({
      entries: entries ?? DEFAULT_CONTEXT.entries,
      reportDiagnostic: reportDiagnostic ?? DEFAULT_CONTEXT.reportDiagnostic,
      reportError: reportError ?? DEFAULT_CONTEXT.reportError,
      reportSuccess,
    }),
    [entries, reportDiagnostic, reportError, reportSuccess],
  )

  return (
    <NativePluginViewContext.Provider value={value}>
      {children}
    </NativePluginViewContext.Provider>
  )
}
