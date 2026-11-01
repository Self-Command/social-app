#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')

const APPLICATION_NAME = 'bsky.app'
const SBOM_SPEC_VERSION = '1.5'
const SOURCE_MANIFEST_SCHEMA_VERSION = 1
const PLATFORMS = new Set(['android', 'ios'])

const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const CHANNEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const BUILD_NUMBER_PATTERN = /^[1-9]\d*$/
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const FINGERPRINT_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/

/*
 * Signing material and credential files never belong in the output directory or
 * in the store packet, even when a caller passes them as artifacts by mistake.
 */
const SECRET_EXTENSION_PATTERN =
  /\.(?:pem|key|p12|pfx|keystore|jks|secret|password|passwd|env)$/i
const SECRET_WORD_PATTERN =
  /(?:^|[._-])(?:password|passwd|passphrase|keystore|credentials?|secret)(?:[._-]|$)/i
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/

const MAX_LICENSES_BYTES = 16 * 1024 * 1024
const HASH_CHUNK_BYTES = 1024 * 1024

const RESERVED_OUTPUT_NAMES = new Set([
  'artifacts.json',
  'checksums.txt',
  'native-plugin-lock.json',
  'sbom.json',
  'signing',
  'source-manifest.json',
  'store-packet.zip',
])

const PACKET_ENTRIES = [
  'manifest.json',
  'native-plugin-lock.json',
  'sbom.json',
  'checksums.txt',
  'signing/fingerprint.txt',
]

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50

export class ArtifactPackageError extends Error {
  /**
   * @param {string[]} issues
   */
  constructor(issues) {
    super(`产物打包校验未通过：${issues.join('；')}`)
    this.name = 'ArtifactPackageError'
    this.issues = issues
  }
}

function fail(issues) {
  throw new ArtifactPackageError(issues)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * UTF-8 byte order keeps file names stable across platforms, unlike the default
 * UTF-16 code unit comparison.
 */
function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
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

function assertOutRoot(outDir) {
  if (samePath(outDir, REPO_ROOT)) {
    fail(['--out: 不能指向仓库根目录'])
  }
  if (isInsidePath(outDir, REPO_ROOT)) {
    fail(['--out: 不能位于仓库根目录的上级目录'])
  }
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readJsonFile(file, label) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    fail([`${label}: 文件不存在`])
  }
  if (stat.isSymbolicLink()) fail([`${label}: 不允许符号链接`])
  if (!stat.isFile()) fail([`${label}: 期望普通文件`])
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail([`${label}: 无法读取（${error.code ?? error.message}）`])
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail([`${label}: 不是合法 JSON`])
  }
  return {value, bytes: Buffer.from(raw, 'utf8')}
}

/**
 * Reads the lock produced by the native assembly pipeline. The lock hash and the
 * plugin list are the minimum needed to bind artifacts to one build input.
 */
