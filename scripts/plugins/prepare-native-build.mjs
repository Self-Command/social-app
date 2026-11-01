#!/usr/bin/env node
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

import {
  NativePipelineError,
  REPO_ROOT,
  assembleNative,
  computeLockHash,
  reportPipelineError,
  serializeNativeLock,
} from './native-pipeline-lib.mjs'

const LOCK_KEYS = ['lockVersion', 'plugins', 'lockHash']
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
const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const MODULE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
const PACKAGE_PREFIX = '@community-plugins/'
const PACKAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEIGHT_MODES = new Set(['fixed', 'content'])
const GENERATED_FILES = [
  'src/features/plugins/generated/native-registry.ts',
  'src/features/plugins/generated/native-plugin-lock.json',
  'src/features/plugins/generated/native-lock.ts',
  'src/features/plugins/generated/native-config.json',
  'src/features/plugins/catalog/catalog.generated.ts',
]

const USAGE = `用法：
  node scripts/plugins/prepare-native-build.mjs --lock <锁文件> --work <工作目录> [--sources <来源映射>] [--app-root <仓库根>] [--fetch] [--skip-git-check]

--fetch 通过 PLUGIN_GIT_HEADER 环境变量提供的认证头克隆插件仓库；
不使用 --fetch 时要求插件目录已存在，并校验 HEAD 与锁记录一致。
--skip-git-check 仅供本地夹具测试，生产构建不得使用。`

class CliError extends Error {}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function readJson(file, label, issues) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    issues.push(`${label}: 无法读取（${error.code ?? error.message}）`)
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    issues.push(`${label}: 不是合法 JSON（${error.message}）`)
    return undefined
  }
}

