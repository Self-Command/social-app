import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {LIMITS} from './check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = path.resolve(HERE, '../..')

export const SNAPSHOT_SCHEMA_VERSION = 1
export const NATIVE_LOCK_VERSION = 1
export const NATIVE_CONFIG_SCHEMA_VERSION = 1
export const PLUGIN_SCHEMA_VERSION = 2
export const PLUGIN_HOST_API_VERSION = 2
export const PLUGIN_NATIVE_API_VERSION = 1
export const PLUGIN_NATIVE_PACKAGE_PREFIX = '@community-plugins/'

export const NATIVE_PERMISSION_KINDS = [
  'microphone',
  'camera',
  'photoLibrary',
  'notifications',
  'locationWhenInUse',
]

export const NATIVE_VIEW_HEIGHT_MODES = ['fixed', 'content']

export const GENERATED_HEADER =
  '// 生成文件，禁止手写；由 scripts/plugins/assemble-native.mjs 在构建期写入。'

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const MODULE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const PACKAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CJK_PATTERN = /[\u4e00-\u9fff]/
const FIXTURE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const SNAPSHOT_KEYS = ['schemaVersion', 'plugins']
const SNAPSHOT_PLUGIN_KEYS = [
  'id',
  'version',
  'commit',
  'sourceDir',
  'manifestHash',
  'packageHash',
]
const MANIFEST_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'description',
  'version',
  'hostApi',
  'nativeApi',
  'platforms',
  'slots',
  'capabilities',
  'settings',
  'native',
]
const NATIVE_KEYS = [
  'package',
  'modules',
  'views',
  'permissions',
  'minAppVersion',
  'network',
]
const NATIVE_VIEW_KEYS = ['name', 'heightMode']
const NATIVE_PERMISSION_KEYS = ['name', 'reason']
const NATIVE_NETWORK_KEYS = ['outbound']

// Directories and files that never contribute to the package hash or to the
// assembled output. They are build inputs, not plugin content.
const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'build'])
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store'])

const CATALOG_REL = 'src/features/plugins/catalog'
const GENERATED_REL = 'src/features/plugins/generated'
const PACKAGE_LINK_REL = 'node_modules/@community-plugins'

export class NativePipelineError extends Error {
  /**
   * @param {string[]} issues
   */
  constructor(issues) {
    super(`Invalid native plugin snapshot:\n${issues.join('\n')}`)
    this.name = 'NativePipelineError'
    this.issues = issues
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

/**
 * UTF-8 byte order keeps hashing stable across platforms, unlike the default
 * UTF-16 code unit comparison.
 */
function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (isPlainObject(value)) {
    const result = {}
    for (const key of Object.keys(value).sort(compareUtf8)) {
      result[key] = canonicalize(value[key])
    }
    return result
  }
  return value
}

/**
 * Canonical JSON: object keys are sorted recursively in UTF-8 byte order,
 * arrays keep their order and no whitespace is emitted.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function checkAllowedKeys(value, allowed, location, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(`${location}.${key}: 未知字段`)
    }
  }
}

function isInsidePath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '') return true
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function samePath(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

function displayPath(absolutePath) {
  const relative = path.relative(REPO_ROOT, absolutePath)
  if (relative === '') return '.'
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return toPosix(absolutePath)
  }
  return toPosix(relative)
}

function readJsonFile(file, location, issues) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    issues.push(`${location}: 文件不存在`)
    return undefined
  }
  if (stat.isSymbolicLink()) {
    issues.push(`${location}: 不允许符号链接`)
    return undefined
  }
  if (!stat.isFile()) {
    issues.push(`${location}: 期望文件`)
    return undefined
  }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    issues.push(`${location}: 无法读取（${error.code ?? error.message}）`)
    return undefined
  }
  try {
    return {value: JSON.parse(raw), bytes: Buffer.byteLength(raw, 'utf8')}
  } catch (error) {
    issues.push(`${location}: 不是合法 JSON（${error.message}）`)
    return undefined
  }
}

/**
 * Reads and validates snapshot.json. Every plugin sourceDir must stay inside
 * the directory that contains the snapshot file, including through symlinks.
 */
export function loadSnapshot(snapshotFile) {
  const resolvedFile = path.resolve(snapshotFile)
  const issues = []
  const parsed = readJsonFile(resolvedFile, displayPath(resolvedFile), issues)
  if (!parsed) throw new NativePipelineError(issues)
  const value = parsed.value
  if (!isPlainObject(value)) {
    throw new NativePipelineError([
      `${displayPath(resolvedFile)}: 快照必须是对象`,
    ])
  }
  checkAllowedKeys(value, SNAPSHOT_KEYS, 'snapshot', issues)
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    issues.push(
      `snapshot.schemaVersion: 期望 ${SNAPSHOT_SCHEMA_VERSION}，实际 ${String(
        value.schemaVersion,
      )}`,
    )
  }
  if (!Array.isArray(value.plugins)) {
    issues.push('snapshot.plugins: 期望数组')
    throw new NativePipelineError(issues)
  }

