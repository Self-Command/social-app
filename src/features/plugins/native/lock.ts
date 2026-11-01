import {sha256} from 'js-sha256'

import {type PluginNativeViewHeightMode} from '../sdk/types'

export const NATIVE_LOCK_VERSION = 1

const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const MODULE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const TOP_LEVEL_KEYS = ['lockVersion', 'plugins', 'lockHash']
const ENTRY_KEYS = [
  'id',
  'version',
  'commit',
  'manifestHash',
  'packageHash',
  'hostApi',
  'nativeApi',
  'modules',
  'views',
]
const VIEW_KEYS = ['name', 'heightMode']

export type NativePluginLockView = Readonly<{
  name: string
  heightMode: PluginNativeViewHeightMode
}>

export type NativePluginLockEntry = Readonly<{
  id: string
  version: string
  commit: string
  manifestHash: string
  packageHash: string
  hostApi: number
  nativeApi: number
  modules: readonly string[]
  views: readonly NativePluginLockView[]
}>

export type NativePluginLock = Readonly<{
  lockVersion: typeof NATIVE_LOCK_VERSION
  plugins: readonly NativePluginLockEntry[]
  lockHash: string
}>

export class NativePluginLockError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid native plugin lock:\n${issues.join('\n')}`)
    this.name = 'NativePluginLockError'
    this.issues = issues
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function checkAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
  issues: string[],
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(`${location}.${key}: unknown field`)
    }
  }
}

function validateEntry(value: unknown, index: number, issues: string[]) {
  const location = `plugins[${index}]`
  if (!isPlainRecord(value)) {
    issues.push(`${location}: expected object`)
    return undefined
  }
  const startIndex = issues.length
  checkAllowedKeys(value, ENTRY_KEYS, location, issues)

  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    issues.push(`${location}.id: expected a reverse-domain identifier`)
  }
  if (
    typeof value.version !== 'string' ||
    !SEMVER_PATTERN.test(value.version)
  ) {
    issues.push(`${location}.version: expected a semantic version`)
  }
  if (typeof value.commit !== 'string' || !COMMIT_PATTERN.test(value.commit)) {
    issues.push(`${location}.commit: expected a lowercase git commit`)
  }
  for (const key of ['manifestHash', 'packageHash'] as const) {
    if (typeof value[key] !== 'string' || !HASH_PATTERN.test(value[key])) {
      issues.push(`${location}.${key}: expected a sha256 digest`)
    }
  }
  for (const key of ['hostApi', 'nativeApi'] as const) {
    if (
      typeof value[key] !== 'number' ||
      !Number.isInteger(value[key]) ||
      value[key] < 1
    ) {
      issues.push(`${location}.${key}: expected a positive integer`)
    }
  }

  const modules: string[] = []
  if (!Array.isArray(value.modules) || value.modules.length === 0) {
    issues.push(`${location}.modules: expected a non-empty array`)
  } else {
    const seen = new Set<string>()
    for (const [moduleIndex, module] of value.modules.entries()) {
      if (
        typeof module !== 'string' ||
        module.length > 64 ||
        !MODULE_PATTERN.test(module)
      ) {
        issues.push(
          `${location}.modules[${moduleIndex}]: expected a module identifier`,
        )
        continue
      }
      if (seen.has(module)) {
        issues.push(
          `${location}.modules[${moduleIndex}]: duplicate module "${module}"`,
        )
        continue
      }
      seen.add(module)
      modules.push(module)
    }
  }

  const views: NativePluginLockView[] = []
  if (!Array.isArray(value.views)) {
    issues.push(`${location}.views: expected array`)
  } else {
    const seen = new Set<string>()
    for (const [viewIndex, view] of value.views.entries()) {
      const viewLocation = `${location}.views[${viewIndex}]`
      if (!isPlainRecord(view)) {
        issues.push(`${viewLocation}: expected object`)
        continue
      }
      checkAllowedKeys(view, VIEW_KEYS, viewLocation, issues)
      if (
        typeof view.name !== 'string' ||
        view.name.length > 64 ||
        !MODULE_PATTERN.test(view.name)
      ) {
        issues.push(`${viewLocation}.name: expected a view identifier`)
        continue
      }
      if (seen.has(view.name)) {
        issues.push(`${viewLocation}.name: duplicate view "${view.name}"`)
        continue
      }
      if (view.heightMode !== 'fixed' && view.heightMode !== 'content') {
        issues.push(`${viewLocation}.heightMode: expected "fixed" or "content"`)
        continue
      }
      seen.add(view.name)
      views.push({name: view.name, heightMode: view.heightMode})
    }
  }

  if (issues.length > startIndex) return undefined
  return {
    id: value.id as string,
    version: value.version as string,
    commit: value.commit as string,
    manifestHash: value.manifestHash as string,
    packageHash: value.packageHash as string,
    hostApi: value.hostApi as number,
    nativeApi: value.nativeApi as number,
    modules,
    views,
  } satisfies NativePluginLockEntry
}

function normalizeEntries(
  entries: readonly NativePluginLockEntry[],
): NativePluginLockEntry[] {
  return [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(entry => ({
      id: entry.id,
      version: entry.version,
      commit: entry.commit,
      manifestHash: entry.manifestHash,
      packageHash: entry.packageHash,
      hostApi: entry.hostApi,
      nativeApi: entry.nativeApi,
      modules: [...entry.modules],
      views: entry.views.map(view => ({
        name: view.name,
        heightMode: view.heightMode,
      })),
    }))
}

/**
 * The hash covers the ordered lock body only. Callers must not add timestamps
 * or environment data, otherwise identical plugin inputs produce different
 * locks.
 */
export function computeNativeLockHash(
  entries: readonly NativePluginLockEntry[],
): string {
  const payload = JSON.stringify({
    lockVersion: NATIVE_LOCK_VERSION,
    plugins: normalizeEntries(entries),
  })
  // The bare sha256(message) helper delegates to node:crypto when it detects
  // Node, which the test setup mocks; the streaming API is the portable path.
  return `sha256:${sha256.create().update(payload).hex()}`
}

export function buildNativePluginLock(
  entries: readonly NativePluginLockEntry[],
): NativePluginLock {
  const issues: string[] = []
  const seen = new Set<string>()
  const validated: NativePluginLockEntry[] = []
  for (const [index, entry] of entries.entries()) {
    const parsed = validateEntry(entry, index, issues)
    if (!parsed) continue
    if (seen.has(parsed.id)) {
      issues.push(`plugins[${index}].id: duplicate plugin "${parsed.id}"`)
      continue
    }
    seen.add(parsed.id)
    validated.push(parsed)
  }
  if (issues.length > 0) throw new NativePluginLockError(issues)

  const plugins = normalizeEntries(validated)
  return {
    lockVersion: NATIVE_LOCK_VERSION,
    plugins,
    lockHash: computeNativeLockHash(plugins),
  }
}

export function parseNativePluginLock(value: unknown): NativePluginLock {
  if (!isPlainRecord(value)) {
    throw new NativePluginLockError(['lock: expected object'])
  }
  const issues: string[] = []
  checkAllowedKeys(value, TOP_LEVEL_KEYS, 'lock', issues)
  if (value.lockVersion !== NATIVE_LOCK_VERSION) {
    issues.push(`lockVersion: expected ${NATIVE_LOCK_VERSION}`)
  }
  if (!Array.isArray(value.plugins)) {
    issues.push('plugins: expected array')
    throw new NativePluginLockError(issues)
  }

  const plugins: NativePluginLockEntry[] = []
  const seen = new Set<string>()
  let previousId = ''
  for (const [index, entry] of value.plugins.entries()) {
    const parsed = validateEntry(entry, index, issues)
    if (!parsed) continue
    if (seen.has(parsed.id)) {
      issues.push(`plugins[${index}].id: duplicate plugin "${parsed.id}"`)
      continue
    }
    if (previousId && parsed.id < previousId) {
      issues.push(`plugins[${index}].id: plugins must be sorted by id`)
      continue
    }
    seen.add(parsed.id)
    previousId = parsed.id
    plugins.push(parsed)
  }

  const lockHash =
    typeof value.lockHash === 'string' && HASH_PATTERN.test(value.lockHash)
      ? value.lockHash
      : ''
  if (!lockHash) {
    issues.push('lockHash: expected a sha256 digest')
  } else if (issues.length === 0) {
    const expected = computeNativeLockHash(plugins)
    if (lockHash !== expected) {
      issues.push(
        `lockHash: expected ${expected}, got ${lockHash} (manual edits are not allowed)`,
      )
    }
  }

  if (issues.length > 0) throw new NativePluginLockError(issues)
  return {
    lockVersion: NATIVE_LOCK_VERSION,
    plugins: normalizeEntries(plugins),
    lockHash,
  }
}

export function serializeNativePluginLock(lock: NativePluginLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`
}

export function createEmptyNativePluginLock(): NativePluginLock {
  return buildNativePluginLock([])
}
