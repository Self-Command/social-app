import {type ReactElement} from 'react'
import {type AppStateStatus, Text} from 'react-native'
import {act, render, screen} from '@testing-library/react-native'

jest.mock('react-native-reanimated', () => {
  const mockReactNative =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    __esModule: true,
    default: mockReactNative.Animated,
    useReducedMotion: () => false,
  }
})

import {
  buildNativePluginLock,
  type NativePluginLock,
  type NativePluginLockEntry,
} from '../native/lock'
import {type NativePluginRegistryEntry} from '../native/registry'
import {
  type NativeAppState,
  type NativeDeactivateReason,
  type NativePluginContext,
  type NativePluginLifecycle,
} from '../native/types'
import {
  type PluginCapability,
  type PluginDefinition,
  type PluginManifest,
  type PluginPlatform,
  type PluginSettingField,
  type PluginSlotComponent,
  type PluginSlotProps,
  type PluginStorage,
} from '../sdk'
import {type PluginAppStateSource} from './app-state'
import {pluginLogger} from './log'
import {usePluginHost} from './plugin-context'
import {
  PluginProvider,
  type PluginProviderNativeOptions,
} from './PluginProvider'
import {PluginSlot} from './PluginSlot'
import {
  createPluginRegistryClient,
  type PluginRegistryClient,
  type PluginRegistryHttpResponse,
  type PluginRegistryRequestInit,
} from './registry-client'
import {
  type CachedPluginRegistry,
  type PluginRegistryEntry,
  type PluginRegistrySyncResult,
} from './registry-types'
import {type PluginStorageFactory} from './resolve'
import {type PluginStorageOptions} from './storage'

jest.mock('react-native-mmkv', () => ({
  MMKV: class MMKVMock {
    private store = new Map<string, string>()

    set(key: string, value: string) {
      this.store.set(key, value)
    }

    getString(key: string) {
      return this.store.get(key)
    }

    delete(key: string) {
      return this.store.delete(key)
    }

    clearAll() {
      this.store.clear()
    }

    addOnValueChangedListener() {
      return {remove: () => {}}
    }
  },
}))

let mockCurrentAccount: {did: string} | null = {did: 'did:plc:alice'}
jest.mock('#/state/session', () => ({
  useSession: () => ({
    accounts: mockCurrentAccount ? [mockCurrentAccount] : [],
    currentAccount: mockCurrentAccount,
    hasSession: mockCurrentAccount !== null,
  }),
}))

const ALICE = 'did:plc:alice'
const GENERATED_AT = '2026-10-31T12:00:00.000Z'
const FOOTER_CONTEXT = {
  uri: 'at://did:plc:alice/app.bsky.feed.post/1',
  cid: 'cid-1',
  authorDid: 'did:plc:alice',
  authorHandle: 'alice.test',
  text: '你好',
  createdAt: '2026-10-31T12:00:00.000Z',
}

type FooterComponent = PluginSlotComponent<'feed.item.footer'>

function textFooter(label: string): FooterComponent {
  return function Footer() {
    return <Text testID={`plugin-${label}`}>{label}</Text>
  }
}

function StorageFooter({
  capabilities,
  host,
}: PluginSlotProps<'feed.item.footer'>) {
  return (
    <Text testID="plugin-storage">
      {capabilities.join('+')}:{host.storage ? 'storage' : 'none'}
    </Text>
  )
}

function SettingsFooter({settings}: PluginSlotProps<'feed.item.footer'>) {
  return (
    <Text testID="plugin-settings">
      {[
        settings.title,
        String(settings.count),
        String(settings.enabled),
        settings.mode,
      ].join('|')}
    </Text>
  )
}