  const snapshotDir = path.dirname(resolvedFile)
  let snapshotReal = snapshotDir
  try {
    snapshotReal = fs.realpathSync(snapshotDir)
  } catch {
    // The snapshot directory exists because the file was read from it.
  }

  const plugins = []
  const seenIds = new Set()
  for (const [index, entry] of value.plugins.entries()) {
    const at = `snapshot.plugins[${index}]`
    if (!isPlainObject(entry)) {
      issues.push(`${at}: 期望对象`)
      continue
    }
    checkAllowedKeys(entry, SNAPSHOT_PLUGIN_KEYS, at, issues)

    if (typeof entry.id !== 'string' || !PLUGIN_ID_PATTERN.test(entry.id)) {
      issues.push(`${at}.id: 期望小写反向域名标识，且不得包含连字符`)
    } else if (seenIds.has(entry.id)) {
      issues.push(`${at}.id: 插件标识 "${entry.id}" 重复`)
    } else {
      seenIds.add(entry.id)
    }
    if (
      typeof entry.version !== 'string' ||
      !SEMVER_PATTERN.test(entry.version)
    ) {
      issues.push(`${at}.version: 期望语义化版本`)
    }
    if (
      typeof entry.commit !== 'string' ||
      !COMMIT_PATTERN.test(entry.commit)
    ) {
      issues.push(`${at}.commit: 期望 40 位小写提交标识`)
    }
    for (const key of ['manifestHash', 'packageHash']) {
      if (entry[key] === undefined) continue
      if (typeof entry[key] !== 'string' || !HASH_PATTERN.test(entry[key])) {
        issues.push(`${at}.${key}: 期望 sha256 摘要`)
      }
    }

    if (typeof entry.sourceDir !== 'string' || entry.sourceDir.length === 0) {
      issues.push(`${at}.sourceDir: 期望非空相对路径`)
      continue
    }
    if (
      path.isAbsolute(entry.sourceDir) ||
      path.win32.isAbsolute(entry.sourceDir)
    ) {
      issues.push(`${at}.sourceDir: 必须是相对路径`)
      continue
    }
    const sourceDirAbs = path.resolve(snapshotDir, entry.sourceDir)
    if (!isInsidePath(snapshotDir, sourceDirAbs)) {
      issues.push(`${at}.sourceDir: 不得越出快照目录`)
      continue
    }
    let stat
    try {
      stat = fs.lstatSync(sourceDirAbs)
    } catch {
      issues.push(`${at}.sourceDir: 目录不存在`)
      continue
    }
    if (stat.isSymbolicLink()) {
      issues.push(`${at}.sourceDir: 不允许符号链接`)
      continue
    }
    if (!stat.isDirectory()) {
      issues.push(`${at}.sourceDir: 期望目录`)
      continue
    }
    let sourceReal
    try {
      sourceReal = fs.realpathSync(sourceDirAbs)
    } catch {
      issues.push(`${at}.sourceDir: 无法解析真实路径`)
      continue
    }
    if (!isInsidePath(snapshotReal, sourceReal)) {
      issues.push(`${at}.sourceDir: 符号链接越出快照目录`)
      continue
    }

    plugins.push({
      id: entry.id,
      version: entry.version,
      commit: entry.commit,
      sourceDir: sourceDirAbs,
      manifestHash: entry.manifestHash,
      packageHash: entry.packageHash,
    })
  }

  if (issues.length > 0) throw new NativePipelineError(issues)
  return {snapshotDir, plugins}
}

function validateStringList(value, location, issues, {minLength = 0} = {}) {
  if (!Array.isArray(value)) {
    issues.push(`${location}: 期望数组`)
    return []
  }
  if (value.length < minLength) {
    issues.push(`${location}: 至少 ${minLength} 项`)
  }
  return value
}