function loadLock(lockFile) {
  const label = 'native-plugin-lock.json'
  const {value, bytes} = readJsonFile(lockFile, label)
  if (!isPlainObject(value)) fail([`${label}: 期望对象`])

  const issues = []
  if (typeof value.lockHash !== 'string' || value.lockHash.length === 0) {
    issues.push(`${label}.lockHash: 缺失`)
  } else if (!HASH_PATTERN.test(value.lockHash)) {
    issues.push(`${label}.lockHash: 期望 sha256 摘要`)
  }
  if (value.lockVersion !== undefined && value.lockVersion !== 1) {
    issues.push(`${label}.lockVersion: 期望 1`)
  }
  if (!Array.isArray(value.plugins)) {
    issues.push(`${label}.plugins: 缺失或不是数组`)
  }

  const plugins = []
  if (Array.isArray(value.plugins)) {
    const seenIds = new Set()
    for (const [index, entry] of value.plugins.entries()) {
      const at = `${label}.plugins[${index}]`
      const startIndex = issues.length
      if (!isPlainObject(entry)) {
        issues.push(`${at}: 期望对象`)
        continue
      }
      if (typeof entry.id !== 'string' || !PLUGIN_ID_PATTERN.test(entry.id)) {
        issues.push(`${at}.id: 期望小写反向域名标识`)
      } else if (seenIds.has(entry.id)) {
        issues.push(`${at}.id: 插件标识 "${entry.id}" 重复`)
      } else {
        seenIds.add(entry.id)
      }
      if (
        typeof entry.version !== 'string' ||
        !VERSION_PATTERN.test(entry.version)
      ) {
        issues.push(`${at}.version: 期望语义化版本`)
      }
      if (
        typeof entry.commit !== 'string' ||
        !COMMIT_PATTERN.test(entry.commit)
      ) {
        issues.push(`${at}.commit: 期望 40 位或 64 位小写提交标识`)
      }
      for (const key of ['manifestHash', 'packageHash']) {
        if (typeof entry[key] !== 'string' || !HASH_PATTERN.test(entry[key])) {
          issues.push(`${at}.${key}: 期望 sha256 摘要`)
        }
      }
      if (issues.length > startIndex) continue
      plugins.push({
        id: entry.id,
        version: entry.version,
        commit: entry.commit,
        manifestHash: entry.manifestHash,
        packageHash: entry.packageHash,
      })
    }
  }

  if (issues.length > 0) throw new ArtifactPackageError(issues)
  return {
    lockHash: value.lockHash,
    lockVersion: value.lockVersion,
    plugins,
    bytes,
  }
}

/**
 * Accepts the JSON emitted by `pnpm licenses list --json` in both layouts:
 * grouped by license (license key -> package array) and keyed by package.
 * Only name, version and license are consumed, so local paths never reach SBOM.
 */
function loadLicenses(file) {
  const label = '--licenses'
  const resolved = path.resolve(file)
  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch {
    fail([`${label}: 文件不存在`])
  }
  if (stat.isSymbolicLink()) fail([`${label}: 不允许符号链接`])
  if (!stat.isFile()) fail([`${label}: 期望普通文件`])
  if (stat.size > MAX_LICENSES_BYTES) {
    fail([`${label}: 文件超过 ${MAX_LICENSES_BYTES} 字节上限`])
  }

  const {value} = readJsonFile(resolved, label)
  const issues = []
  const packages = []

  const addPackage = (entry, fallbackLicense) => {
    if (!isPlainObject(entry)) {
      issues.push(`${label}: 依赖条目必须是对象`)
      return
    }
    if (
      typeof entry.name !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(entry.name)
    ) {
      issues.push(`${label}: 依赖条目缺少合法的包名`)
      return
    }
    const license =
      typeof entry.license === 'string' && entry.license.length > 0
        ? entry.license
        : typeof fallbackLicense === 'string' && fallbackLicense.length > 0
          ? fallbackLicense
          : undefined
    let versions = []
    if (Array.isArray(entry.versions)) {
      versions = entry.versions.filter(
        version => typeof version === 'string' && version.length > 0,
      )
    } else if (typeof entry.version === 'string' && entry.version.length > 0) {
      versions = [entry.version]
    }
    if (versions.length === 0) versions = [undefined]
    for (const version of versions) {
      packages.push({name: entry.name, version, license})
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) addPackage(entry)
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (Array.isArray(entry)) {
        for (const item of entry) addPackage(item, key)
      } else if (isPlainObject(entry)) {
        addPackage(entry)
      } else {
        issues.push(`${label}: 依赖条目 ${key} 格式无效`)
      }
    }
  } else {
    issues.push(`${label}: 期望对象或数组`)
  }

  if (issues.length > 0) throw new ArtifactPackageError(issues)
  return packages
}

function packageUrl(name, version) {
  const encoded = name
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  const suffix = version ? `@${encodeURIComponent(version)}` : ''
  return `pkg:npm/${encoded}${suffix}`
}