function checkKeys(value, allowed, label, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${label}.${key}: 未知字段`)
  }
}

function validateStringList(value, label, issues, {minLength = 0} = {}) {
  if (!Array.isArray(value)) {
    issues.push(`${label}: 期望数组`)
    return []
  }
  if (value.length < minLength) issues.push(`${label}: 至少 ${minLength} 项`)
  return value
}

function validateEntry(entry, index, issues) {
  const at = `lock.plugins[${index}]`
  if (!isPlainObject(entry)) {
    issues.push(`${at}: 期望对象`)
    return undefined
  }
  checkKeys(entry, ENTRY_KEYS, at, issues)
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
    issues.push(`${at}.id: 期望小写反向域名标识且不含连字符`)
  }
  if (
    typeof entry.version !== 'string' ||
    !SEMVER_PATTERN.test(entry.version)
  ) {
    issues.push(`${at}.version: 期望语义化版本`)
  }
  if (typeof entry.commit !== 'string' || !COMMIT_PATTERN.test(entry.commit)) {
    issues.push(`${at}.commit: 期望 40 位小写提交标识`)
  }
  for (const key of ['manifestHash', 'packageHash']) {
    if (typeof entry[key] !== 'string' || !HASH_PATTERN.test(entry[key])) {
      issues.push(`${at}.${key}: 期望 sha256 摘要`)
    }
  }
  if (entry.hostApi !== 2) issues.push(`${at}.hostApi: 期望 2`)
  if (entry.nativeApi !== 1) issues.push(`${at}.nativeApi: 期望 1`)

  const modules = validateStringList(entry.modules, `${at}.modules`, issues, {
    minLength: 1,
  })
  for (const [moduleIndex, module] of modules.entries()) {
    if (
      typeof module !== 'string' ||
      module.length > 64 ||
      !MODULE_PATTERN.test(module)
    ) {
      issues.push(`${at}.modules[${moduleIndex}]: 期望模块标识符`)
    }
  }

  const views = validateStringList(entry.views, `${at}.views`, issues, {
    minLength: 1,
  })
  for (const [viewIndex, view] of views.entries()) {
    const viewAt = `${at}.views[${viewIndex}]`
    if (!isPlainObject(view)) {
      issues.push(`${viewAt}: 期望对象`)
      continue
    }
    checkKeys(view, VIEW_KEYS, viewAt, issues)
    if (
      typeof view.name !== 'string' ||
      !MODULE_PATTERN.test(view.name) ||
      !HEIGHT_MODES.has(view.heightMode)
    ) {
      issues.push(`${viewAt}: 期望有效的视图名称与高度模式`)
    }
  }

  return {
    id: entry.id,
    version: entry.version,
    commit: entry.commit,
    manifestHash: entry.manifestHash,
    packageHash: entry.packageHash,
    hostApi: entry.hostApi,
    nativeApi: entry.nativeApi,
    modules: [...modules],
    views: views.map(view => ({
      name: view.name,
      heightMode: view.heightMode,
    })),
  }
}

function readLock(lockFile) {
  const issues = []
  const value = readJson(lockFile, '锁文件', issues)
  if (!value) throw new NativePipelineError(issues)
  if (!isPlainObject(value)) {
    throw new NativePipelineError(['锁文件: 期望对象'])
  }
  checkKeys(value, LOCK_KEYS, 'lock', issues)
  if (value.lockVersion !== 1) {
    issues.push(`lock.lockVersion: 期望 1，实际 ${String(value.lockVersion)}`)
  }
  if (
    typeof value.lockHash !== 'string' ||
    !HASH_PATTERN.test(value.lockHash)
  ) {
    issues.push('lock.lockHash: 期望 sha256 摘要')
  }
  if (!Array.isArray(value.plugins)) {
    issues.push('lock.plugins: 期望数组')
    throw new NativePipelineError(issues)
  }

  const plugins = []
  const seen = new Set()
  let lastId = ''
  for (const [index, entry] of value.plugins.entries()) {
    const normalized = validateEntry(entry, index, issues)
    if (!normalized) continue
    if (seen.has(normalized.id)) {
      issues.push(`lock.plugins[${index}].id: 插件标识重复`)
    } else if (normalized.id < lastId) {
      issues.push(`lock.plugins[${index}].id: 必须按标识升序排列`)
    }
    seen.add(normalized.id)
    lastId = normalized.id
    plugins.push(normalized)
  }

  if (issues.length > 0) throw new NativePipelineError(issues)
  const expectedHash = computeLockHash(plugins)
  if (expectedHash !== value.lockHash) {
    throw new NativePipelineError([
      `lock.lockHash: 与锁内容不一致（期望 ${expectedHash}，实际 ${value.lockHash}）`,
    ])
  }
  return {lockHash: value.lockHash, plugins}
}

function readSources(sourcesFile, plugins) {
  const issues = []
  const value = readJson(sourcesFile, '插件来源映射', issues)
  if (!value) throw new NativePipelineError(issues)
  if (!isPlainObject(value)) {
    throw new NativePipelineError(['插件来源映射: 期望对象'])
  }
  const expectedIds = new Set(plugins.map(plugin => plugin.id))
  for (const [id, repository] of Object.entries(value)) {
    if (!expectedIds.has(id)) {
      issues.push(`插件来源映射.${id}: 锁中没有该插件`)
      continue
    }
    if (
      typeof repository !== 'string' ||
      !REPOSITORY_PATTERN.test(repository) ||
      repository.includes('..')
    ) {
      issues.push(
        `插件来源映射.${id}: 期望 <owner>/<repo> 形式，且不得包含路径回溯`,
      )
    }
  }
  for (const id of expectedIds) {
    if (!Object.hasOwn(value, id)) {
      issues.push(`插件来源映射.${id}: 缺少仓库地址`)
    }
  }
  if (issues.length > 0) throw new NativePipelineError(issues)
  return value
}

function runGit(args, cwd) {
  const env = {...process.env}
  if (process.env.PLUGIN_GIT_HEADER) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = process.env.PLUGIN_GIT_HEADER
  }
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = String(error.stderr ?? '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ')
    throw new CliError(
      `git ${args.join(' ')} 执行失败${stderr ? `：${stderr}` : ''}`,
    )
  }
}

function checkoutPlugin({id, repository, commit, dest, fetch, skipGitCheck}) {
  if (fetch) {
    if (!process.env.PLUGIN_GIT_HEADER) {
      throw new CliError(
        '--fetch 需要 PLUGIN_GIT_HEADER 环境变量（由工作流从 Environment Secret 构造）',
      )
    }
    fs.rmSync(dest, {recursive: true, force: true})
    fs.mkdirSync(dest, {recursive: true})
    runGit(['init', '-q'], dest)
    runGit(
      ['remote', 'add', 'origin', `https://github.com/${repository}.git`],
      dest,
    )
    runGit(['fetch', '--depth=1', 'origin', commit], dest)
    runGit(['checkout', '-q', '--detach', 'FETCH_HEAD'], dest)
  }

  if (skipGitCheck) return
  const head = runGit(['rev-parse', 'HEAD'], dest).trim()
  if (head !== commit) {
    throw new CliError(
      `插件 ${id} 的提交不一致：锁记录 ${commit}，实际 HEAD ${head}`,
    )
  }
}

function assertNoSymlink(target, label) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return false
  }
  if (stat.isSymbolicLink()) {
    throw new NativePipelineError([`${label}: 不允许符号链接`])
  }
  return true
}

function resetDirInside(root, target, label) {
  if (!isInside(root, target)) {
    throw new NativePipelineError([`${label}: 路径越界`])
  }
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    throw new NativePipelineError([`${label}: 目标为符号链接，拒绝替换`])
  }
  if (!stat.isDirectory()) {
    throw new NativePipelineError([`${label}: 期望目录，拒绝替换`])
  }
  fs.rmSync(target, {recursive: true, force: true})
}