function validateNativeManifest(value, expected, issues) {
  if (!isPlainObject(value)) {
    issues.push('manifest: 期望对象')
    return undefined
  }
  const startIndex = issues.length
  checkAllowedKeys(value, MANIFEST_KEYS, 'manifest', issues)

  if (value.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    issues.push(`manifest.schemaVersion: 期望 ${PLUGIN_SCHEMA_VERSION}`)
  }
  if (typeof value.id !== 'string' || !PLUGIN_ID_PATTERN.test(value.id)) {
    issues.push('manifest.id: 期望反向域名标识')
  } else if (value.id !== expected.id) {
    issues.push(`manifest.id: 与快照不一致（快照 ${expected.id}）`)
  }
  if (
    typeof value.version !== 'string' ||
    !SEMVER_PATTERN.test(value.version)
  ) {
    issues.push('manifest.version: 期望语义化版本')
  } else if (value.version !== expected.version) {
    issues.push(`manifest.version: 与快照不一致（快照 ${expected.version}）`)
  }
  if (value.hostApi !== PLUGIN_HOST_API_VERSION) {
    issues.push(`manifest.hostApi: 期望 ${PLUGIN_HOST_API_VERSION}`)
  }
  if (value.nativeApi !== PLUGIN_NATIVE_API_VERSION) {
    issues.push(`manifest.nativeApi: 期望 ${PLUGIN_NATIVE_API_VERSION}`)
  }

  const native = value.native
  if (!isPlainObject(native)) {
    issues.push('manifest.native: 期望对象')
    return undefined
  }
  checkAllowedKeys(native, NATIVE_KEYS, 'manifest.native', issues)

  let packageName = ''
  if (
    typeof native.package !== 'string' ||
    !native.package.startsWith(PLUGIN_NATIVE_PACKAGE_PREFIX)
  ) {
    issues.push(
      `manifest.native.package: 期望以 "${PLUGIN_NATIVE_PACKAGE_PREFIX}" 开头`,
    )
  } else {
    packageName = native.package
    const slug = packageName.slice(PLUGIN_NATIVE_PACKAGE_PREFIX.length)
    if (!PACKAGE_SLUG_PATTERN.test(slug)) {
      issues.push('manifest.native.package: 期望小写字母数字连字符标识')
    }
    const idTail =
      typeof expected.id === 'string' && expected.id.includes('.')
        ? expected.id.split('.').pop()
        : ''
    if (idTail && slug !== idTail) {
      issues.push(
        `manifest.native.package: 期望 "${PLUGIN_NATIVE_PACKAGE_PREFIX}${idTail}"，与插件标识一致`,
      )
    }
  }

  const modules = []
  const moduleEntries = validateStringList(
    native.modules,
    'manifest.native.modules',
    issues,
    {minLength: 1},
  )
  const seenModules = new Set()
  for (const [index, module] of moduleEntries.entries()) {
    if (
      typeof module !== 'string' ||
      module.length > 64 ||
      !MODULE_PATTERN.test(module)
    ) {
      issues.push(`manifest.native.modules[${index}]: 期望模块标识符`)
      continue
    }
    if (seenModules.has(module)) {
      issues.push(`manifest.native.modules[${index}]: 模块 "${module}" 重复`)
      continue
    }
    seenModules.add(module)
    modules.push(module)
  }

  const views = []
  const viewEntries = validateStringList(
    native.views,
    'manifest.native.views',
    issues,
    {minLength: 1},
  )
  const seenViews = new Set()
  for (const [index, view] of viewEntries.entries()) {
    const at = `manifest.native.views[${index}]`
    if (!isPlainObject(view)) {
      issues.push(`${at}: 期望对象`)
      continue
    }
    checkAllowedKeys(view, NATIVE_VIEW_KEYS, at, issues)
    if (
      typeof view.name !== 'string' ||
      view.name.length > 64 ||
      !MODULE_PATTERN.test(view.name)
    ) {
      issues.push(`${at}.name: 期望视图标识符`)
      continue
    }
    if (seenViews.has(view.name)) {
      issues.push(`${at}.name: 视图 "${view.name}" 重复`)
      continue
    }
    if (!NATIVE_VIEW_HEIGHT_MODES.includes(view.heightMode)) {
      issues.push(`${at}.heightMode: 期望 fixed 或 content`)
      continue
    }
    seenViews.add(view.name)
    views.push({name: view.name, heightMode: view.heightMode})
  }

  const permissions = []
  const permissionEntries = validateStringList(
    native.permissions,
    'manifest.native.permissions',
    issues,
  )
  const seenPermissions = new Set()
  for (const [index, permission] of permissionEntries.entries()) {
    const at = `manifest.native.permissions[${index}]`
    if (!isPlainObject(permission)) {
      issues.push(`${at}: 期望对象`)
      continue
    }
    checkAllowedKeys(permission, NATIVE_PERMISSION_KEYS, at, issues)
    if (
      typeof permission.name !== 'string' ||
      !NATIVE_PERMISSION_KINDS.includes(permission.name)
    ) {
      issues.push(`${at}.name: 未知原生权限`)
      continue
    }
    if (seenPermissions.has(permission.name)) {
      issues.push(`${at}.name: 权限 "${permission.name}" 重复`)
      continue
    }
    if (
      typeof permission.reason !== 'string' ||
      permission.reason.length < 4 ||
      permission.reason.length > 120
    ) {
      issues.push(`${at}.reason: 期望 4-120 个字符的中文说明`)
      continue
    }
    if (!CJK_PATTERN.test(permission.reason)) {
      issues.push(`${at}.reason: 必须包含中文说明`)
      continue
    }
    seenPermissions.add(permission.name)
    permissions.push({name: permission.name, reason: permission.reason})
  }

  if (
    typeof native.minAppVersion !== 'string' ||
    !SEMVER_PATTERN.test(native.minAppVersion)
  ) {
    issues.push('manifest.native.minAppVersion: 期望语义化版本')
  }

  const network = {outbound: []}
  if (!isPlainObject(native.network)) {
    issues.push('manifest.native.network: 期望对象')
  } else {
    checkAllowedKeys(
      native.network,
      NATIVE_NETWORK_KEYS,
      'manifest.native.network',
      issues,
    )
    const origins = validateStringList(
      native.network.outbound,
      'manifest.native.network.outbound',
      issues,
    )
    const seenOrigins = new Set()
    for (const [index, origin] of origins.entries()) {
      const at = `manifest.native.network.outbound[${index}]`
      let url
      try {
        url = new URL(origin)
      } catch {
        issues.push(`${at}: 期望 HTTPS 来源`)
        continue
      }
      if (url.protocol !== 'https:') {
        issues.push(`${at}: 期望 HTTPS 来源`)
        continue
      }
      if (url.username || url.password) {
        issues.push(`${at}: 来源中不得包含凭据`)
        continue
      }
      if (
        (url.pathname !== '/' && url.pathname !== '') ||
        url.search ||
        url.hash
      ) {
        issues.push(`${at}: 期望不含路径、查询或片段的来源`)
        continue
      }
      if (seenOrigins.has(origin)) {
        issues.push(`${at}: 来源 "${origin}" 重复`)
        continue
      }
      seenOrigins.add(origin)
      network.outbound.push(origin)
    }
  }

  if (issues.length > startIndex) return undefined
  return {
    package: packageName,
    modules,
    views,
    permissions,
    minAppVersion: native.minAppVersion,
    network,
  }
}

