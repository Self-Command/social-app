import {
  buildNativePluginLock,
  type NativePluginLock,
  type NativePluginLockEntry,
} from '../native/lock'
import {type NativePluginRegistryEntry} from '../native/registry'
import {
  type PluginDefinition,
  type PluginManifest,
  type PluginPlatform,
  validatePluginManifest,
} from '../sdk'
import {
  type CachedPluginRegistry,
  type PluginRegistryEntry,
} from './registry-types'
import {
  comparePluginVersions,
  type PluginResolutionIssue,
  resolvePlugins,
} from './resolve'

const ACCOUNT_DID = 'did:plc:example'
const COMMIT = 'a'.repeat(40)
const MANIFEST_HASH = `sha256:${'1'.repeat(64)}`
const PACKAGE_HASH = `sha256:${'2'.repeat(64)}`

const JS_MANIFEST = {
  schemaVersion: 2,
  id: 'com.example.bookmarks',
  name: '收藏',
  description: '在信息流中保存与查看书签。',
  version: '1.0.0',
  hostApi: 2,
  platforms: ['ios', 'android', 'web'],
  slots: [{id: 'feed.item.footer', order: 10}],
  capabilities: [],
  settings: [],
} as const

const NATIVE_MANIFEST = {
  schemaVersion: 2,
  id: 'com.selfcommand.voicecomment',
  name: '语音评论',
  description: '在信息流中录制与播放语音评论。',
  version: '1.0.0',
  hostApi: 2,
  nativeApi: 1,
  platforms: ['ios', 'android'],
  slots: [{id: 'feed.item.footer', order: 10}],
  capabilities: [],
  settings: [],
  native: {
    package: '@community-plugins/voicecomment',
    modules: ['VoiceCommentModule'],
    views: [{name: 'VoiceRecorderView', heightMode: 'content'}],
    permissions: [{name: 'microphone', reason: '录制语音评论需要访问麦克风。'}],
    minAppVersion: '2.0.0',
    network: {outbound: []},
  },
} as const

function makeManifest(
  source: object,
  overrides: Record<string, unknown> = {},
): PluginManifest {
  const result = validatePluginManifest({...source, ...overrides})
  if (!result.ok) {
    throw new Error(result.errors.join('\n'))
  }
  return result.manifest
}

function makeNativeManifest(
  nativeOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): PluginManifest {
  return makeManifest(NATIVE_MANIFEST, {
    ...overrides,
    native: {...NATIVE_MANIFEST.native, ...nativeOverrides},
  })
}

function makeDefinition(manifest: PluginManifest): PluginDefinition {
  return {
    manifest,
    slots: {},
  }
}

function makeRegistryEntry(
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return {
    id: JS_MANIFEST.id,
    version: JS_MANIFEST.version,
    hostApi: JS_MANIFEST.hostApi,
    platforms: [...JS_MANIFEST.platforms],
    capabilities: [],
    settings: {},
    ...overrides,
  }
}

function makeRegistry(
  entries: PluginRegistryEntry[] = [makeRegistryEntry()],
): CachedPluginRegistry {
  return {
    etag: undefined,
    snapshot: {
      revision: 1,
      generatedAt: '2026-11-01T00:00:00.000Z',
      plugins: entries,
    },
  }
}

function makeLockEntry(
  overrides: Partial<NativePluginLockEntry> = {},
): NativePluginLockEntry {
  return {
    id: NATIVE_MANIFEST.id,
    version: NATIVE_MANIFEST.version,
    commit: COMMIT,
    manifestHash: MANIFEST_HASH,
    packageHash: PACKAGE_HASH,
    hostApi: 2,
    nativeApi: 1,
    modules: ['VoiceCommentModule'],
    views: [{name: 'VoiceRecorderView', heightMode: 'content'}],
    ...overrides,
  }
}

function makeNativeLock(
  overrides: Partial<NativePluginLockEntry> = {},
): NativePluginLock {
  return buildNativePluginLock([makeLockEntry(overrides)])
}