function definition(
  id: string,
  Component: FooterComponent,
  overrides: {
    capabilities?: PluginCapability[]
    platforms?: PluginPlatform[]
    settings?: PluginSettingField[]
  } = {},
): PluginDefinition {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      description: 'Test plugin',
      version: '1.0.0',
      hostApi: 2,
      platforms: overrides.platforms ?? ['ios', 'android', 'web'],
      slots: [{id: 'feed.item.footer', order: 1}],
      capabilities: overrides.capabilities ?? ['feed.read'],
      settings: overrides.settings ?? [],
    },
    slots: {'feed.item.footer': Component},
  }
}

const NATIVE_ID = 'com.example.voice'
const NATIVE_PACKAGE = '@community-plugins/voice'

function nativeDefinition(
  lifecycle: Partial<NativePluginLifecycle> = {},
): PluginDefinition {
  const manifest: PluginManifest = {
    schemaVersion: 2,
    id: NATIVE_ID,
    name: '语音评论',
    description: '在信息流中录制语音评论。',
    version: '1.0.0',
    hostApi: 2,
    nativeApi: 1,
    platforms: ['ios'],
    slots: [{id: 'feed.item.footer', order: 1}],
    capabilities: [],
    settings: [],
    native: {
      package: NATIVE_PACKAGE,
      modules: ['VoiceModule'],
      views: [{name: 'VoiceView', heightMode: 'content'}],
      permissions: [{name: 'microphone', reason: '录制语音需要使用麦克风。'}],
      minAppVersion: '1.0.0',
      network: {outbound: []},
    },
  }
  return {
    manifest,
    slots: {'feed.item.footer': textFooter('native')},
    native: lifecycle,
  }
}

function nativeLockEntry(
  overrides: Partial<NativePluginLockEntry> = {},
): NativePluginLockEntry {
  return {
    id: NATIVE_ID,
    version: '1.0.0',
    commit: 'a'.repeat(40),
    manifestHash: `sha256:${'1'.repeat(64)}`,
    packageHash: `sha256:${'2'.repeat(64)}`,
    hostApi: 2,
    nativeApi: 1,
    modules: ['VoiceModule'],
    views: [{name: 'VoiceView', heightMode: 'content'}],
    ...overrides,
  }
}

function nativeLock(
  overrides: Partial<NativePluginLockEntry> = {},
): NativePluginLock {
  return buildNativePluginLock([nativeLockEntry(overrides)])
}

const NATIVE_REGISTRY: readonly NativePluginRegistryEntry[] = [
  {
    id: NATIVE_ID,
    version: '1.0.0',
    nativeApi: 1,
    packageName: NATIVE_PACKAGE,
    modules: ['VoiceModule'],
    views: [{name: 'VoiceView', heightMode: 'content'}],
  },
]

const NATIVE_OPTIONS: PluginProviderNativeOptions = {
  registry: NATIVE_REGISTRY,
  lock: nativeLock(),
  hostInfo: {
    nativeApi: 1,
    appVersion: '1.0.0',
    buildNumber: '1',
    channel: 'production',
    platform: 'ios',
  },
}

function nativeRegistryEntry(
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return registryEntry(NATIVE_ID, {
    platforms: ['ios'],
    capabilities: [],
    ...overrides,
  })
}

function registryEntry(
  id: string,
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return {
    id,
    version: '1.0.0',
    hostApi: 2,
    platforms: ['ios', 'android', 'web'],
    capabilities: ['feed.read'],
    settings: {},
    ...overrides,
  }
}

function cachedRegistry(
  revision: number,
  plugins: PluginRegistryEntry[],
): CachedPluginRegistry {
  return {
    etag: `"rev-${revision}"`,
    snapshot: {revision, generatedAt: GENERATED_AT, plugins},
  }
}

type FakeRegistryClient = {
  client: PluginRegistryClient
  sync: jest.Mock<Promise<PluginRegistrySyncResult>, [CachedPluginRegistry?]>
  loadCached: jest.Mock<Promise<CachedPluginRegistry | undefined>, []>
  enqueue: (result: PluginRegistrySyncResult) => void
}