function licenseValue(license) {
  if (typeof license !== 'string' || license.length === 0) return undefined
  if (/[()]|\b(?:OR|AND|WITH)\b/.test(license)) {
    return {expression: license}
  }
  if (/^[A-Za-z0-9.+-]+$/.test(license)) {
    return {license: {id: license}}
  }
  return {license: {name: license}}
}

function buildSbom({version, plugins, licensePackages}) {
  const components = []
  const seen = new Set()

  const add = (component, key) => {
    if (seen.has(key)) return
    seen.add(key)
    components.push(component)
  }

  for (const plugin of plugins) {
    add(
      {
        type: 'library',
        'bom-ref': `pkg:generic/${plugin.id}@${plugin.version}`,
        name: plugin.id,
        version: plugin.version,
        properties: [
          {name: 'community:plugin.commit', value: plugin.commit},
          {name: 'community:plugin.manifestHash', value: plugin.manifestHash},
          {name: 'community:plugin.packageHash', value: plugin.packageHash},
        ],
      },
      `plugin:${plugin.id}@${plugin.version}`,
    )
  }

  for (const pkg of licensePackages) {
    const license = licenseValue(pkg.license)
    add(
      {
        type: 'library',
        'bom-ref': packageUrl(pkg.name, pkg.version),
        name: pkg.name,
        ...(pkg.version ? {version: pkg.version} : {}),
        ...(license ? {licenses: [license]} : {}),
      },
      `npm:${pkg.name}@${pkg.version ?? ''}`,
    )
  }

  components.sort(
    (a, b) =>
      compareUtf8(a.name, b.name) ||
      compareUtf8(a.version ?? '', b.version ?? ''),
  )

  return {
    bomFormat: 'CycloneDX',
    specVersion: SBOM_SPEC_VERSION,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `pkg:generic/${APPLICATION_NAME}@${version}`,
        name: APPLICATION_NAME,
        version,
      },
    },
    components,
  }
}

function buildSourceManifest({
  options,
  buildNumber,
  generatedAt,
  lock,
  artifacts,
}) {
  return {
    schemaVersion: SOURCE_MANIFEST_SCHEMA_VERSION,
    generatedAt,
    application: {
      name: APPLICATION_NAME,
      commit: options.sourceRevision ?? null,
    },
    platform: options.platform,
    channel: options.channel,
    version: options.version,
    buildNumber,
    lockHash: lock.lockHash,
    plugins: lock.plugins.map(plugin => ({
      id: plugin.id,
      version: plugin.version,
      commit: plugin.commit,
      manifestHash: plugin.manifestHash,
      packageHash: plugin.packageHash,
    })),
    artifacts: artifacts.map(artifact => ({
      name: artifact.name,
      sha256: artifact.sha256,
      size: artifact.size,
    })),
  }
}

function renderChecksums(artifacts) {
  return artifacts
    .map(artifact => `${artifact.sha256}  ${artifact.name}\n`)
    .join('')
}

function validateOptions(options) {
  const issues = []
  if (!PLATFORMS.has(options.platform)) {
    issues.push('--platform: 期望 android 或 ios')
  }
  if (
    typeof options.buildId !== 'string' ||
    !BUILD_ID_PATTERN.test(options.buildId) ||
    options.buildId === '.' ||
    options.buildId === '..'
  ) {
    issues.push('--build-id: 只允许字母、数字、点、下划线与连字符')
  }
  if (
    typeof options.channel !== 'string' ||
    !CHANNEL_PATTERN.test(options.channel)
  ) {
    issues.push('--channel: 只允许字母、数字、点、下划线与连字符')
  }
  if (
    typeof options.version !== 'string' ||
    !VERSION_PATTERN.test(options.version)
  ) {
    issues.push('--version: 期望语义化版本')
  }
  if (
    typeof options.buildNumber !== 'string' ||
    !BUILD_NUMBER_PATTERN.test(options.buildNumber)
  ) {
    issues.push('--build-number: 期望正整数')
  }
  if (typeof options.lockFile !== 'string' || options.lockFile.length === 0) {
    issues.push('--lock: 缺失')
  }
  if (!Array.isArray(options.artifacts) || options.artifacts.length === 0) {
    issues.push('--artifact: 至少提供一个产物')
  }
  if (typeof options.outDir !== 'string' || options.outDir.length === 0) {
    issues.push('--out: 缺失')
  }
  if (
    options.sourceRevision !== undefined &&
    (typeof options.sourceRevision !== 'string' ||
      !COMMIT_PATTERN.test(options.sourceRevision))
  ) {
    issues.push('--source-revision: 期望 40 位或 64 位小写提交标识')
  }
  if (issues.length > 0) throw new ArtifactPackageError(issues)
}

