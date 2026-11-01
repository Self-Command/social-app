import {createNativePluginError} from './errors'
import {validateNativeViewProps} from './payload'
import {type NativePluginRegistryEntry} from './registry'
import {
  NATIVE_PRESENTATION_MODES,
  NATIVE_SHEET_DETENTS,
  type NativePluginError,
  type NativePresentationMode,
  type NativePresentationOptions,
  type NativeSheetDetent,
} from './types'

export const NATIVE_SURFACE_TITLE_MAX_LENGTH = 80

export type NativeSurfaceEntry = {
  readonly pluginId: string
  readonly view: string
  readonly props: Readonly<Record<string, unknown>>
  readonly presentation: NativePresentationOptions
}

export type NativeSurfaceManager = {
  present: (
    pluginId: string,
    view: string,
    props?: unknown,
    options?: NativePresentationOptions,
  ) => Promise<void>
  dismiss: (pluginId: string, view?: string) => Promise<void>
  /** Closes the surface owned by one plugin, e.g. on deactivate or sign out. */
  dismissPlugin: (pluginId: string) => void
  getActive: () => NativeSurfaceEntry | undefined
  subscribe: (listener: () => void) => () => void
  dispose: () => void
}

type Fail = (error: NativePluginError) => never

function normalizePresentation(
  options: NativePresentationOptions | undefined,
  fail: Fail,
): NativePresentationOptions {
  if (!options) return {}

  const raw = options as {
    mode?: unknown
    detents?: unknown
    title?: unknown
  }

  let mode: NativePresentationMode | undefined
  if (raw.mode !== undefined) {
    if (
      typeof raw.mode !== 'string' ||
      !(NATIVE_PRESENTATION_MODES as readonly string[]).includes(raw.mode)
    ) {
      fail(
        createNativePluginError(
          'invalid_argument',
          '插件界面呈现方式无效，无法打开。',
        ),
      )
    }
    mode = raw.mode as NativePresentationMode
  }

  let detents: NativeSheetDetent[] | undefined
  if (raw.detents !== undefined) {
    if (!Array.isArray(raw.detents)) {
      fail(
        createNativePluginError(
          'invalid_argument',
          '插件界面高度档位无效，无法打开。',
        ),
      )
    }
    detents = []
    for (const detent of raw.detents) {
      if (
        typeof detent !== 'string' ||
        !(NATIVE_SHEET_DETENTS as readonly string[]).includes(detent)
      ) {
        fail(
          createNativePluginError(
            'invalid_argument',
            '插件界面高度档位无效，无法打开。',
          ),
        )
      }
      if (!detents.includes(detent as NativeSheetDetent)) {
        detents.push(detent as NativeSheetDetent)
      }
    }
    if (detents.length === 0) {
      fail(
        createNativePluginError(
          'invalid_argument',
          '插件界面高度档位无效，无法打开。',
        ),
      )
    }
  }

  let title: string | undefined
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') {
      fail(
        createNativePluginError(
          'invalid_argument',
          '插件界面标题无效，无法打开。',
        ),
      )
    }
    const trimmed = raw.title.trim().slice(0, NATIVE_SURFACE_TITLE_MAX_LENGTH)
    title = trimmed || undefined
  }

  return {mode, detents, title}
}

/**
 * Runs a synchronous operation and reports failures as a rejected promise, so
 * the async surface API never throws synchronously.
 */
function settle(operation: () => void): Promise<void> {
  try {
    operation()
    return Promise.resolve()
  } catch (error) {
    if (error instanceof Error) {
      return Promise.reject(error)
    }
    return Promise.reject(new Error('Native surface operation failed'))
  }
}

/**
 * One host-owned surface at a time. Every call is bound to the plugin that
 * presented it, so a plugin can never close or replace another plugin's view.
 */
export function createNativeSurfaceManager(options: {
  getPlugin: (pluginId: string) => NativePluginRegistryEntry | undefined
  onError?: (pluginId: string, error: NativePluginError) => void
}): NativeSurfaceManager {
  const listeners = new Set<() => void>()
  let active: NativeSurfaceEntry | undefined
  let disposed = false

  function notify() {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        // A broken subscriber must not block the remaining listeners.
      }
    }
  }

  function fail(pluginId: string, error: NativePluginError): never {
    try {
      options.onError?.(pluginId, error)
    } catch {
      // Reporting must not change the rejection seen by the plugin.
    }
    throw error
  }

  function assertAlive(pluginId: string) {
    if (disposed) {
      fail(
        pluginId,
        createNativePluginError(
          'host_shutdown',
          '插件界面服务已关闭，无法继续操作。',
        ),
      )
    }
  }

  return {
    present(pluginId, view, props, presentationOptions) {
      return settle(() => {
        assertAlive(pluginId)

        const plugin = options.getPlugin(pluginId)
        if (!plugin || !plugin.views.some(item => item.name === view)) {
          fail(
            pluginId,
            createNativePluginError(
              'invalid_argument',
              '插件视图未注册，无法打开。',
            ),
          )
        }

        const propsResult = validateNativeViewProps(props)
        if (!propsResult.ok) {
          fail(pluginId, propsResult.error)
        }

        const presentation = normalizePresentation(presentationOptions, error =>
          fail(pluginId, error),
        )

        if (active && (active.pluginId !== pluginId || active.view !== view)) {
          fail(
            pluginId,
            createNativePluginError(
              'unavailable',
              '已有插件界面处于打开状态，请先关闭后再试。',
            ),
          )
        }

        active = {
          pluginId,
          view,
          props: propsResult.value,
          presentation,
        }
        notify()
      })
    },

    dismiss(pluginId, view) {
      return settle(() => {
        assertAlive(pluginId)
        if (!active) {
          fail(
            pluginId,
            createNativePluginError(
              'invalid_argument',
              '当前没有可关闭的插件界面。',
            ),
          )
        }
        if (active.pluginId !== pluginId) {
          fail(
            pluginId,
            createNativePluginError(
              'invalid_argument',
              '只能关闭当前插件自己的界面。',
            ),
          )
        }
        if (view !== undefined && active.view !== view) {
          fail(
            pluginId,
            createNativePluginError(
              'invalid_argument',
              '只能关闭当前打开的插件视图。',
            ),
          )
        }

        active = undefined
        notify()
      })
    },

    dismissPlugin(pluginId) {
      if (active?.pluginId !== pluginId) return
      active = undefined
      notify()
    },

    getActive() {
      return active
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      active = undefined
      notify()
      listeners.clear()
    },
  }
}