function fakeRegistryClient(
  initial?: CachedPluginRegistry,
): FakeRegistryClient {
  let latest = initial
  const queued: PluginRegistrySyncResult[] = []

  const loadCached = jest.fn<Promise<CachedPluginRegistry | undefined>, []>(
    () => Promise.resolve(latest),
  )
  const sync = jest.fn<
    Promise<PluginRegistrySyncResult>,
    [CachedPluginRegistry?]
  >(() => {
    const next = queued.shift()
    if (next) {
      if (next.status === 'updated') {
        latest = next.registry
      } else if ('registry' in next && next.registry) {
        latest = next.registry
      }
      return Promise.resolve(next)
    }
    if (latest) {
      return Promise.resolve({status: 'not-modified', registry: latest})
    }
    return Promise.resolve({
      status: 'failed',
      reason: 'network',
      registry: undefined,
    })
  })

  return {
    client: {
      url: 'https://registry.example.com/xrpc/com.selfcommand.admin.plugin.public',
      enabled: true,
      loadCached,
      sync,
    },
    sync,
    loadCached,
    enqueue(result) {
      queued.push(result)
    },
  }
}

type DisabledRegistryClient = {
  client: PluginRegistryClient
  sync: jest.Mock<Promise<PluginRegistrySyncResult>, [CachedPluginRegistry?]>
}

function disabledRegistryClient(): DisabledRegistryClient {
  const loadCached = jest.fn<Promise<CachedPluginRegistry | undefined>, []>(
    () => Promise.resolve(undefined),
  )
  const sync = jest.fn<
    Promise<PluginRegistrySyncResult>,
    [CachedPluginRegistry?]
  >(() => Promise.resolve({status: 'disabled', reason: 'not-configured'}))
  return {
    client: {url: undefined, enabled: false, loadCached, sync},
    sync,
  }
}

type FakeAppState = {
  source: PluginAppStateSource
  emit: (state: AppStateStatus) => Promise<void>
}

function fakeAppState(initial: AppStateStatus | null = 'active'): FakeAppState {
  let current = initial
  const listeners = new Set<(state: AppStateStatus) => void>()
  return {
    source: {
      getCurrentState: () => current,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    async emit(state) {
      current = state
      act(() => {
        for (const listener of [...listeners]) listener(state)
      })
      await flush()
    },
  }
}

function fakeStorage(): PluginStorage {
  return {
    get: jest.fn(() => Promise.resolve(undefined)),
    set: jest.fn(() => Promise.resolve()),
    remove: jest.fn(() => Promise.resolve()),
    list: jest.fn(() => Promise.resolve([])),
    clear: jest.fn(() => Promise.resolve()),
  }
}

type ScreenProps = {
  plugins: readonly PluginDefinition[]
  client: PluginRegistryClient
  appState: FakeAppState
  platform?: PluginPlatform
  createStorage?: PluginStorageFactory
  native?: PluginProviderNativeOptions
}

function DiagnosticsProbe() {
  const host = usePluginHost()
  const skips =
    host?.nativeDiagnostics?.skips
      .map(skip => `${skip.pluginId}:${skip.reason}`)
      .join(',') ?? 'none'
  return <Text testID="native-skips">{skips}</Text>
}

function Screen({
  plugins,
  client,
  appState,
  platform = 'ios',
  createStorage,
  native,
}: ScreenProps) {
  return (
    <PluginProvider
      plugins={plugins}
      registryClient={client}
      appStateSource={appState.source}
      platform={platform}
      createStorage={createStorage}
      native={native}>
      <Text testID="provider-child">child</Text>
      <DiagnosticsProbe />
      <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />
    </PluginProvider>
  )
}

async function renderScreen(props: ScreenProps) {
  const result = render(<Screen {...props} />)
  await flush()
  return result
}

/** Lets the promises behind registry load/sync and resolution settle. */
async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index++) {
      await Promise.resolve()
    }
  })
}

async function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms)
  })
  await flush()
}

let warn: jest.SpyInstance
let logError: jest.SpyInstance