export function computeManifestHash(manifest) {
  return `sha256:${sha256Hex(Buffer.from(canonicalJson(manifest), 'utf8'))}`
}

function walkPackageFiles(rootDir, relativeDir, files, issues) {
  let entries
  try {
    entries = fs.readdirSync(path.join(rootDir, relativeDir), {
      withFileTypes: true,
    })
  } catch (error) {
    issues.push(
      `${displayPath(rootDir)}: 无法读取目录（${error.code ?? error.message}）`,
    )
    return
  }
  for (const entry of entries) {
    const relativePath = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name
    const absolutePath = path.join(rootDir, relativePath)
    let stat
    try {
      stat = fs.lstatSync(absolutePath)
    } catch (error) {
      issues.push(`${relativePath}: 无法读取（${error.code ?? error.message}）`)
      continue
    }
    if (stat.isSymbolicLink()) {
      issues.push(`${relativePath}: 不允许符号链接`)
      continue
    }
    if (stat.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
      walkPackageFiles(rootDir, relativePath, files, issues)
      continue
    }
    if (!stat.isFile()) {
      issues.push(`${relativePath}: 不支持的文件类型`)
      continue
    }
    if (EXCLUDED_FILE_NAMES.has(entry.name) || entry.name.endsWith('.log')) {
      continue
    }
    const bytes = fs.readFileSync(absolutePath)
    files.push({relativePath, sha256: sha256Hex(bytes)})
  }
}

/**
 * Package hash covers every plugin file below sourceDir except build inputs:
 * for each file, `${posixRelativePath}\0${sha256(fileBytes)}\n`, sorted by
 * relative path.
 */
export function computePackageHash(sourceDir) {
  const files = []
  const issues = []
  walkPackageFiles(sourceDir, '', files, issues)
  if (issues.length > 0) {
    throw new Error(issues.join('；'))
  }
  files.sort((a, b) => compareUtf8(a.relativePath, b.relativePath))
  const payload = files
    .map(file => `${file.relativePath}\0${file.sha256}\n`)
    .join('')
  return `sha256:${sha256Hex(Buffer.from(payload, 'utf8'))}`
}

/**
 * Validates snapshot entries, reads each manifest, verifies declared hashes and
 * returns everything the lock and assembly need.
 */