function resolveGeneratedAt(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    const parsed = Date.parse(explicit)
    if (Number.isNaN(parsed)) {
      fail(['generatedAt: 期望 ISO 时间'])
    }
    return new Date(parsed).toISOString()
  }
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch !== undefined && epoch !== '') {
    if (!/^\d+$/.test(epoch)) {
      fail(['SOURCE_DATE_EPOCH: 期望秒级 Unix 时间戳'])
    }
    const ms = Number(epoch) * 1000
    if (!Number.isFinite(ms)) {
      fail(['SOURCE_DATE_EPOCH: 数值超出范围'])
    }
    return new Date(ms).toISOString()
  }
  return new Date().toISOString()
}

function normalizeFingerprint(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value.trim())) {
    fail(['--signing-fingerprint: 期望 1-256 个可见字符'])
  }
  return value.trim()
}

function prepareArtifactList(artifacts) {
  const issues = []
  const seen = new Set()
  const prepared = []

  for (const [index, artifact] of artifacts.entries()) {
    const at = `artifact[${index}]`
    if (!isPlainObject(artifact)) {
      issues.push(`${at}: 期望对象`)
      continue
    }
    const name = artifact.name
    if (
      typeof name !== 'string' ||
      !ARTIFACT_NAME_PATTERN.test(name) ||
      name === '.' ||
      name === '..'
    ) {
      issues.push(
        `${at}.name: 文件名只允许字母、数字、点、下划线与连字符，且不得包含路径`,
      )
      continue
    }
    if (RESERVED_OUTPUT_NAMES.has(name)) {
      issues.push(`${at}.name: 名称 "${name}" 与生成文件冲突`)
      continue
    }
    if (SECRET_EXTENSION_PATTERN.test(name) || SECRET_WORD_PATTERN.test(name)) {
      issues.push(`${at}.name: 不允许打包签名密钥或凭据文件`)
      continue
    }
    if (seen.has(name)) {
      issues.push(`${at}.name: 产物名称 "${name}" 重复`)
      continue
    }
    seen.add(name)

    const source = path.resolve(artifact.path)
    let stat
    try {
      stat = fs.lstatSync(source)
    } catch {
      issues.push(`${at}.path: 文件不存在`)
      continue
    }
    if (stat.isSymbolicLink()) {
      issues.push(`${at}.path: 不允许符号链接`)
      continue
    }
    if (!stat.isFile()) {
      issues.push(`${at}.path: 期望普通文件`)
      continue
    }
    prepared.push({name, source})
  }

  if (issues.length > 0) throw new ArtifactPackageError(issues)
  return prepared.sort((a, b) => compareUtf8(a.name, b.name))
}

function prepareOutDir(outDir) {
  const resolved = path.resolve(outDir)
  assertOutRoot(resolved)

  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fail([`--out: 无法访问输出目录（${error.code ?? error.message}）`])
    }
    stat = undefined
  }

  if (stat) {
    if (stat.isSymbolicLink()) fail(['--out: 不允许符号链接'])
    if (!stat.isDirectory()) fail(['--out: 期望目录'])
    let entries
    try {
      entries = fs.readdirSync(resolved)
    } catch (error) {
      fail([`--out: 无法读取输出目录（${error.code ?? error.message}）`])
    }
    if (entries.length > 0) {
      fail(['--out: 输出目录非空，拒绝覆盖'])
    }
    return {outDir: resolved, created: false}
  }

  try {
    fs.mkdirSync(resolved, {recursive: true})
  } catch (error) {
    fail([`--out: 无法创建输出目录（${error.code ?? error.message}）`])
  }
  return {outDir: resolved, created: true}
}

