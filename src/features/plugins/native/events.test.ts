import {isNativePluginError} from './errors'
import {createNativeEventBus, createPluginEvents} from './events'
import {
  NATIVE_HOST_EVENTS,
  type NativeHostEvent,
  type NativeHostEventPayloads,
  type NativePluginError,
} from './types'

const PLUGIN_ID = 'com.example.voicecomment'
const OTHER_PLUGIN_ID = 'com.example.keywordalerts'
const CHINESE_TEXT = /[\u4e00-\u9fff]/

type EventCase = {
  [E in NativeHostEvent]: readonly [E, NativeHostEventPayloads[E]]
}[NativeHostEvent]

const EVENT_CASES: EventCase[] = [
  ['app.foreground', {}],
  ['app.background', {}],
  ['account.changed', {signedIn: true}],
  ['theme.changed', {scheme: 'dark'}],
  ['settings.changed', {pluginId: PLUGIN_ID}],
  ['capabilities.changed', {pluginId: PLUGIN_ID}],
  ['registry.changed', {revision: 2}],
  ['permission.changed', {permission: 'camera', status: 'granted'}],
]

function captureThrown(fn: () => void): NativePluginError {
  try {
    fn()
  } catch (error) {
    if (!isNativePluginError(error)) {
      throw new Error('expected a NativePluginError to be thrown')
    }
    return error
  }
  throw new Error('expected the function to throw')
}

