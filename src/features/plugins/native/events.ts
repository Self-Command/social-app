import {type PluginCapability} from '../catalog/capabilities'
import {createNativePluginError} from './errors'
import {
  NATIVE_HOST_EVENTS,
  type NativeEventsApi,
  type NativeHostEvent,
  type NativeHostEventPayloads,
} from './types'

export type NativeHostEventHandler<E extends NativeHostEvent> = (
  payload: NativeHostEventPayloads[E],
) => void

export type NativeEventBus = {
  subscribe<E extends NativeHostEvent>(
    pluginId: string,
    event: E,
    handler: NativeHostEventHandler<E>,
  ): () => void
  emit<E extends NativeHostEvent>(
    event: E,
    payload: NativeHostEventPayloads[E],
  ): void
  /**
   * Releases every subscription of one plugin, or every plugin when no id is
   * given. Used on account switches, unload and host shutdown.
   */
  clear(pluginId?: string): void
}

export type PluginEventsApi = NativeEventsApi & {
  /**
   * Releases every subscription made through this plugin view. Safe to call
   * more than once.
   */
  dispose: () => void
}

const SENSITIVE_PAYLOAD_KEYS = new Set([
  'did',
  'handle',
  'token',
  'accessToken',
  'refreshToken',
  'deviceId',
])

type StoredHandler = (payload: never) => void

function isNativeHostEvent(value: unknown): value is NativeHostEvent {
  return (
    typeof value === 'string' &&
    (NATIVE_HOST_EVENTS as readonly string[]).includes(value)
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertNoSensitiveKeys(value: Record<string, unknown>) {
  for (const key of Object.keys(value)) {
    if (SENSITIVE_PAYLOAD_KEYS.has(key)) {
      throw createNativePluginError(
        'invalid_argument',
        '事件载荷包含敏感信息，已拒绝分发。',
      )
    }
  }
}

/*
 * Payloads are shallow by contract: a plain object whose own keys, plus one
 * nested level, are free of account identifiers, tokens and device ids.
 */
function assertSafePayload(payload: unknown): void {
  if (!isPlainRecord(payload)) {
    throw createNativePluginError(
      'invalid_argument',
      '事件载荷格式无效，无法分发。',
    )
  }
  assertNoSensitiveKeys(payload)
  for (const value of Object.values(payload)) {
    if (isPlainRecord(value)) {
      assertNoSensitiveKeys(value)
    }
  }
}

/**
 * Host-side event bus. Plugins never emit and never see other plugins'
 * subscriptions; the host bridges native events into `emit` and hands each
 * plugin only its own view created by `createPluginEvents`.
 */
export function createNativeEventBus(
  options: {
    onHandlerError?: (
      pluginId: string,
      event: NativeHostEvent,
      error: unknown,
    ) => void
  } = {},
): NativeEventBus {
  const subscriptions = new Map<
    string,
    Map<NativeHostEvent, Set<StoredHandler>>
  >()

  function reportHandlerError(
    pluginId: string,
    event: NativeHostEvent,
    error: unknown,
  ) {
    try {
      options.onHandlerError?.(pluginId, event, error)
    } catch {
      /*
       * The host reporter must not interrupt delivery to other handlers.
       */
    }
  }

  return {
    subscribe(pluginId, event, handler) {
      if (!isNativeHostEvent(event)) {
        throw createNativePluginError(
          'invalid_argument',
          '不支持的事件类型，无法订阅。',
        )
      }
      if (typeof handler !== 'function') {
        throw createNativePluginError(
          'invalid_argument',
          '事件处理器无效，无法订阅。',
        )
      }

      let handlers = subscriptions.get(pluginId)
      if (!handlers) {
        handlers = new Map()
        subscriptions.set(pluginId, handlers)
      }
      let bucket = handlers.get(event)
      if (!bucket) {
        bucket = new Set()
        handlers.set(event, bucket)
      }

      const stored = handler as StoredHandler
      bucket.add(stored)

      let active = true
      return () => {
        if (!active) return
        active = false
        bucket.delete(stored)
        if (bucket.size === 0) {
          handlers.delete(event)
        }
      }
    },

    emit(event, payload) {
      if (!isNativeHostEvent(event)) {
        throw createNativePluginError(
          'invalid_argument',
          '不支持的事件类型，无法分发。',
        )
      }
      assertSafePayload(payload)

      for (const [pluginId, handlers] of subscriptions) {
        const bucket = handlers.get(event)
        if (!bucket) continue
        for (const handler of Array.from(bucket)) {
          try {
            ;(handler as unknown as NativeHostEventHandler<typeof event>)(
              payload,
            )
          } catch (error) {
            reportHandlerError(pluginId, event, error)
          }
        }
      }
    },

    clear(pluginId) {
      if (pluginId === undefined) {
        subscriptions.clear()
        return
      }
      subscriptions.delete(pluginId)
    },
  }
}

/**
 * Creates the `events` view for one plugin. The view is absent unless the
 * plugin was granted `events.subscribe`, and every subscription is scoped to
 * its plugin id so events never cross plugin boundaries.
 */
export function createPluginEvents(options: {
  pluginId: string
  capabilities: readonly PluginCapability[]
  bus: NativeEventBus
  onHandlerError?: (error: unknown) => void
}): PluginEventsApi | undefined {
  if (!options.capabilities.includes('events.subscribe')) {
    return undefined
  }

  const unsubscribers = new Set<() => void>()
  let disposed = false

  return {
    subscribe<E extends NativeHostEvent>(
      event: E,
      handler: NativeHostEventHandler<E>,
    ): () => void {
      if (disposed) {
        throw createNativePluginError(
          'host_shutdown',
          '插件事件订阅已关闭，无法继续订阅。',
        )
      }

      const unsubscribe = options.bus.subscribe(
        options.pluginId,
        event,
        payload => {
          try {
            handler(payload)
          } catch (error) {
            try {
              options.onHandlerError?.(error)
            } catch {
              /*
               * The plugin reporter must not prevent the bus from recording
               * the failure.
               */
            }
            throw error
          }
        },
      )

      let active = true
      const release = () => {
        if (!active) return
        active = false
        unsubscribers.delete(release)
        unsubscribe()
      }
      unsubscribers.add(release)
      return release
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const release of Array.from(unsubscribers)) {
        release()
      }
      unsubscribers.clear()
    },
  }
}