function warningsFor(message: string) {
  return warn.mock.calls.filter(([logged]) => logged === message)
}

/** How many render failures the host actually counted. */
function renderFailures(): number {
  return logError.mock.calls.filter(
    ([message]) => message === 'Plugin render failed',
  ).length
}

beforeEach(() => {
  jest.useFakeTimers()
  mockCurrentAccount = {did: ALICE}
  warn = jest.spyOn(pluginLogger, 'warn')
  logError = jest.spyOn(pluginLogger, 'error')
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  mockCurrentAccount = {did: ALICE}
})

describe('PluginProvider capabilities', () => {
  test('omits a plugin when the registry withholds a declared capability', async () => {
    const plugin = definition('com.example.partial', StorageFooter, {
      capabilities: ['feed.read', 'storage.local'],
    })
    const client = fakeRegistryClient(
      cachedRegistry(1, [
        registryEntry(plugin.manifest.id, {capabilities: ['feed.read']}),
      ]),
    )
    const createStorage = jest.fn<PluginStorage, [PluginStorageOptions]>(() =>
      fakeStorage(),
    )

    await renderScreen({
      plugins: [plugin],
      client: client.client,
      appState: fakeAppState(),
      createStorage,
    })

    expect(screen.getByTestId('provider-child')).toBeTruthy()
    expect(screen.queryByTestId('plugin-storage')).toBeNull()
    expect(createStorage).not.toHaveBeenCalled()
    expect(
      warningsFor('Plugin skipped').map(([, metadata]) => metadata),
    ).toEqual([{pluginId: plugin.manifest.id, reason: 'missing-capability'}])
  })

  test('grants only the manifest capabilities and injects scoped storage', async () => {
    const plugin = definition('com.example.storage', StorageFooter, {
      capabilities: ['feed.read', 'storage.local'],
    })
    const storage = fakeStorage()
    const createStorage = jest.fn<PluginStorage, [PluginStorageOptions]>(
      () => storage,
    )
    const client = fakeRegistryClient(
      cachedRegistry(1, [
        registryEntry(plugin.manifest.id, {
          capabilities: ['feed.read', 'storage.local', 'toast.show'],
        }),
      ]),
    )

    await renderScreen({
      plugins: [plugin],
      client: client.client,
      appState: fakeAppState(),
      createStorage,
    })

    expect(screen.getByText('feed.read+storage.local:storage')).toBeTruthy()
    expect(createStorage).toHaveBeenCalledTimes(1)
    expect(createStorage.mock.calls[0][0]).toEqual({
      accountDid: ALICE,
      pluginId: plugin.manifest.id,
    })
  })
})