export function preparePlugins(snapshotFile) {
  const {plugins} = loadSnapshot(snapshotFile)
  const issues = []
  const prepared = []

  for (const [index, plugin] of plugins.entries()) {
    const at = `snapshot.plugins[${index}] (${plugin.id})`
    const manifestFile = path.join(plugin.sourceDir, 'manifest.json')
    const parsed = readJsonFile(manifestFile, `${at}.manifest`, issues)
    let manifest
    let manifestHash
    let native
    if (parsed) {
      if (parsed.bytes > LIMITS.manifestBytes) {
        issues.push(
          `${at}.manifest: 大小 ${parsed.bytes} 字节，超过上限 ${LIMITS.manifestBytes} 字节`,
        )
      }
      manifest = parsed.value
      const manifestIssues = []
      native = validateNativeManifest(
        manifest,
        {id: plugin.id, version: plugin.version},
        manifestIssues,
      )
      for (const issue of manifestIssues) {
        issues.push(`${at}: ${issue}`)
      }
      manifestHash = computeManifestHash(manifest)
      if (
        plugin.manifestHash !== undefined &&
        plugin.manifestHash !== manifestHash
      ) {
        issues.push(
          `${at}.manifestHash: 与快照记录不一致（实际 ${manifestHash}）`,
        )
      }
    }

    let packageHash
    try {
      packageHash = computePackageHash(plugin.sourceDir)
    } catch (error) {
      issues.push(`${at}.packageHash: ${error.message}`)
    }
    if (
      plugin.packageHash !== undefined &&
      packageHash !== undefined &&
      plugin.packageHash !== packageHash
    ) {
      issues.push(`${at}.packageHash: 与快照记录不一致（实际 ${packageHash}）`)
    }

    prepared.push({
      id: plugin.id,
      version: plugin.version,
      commit: plugin.commit,
      sourceDir: plugin.sourceDir,
      manifest,
      manifestHash,
      packageHash,
      native,
    })
  }

  if (issues.length > 0) throw new NativePipelineError(issues)
  return prepared
}

function cloneLockEntry(entry) {
  return {
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
  }
}

export function createLockEntry(plugin) {
  return cloneLockEntry({
    id: plugin.id,
    version: plugin.version,
    commit: plugin.commit,
    manifestHash: plugin.manifestHash,
    packageHash: plugin.packageHash,
    hostApi: plugin.manifest.hostApi,
    nativeApi: plugin.manifest.nativeApi,
    modules: plugin.native.modules,
    views: plugin.native.views,
  })
}

/**
 * Matches src/features/plugins/native/lock.ts: entries sorted by id, fixed
 * field order, and the hash covering `{lockVersion, plugins}` only.
 */
export function computeLockHash(entries) {
  const payload = JSON.stringify({
    lockVersion: NATIVE_LOCK_VERSION,
    plugins: entries.map(cloneLockEntry),
  })
  return `sha256:${sha256Hex(Buffer.from(payload, 'utf8'))}`
}

export function createNativeLock(entries) {
  const plugins = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(cloneLockEntry)
  return {
    lockVersion: NATIVE_LOCK_VERSION,
    plugins,
    lockHash: computeLockHash(plugins),
  }
}