/**
 * Streams the copied file through SHA-256 so large install packages are never
 * loaded into memory in full.
 */
function hashFile(file) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    let size = 0
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      size += read
      hash.update(chunk.subarray(0, read))
    }
    return {sha256: hash.digest('hex'), size}
  } finally {
    fs.closeSync(descriptor)
  }
}

function copyArtifacts(prepared, outDir, written) {
  const artifacts = []
  for (const item of prepared) {
    const target = path.join(outDir, item.name)
    if (!isInsidePath(outDir, target)) {
      fail([`${item.name}: 写入路径越界`])
    }
    try {
      fs.copyFileSync(item.source, target)
    } catch (error) {
      fail([
        `${item.name}: 无法复制到输出目录（${error.code ?? error.message}）`,
      ])
    }
    written.push(target)
    let digest
    try {
      digest = hashFile(target)
    } catch (error) {
      fail([`${item.name}: 无法计算摘要（${error.code ?? error.message}）`])
    }
    artifacts.push({name: item.name, sha256: digest.sha256, size: digest.size})
  }
  return artifacts
}

function writeOutput(outDir, name, data, written) {
  const target = path.join(outDir, name)
  if (!isInsidePath(outDir, target)) {
    fail([`${name}: 写入路径越界`])
  }
  try {
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, data)
  } catch (error) {
    fail([`${name}: 无法写入输出目录（${error.code ?? error.message}）`])
  }
  written.push(target)
}

function cleanupOutput(outDir, written, created) {
  if (created) {
    fs.rmSync(outDir, {recursive: true, force: true})
    return
  }
  for (const target of [...written].reverse()) {
    try {
      fs.unlinkSync(target)
    } catch {
      // The file may not have been written yet; nothing else to clean up.
    }
  }
  try {
    fs.rmdirSync(path.join(outDir, 'signing'))
  } catch {
    // The directory was never created.
  }
}

function assertNoSecrets(entries) {
  const issues = []
  for (const entry of entries) {
    if (
      SECRET_EXTENSION_PATTERN.test(entry.name) ||
      SECRET_WORD_PATTERN.test(entry.name)
    ) {
      issues.push(`${entry.name}: 资料包不允许包含签名密钥或凭据文件`)
      continue
    }
    if (PRIVATE_KEY_PATTERN.test(entry.data.toString('utf8'))) {
      issues.push(`${entry.name}: 资料包不允许包含私钥内容`)
    }
  }
  if (issues.length > 0) throw new ArtifactPackageError(issues)
}

let crcTable

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Converts a timestamp to the MS-DOS date/time pair used by ZIP headers. UTC is
 * used so repeated runs with the same SOURCE_DATE_EPOCH stay byte identical.
 */
function dosDateTime(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107)
  const time =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2)
  const day =
    ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return {time, date: day}
}

/**
 * Minimal ZIP writer using the store method (no compression), which keeps the
 * archive readable without any native zip binary or third-party dependency.
 */
export function createStoreZip(entries, timestampMs) {
  assertNoSecrets(entries)
  const {time, date} = dosDateTime(timestampMs)
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf8')
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    localParts.push(local, nameBytes, data)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}

/**
 * Store-only ZIP reader used to verify the generated packet without relying on
 * an external unzip implementation.
 */