function copyTree(source, target) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    throw new NativePipelineError([`${toPosix(source)}: 不允许复制符号链接`])
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, {recursive: true})
    for (const name of fs.readdirSync(source).sort()) {
      copyTree(path.join(source, name), path.join(target, name))
    }
    return
  }
  if (!stat.isFile()) {
    throw new NativePipelineError([`${toPosix(source)}: 不支持的文件类型`])
  }
  fs.mkdirSync(path.dirname(target), {recursive: true})
  fs.copyFileSync(source, target)
}

function ensurePackageLink(appRoot, slug, moduleDir, links) {
  const linkRoot = path.join(appRoot, 'node_modules', '@community-plugins')
  const linkPath = path.join(linkRoot, slug)
  if (!isInside(appRoot, linkPath) || !isInside(appRoot, moduleDir)) {
    throw new NativePipelineError([
      `node_modules/@community-plugins/${slug}: 路径越界`,
    ])
  }
  fs.mkdirSync(linkRoot, {recursive: true})

  let stat
  try {
    stat = fs.lstatSync(linkPath)
  } catch {
    stat = undefined
  }
  if (stat) {
    if (!stat.isSymbolicLink()) {
      throw new NativePipelineError([
        `node_modules/@community-plugins/${slug}: 已存在同名真实目录，拒绝替换`,
      ])
    }
    let currentReal = ''
    try {
      currentReal = fs.realpathSync(linkPath)
    } catch {
      currentReal = ''
    }
    const targetReal = fs.realpathSync(moduleDir)
    const same =
      process.platform === 'win32'
        ? currentReal.toLowerCase() === targetReal.toLowerCase()
        : currentReal === targetReal
    if (same) {
      links.push({
        link: `node_modules/@community-plugins/${slug}`,
        status: 'existing',
      })
      return
    }
    try {
      fs.unlinkSync(linkPath)
    } catch {
      fs.rmdirSync(linkPath)
    }
  }

  fs.symlinkSync(
    moduleDir,
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  links.push({
    link: `node_modules/@community-plugins/${slug}`,
    status: 'created',
  })
}

function overlayAssembly({appRoot, assemblyDir, plugins}) {
  const files = []
  for (const plugin of plugins) {
    const slug = plugin.native.package.slice(PACKAGE_PREFIX.length)
    const catalogRel = `src/features/plugins/catalog/${plugin.id}`
    const moduleRel = `modules/plugin-${slug}`

    const catalogSource = path.join(assemblyDir, catalogRel)
    const catalogTarget = path.join(appRoot, catalogRel)
    resetDirInside(appRoot, catalogTarget, catalogRel)
    copyTree(catalogSource, catalogTarget)
    files.push(toPosix(catalogRel))

    const moduleSource = path.join(assemblyDir, moduleRel)
    const moduleTarget = path.join(appRoot, moduleRel)
    resetDirInside(appRoot, moduleTarget, moduleRel)
    copyTree(moduleSource, moduleTarget)
    files.push(toPosix(moduleRel))
  }

  for (const relative of GENERATED_FILES) {
    const source = path.join(assemblyDir, relative)
    const target = path.join(appRoot, relative)
    if (!isInside(appRoot, target)) {
      throw new NativePipelineError([`${relative}: 路径越界`])
    }
    assertNoSymlink(target, relative)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.copyFileSync(source, target)
    files.push(relative)
  }

  const links = []
  for (const plugin of plugins) {
    const slug = plugin.native.package.slice(PACKAGE_PREFIX.length)
    if (!PACKAGE_SLUG_PATTERN.test(slug)) {
      throw new NativePipelineError([
        `插件 ${plugin.id}: 原生包名 "${plugin.native.package}" 无效`,
      ])
    }
    ensurePackageLink(
      appRoot,
      slug,
      path.join(appRoot, 'modules', `plugin-${slug}`),
      links,
    )
  }
  return {files, links}
}

function parseArgs(argv) {
  const options = {
    lock: undefined,
    sources: undefined,
    work: undefined,
    appRoot: REPO_ROOT,
    fetch: false,
    skipGitCheck: false,
    noOverlay: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (arg === '--fetch') {
      options.fetch = true
      continue
    }
    if (arg === '--skip-git-check') {
      options.skipGitCheck = true
      continue
    }
    if (arg === '--no-overlay') {
      options.noOverlay = true
      continue
    }
    if (!['--lock', '--sources', '--work', '--app-root'].includes(arg)) {
      throw new CliError(`未知参数：${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`${arg} 缺少参数值`)
    }
    index += 1
    if (arg === '--lock') options.lock = value
    else if (arg === '--sources') options.sources = value
    else if (arg === '--work') options.work = value
    else options.appRoot = path.resolve(value)
  }
  if (!options.lock) throw new CliError('必须提供 --lock')
  if (!options.work) throw new CliError('必须提供 --work')
  if (options.fetch && options.skipGitCheck) {
    throw new CliError('--fetch 与 --skip-git-check 不能同时使用')
  }
  options.lock = path.resolve(options.lock)
  options.work = path.resolve(options.work)
  options.sources = options.sources
    ? path.resolve(options.sources)
    : path.join(options.work, 'sources.json')
  if (
    !fs.existsSync(options.appRoot) ||
    !fs.statSync(options.appRoot).isDirectory()
  ) {
    throw new CliError('--app-root 必须是已存在的目录')
  }
  return options
}

function run(options) {
  const {lockHash, plugins} = readLock(options.lock)
  const sources = readSources(options.sources, plugins)

  const pluginsRoot = path.join(options.work, 'plugins')
  fs.mkdirSync(pluginsRoot, {recursive: true})

  for (const plugin of plugins) {
    const dest = path.join(pluginsRoot, plugin.id)
    if (!options.fetch) {
      if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
        throw new CliError(
          `插件 ${plugin.id} 的源码目录不存在：${toPosix(dest)}`,
        )
      }
      assertNoSymlink(dest, `plugins/${plugin.id}`)
    }
    checkoutPlugin({
      id: plugin.id,
      repository: sources[plugin.id],
      commit: plugin.commit,
      dest,
      fetch: options.fetch,
      skipGitCheck: options.skipGitCheck,
    })
  }

  const snapshotFile = path.join(options.work, 'snapshot.json')
  const snapshot = {
    schemaVersion: 1,
    plugins: plugins.map(plugin => ({
      id: plugin.id,
      version: plugin.version,
      commit: plugin.commit,
      sourceDir: `plugins/${plugin.id}`,
      manifestHash: plugin.manifestHash,
      packageHash: plugin.packageHash,
    })),
  }
  fs.writeFileSync(
    snapshotFile,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  )

  const assemblyDir = path.join(options.work, 'assembly')
  fs.rmSync(assemblyDir, {recursive: true, force: true})
  const assembly = assembleNative({snapshotFile, outDir: assemblyDir})

  if (assembly.lock.lockHash !== lockHash) {
    throw new NativePipelineError([
      `装配后的锁哈希与输入锁不一致（输入 ${lockHash}，装配 ${assembly.lock.lockHash}）`,
    ])
  }
  const inputLock = {lockVersion: 1, plugins, lockHash}
  const expectedLock = serializeNativeLock(inputLock)
  const actualLock = fs.readFileSync(
    path.join(
      assemblyDir,
      'src/features/plugins/generated/native-plugin-lock.json',
    ),
    'utf8',
  )
  if (expectedLock !== actualLock) {
    throw new NativePipelineError([
      '装配生成的锁文件与输入锁内容不一致，请重新生成锁文件',
    ])
  }

  const nativePlugins = []
  for (const plugin of plugins) {
    const manifestIssues = []
    const manifestFile = path.join(pluginsRoot, plugin.id, 'manifest.json')
    const manifest = readJson(
      manifestFile,
      `${plugin.id} manifest`,
      manifestIssues,
    )
    if (!manifest || manifestIssues.length > 0) {
      throw new NativePipelineError(manifestIssues)
    }
    nativePlugins.push({
      id: plugin.id,
      version: plugin.version,
      commit: plugin.commit,
      native: manifest.native,
    })
  }

  let overlay = {files: [], links: []}
  if (!options.noOverlay) {
    overlay = overlayAssembly({
      appRoot: options.appRoot,
      assemblyDir,
      plugins: nativePlugins,
    })
  }

  const record = {
    schemaVersion: 1,
    lockHash,
    appRoot: toPosix(path.relative(REPO_ROOT, options.appRoot) || '.'),
    plugins: plugins.map(plugin => ({
      id: plugin.id,
      version: plugin.version,
      commit: plugin.commit,
    })),
    files: overlay.files,
    links: overlay.links,
  }
  const recordFile = path.join(options.work, 'assembly-record.json')
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

  console.log(`原生插件装配完成：${plugins.length} 个插件`)
  console.log(`  锁哈希：${lockHash}`)
  console.log(`  工作目录：${toPosix(options.work)}`)
  if (!options.noOverlay) {
    console.log(
      `  覆盖文件 ${overlay.files.length} 项，包链接 ${overlay.links.length} 项`,
    )
  }
  return record
}

function main(argv) {
  try {
    const options = parseArgs(argv)
    run(options)
  } catch (error) {
    reportPipelineError('prepare-native-build', error)
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main(process.argv.slice(2))
}

export {run, readLock, readSources}