export function serializeNativeLock(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`
}

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function viewLiteral(view, indent) {
  return `${indent}{name: ${quote(view.name)}, heightMode: ${quote(
    view.heightMode,
  )}},`
}

export function renderNativeRegistry(entries) {
  const header = [
    GENERATED_HEADER,
    "import {type NativePluginRegistryEntry} from '../native/registry'",
    '',
  ].join('\n')
  if (entries.length === 0) {
    return `${header}export const NATIVE_PLUGIN_REGISTRY: readonly NativePluginRegistryEntry[] = []\n`
  }
  const body = entries
    .map(entry =>
      [
        '  {',
        `    id: ${quote(entry.id)},`,
        `    version: ${quote(entry.version)},`,
        `    nativeApi: ${entry.nativeApi},`,
        `    packageName: ${quote(entry.packageName)},`,
        `    modules: [${entry.modules.map(quote).join(', ')}],`,
        '    views: [',
        ...entry.views.map(view => viewLiteral(view, '      ')),
        '    ],',
        '  },',
      ].join('\n'),
    )
    .join('\n')
  return `${header}export const NATIVE_PLUGIN_REGISTRY: readonly NativePluginRegistryEntry[] = [\n${body}\n]\n`
}

export function renderNativeLockModule(entries) {
  if (entries.length === 0) {
    return [
      GENERATED_HEADER,
      "import {type NativePluginLock} from '../native/lock'",
      '',
      'export const NATIVE_PLUGIN_LOCK: NativePluginLock | undefined = undefined',
      '',
    ].join('\n')
  }
  return [
    GENERATED_HEADER,
    "import {parseNativePluginLock, type NativePluginLock} from '../native/lock'",
    "import lockJson from './native-plugin-lock.json'",
    '',
    'export const NATIVE_PLUGIN_LOCK: NativePluginLock = parseNativePluginLock(lockJson)',
    '',
  ].join('\n')
}

function importNameFor(id) {
  return `plugin${id
    .split('.')
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')}`
}

export function renderCatalogGenerated(plugins) {
  const lines = [
    GENERATED_HEADER,
    "import {type PluginDefinition} from '../sdk'",
  ]
  for (const plugin of plugins) {
    lines.push(
      `import {plugin as ${importNameFor(plugin.id)}} from './${plugin.id}'`,
    )
  }
  lines.push('')
  if (plugins.length === 0) {
    lines.push(
      'export const GENERATED_PLUGIN_CATALOG: readonly PluginDefinition[] = []',
    )
  } else {
    lines.push(
      'export const GENERATED_PLUGIN_CATALOG: readonly PluginDefinition[] = [',
    )
    for (const plugin of plugins) {
      lines.push(`  ${importNameFor(plugin.id)},`)
    }
    lines.push(']')
  }
  return `${lines.join('\n')}\n`
}

export function renderNativeConfig(plugins) {
  const config = {
    schemaVersion: NATIVE_CONFIG_SCHEMA_VERSION,
    plugins: plugins.map(plugin => ({
      id: plugin.id,
      package: plugin.native.package,
      modules: [...plugin.native.modules],
      views: plugin.native.views.map(view => ({
        name: view.name,
        heightMode: view.heightMode,
      })),
      permissions: [...plugin.native.permissions]
        .sort((a, b) => compareUtf8(a.name, b.name))
        .map(permission => ({
          name: permission.name,
          reason: permission.reason,
        })),
    })),
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

function assertInsidePath(root, target) {
  if (!isInsidePath(root, target)) {
    throw new NativePipelineError([`写入路径越界：${displayPath(target)}`])
  }
}

export function assertOutRoot(outRoot) {
  const resolved = path.resolve(outRoot)
  if (samePath(resolved, REPO_ROOT)) {
    throw new NativePipelineError(['--out 不能指向仓库根目录'])
  }
  if (isInsidePath(resolved, REPO_ROOT)) {
    throw new NativePipelineError(['--out 不能是仓库根目录或它的上级目录'])
  }
}

function writeFileInside(outRoot, relativePath, content) {
  const target = path.join(outRoot, relativePath)
  assertInsidePath(outRoot, target)
  fs.mkdirSync(path.dirname(target), {recursive: true})
  fs.writeFileSync(target, content, 'utf8')
  return toPosix(relativePath)
}

function resetGeneratedDir(outRoot, target) {
  assertInsidePath(outRoot, target)
  if (samePath(outRoot, target)) {
    throw new NativePipelineError(['拒绝清空输出根目录'])
  }
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target)
    return
  }
  if (stat.isDirectory()) {
    fs.rmSync(target, {recursive: true, force: true})
    return
  }
  fs.unlinkSync(target)
}

function copyTreeEntry(source, target, context) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    throw new NativePipelineError([
      `${displayPath(source)}: 不允许复制符号链接`,
    ])
  }
  if (stat.isDirectory()) {
    if (EXCLUDED_DIR_NAMES.has(path.basename(source))) return
    assertInsidePath(context.outRoot, target)
    if (fs.existsSync(target)) {
      throw new NativePipelineError([
        `${displayPath(target)}: 目标路径冲突，拒绝覆盖`,
      ])
    }
    fs.mkdirSync(target, {recursive: true})
    const names = fs.readdirSync(source).sort(compareUtf8)
    for (const name of names) {
      if (EXCLUDED_DIR_NAMES.has(name)) continue
      if (EXCLUDED_FILE_NAMES.has(name) || name.endsWith('.log')) continue
      copyTreeEntry(path.join(source, name), path.join(target, name), context)
    }
    return
  }
  if (!stat.isFile()) {
    throw new NativePipelineError([`${displayPath(source)}: 不支持的文件类型`])
  }
  assertInsidePath(context.outRoot, target)
  if (fs.existsSync(target)) {
    throw new NativePipelineError([
      `${displayPath(target)}: 目标路径冲突，拒绝覆盖`,
    ])
  }
  fs.mkdirSync(path.dirname(target), {recursive: true})
  fs.copyFileSync(source, target)
  context.written.add(toPosix(path.relative(context.outRoot, target)))
}

function nativePackageSlug(plugin) {
  return plugin.native.package.slice(PLUGIN_NATIVE_PACKAGE_PREFIX.length)
}

