import {type ComponentType} from 'react'
import {requireNativeViewManager} from 'expo-modules-core'

import {type NativePluginRegistryEntry} from './registry'

export type NativeViewLoadFailure =
  'native_view_not_found' | 'native_view_load_failed'

export type ResolvedNativeView =
  | {
      status: 'resolved'
      moduleName: string
      Component: ComponentType<Record<string, unknown>>
    }
  | {status: 'missing'; reason: NativeViewLoadFailure}

type ExpoViewConfigHost = {
  getViewConfig?: (moduleName: string, viewName: string) => unknown
}

const viewCache = new Map<string, ComponentType<Record<string, unknown>>>()

function findViewModule(
  entry: NativePluginRegistryEntry,
  viewName: string,
): string | undefined {
  const expo = (globalThis as {expo?: ExpoViewConfigHost}).expo
  if (typeof expo?.getViewConfig === 'function') {
    for (const moduleName of entry.modules) {
      try {
        if (expo.getViewConfig(moduleName, viewName)) {
          return moduleName
        }
      } catch {
        // A module that is not linked cannot expose a view config.
      }
    }
    /*
     * The config host is unavailable in some runtimes (Jest polyfill, older
     * clients). Single-module entries are unambiguous and resolve directly.
     */
    return entry.modules.length === 1 ? entry.modules[0] : undefined
  }

  /*
   * Registry entries do not carry a view-to-module map. Builds with a single
   * module, which is the supported layout, resolve directly; multi-module
   * entries rely on the Expo view config probe above.
   */
  return entry.modules.length === 1 ? entry.modules[0] : undefined
}

/**
 * Loads one compiled plugin view. Only exported from the generated registry,
 * so JavaScript cannot name an arbitrary native module.
 */
export function resolveNativeView(
  entry: NativePluginRegistryEntry,
  viewName: string,
): ResolvedNativeView {
  if (!entry.views.some(view => view.name === viewName)) {
    return {status: 'missing', reason: 'native_view_not_found'}
  }

  const moduleName = findViewModule(entry, viewName)
  if (!moduleName) {
    return {status: 'missing', reason: 'native_view_not_found'}
  }

  const cacheKey = `${moduleName}:${viewName}`
  let Component = viewCache.get(cacheKey)
  if (!Component) {
    try {
      Component = requireNativeViewManager(
        moduleName,
        viewName,
      ) as ComponentType<Record<string, unknown>>
    } catch {
      return {status: 'missing', reason: 'native_view_load_failed'}
    }
    viewCache.set(cacheKey, Component)
  }

  return {status: 'resolved', moduleName, Component}
}

/** Drops cached components after a development-time plugin rebuild. */
export function clearNativeViewCache(): void {
  viewCache.clear()
}