describe('native host event bus', () => {
  test('delivers every whitelisted event to its subscriber', () => {
    const bus = createNativeEventBus()

    expect(EVENT_CASES.map(([event]) => event)).toEqual([...NATIVE_HOST_EVENTS])

    for (const [event, payload] of EVENT_CASES) {
      const handler = jest.fn()
      const unsubscribe = bus.subscribe(PLUGIN_ID, event, handler)

      bus.emit(event, payload)

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(payload)

      unsubscribe()
    }
  })

  test('rejects unknown events when subscribing', () => {
    const bus = createNativeEventBus()
    const handler = jest.fn()

    const error = captureThrown(() =>
      bus.subscribe(PLUGIN_ID, 'plugin.custom' as NativeHostEvent, handler),
    )

    expect(error.code).toBe('invalid_argument')
    expect(error.message).toMatch(CHINESE_TEXT)
    expect(handler).not.toHaveBeenCalled()
  })

  test('rejects unknown events when emitting', () => {
    const bus = createNativeEventBus()

    const error = captureThrown(() =>
      bus.emit('plugin.custom' as NativeHostEvent, {}),
    )

    expect(error.code).toBe('invalid_argument')
    expect(error.message).toMatch(CHINESE_TEXT)
  })

  test('stops delivery after unsubscribe and tolerates repeated calls', () => {
    const bus = createNativeEventBus()
    const handler = jest.fn()
    const unsubscribe = bus.subscribe(PLUGIN_ID, 'theme.changed', handler)

    bus.emit('theme.changed', {scheme: 'dark'})
    expect(handler).toHaveBeenCalledTimes(1)

    unsubscribe()
    bus.emit('theme.changed', {scheme: 'light'})
    expect(handler).toHaveBeenCalledTimes(1)

    expect(() => unsubscribe()).not.toThrow()
  })

  test('keeps multiple subscriptions for the same plugin and event independent', () => {
    const bus = createNativeEventBus()
    const first = jest.fn()
    const second = jest.fn()
    const offFirst = bus.subscribe(PLUGIN_ID, 'settings.changed', first)
    bus.subscribe(PLUGIN_ID, 'settings.changed', second)

    offFirst()
    bus.emit('settings.changed', {pluginId: PLUGIN_ID})

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  test('catches handler failures and keeps delivering to everyone else', () => {
    const onHandlerError = jest.fn()
    const bus = createNativeEventBus({onHandlerError})
    const failure = new Error('handler failed')
    const failing = jest.fn(() => {
      throw failure
    })
    const samePlugin = jest.fn()
    const otherPlugin = jest.fn()

    bus.subscribe(PLUGIN_ID, 'theme.changed', failing)
    bus.subscribe(PLUGIN_ID, 'theme.changed', samePlugin)
    bus.subscribe(OTHER_PLUGIN_ID, 'theme.changed', otherPlugin)

    expect(() => bus.emit('theme.changed', {scheme: 'dark'})).not.toThrow()

    expect(samePlugin).toHaveBeenCalledTimes(1)
    expect(otherPlugin).toHaveBeenCalledTimes(1)
    expect(onHandlerError).toHaveBeenCalledTimes(1)
    expect(onHandlerError).toHaveBeenCalledWith(
      PLUGIN_ID,
      'theme.changed',
      failure,
    )
  })

  test('keeps plugins isolated from each other', () => {
    const bus = createNativeEventBus()
    const first = jest.fn()
    const second = jest.fn()
    bus.subscribe(PLUGIN_ID, 'theme.changed', first)
    bus.subscribe(OTHER_PLUGIN_ID, 'app.background', second)

    bus.emit('theme.changed', {scheme: 'dark'})

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  test('rejects payloads that expose account, token or device identifiers', () => {
    const bus = createNativeEventBus()
    const handler = jest.fn()
    bus.subscribe(PLUGIN_ID, 'theme.changed', handler)

    for (const key of [
      'did',
      'handle',
      'token',
      'accessToken',
      'refreshToken',
      'deviceId',
    ]) {
      const payload = {
        scheme: 'dark',
        [key]: 'secret',
      } as unknown as NativeHostEventPayloads['theme.changed']

      const error = captureThrown(() => bus.emit('theme.changed', payload))

      expect(error.code).toBe('invalid_argument')
      expect(error.message).toMatch(CHINESE_TEXT)
    }

    expect(handler).not.toHaveBeenCalled()
  })

  test('rejects sensitive keys one level down without deep recursion', () => {
    const bus = createNativeEventBus()
    const handler = jest.fn()
    bus.subscribe(PLUGIN_ID, 'theme.changed', handler)

    const payload = {
      scheme: 'dark',
      detail: {token: 'secret'},
    } as unknown as NativeHostEventPayloads['theme.changed']

    const error = captureThrown(() => bus.emit('theme.changed', payload))

    expect(error.code).toBe('invalid_argument')
    expect(handler).not.toHaveBeenCalled()
  })

  test('rejects payloads that are not plain objects', () => {
    const bus = createNativeEventBus()
    const handler = jest.fn()
    bus.subscribe(PLUGIN_ID, 'app.foreground', handler)

    for (const payload of [null, [], 'active', new Date()]) {
      const error = captureThrown(() =>
        bus.emit('app.foreground', payload as never),
      )

      expect(error.code).toBe('invalid_argument')
    }

    expect(handler).not.toHaveBeenCalled()
  })

  test('clears subscriptions for one plugin or for every plugin', () => {
    const bus = createNativeEventBus()
    const first = jest.fn()
    const second = jest.fn()
    bus.subscribe(PLUGIN_ID, 'app.foreground', first)
    bus.subscribe(OTHER_PLUGIN_ID, 'app.foreground', second)

    bus.clear(PLUGIN_ID)
    bus.emit('app.foreground', {})
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    bus.clear()
    bus.emit('app.foreground', {})
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('plugin events view', () => {
  test('is absent without the events.subscribe capability', () => {
    const bus = createNativeEventBus()

    expect(
      createPluginEvents({pluginId: PLUGIN_ID, capabilities: [], bus}),
    ).toBeUndefined()
    expect(
      createPluginEvents({
        pluginId: PLUGIN_ID,
        capabilities: ['feed.read'],
        bus,
      }),
    ).toBeUndefined()
    expect(
      createPluginEvents({
        pluginId: PLUGIN_ID,
        capabilities: ['events.subscribe'],
        bus,
      }),
    ).toBeDefined()
  })

  test('scopes subscriptions to the owning plugin and releases them', () => {
    const bus = createNativeEventBus()
    const events = createPluginEvents({
      pluginId: PLUGIN_ID,
      capabilities: ['events.subscribe'],
      bus,
    })
    if (!events) throw new Error('expected an events view')
    const handler = jest.fn()
    const unsubscribe = events.subscribe('registry.changed', handler)

    bus.emit('registry.changed', {revision: 2})
    expect(handler).toHaveBeenCalledWith({revision: 2})

    unsubscribe()
    bus.emit('registry.changed', {revision: 3})
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('dispose releases every subscription and blocks new ones', () => {
    const bus = createNativeEventBus()
    const events = createPluginEvents({
      pluginId: PLUGIN_ID,
      capabilities: ['events.subscribe'],
      bus,
    })
    if (!events) throw new Error('expected an events view')
    const first = jest.fn()
    const second = jest.fn()
    events.subscribe('app.foreground', first)
    events.subscribe('app.background', second)

    events.dispose()
    bus.emit('app.foreground', {})
    bus.emit('app.background', {})

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    expect(() => events.dispose()).not.toThrow()

    const error = captureThrown(() => events.subscribe('app.foreground', first))

    expect(error.code).toBe('host_shutdown')
    expect(error.message).toMatch(CHINESE_TEXT)
  })

  test('reports plugin handler failures to both the plugin and the bus', () => {
    const busOnError = jest.fn()
    const pluginOnError = jest.fn()
    const bus = createNativeEventBus({onHandlerError: busOnError})
    const events = createPluginEvents({
      pluginId: PLUGIN_ID,
      capabilities: ['events.subscribe'],
      bus,
      onHandlerError: pluginOnError,
    })
    if (!events) throw new Error('expected an events view')
    const failure = new Error('plugin handler failed')
    const failing = jest.fn(() => {
      throw failure
    })
    const healthy = jest.fn()

    events.subscribe('permission.changed', failing)
    events.subscribe('permission.changed', healthy)

    expect(() =>
      bus.emit('permission.changed', {
        permission: 'camera',
        status: 'granted',
      }),
    ).not.toThrow()

    expect(healthy).toHaveBeenCalledTimes(1)
    expect(pluginOnError).toHaveBeenCalledTimes(1)
    expect(pluginOnError).toHaveBeenCalledWith(failure)
    expect(busOnError).toHaveBeenCalledTimes(1)
    expect(busOnError).toHaveBeenCalledWith(
      PLUGIN_ID,
      'permission.changed',
      failure,
    )
  })
})