function copyCatalogPlugin(plugin, outRoot, written) {
  const targetDir = path.join(outRoot, CATALOG_REL, plugin.id)
  resetGeneratedDir(outRoot, targetDir)
  fs.mkdirSync(targetDir, {recursive: true})
  const context = {outRoot, written}
  const sourceRoot = plugin.sourceDir

  // Plugin repositories keep JS under src/; the catalog entry root is the
  // plugin id directory, so src/ content is flattened there. This keeps the
  // convention `catalog/<id>/index.ts` importing `../../sdk` valid.
  const sourceDir = path.join(sourceRoot, 'src')
  let sourceStat
  try {
    sourceStat = fs.lstatSync(sourceDir)
  } catch {
    sourceStat = undefined
  }
  if (sourceStat) {
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new NativePipelineError([
        `${displayPath(sourceDir)}: 期望普通的源码目录`,
      ])
    }
    for (const name of fs.readdirSync(sourceDir).sort(compareUtf8)) {
      if (EXCLUDED_DIR_NAMES.has(name)) continue
      if (EXCLUDED_FILE_NAMES.has(name) || name.endsWith('.log')) continue
      copyTreeEntry(
        path.join(sourceDir, name),
        path.join(targetDir, name),
        context,
      )
    }
  }

  for (const name of fs.readdirSync(sourceRoot).sort(compareUtf8)) {
    if (name === 'src' || name === 'native') continue
    if (EXCLUDED_DIR_NAMES.has(name)) continue
    if (EXCLUDED_FILE_NAMES.has(name) || name.endsWith('.log')) continue
    copyTreeEntry(
      path.join(sourceRoot, name),
      path.join(targetDir, name),
      context,
    )
  }
}

function copyNativeModule(plugin, outRoot, written) {
  const sourceDir = path.join(plugin.sourceDir, 'native')
  let stat
  try {
    stat = fs.lstatSync(sourceDir)
  } catch {
    throw new NativePipelineError([
      `snapshot.plugins (${plugin.id}): 缺少 native/ 目录`,
    ])
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new NativePipelineError([
      `snapshot.plugins (${plugin.id}): native/ 必须是普通目录`,
    ])
  }
  const targetDir = path.join(
    outRoot,
    'modules',
    `plugin-${nativePackageSlug(plugin)}`,
  )
  resetGeneratedDir(outRoot, targetDir)
  fs.mkdirSync(targetDir, {recursive: true})
  const context = {outRoot, written}
  for (const name of fs.readdirSync(sourceDir).sort(compareUtf8)) {
    if (EXCLUDED_DIR_NAMES.has(name)) continue
    if (EXCLUDED_FILE_NAMES.has(name) || name.endsWith('.log')) continue
    copyTreeEntry(
      path.join(sourceDir, name),
      path.join(targetDir, name),
      context,
    )
  }
}

function removeLink(linkPath) {
  try {
    fs.unlinkSync(linkPath)
  } catch (error) {
    if (process.platform === 'win32') {
      // Windows removes directory junctions through rmdir.
      fs.rmdirSync(linkPath)
      return
    }
    throw error
  }
}

/**
 * Creates node_modules/@community-plugins/<slug> as a junction (Windows) or
 * directory symlink (POSIX). Existing links are only replaced when they point
 * somewhere else; a real file or directory is never deleted.
 */