describe('PluginProvider filtering', () => {
  test('filters by platform, hostApi and unknown registry ids', async () => {
    const webOnly = definition('com.example.web', textFooter('web'), {
      platforms: ['web'],
    })
    const newerHost = definition('com.example.api', textFooter('api'))
    const good = definition('com.example.good', textFooter('good'))
    const client = fakeRegistryClient(
      cachedRegistry(1, [
        registryEntry(webOnly.manifest.id, {platforms: ['web']}),
        registryEntry(newerHost.manifest.id, {hostApi: 3}),
        registryEntry(good.manifest.id),
        registryEntry('com.example.unknown'),
      ]),
    )

    await renderScreen({
      plugins: [webOnly, newerHost, good],
      client: client.client,
      appState: fakeAppState(),
      platform: 'ios',
    })

    expect(screen.getByTestId('plugin-good')).toBeTruthy()
    expect(screen.queryByTestId('plugin-web')).toBeNull()
    expect(screen.queryByTestId('plugin-api')).toBeNull()
    expect(screen.queryByTestId('plugin-unknown')).toBeNull()
    expect(
      warningsFor('Plugin skipped').map(([, metadata]) => metadata),
    ).toEqual([
      {pluginId: webOnly.manifest.id, reason: 'platform-mismatch'},
      {pluginId: newerHost.manifest.id, reason: 'host_api_mismatch'},
    ])
  })

  test('merges valid settings and falls back to defaults for invalid values', async () => {
    const plugin = definition('com.example.settings', SettingsFooter, {
      settings: [
        {
          key: 'title',
          type: 'string',
          label: 'Title',
          description: 'Title',
          default: 'default title',
          maxLength: 20,
        },
        {
          key: 'count',
          type: 'number',
          label: 'Count',
          description: 'Count',
          default: 5,
          min: 1,
          max: 10,
        },
        {
          key: 'enabled',
          type: 'boolean',
          label: 'Enabled',
          description: 'Enabled',
          default: false,
        },
        {
          key: 'mode',
          type: 'select',
          label: 'Mode',
          description: 'Mode',
          default: 'a',
          options: ['a', 'b'],
        },
      ],
    })
    const client = fakeRegistryClient(
      cachedRegistry(1, [
        registryEntry(plugin.manifest.id, {
          settings: {
            title: 'Hello',
            count: 99,
            enabled: 'yes',
            mode: 'b',
            extra: 'not-allowed',
          },
        }),
      ]),
    )

    await renderScreen({
      plugins: [plugin],
      client: client.client,
      appState: fakeAppState(),
    })

    expect(screen.getByText('Hello|5|false|b')).toBeTruthy()

    const settingsWarnings = warningsFor(
      'Plugin setting rejected; using default',
    ).map(([, metadata]) => metadata)
    expect(settingsWarnings).toEqual(
      expect.arrayContaining([
        {
          pluginId: plugin.manifest.id,
          key: 'count',
          reason: 'out-of-range',
        },
        {
          pluginId: plugin.manifest.id,
          key: 'enabled',
          reason: 'invalid-type',
        },
        {
          pluginId: plugin.manifest.id,
          key: 'extra',
          reason: 'unknown-setting',
        },
      ]),
    )

    // Rejected values themselves never reach the logs.
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('99')
    expect(logged).not.toContain('not-allowed')
  })
})

describe('PluginProvider degradation', () => {
  test('renders children without plugins when the registry is disabled', async () => {
    const plugin = definition('com.example.orphan', textFooter('orphan'))
    const registry = disabledRegistryClient()

    await renderScreen({
      plugins: [plugin],
      client: registry.client,
      appState: fakeAppState(),
    })

    expect(screen.getByTestId('provider-child')).toBeTruthy()
    expect(screen.queryByTestId('plugin-orphan')).toBeNull()
    expect(registry.sync).toHaveBeenCalledTimes(1)

    // No foreground polling is started without a configured registry.
    await advance(5 * 60_000)
    expect(registry.sync).toHaveBeenCalledTimes(1)
  })

  test('does not fetch or render plugins when the registry URL is empty', async () => {
    const previous = process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL
    process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL = ''
    const fetchImpl = jest.fn<
      Promise<PluginRegistryHttpResponse>,
      [string, PluginRegistryRequestInit]
    >()
    const client = createPluginRegistryClient({fetch: fetchImpl})
    const plugin = definition(
      'com.example.unconfigured',
      textFooter('unconfigured'),
    )

    try {
      expect(client.enabled).toBe(false)

      await renderScreen({
        plugins: [plugin],
        client,
        appState: fakeAppState(),
      })

      expect(screen.getByTestId('provider-child')).toBeTruthy()
      expect(screen.queryByTestId('plugin-unconfigured')).toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) {
        delete process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL
      } else {
        process.env.EXPO_PUBLIC_PLUGIN_REGISTRY_URL = previous
      }
    }
  })

  test('renders children without plugins when sync fails and there is no cache', async () => {
    const plugin = definition('com.example.offline', textFooter('offline'))
    const client = fakeRegistryClient()

    await renderScreen({
      plugins: [plugin],
      client: client.client,
      appState: fakeAppState(),
    })

    expect(screen.getByTestId('provider-child')).toBeTruthy()
    expect(screen.queryByTestId('plugin-offline')).toBeNull()
    expect(
      warningsFor('Plugin registry sync failed').map(
        ([, metadata]) => metadata,
      ),
    ).toEqual([
      expect.objectContaining({reason: 'network', httpStatus: undefined}),
    ])
  })

  test('renders no plugins or storage while signed out', async () => {
    mockCurrentAccount = null
    const plugin = definition('com.example.account', textFooter('account'))
    const client = fakeRegistryClient(
      cachedRegistry(1, [registryEntry(plugin.manifest.id)]),
    )
    const createStorage = jest.fn<PluginStorage, [PluginStorageOptions]>(() =>
      fakeStorage(),
    )

    await renderScreen({
      plugins: [plugin],
      client: client.client,
      appState: fakeAppState(),
      createStorage,
    })

    expect(screen.getByTestId('provider-child')).toBeTruthy()
    expect(screen.queryByTestId('plugin-account')).toBeNull()
    expect(createStorage).not.toHaveBeenCalled()
  })
})