function makeNativeRegistryEntry(
  overrides: Partial<NativePluginRegistryEntry> = {},
): NativePluginRegistryEntry {
  return {
    id: NATIVE_MANIFEST.id,
    version: NATIVE_MANIFEST.version,
    nativeApi: NATIVE_MANIFEST.nativeApi,
    packageName: NATIVE_MANIFEST.native.package,
    modules: ['VoiceCommentModule'],
    views: [{name: 'VoiceRecorderView', heightMode: 'content'}],
    ...overrides,
  }
}

function reasons(issues: readonly PluginResolutionIssue[]): string[] {
  return issues.map(issue => issue.reason)
}

function resolveNative({
  manifest = makeNativeManifest(),
  registryEntry = makeRegistryEntry({
    id: NATIVE_MANIFEST.id,
    version: NATIVE_MANIFEST.version,
    platforms: [...NATIVE_MANIFEST.platforms],
  }),
  nativeLock = makeNativeLock(),
  nativeRegistry = [makeNativeRegistryEntry()],
  platform = 'ios',
  appVersion = '2.1.0',
}: {
  manifest?: PluginManifest
  registryEntry?: PluginRegistryEntry
  nativeLock?: NativePluginLock | null
  nativeRegistry?: readonly NativePluginRegistryEntry[] | null
  platform?: PluginPlatform
  appVersion?: string
} = {}) {
  return resolvePlugins({
    definitions: [makeDefinition(manifest)],
    registry: makeRegistry([registryEntry]),
    platform,
    accountDid: ACCOUNT_DID,
    nativeLock: nativeLock === null ? undefined : nativeLock,
    nativeRegistry: nativeRegistry === null ? undefined : nativeRegistry,
    appVersion,
  })
}