export function readStoreZip(buffer) {
  if (buffer.length < 22) {
    throw new Error('不是合法的 ZIP 文件：长度不足')
  }
  let endOffset = -1
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      endOffset = index
      break
    }
  }
  if (endOffset < 0) {
    throw new Error('不是合法的 ZIP 文件：未找到中央目录结束记录')
  }

  const count = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('不是合法的 ZIP 文件：中央目录越界')
  }

  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error('不是合法的 ZIP 文件：中央目录条目无效')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    if (method !== 0) {
      throw new Error('资料包只支持 store 方式')
    }
    const checksum = buffer.readUInt32LE(cursor + 16)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8')

    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error('不是合法的 ZIP 文件：本地文件头无效')
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = buffer.subarray(dataStart, dataStart + size)
    if (data.length !== size || crc32(data) !== checksum) {
      throw new Error(`ZIP 条目 "${name}" 的 CRC 校验失败`)
    }
    entries.push({name, data})
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function normalizeLockBytes(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
}

/**
 * Collects build artifacts, writes checksums, SBOM, source manifest and the
 * store packet, and returns the metadata that the release callback consumes.
 */
export function packageArtifacts(options) {
  validateOptions(options)
  const generatedAt = resolveGeneratedAt(options.generatedAt)
  const fingerprint = normalizeFingerprint(options.signingFingerprint)
  const lock = loadLock(path.resolve(options.lockFile))
  const licensePackages = options.licensesFile
    ? loadLicenses(options.licensesFile)
    : []
  const prepared = prepareArtifactList(options.artifacts)
  const buildNumber = Number(options.buildNumber)

  const {outDir, created} = prepareOutDir(options.outDir)
  const written = []
  try {
    const artifacts = copyArtifacts(prepared, outDir, written)
    const checksums = renderChecksums(artifacts)
    const artifactsJson = `${JSON.stringify(artifacts, null, 2)}\n`
    const sourceManifest = buildSourceManifest({
      options,
      buildNumber,
      generatedAt,
      lock,
      artifacts,
    })
    const sourceManifestJson = `${JSON.stringify(sourceManifest, null, 2)}\n`
    const sbom = buildSbom({
      version: options.version,
      plugins: lock.plugins,
      licensePackages,
    })
    const sbomJson = `${JSON.stringify(sbom, null, 2)}\n`
    const fingerprintContent = `${fingerprint ?? '未配置'}\n`
    const lockBytes = normalizeLockBytes(lock.bytes)

    const packetEntries = [
      {name: PACKET_ENTRIES[0], data: Buffer.from(sourceManifestJson, 'utf8')},
      {name: PACKET_ENTRIES[1], data: lockBytes},
      {name: PACKET_ENTRIES[2], data: Buffer.from(sbomJson, 'utf8')},
      {name: PACKET_ENTRIES[3], data: Buffer.from(checksums, 'utf8')},
      {name: PACKET_ENTRIES[4], data: Buffer.from(fingerprintContent, 'utf8')},
    ]
    const packet = createStoreZip(packetEntries, Date.parse(generatedAt))

    writeOutput(outDir, 'native-plugin-lock.json', lockBytes, written)
    writeOutput(outDir, 'signing/fingerprint.txt', fingerprintContent, written)
    writeOutput(outDir, 'sbom.json', sbomJson, written)
    writeOutput(outDir, 'checksums.txt', checksums, written)
    writeOutput(outDir, 'artifacts.json', artifactsJson, written)
    writeOutput(outDir, 'source-manifest.json', sourceManifestJson, written)
    writeOutput(outDir, 'store-packet.zip', packet, written)

    return {
      outDir,
      artifacts,
      checksums,
      sbom,
      sourceManifest,
      lockHash: lock.lockHash,
      fingerprint: fingerprint ?? null,
      files: [...written]
        .map(target => path.relative(outDir, target).split(path.sep).join('/'))
        .sort(compareUtf8),
    }
  } catch (error) {
    cleanupOutput(outDir, written, created)
    throw error
  }
}

const VALUE_FLAGS = new Set([
  '--platform',
  '--build-id',
  '--channel',
  '--version',
  '--build-number',
  '--lock',
  '--artifact',
  '--licenses',
  '--signing-fingerprint',
  '--source-revision',
  '--out',
])

