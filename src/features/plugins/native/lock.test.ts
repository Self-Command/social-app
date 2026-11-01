import {
  buildNativePluginLock,
  computeNativeLockHash,
  createEmptyNativePluginLock,
  NATIVE_LOCK_VERSION,
  type NativePluginLockEntry,
  NativePluginLockError,
  parseNativePluginLock,
  serializeNativePluginLock,
} from './lock'

const COMMIT = 'a'.repeat(40)
const MANIFEST_HASH = `sha256:${'1'.repeat(64)}`
const PACKAGE_HASH = `sha256:${'2'.repeat(64)}`

function makeEntry(
  overrides: Partial<NativePluginLockEntry> = {},
): NativePluginLockEntry {
  return {
    id: 'com.selfcommand.voicecomment',
    version: '1.0.0',
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

describe('native plugin lock', () => {
  test('same input produces identical bytes and lock hash', () => {
    const entries = [makeEntry()]
    const first = buildNativePluginLock(entries)
    const second = buildNativePluginLock(entries)

    expect(first.lockHash).toBe(second.lockHash)
    expect(serializeNativePluginLock(first)).toBe(
      serializeNativePluginLock(second),
    )
    expect(first.lockHash).toBe(`sha256:${first.lockHash.slice(7)}`)
    expect(first.lockHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.lockVersion).toBe(NATIVE_LOCK_VERSION)
  })

  test('sorts plugins by id and keeps a fixed field order', () => {
    const lock = buildNativePluginLock([
      makeEntry({id: 'com.selfcommand.voicecomment'}),
      makeEntry({id: 'com.example.keywordalerts'}),
    ])

    expect(lock.plugins.map(plugin => plugin.id)).toEqual([
      'com.example.keywordalerts',
      'com.selfcommand.voicecomment',
    ])
    expect(Object.keys(lock)).toEqual(['lockVersion', 'plugins', 'lockHash'])
    expect(Object.keys(lock.plugins[0] ?? {})).toEqual([
      'id',
      'version',
      'commit',
      'manifestHash',
      'packageHash',
      'hostApi',
      'nativeApi',
      'modules',
      'views',
    ])
    expect(Object.keys(lock.plugins[0]?.views[0] ?? {})).toEqual([
      'name',
      'heightMode',
    ])
  })

  test('does not mutate the input and ignores input order', () => {
    const first = makeEntry({id: 'com.example.one'})
    const second = makeEntry({id: 'com.example.two'})
    const entries = [second, first]
    const lock = buildNativePluginLock(entries)

    expect(entries).toEqual([second, first])
    expect(buildNativePluginLock([first, second])).toEqual(lock)
  })

  test('empty lock is deterministic', () => {
    const empty = createEmptyNativePluginLock()
    expect(empty.plugins).toEqual([])
    expect(empty.lockHash).toBe(computeNativeLockHash([]))
    expect(createEmptyNativePluginLock()).toEqual(empty)
  })

  test('parse accepts a generated lock and rejects a tampered one', () => {
    const lock = buildNativePluginLock([makeEntry()])
    expect(
      parseNativePluginLock(JSON.parse(serializeNativePluginLock(lock))),
    ).toEqual(lock)

    const tampered = {...lock, lockHash: `sha256:${'0'.repeat(64)}`}
    expect(() => parseNativePluginLock(tampered)).toThrow(NativePluginLockError)
    try {
      parseNativePluginLock(tampered)
    } catch (error) {
      expect((error as NativePluginLockError).issues.join('\n')).toContain(
        'manual edits are not allowed',
      )
    }
  })

  test('parse rejects unsorted, duplicate and unknown fields', () => {
    const two = buildNativePluginLock([
      makeEntry({id: 'com.example.one'}),
      makeEntry({id: 'com.example.two'}),
    ])
    expect(() =>
      parseNativePluginLock({...two, plugins: [...two.plugins].reverse()}),
    ).toThrow(/sorted by id/)

    expect(() =>
      parseNativePluginLock({
        ...two,
        plugins: [two.plugins[0], two.plugins[0]],
      }),
    ).toThrow(/duplicate plugin/)

    expect(() =>
      parseNativePluginLock({
        ...two,
        plugins: [{...two.plugins[0], extra: true}, two.plugins[1]],
      }),
    ).toThrow(/unknown field/)
  })

  test('rejects malformed entries', () => {
    const invalid = [
      makeEntry({commit: 'abc'}),
      makeEntry({manifestHash: 'sha256:xyz'}),
      makeEntry({version: '1.0'}),
      makeEntry({hostApi: 0}),
      makeEntry({modules: []}),
      makeEntry({modules: ['VoiceCommentModule', 'VoiceCommentModule']}),
      makeEntry({
        views: [
          {name: 'Recorder', heightMode: 'content'},
          {name: 'Recorder', heightMode: 'fixed'},
        ],
      }),
      makeEntry({views: [{name: 'Recorder', heightMode: 'auto' as never}]}),
    ]
    for (const entry of invalid) {
      expect(() => buildNativePluginLock([entry])).toThrow(
        NativePluginLockError,
      )
    }

    expect(() =>
      buildNativePluginLock([
        makeEntry({id: 'com.example.one'}),
        makeEntry({id: 'com.example.one'}),
      ]),
    ).toThrow(/duplicate plugin/)
  })
})