describe('PluginProvider refresh', () => {
  test('polls every 60 seconds and disables a plugin missing from the new revision', async () => {
    const plugin = definition('com.example.victim', textFooter('victim'))
    const client = fakeRegistryClient(
      cachedRegistry(1, [registryEntry(plugin.manifest.id)]),
    )

    await renderScreen({
      plugins: [plugin],
      client: client.client,
      appState: fakeAppState('active'),
    })

    expect(screen.getByTestId('plugin-victim')).toBeTruthy()
    expect(client.sync).toHaveBeenCalledTimes(1)

    await advance(59_999)
    expect(client.sync).toHaveBeenCalledTimes(1)

    client.enqueue({
      status: 'updated',
      registry: cachedRegistry(2, []),
      cacheWriteFailed: false,
    })
    await advance(1)

    expect(client.sync).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('plugin-victim')).toBeNull()
    expect(screen.getByTestId('provider-child')).toBeTruthy()
  })

  test('pauses polling in the background and syncs when foregrounded', async () => {
    const client = fakeRegistryClient(cachedRegistry(1, []))
    const appState = fakeAppState('background')

    await renderScreen({
      plugins: [],
      client: client.client,
      appState,
    })

    // Startup sync only; no interval while the app starts in the background.
    expect(client.sync).toHaveBeenCalledTimes(1)
    await advance(5 * 60_000)
    expect(client.sync).toHaveBeenCalledTimes(1)

    await appState.emit('active')
    expect(client.sync).toHaveBeenCalledTimes(2)

    await advance(60_000)
    expect(client.sync).toHaveBeenCalledTimes(3)

    await appState.emit('background')
    await advance(5 * 60_000)
    expect(client.sync).toHaveBeenCalledTimes(3)
  })
})