export function parseArgs(argv) {
  const options = {
    platform: undefined,
    buildId: undefined,
    channel: undefined,
    version: undefined,
    buildNumber: undefined,
    lockFile: undefined,
    artifacts: [],
    licensesFile: undefined,
    signingFingerprint: undefined,
    sourceRevision: undefined,
    outDir: undefined,
  }
  const seen = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return {help: true}
    if (!VALUE_FLAGS.has(arg)) {
      throw new Error(`未知参数：${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} 缺少参数值`)
    }
    index += 1
    if (arg !== '--artifact') {
      if (seen.has(arg)) throw new Error(`参数 ${arg} 重复`)
      seen.add(arg)
    }

    if (arg === '--artifact') {
      const separator = value.indexOf('=')
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error('--artifact 期望 <名称>=<路径>')
      }
      options.artifacts.push({
        name: value.slice(0, separator),
        path: value.slice(separator + 1),
      })
    } else if (arg === '--platform') options.platform = value
    else if (arg === '--build-id') options.buildId = value
    else if (arg === '--channel') options.channel = value
    else if (arg === '--version') options.version = value
    else if (arg === '--build-number') options.buildNumber = value
    else if (arg === '--lock') options.lockFile = value
    else if (arg === '--licenses') options.licensesFile = value
    else if (arg === '--signing-fingerprint') {
      options.signingFingerprint = value
    } else if (arg === '--source-revision') options.sourceRevision = value
    else options.outDir = value
  }

  const missing = []
  if (!options.platform) missing.push('--platform')
  if (!options.buildId) missing.push('--build-id')
  if (!options.channel) missing.push('--channel')
  if (!options.version) missing.push('--version')
  if (!options.buildNumber) missing.push('--build-number')
  if (!options.lockFile) missing.push('--lock')
  if (options.artifacts.length === 0) missing.push('--artifact')
  if (!options.outDir) missing.push('--out')
  if (missing.length > 0) {
    throw new Error(`缺少必需参数：${missing.join('、')}`)
  }

  return options
}

export function usageText() {
  return [
    '用法：',
    '  node scripts/release/package-artifacts.mjs \\',
    '    --platform <android|ios> --build-id <构建单号> --channel <渠道> \\',
    '    --version <版本> --build-number <构建号> \\',
    '    --lock <native-plugin-lock.json> \\',
    '    --artifact <名称>=<路径> [--artifact <名称>=<路径> ...] \\',
    '    --out <输出目录>',
    '',
    '可选参数：',
    '  --licenses <pnpm licenses JSON>  依赖清单，写入 SBOM',
    '  --signing-fingerprint <指纹>     签名证书指纹，仅写入资料包',
    '  --source-revision <提交>         应用提交标识，写入来源清单',
    '',
    '说明：',
    '  - 输出目录必须为空，且不得是仓库根目录或其上级目录。',
    '  - 生成时间优先取 SOURCE_DATE_EPOCH（秒），未设置时使用当前时间。',
    '  - 产物名称只允许字母、数字、点、下划线与连字符。',
  ].join('\n')
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`产物打包失败：${error.message}`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(usageText())
    return
  }

  try {
    const result = packageArtifacts(options)
    console.log('产物打包完成：')
    console.log(`  平台：${options.platform}；渠道：${options.channel}`)
    console.log(
      `  版本：${options.version}（构建号 ${result.sourceManifest.buildNumber}）`,
    )
    console.log(
      `  产物：${result.artifacts.length} 个；锁哈希：${result.lockHash}`,
    )
    console.log(`  输出目录：${result.outDir}`)
  } catch (error) {
    if (error instanceof ArtifactPackageError) {
      console.error(`产物打包失败，共 ${error.issues.length} 项：`)
      for (const issue of error.issues) console.error(`- ${issue}`)
    } else {
      console.error(`产物打包失败：${error?.message ?? String(error)}`)
    }
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