function ensurePackageLink(outRoot, slug, moduleDir) {
  const linkDir = path.join(outRoot, PACKAGE_LINK_REL)
  const linkPath = path.join(linkDir, slug)
  assertInsidePath(outRoot, linkDir)
  assertInsidePath(outRoot, linkPath)
  assertInsidePath(outRoot, moduleDir)
  fs.mkdirSync(linkDir, {recursive: true})

  let stat
  try {
    stat = fs.lstatSync(linkPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    stat = undefined
  }
  if (stat) {
    if (!stat.isSymbolicLink()) {
      throw new NativePipelineError([
        `${toPosix(path.relative(outRoot, linkPath))}: 已存在同名真实文件或目录，拒绝替换`,
      ])
    }
    let currentReal = ''
    try {
      currentReal = fs.realpathSync(linkPath)
    } catch {
      currentReal = ''
    }
    const targetReal = fs.realpathSync(moduleDir)
    if (currentReal && samePath(currentReal, targetReal)) {
      return {
        link: toPosix(path.relative(outRoot, linkPath)),
        target: toPosix(path.relative(outRoot, moduleDir)),
        status: 'existing',
      }
    }
    removeLink(linkPath)
  }

  fs.symlinkSync(
    moduleDir,
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return {
    link: toPosix(path.relative(outRoot, linkPath)),
    target: toPosix(path.relative(outRoot, moduleDir)),
    status: 'created',
  }
}

function writeGeneratedFiles(outRoot, plugins, entries, lock, written) {
  const generatedFiles = [
    [
      `${GENERATED_REL}/native-registry.ts`,
      renderNativeRegistry(
        plugins.map(plugin => ({
          id: plugin.id,
          version: plugin.version,
          nativeApi: plugin.manifest.nativeApi,
          packageName: plugin.native.package,
          modules: plugin.native.modules,
          views: plugin.native.views,
        })),
      ),
    ],
    [`${GENERATED_REL}/native-plugin-lock.json`, serializeNativeLock(lock)],
    [`${GENERATED_REL}/native-lock.ts`, renderNativeLockModule(entries)],
    [`${GENERATED_REL}/native-config.json`, renderNativeConfig(plugins)],
    [`${CATALOG_REL}/catalog.generated.ts`, renderCatalogGenerated(plugins)],
  ]
  for (const [relativePath, content] of generatedFiles) {
    written.add(writeFileInside(outRoot, relativePath, content))
  }
}

/**
 * Assembles JS, native sources, package links and generated files below outDir.
 * Plugin repositories are only read; no plugin script is ever executed.
 */
export function assembleNative({snapshotFile, outDir}) {
  const plugins = preparePlugins(snapshotFile).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  const outRoot = path.resolve(outDir)
  assertOutRoot(outRoot)
  fs.mkdirSync(outRoot, {recursive: true})

  const entries = plugins.map(createLockEntry)
  const lock = createNativeLock(entries)
  const written = new Set()
  const links = []

  for (const plugin of plugins) {
    copyCatalogPlugin(plugin, outRoot, written)
    copyNativeModule(plugin, outRoot, written)
  }
  for (const plugin of plugins) {
    const slug = nativePackageSlug(plugin)
    links.push(
      ensurePackageLink(
        outRoot,
        slug,
        path.join(outRoot, 'modules', `plugin-${slug}`),
      ),
    )
  }
  writeGeneratedFiles(outRoot, plugins, entries, lock, written)

  return {
    lock,
    files: [...written].sort(compareUtf8),
    links,
  }
}

/**
 * Writes only the lock file. Input is the snapshot plus plugin files; assemble
 * output is not consulted.
 */
export function writeNativeLock({snapshotFile, outDir}) {
  const plugins = preparePlugins(snapshotFile)
  const entries = plugins.map(createLockEntry)
  const lock = createNativeLock(entries)
  const outRoot = path.resolve(outDir)
  assertOutRoot(outRoot)
  const relativePath = `${GENERATED_REL}/native-plugin-lock.json`
  writeFileInside(outRoot, relativePath, serializeNativeLock(lock))
  return {lock, lockPath: path.join(outRoot, relativePath)}
}

export function usageText(scriptName) {
  return [
    '用法：',
    `  node scripts/plugins/${scriptName} --fixture <名称> [--out <目录>]`,
    `  node scripts/plugins/${scriptName} --snapshot <文件> --out <目录>`,
    '',
    '--fixture 读取 scripts/plugins/fixtures/<名称>/snapshot.json，',
    '默认输出到 .plugin-build/<名称>；--snapshot 必须显式提供 --out。',
  ].join('\n')
}

/**
 * Shared CLI parsing for assemble-native.mjs and build-native-lock.mjs.
 */
export function parsePipelineArgs(argv) {
  const options = {fixture: undefined, snapshot: undefined, out: undefined}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fixture' || arg === '--snapshot' || arg === '--out') {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new Error(`参数 ${arg} 缺少值`)
      }
      index += 1
      options[arg.slice(2)] = value
      continue
    }
    throw new Error(`未知参数 ${arg}`)
  }

  if (options.fixture !== undefined && options.snapshot !== undefined) {
    throw new Error('--fixture 与 --snapshot 只能选择一种')
  }
  if (options.fixture === undefined && options.snapshot === undefined) {
    throw new Error('必须提供 --fixture 或 --snapshot')
  }
  if (options.snapshot !== undefined && options.out === undefined) {
    throw new Error('--snapshot 必须同时提供 --out')
  }
  if (options.out !== undefined && options.out.length === 0) {
    throw new Error('--out 不能为空')
  }

  let fixtureName
  let snapshotFile
  if (options.fixture !== undefined) {
    if (!FIXTURE_NAME_PATTERN.test(options.fixture)) {
      throw new Error('--fixture 只允许小写字母、数字与连字符')
    }
    fixtureName = options.fixture
    snapshotFile = path.join(
      REPO_ROOT,
      'scripts',
      'plugins',
      'fixtures',
      fixtureName,
      'snapshot.json',
    )
  } else {
    snapshotFile = path.resolve(options.snapshot)
  }

  const outDir =
    options.out !== undefined
      ? path.resolve(options.out)
      : path.join(REPO_ROOT, '.plugin-build', fixtureName)

  return {fixtureName, snapshotFile, outDir}
}

export function reportPipelineError(scriptName, error) {
  if (error instanceof NativePipelineError) {
    console.error(
      `${scriptName}: 原生插件流水线校验未通过，共 ${error.issues.length} 项：`,
    )
    for (const issue of error.issues) {
      console.error(`- ${issue}`)
    }
  } else {
    console.error(`${scriptName}: ${error?.message ?? String(error)}`)
  }
  process.exitCode = 1
}