describe('PluginProvider circuit breaker', () => {
  type BadPluginState = {shouldThrow: boolean}

  function breakerScreen(state: BadPluginState) {
    function BadFooter(): ReactElement {
      if (state.shouldThrow) throw new Error('bad render')
      return <Text testID="plugin-bad">bad fixed</Text>
    }
    function GoodFooter() {
      return <Text testID="plugin-good">good</Text>
    }
    const bad = definition('com.example.bad', BadFooter)
    const good = definition('com.example.good', GoodFooter)
    const entries = [
      registryEntry(bad.manifest.id),
      registryEntry(good.manifest.id),
    ]
    return {bad, good, entries}
  }

  test('disables only the failing plugin after 3 consecutive failures', async () => {
    const state = {shouldThrow: true}
    const {bad, good, entries} = breakerScreen(state)
    const client = fakeRegistryClient(cachedRegistry(1, entries))

    await renderScreen({
      plugins: [bad, good],
      client: client.client,
      appState: fakeAppState('active'),
    })

    expect(renderFailures()).toBe(1)
    expect(screen.getByTestId('plugin-good')).toBeTruthy()
    expect(warningsFor('Plugin disabled by circuit breaker')).toHaveLength(0)

    await advance(1000)
    expect(renderFailures()).toBe(2)
    expect(warningsFor('Plugin disabled by circuit breaker')).toHaveLength(0)

    await advance(1000)
    expect(renderFailures()).toBe(3)
    expect(warningsFor('Plugin disabled by circuit breaker')).toHaveLength(1)
    expect(screen.getByTestId('provider-child')).toBeTruthy()
    expect(screen.getByTestId('plugin-good')).toBeTruthy()

    // The broken plugin is no longer retried.
    await advance(10_000)
    expect(renderFailures()).toBe(3)
  })

  test('recovers a broken plugin after a registry refresh', async () => {
    const state = {shouldThrow: true}
    const {bad, good, entries} = breakerScreen(state)
    const client = fakeRegistryClient(cachedRegistry(1, entries))
    const appState = fakeAppState('active')

    await renderScreen({
      plugins: [bad, good],
      client: client.client,
      appState,
    })

    await advance(1000)
    await advance(1000)
    expect(renderFailures()).toBe(3)
    expect(screen.queryByTestId('plugin-bad')).toBeNull()

    state.shouldThrow = false
    client.enqueue({
      status: 'updated',
      registry: cachedRegistry(2, entries),
      cacheWriteFailed: false,
    })
    await appState.emit('active')

    expect(screen.getByTestId('plugin-bad')).toBeTruthy()
    expect(screen.getByText('bad fixed')).toBeTruthy()
    expect(screen.getByTestId('plugin-good')).toBeTruthy()
    expect(renderFailures()).toBe(3)
  })

  test('recovers a broken plugin after an app restart', async () => {
    const state = {shouldThrow: true}
    const {bad, good, entries} = breakerScreen(state)
    const client = fakeRegistryClient(cachedRegistry(1, entries))

    const first = await renderScreen({
      plugins: [bad, good],
      client: client.client,
      appState: fakeAppState('active'),
    })

    await advance(1000)
    await advance(1000)
    expect(renderFailures()).toBe(3)
    expect(screen.queryByTestId('plugin-bad')).toBeNull()

    first.unmount()
    state.shouldThrow = false

    await renderScreen({
      plugins: [bad, good],
      client: client.client,
      appState: fakeAppState('active'),
    })

    expect(screen.getByTestId('plugin-bad')).toBeTruthy()
    expect(screen.getByText('bad fixed')).toBeTruthy()
    expect(screen.getByTestId('plugin-good')).toBeTruthy()
  })
})

function lifecycleRecorder(): {
  calls: string[]
  lifecycle: jest.Mocked<NativePluginLifecycle>
} {
  const calls: string[] = []
  const lifecycle: NativePluginLifecycle = {
    activate: jest.fn((_context: NativePluginContext) => {
      calls.push('activate')
    }),
    deactivate: jest.fn((reason: NativeDeactivateReason) => {
      calls.push(`deactivate:${reason}`)
    }),
    settingsChanged: jest.fn(() => {
      calls.push('settingsChanged')
    }),
    capabilitiesChanged: jest.fn(() => {
      calls.push('capabilitiesChanged')
    }),
    appStateChanged: jest.fn((state: NativeAppState) => {
      calls.push(`appState:${state}`)
    }),
    dispose: jest.fn(() => {
      calls.push('dispose')
    }),
  }
  return {calls, lifecycle: lifecycle as jest.Mocked<NativePluginLifecycle>}
}

function nativeScreenProps(
  lifecycle: Partial<NativePluginLifecycle>,
  appState = fakeAppState('active'),
  native: PluginProviderNativeOptions = NATIVE_OPTIONS,
): ScreenProps {
  const plugin = nativeDefinition(lifecycle)
  const client = fakeRegistryClient(cachedRegistry(1, [nativeRegistryEntry()]))
  return {
    plugins: [plugin],
    client: client.client,
    appState,
    native,
  }
}