describe('resolvePlugins', () => {
  test('returns nothing without a registry or account', () => {
    const definition = makeDefinition(makeManifest(JS_MANIFEST))

    expect(
      resolvePlugins({
        definitions: [definition],
        registry: undefined,
        platform: 'ios',
        accountDid: ACCOUNT_DID,
      }),
    ).toEqual({plugins: [], issues: []})

    expect(
      resolvePlugins({
        definitions: [definition],
        registry: makeRegistry(),
        platform: 'ios',
        accountDid: undefined,
      }),
    ).toEqual({plugins: [], issues: []})
  })

  test('resolves a pure JS plugin without a native lock', () => {
    const result = resolvePlugins({
      definitions: [makeDefinition(makeManifest(JS_MANIFEST))],
      registry: makeRegistry(),
      platform: 'ios',
      accountDid: ACCOUNT_DID,
    })

    expect(result.issues).toEqual([])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]?.definition.manifest.id).toBe(JS_MANIFEST.id)
    expect(result.plugins[0]?.capabilities).toEqual([])
  })

  test('resolves a native plugin when manifest, registry and lock agree', () => {
    const result = resolveNative()

    expect(result.issues).toEqual([])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]?.definition.manifest.id).toBe(NATIVE_MANIFEST.id)
  })

  test('skips a native plugin without a compiled lock', () => {
    const result = resolveNative({nativeLock: null})
    expect(reasons(result.issues)).toEqual(['native_not_compiled'])
  })

  test('skips a native plugin missing from the registry', () => {
    const result = resolveNative({
      registryEntry: makeRegistryEntry({id: 'com.example.other'}),
    })
    expect(reasons(result.issues)).toEqual(['missing-registry-entry'])
  })

  test('skips when the enabled registry version differs from the build', () => {
    const result = resolveNative({
      registryEntry: makeRegistryEntry({
        id: NATIVE_MANIFEST.id,
        version: '2.0.0',
        platforms: [...NATIVE_MANIFEST.platforms],
      }),
    })
    expect(reasons(result.issues)).toEqual(['manifest_mismatch'])
  })

  test('skips when the lock version differs from the manifest', () => {
    const result = resolveNative({
      nativeLock: makeNativeLock({version: '0.9.0'}),
    })
    expect(reasons(result.issues)).toEqual(['manifest_mismatch'])
  })

  test('skips when the lock host API differs', () => {
    const result = resolveNative({nativeLock: makeNativeLock({hostApi: 3})})
    expect(reasons(result.issues)).toEqual(['host_api_mismatch'])
  })

  test('skips when the registry host API differs', () => {
    const result = resolveNative({
      registryEntry: makeRegistryEntry({
        id: NATIVE_MANIFEST.id,
        platforms: [...NATIVE_MANIFEST.platforms],
        hostApi: 3,
      }),
    })
    expect(reasons(result.issues)).toEqual(['host_api_mismatch'])
  })

  test('skips when the lock native API differs', () => {
    const result = resolveNative({nativeLock: makeNativeLock({nativeApi: 2})})
    expect(reasons(result.issues)).toEqual(['native_api_mismatch'])
  })

  test('skips when a declared native module is not compiled', () => {
    const result = resolveNative({
      nativeLock: makeNativeLock({modules: ['Other']}),
    })
    expect(reasons(result.issues)).toEqual(['native_module_missing'])
  })

  test('skips when a declared native view is not compiled', () => {
    const result = resolveNative({nativeLock: makeNativeLock({views: []})})
    expect(reasons(result.issues)).toEqual(['native_view_missing'])
  })

  test('skips when a compiled view has a different height mode', () => {
    const result = resolveNative({
      nativeLock: makeNativeLock({
        views: [{name: 'VoiceRecorderView', heightMode: 'fixed'}],
      }),
    })
    expect(reasons(result.issues)).toEqual(['manifest_mismatch'])
  })

  test('skips when the plugin is missing from the compiled registry', () => {
    const result = resolveNative({
      nativeRegistry: [makeNativeRegistryEntry({id: 'com.example.other'})],
    })
    expect(reasons(result.issues)).toEqual(['native_not_compiled'])
  })

  test('skips when the compiled package differs from the manifest', () => {
    const result = resolveNative({
      nativeRegistry: [
        makeNativeRegistryEntry({packageName: '@community-plugins/other'}),
      ],
    })
    expect(reasons(result.issues)).toEqual(['manifest_mismatch'])
  })

  test('skips when the compiled version differs from the lock', () => {
    const result = resolveNative({
      nativeRegistry: [makeNativeRegistryEntry({version: '2.0.0'})],
    })
    expect(reasons(result.issues)).toEqual(['manifest_mismatch'])
  })

  test('skips when the compiled native API differs from the lock', () => {
    const result = resolveNative({
      nativeRegistry: [makeNativeRegistryEntry({nativeApi: 2})],
    })
    expect(reasons(result.issues)).toEqual(['native_api_mismatch'])
  })

  test('skips when a locked module is not in the compiled registry', () => {
    const result = resolveNative({
      nativeLock: makeNativeLock({
        modules: ['VoiceCommentModule', 'ExtraModule'],
      }),
    })
    expect(reasons(result.issues)).toEqual(['native_module_missing'])
  })

  test('skips when a manifest module is not in the compiled registry', () => {
    const result = resolveNative({
      nativeRegistry: [makeNativeRegistryEntry({modules: []})],
    })
    expect(reasons(result.issues)).toEqual(['native_module_missing'])
  })

  test('skips when a locked view is not in the compiled registry', () => {
    const result = resolveNative({
      nativeRegistry: [makeNativeRegistryEntry({views: []})],
    })
    expect(reasons(result.issues)).toEqual(['native_view_missing'])
  })

  test('skips when a registry view has a different height mode', () => {
    const result = resolveNative({
      nativeRegistry: [
        makeNativeRegistryEntry({
          views: [{name: 'VoiceRecorderView', heightMode: 'fixed'}],
        }),
      ],
    })
    expect(reasons(result.issues)).toEqual(['manifest_mismatch'])
  })

  test('resolves when the compiled registry matches the lock', () => {
    const result = resolveNative({
      nativeRegistry: [makeNativeRegistryEntry()],
    })

    expect(result.issues).toEqual([])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]?.definition.manifest.id).toBe(NATIVE_MANIFEST.id)
  })

  test('skips when the app is older than minAppVersion', () => {
    const result = resolveNative({appVersion: '1.9.9'})
    expect(reasons(result.issues)).toEqual(['min_app_version'])
  })

  test('treats a prerelease app version as older than the stable minimum', () => {
    const result = resolveNative({appVersion: '2.0.0-beta.1'})
    expect(reasons(result.issues)).toEqual(['min_app_version'])
  })

  test('does not apply minAppVersion without a known app version', () => {
    const result = resolveNative({appVersion: undefined})
    expect(result.issues).toEqual([])
    expect(result.plugins).toHaveLength(1)
  })

  test('skips a native plugin on an unsupported platform', () => {
    const result = resolveNative({platform: 'web'})
    expect(reasons(result.issues)).toEqual(['platform-mismatch'])
  })

  test('skips when the registry does not grant a declared capability', () => {
    const manifest = makeManifest(JS_MANIFEST, {
      capabilities: ['storage.local'],
    })
    const result = resolvePlugins({
      definitions: [makeDefinition(manifest)],
      registry: makeRegistry(),
      platform: 'ios',
      accountDid: ACCOUNT_DID,
    })
    expect(reasons(result.issues)).toEqual(['missing-capability'])
  })

  test('keeps the granted capabilities and builds the host API', () => {
    const manifest = makeManifest(JS_MANIFEST, {
      capabilities: ['storage.local', 'toast.show'],
    })
    const result = resolvePlugins({
      definitions: [makeDefinition(manifest)],
      registry: makeRegistry([
        makeRegistryEntry({capabilities: ['storage.local', 'toast.show']}),
      ]),
      platform: 'ios',
      accountDid: ACCOUNT_DID,
      createToast: () => ({show: jest.fn()}),
    })
    expect(result.issues).toEqual([])
    expect(result.plugins[0]?.capabilities).toEqual([
      'storage.local',
      'toast.show',
    ])
    expect(result.plugins[0]?.host.storage).toBeDefined()
    expect(result.plugins[0]?.host.toast).toBeDefined()
  })

  test('skips when plugin storage cannot be created', () => {
    const manifest = makeManifest(JS_MANIFEST, {
      capabilities: ['storage.local'],
    })
    const result = resolvePlugins({
      definitions: [makeDefinition(manifest)],
      registry: makeRegistry([
        makeRegistryEntry({capabilities: ['storage.local']}),
      ]),
      platform: 'ios',
      accountDid: ACCOUNT_DID,
      createStorage: () => {
        throw new Error('unavailable')
      },
    })
    expect(reasons(result.issues)).toEqual(['storage-unavailable'])
  })
})

describe('comparePluginVersions', () => {
  test('orders numeric segments numerically', () => {
    expect(comparePluginVersions('1.10.0', '1.9.9')).toBe(1)
    expect(comparePluginVersions('2.0.0', '10.0.0')).toBe(-1)
    expect(comparePluginVersions('1.0.0', '1.0.0')).toBe(0)
  })

  test('orders prereleases below the stable release', () => {
    expect(comparePluginVersions('2.0.0-beta.1', '2.0.0')).toBe(-1)
    expect(comparePluginVersions('2.0.0', '2.0.0-rc.1')).toBe(1)
    expect(comparePluginVersions('2.0.0-beta.2', '2.0.0-beta.10')).toBe(-1)
    expect(comparePluginVersions('2.0.0-beta', '2.0.0-beta.1')).toBe(-1)
  })

  test('treats invalid versions as equal rather than skipping', () => {
    expect(comparePluginVersions('2.0', '2.0.0')).toBe(0)
    expect(comparePluginVersions('latest', '2.0.0')).toBe(0)
  })
})
