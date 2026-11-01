#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(HERE, '../..')
const INSTALL_PACKAGES = 'android.permission.REQUEST_INSTALL_PACKAGES'
const SELF_UPDATE_MODULE = 'app-updater'
const STORE_CHANNELS = new Set(['google_play', 'app_store', 'china_store'])
const CHANNELS = new Set([...STORE_CHANNELS, 'enterprise', 'development'])
const DEFAULT_MANIFEST = 'android/app/src/main/AndroidManifest.xml'
const DEFAULT_AUTOLINKING =
  'android/app/build/generated/autolinking/autolinking.json'

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

export function parsePermissions(manifest) {
  const permissions = new Set()
  const pattern =
    /<uses-permission(?:-sdk-\d+)?\b[^>]*\bandroid:name\s*=\s*"([^"]+)"[^>]*>/g
  for (const match of manifest.matchAll(pattern)) {
    permissions.add(match[1])
  }
  return [...permissions].sort()
}

function collectStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output)
  }
}

export function parseModules(source) {
  const parsed = JSON.parse(source)
  const values = []
  if (Array.isArray(parsed?.modules)) {
    for (const module of parsed.modules) {
      collectStrings(module, values)
    }
  }
  if (Array.isArray(parsed?.packages)) {
    collectStrings(parsed.packages, values)
  }
  if (parsed?.dependencies && typeof parsed.dependencies === 'object') {
    values.push(...Object.keys(parsed.dependencies))
  }
  if (values.length === 0) {
    collectStrings(parsed, values)
  }
  return [...new Set(values)].sort()
}

export function hasSelfUpdateModule(modules) {
  return modules.some(value => value.toLowerCase().includes(SELF_UPDATE_MODULE))
}

function findManifest(repoRoot) {
  const file = path.join(repoRoot, DEFAULT_MANIFEST)
  return fs.existsSync(file) ? file : undefined
}

function scanAndroidSource(repoRoot) {
  const androidDir = path.join(repoRoot, 'android')
  if (!fs.existsSync(androidDir)) return false
  const pending = [androidDir]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(full)
      } else if (entry.isFile() && entry.name.endsWith('.xml')) {
        if (readText(full).includes(INSTALL_PACKAGES)) return true
      }
    }
  }
  return false
}

function findModules(repoRoot) {
  const autolinking = path.join(repoRoot, DEFAULT_AUTOLINKING)
  if (fs.existsSync(autolinking)) {
    return {file: autolinking, modules: parseModules(readText(autolinking))}
  }
  const modulesDir = path.join(repoRoot, 'modules')
  if (!fs.existsSync(modulesDir)) return {file: undefined, modules: []}
  const modules = fs
    .readdirSync(modulesDir, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  return {file: modulesDir, modules}
}

/**
 * Asserts that a channel's manifest matches the distribution policy. Store
 * channels must not carry the self-update permission or module; the enterprise
 * channel must carry both so the APK updater keeps working.
 */
export function assertChannel(options) {
  const {
    channel,
    repoRoot = DEFAULT_REPO_ROOT,
    manifestFile,
    modulesFile,
    requireManifest = false,
  } = options

  if (!CHANNELS.has(channel)) {
    return {
      ok: false,
      channel,
      reasons: [`不支持的渠道：${String(channel)}`],
    }
  }

  const resolvedManifest = manifestFile
    ? path.resolve(manifestFile)
    : findManifest(repoRoot)
  if (requireManifest && !resolvedManifest) {
    return {
      ok: false,
      channel,
      reasons: ['构建后校验需要 AndroidManifest.xml，但未找到。'],
    }
  }

  const reasons = []
  let permissions = []
  let selfUpdateModule = false
  let manifestMissing = false

  if (resolvedManifest) {
    if (!fs.existsSync(resolvedManifest)) {
      return {
        ok: false,
        channel,
        reasons: [`AndroidManifest.xml 不存在：${resolvedManifest}`],
      }
    }
    permissions = parsePermissions(readText(resolvedManifest))
  } else {
    manifestMissing = true
    if (scanAndroidSource(repoRoot)) permissions = [INSTALL_PACKAGES]
  }

  const moduleInfo = modulesFile
    ? {
        file: path.resolve(modulesFile),
        modules: parseModules(readText(path.resolve(modulesFile))),
      }
    : findModules(repoRoot)
  selfUpdateModule = hasSelfUpdateModule(moduleInfo.modules)

  const hasInstallPermission = permissions.includes(INSTALL_PACKAGES)

  if (STORE_CHANNELS.has(channel)) {
    if (hasInstallPermission) {
      reasons.push(`${channel} 渠道不得包含 ${INSTALL_PACKAGES}。`)
    }
    if (selfUpdateModule) {
      reasons.push(`${channel} 渠道不得包含自更新模块 ${SELF_UPDATE_MODULE}。`)
    }
  } else if (channel === 'enterprise') {
    if (!hasInstallPermission) {
      reasons.push(`enterprise 渠道缺少 ${INSTALL_PACKAGES}。`)
    }
    if (!selfUpdateModule) {
      reasons.push(`enterprise 渠道缺少自更新模块 ${SELF_UPDATE_MODULE}。`)
    }
  }

  return {
    ok: reasons.length === 0,
    channel,
    manifest: resolvedManifest ?? null,
    manifestMissing,
    permissions,
    selfUpdateModule,
    modulesFile: moduleInfo.file ?? null,
    reasons,
  }
}

function parseArgs(argv) {
  const options = {channel: undefined, out: undefined, requireManifest: false}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return {help: true}
    if (arg === '--require-manifest') {
      options.requireManifest = true
      continue
    }
    if (
      !['--channel', '--manifest', '--modules', '--out', '--root'].includes(arg)
    ) {
      throw new Error(`未知参数：${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} 缺少参数值`)
    }
    index += 1
    if (arg === '--channel') options.channel = value
    else if (arg === '--manifest') options.manifestFile = value
    else if (arg === '--modules') options.modulesFile = value
    else if (arg === '--out') options.out = value
    else options.repoRoot = path.resolve(value)
  }
  if (!options.channel) throw new Error('必须提供 --channel')
  return options
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`渠道校验失败：${error.message}`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(
      '用法：node scripts/plugins/assert-channel.mjs --channel <google_play|app_store|china_store|enterprise|development> [--manifest <文件>] [--modules <文件>] [--out <记录文件>] [--require-manifest]',
    )
    return
  }

  const result = assertChannel(options)
  if (options.out) {
    const target = path.resolve(options.out)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
  if (!result.ok) {
    console.error(`渠道校验失败（${result.channel}）：`)
    for (const reason of result.reasons) console.error(`  - ${reason}`)
    process.exitCode = 1
    return
  }
  const suffix = result.manifestMissing ? '（未生成原生工程，按源码断言）' : ''
  console.log(`渠道校验通过：${result.channel}${suffix}`)
  console.log(
    `  权限 ${result.permissions.length} 项，自更新模块：${result.selfUpdateModule ? '存在' : '不存在'}`,
  )
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