describe('PluginProvider native lifecycle', () => {
  test('activates with host context and disposes on shutdown', async () => {
    const {calls, lifecycle} = lifecycleRecorder()
    const result = await renderScreen(nativeScreenProps(lifecycle))

    expect(screen.getByTestId('plugin-native')).toBeTruthy()
    expect(lifecycle.activate).toHaveBeenCalledTimes(1)
    expect(lifecycle.activate.mock.calls[0]?.[0]).toMatchObject({
      pluginId: NATIVE_ID,
      nativeApi: 1,
      appVersion: '1.0.0',
      buildNumber: '1',
      channel: 'production',
      platform: 'ios',
      capabilities: [],
      permissions: ['microphone'],
      settings: {},
    })
    expect(calls).toEqual(['activate'])

    result.unmount()
    await flush()

    expect(calls).toEqual(['activate', 'deactivate:host_shutdown', 'dispose'])
  })

  test('deactivates in the background and reactivates in the foreground', async () => {
    const {calls, lifecycle} = lifecycleRecorder()
    const appState = fakeAppState('active')
    await renderScreen(nativeScreenProps(lifecycle, appState))

    await appState.emit('background')
    expect(calls).toEqual([
      'activate',
      'appState:background',
      'deactivate:app_background',
    ])

    await appState.emit('active')
    expect(calls).toEqual([
      'activate',
      'appState:background',
      'deactivate:app_background',
      'activate',
      'appState:active',
    ])
  })

  test('clears account state on switch and sign out', async () => {
    const {lifecycle} = lifecycleRecorder()
    const props = nativeScreenProps(lifecycle)
    const result = await renderScreen(props)
    expect(lifecycle.activate).toHaveBeenCalledTimes(1)

    // The session mock reads a module variable, so rerender with a fresh
    // plugins array: React Compiler would otherwise reuse the same element
    // and skip the provider entirely.
    mockCurrentAccount = {did: 'did:plc:bob'}
    result.rerender(<Screen {...props} plugins={[...props.plugins]} />)
    await flush()

    expect(lifecycle.deactivate).toHaveBeenCalledWith('account_changed')
    expect(lifecycle.activate).toHaveBeenCalledTimes(2)

    mockCurrentAccount = null
    result.rerender(<Screen {...props} plugins={[...props.plugins]} />)
    await flush()

    expect(lifecycle.deactivate).toHaveBeenLastCalledWith('signed_out')
    expect(lifecycle.activate).toHaveBeenCalledTimes(2)
  })

  test('unloads after two seconds when activate never settles', async () => {
    const deactivate = jest.fn(async () => {})
    const activate = jest.fn(() => new Promise<void>(() => {}))
    const appState = fakeAppState('active')

    await renderScreen(nativeScreenProps({activate, deactivate}, appState))
    expect(activate).toHaveBeenCalledTimes(1)

    await appState.emit('background')
    expect(deactivate).not.toHaveBeenCalled()

    await advance(2000)
    await flush()

    expect(deactivate).toHaveBeenCalledWith('app_background')
    expect(warningsFor('Native plugin lifecycle timed out')).toHaveLength(1)
  })

  test('tolerates a throwing dispose during shutdown', async () => {
    const dispose = jest.fn(() => {
      throw new Error('dispose failed')
    })
    const result = await renderScreen(nativeScreenProps({dispose}))

    expect(dispose).not.toHaveBeenCalled()
    result.unmount()
    await flush()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(
      warningsFor('Native plugin lifecycle hook failed').length,
    ).toBeGreaterThan(0)
  })

  test('reports native_not_compiled when the build has no lock entry', async () => {
    await renderScreen(
      nativeScreenProps({}, fakeAppState('active'), {
        registry: NATIVE_REGISTRY,
      }),
    )

    expect(screen.queryByTestId('plugin-native')).toBeNull()
    expect(screen.getByText(`${NATIVE_ID}:native_not_compiled`)).toBeTruthy()
  })
})
