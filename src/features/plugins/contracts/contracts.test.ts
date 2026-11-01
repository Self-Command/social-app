import {parseNativePluginLock} from '../native/lock'
import {validatePluginManifest} from '../sdk/manifest'
import nativeInvalidPermissions from './fixtures/native-invalid-permissions.json'
import nativeInvalidUnknownField from './fixtures/native-invalid-unknown-field.json'
import nativeInvalidVersion from './fixtures/native-invalid-version.json'
import nativeInvalidViews from './fixtures/native-invalid-views.json'
import nativeLock from './fixtures/native-lock.json'
import nativeValid from './fixtures/native-valid.json'
import skipReasons from './fixtures/skip-reasons.json'

/**
 * Every contract fixture, keyed by file name so the tests keep referring to the
 * artifacts a plugin author would recognize.
 */
const FIXTURES = {
  'native-valid.json': nativeValid,
  'native-invalid-unknown-field.json': nativeInvalidUnknownField,
  'native-invalid-version.json': nativeInvalidVersion,
  'native-invalid-permissions.json': nativeInvalidPermissions,
  'native-invalid-views.json': nativeInvalidViews,
  'native-lock.json': nativeLock,
  'skip-reasons.json': skipReasons,
} satisfies Record<string, unknown>

function readFixture(name: keyof typeof FIXTURES): unknown {
  return FIXTURES[name]
}

function expectInvalidManifest(value: unknown): string {
  const result = validatePluginManifest(value)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.errors.join('\n')
}

const SKIP_REASONS = [
  'native_api_mismatch',
  'host_api_mismatch',
  'manifest_mismatch',
  'native_not_compiled',
  'native_module_missing',
  'native_view_missing',
  'min_app_version',
  'revoked',
  'disabled',
  'circuit_open',
]

describe('native manifest fixtures', () => {
  test('accepts the valid native manifest', () => {
    const result = validatePluginManifest(readFixture('native-valid.json'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.errors.join('\n'))
    }
    expect(result.manifest.native?.package).toBe('@community-plugins/voicedemo')
    expect(result.manifest.native?.permissions).toHaveLength(2)
    expect(result.manifest.native?.views).toHaveLength(2)
  })

  test('rejects unknown manifest and native fields', () => {
    expect(
      expectInvalidManifest(readFixture('native-invalid-unknown-field.json')),
    ).toContain('unknown field')
  })

  test('rejects mismatched contract versions', () => {
    const errors = expectInvalidManifest(
      readFixture('native-invalid-version.json'),
    )
    expect(errors).toContain('schemaVersion')
    expect(errors).toContain('hostApi')
    expect(errors).toContain('nativeApi')
  })

  test('rejects a missing permission declaration', () => {
    expect(
      expectInvalidManifest(readFixture('native-invalid-permissions.json')),
    ).toContain('native.permissions')
  })

  test('rejects a missing view declaration', () => {
    expect(
      expectInvalidManifest(readFixture('native-invalid-views.json')),
    ).toContain('native.views')
  })
})

describe('native lock fixture', () => {
  test('parses the generated lock and keeps its hash stable', () => {
    const lock = parseNativePluginLock(readFixture('native-lock.json'))
    expect(lock.lockVersion).toBe(1)
    expect(lock.plugins.map(plugin => plugin.id)).toEqual([
      'com.example.voicedemo',
    ])
    expect(lock.lockHash).toBe(
      'sha256:219f473f97426cbeed67526900391ba592528d043becb68244798554ecc8d228',
    )
  })

  test('rejects a lock whose fields or hash were edited by hand', () => {
    const fixture = readFixture('native-lock.json') as {
      plugins: Array<Record<string, unknown>>
    }
    expect(() =>
      parseNativePluginLock({
        ...(fixture as object),
        plugins: [{...fixture.plugins[0], version: '1.0.1'}],
      }),
    ).toThrow(/manual edits are not allowed/)
  })
})

describe('skip reason fixture', () => {
  const reasons = readFixture('skip-reasons.json') as Record<string, string>

  test('lists every documented skip reason once', () => {
    expect(Object.keys(reasons).sort()).toEqual([...SKIP_REASONS].sort())
    expect(new Set(Object.keys(reasons)).size).toBe(SKIP_REASONS.length)
  })

  test('explains each skip reason in Chinese', () => {
    for (const description of Object.values(reasons)) {
      expect(description.trim().length).toBeGreaterThan(0)
      expect(description).toMatch(/[\u4e00-\u9fff]/)
    }
  })
})
