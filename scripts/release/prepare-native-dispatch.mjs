#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

import {readLock} from '../plugins/prepare-native-build.mjs'

const PROFILES = new Set(['enterprise', 'production', 'testflight'])
const CHANNELS = new Set([
  'development',
  'enterprise',
  'google_play',
  'app_store',
  'china_store',
])
const CHANNEL_PLATFORMS = new Map([
  ['development', new Set(['android', 'ios'])],
  ['enterprise', new Set(['android'])],
  ['google_play', new Set(['android'])],
  ['app_store', new Set(['ios'])],
  ['china_store', new Set(['android'])],
])

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const BUILD_NUMBER_PATTERN = /^[1-9]\d{0,8}$/
const NONCE_PATTERN = /^[A-Za-z0-9._-]{16,128}$/
const APPROVAL_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FINGERPRINT_PATTERN =
  /^[0-9A-Fa-f]{64}$|^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/

const USAGE = `用法：
  node scripts/release/prepare-native-dispatch.mjs \\
    --work <目录> --lock <锁文件> \\
    --build-id <构建单号> --profile <enterprise|production|testflight> \\
    --platform <android|ios> --channel <渠道> --version <版本> \\
    --build-number <构建号> --callback-url <HTTPS> --nonce <nonce> \\
    --signing-fingerprint <指纹> --plugin-repos <JSON> \\
    --github-repo <owner/repo> --release-repo <owner/repo> \\
    [--app-revision <提交>] [--approval-id <编号>]

校验手动构建派发参数，写出插件来源映射、失败回调所需空产物清单与阶段标记。
锁文件由工作流从 workflow_dispatch 输入写入，本脚本不联网、不读取任何密钥。`

class CliError extends Error {}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message) {
  throw new CliError(message)
}

function normalizeFingerprint(value) {
  const compact = value.replaceAll(':', '').toUpperCase()
  const pairs = []
  for (let index = 0; index < compact.length; index += 2) {
    pairs.push(compact.slice(index, index + 2))
  }
  return pairs.join(':')
}

function checkCallbackUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('--callback-url: 必须是有效的 HTTPS 地址')
  }
  if (url.protocol !== 'https:') {
    fail('--callback-url: 必须使用 HTTPS')
  }
  if (url.username || url.password) {
    fail('--callback-url: 不得包含凭据')
  }
  if (url.search || url.hash) {
    fail('--callback-url: 不得包含查询参数或片段')
  }
  return value
}

function checkRepository(value, label) {
  if (
    typeof value !== 'string' ||
    !REPOSITORY_PATTERN.test(value) ||
    value.includes('..') ||
    value.toLowerCase().endsWith('.git')
  ) {
    fail(`${label}: 期望 <owner>/<repo> 形式，且不得包含路径回溯`)
  }
  return value
}

function readPluginRepos(raw, pluginIds) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail('--plugin-repos: 必须是合法 JSON')
  }
  if (!isPlainObject(value)) fail('--plugin-repos: 期望对象')
  const expected = new Set(pluginIds)
  for (const [id, repository] of Object.entries(value)) {
    if (!expected.has(id)) {
      fail(`--plugin-repos.${id}: 锁中没有该插件`)
    }
    checkRepository(repository, `--plugin-repos.${id}`)
  }
  for (const id of expected) {
    if (!Object.hasOwn(value, id)) {
      fail(`--plugin-repos.${id}: 缺少仓库地址`)
    }
  }
  return value
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, content, 'utf8')
}

/**
 * Validates one workflow_dispatch payload and writes the files later steps
 * consume. The lock itself is validated with the same reader the assembly
 * uses, so a malformed lock never reaches checkout.
 */
export function prepareDispatch(options) {
  const issues = []
  if (!BUILD_ID_PATTERN.test(options.buildId ?? '')) {
    issues.push(
      '--build-id: 只允许字母、数字、点、下划线与连字符，且不以符号开头',
    )
  }
  if (!PROFILES.has(options.profile)) {
    issues.push('--profile: 期望 enterprise、production 或 testflight')
  }
  if (options.platform !== 'android' && options.platform !== 'ios') {
    issues.push('--platform: 期望 android 或 ios')
  }
  if (!CHANNELS.has(options.channel)) {
    issues.push(
      '--channel: 期望 development、enterprise、google_play、app_store 或 china_store',
    )
  }
  if (!VERSION_PATTERN.test(options.version ?? '')) {
    issues.push('--version: 期望语义化版本')
  }
  if (!BUILD_NUMBER_PATTERN.test(options.buildNumber ?? '')) {
    issues.push('--build-number: 期望 1-9 位正整数')
  }
  if (!NONCE_PATTERN.test(options.nonce ?? '')) {
    issues.push('--nonce: 期望 16-128 位字母、数字、点、下划线或连字符')
  }
  if (!FINGERPRINT_PATTERN.test(options.signingFingerprint ?? '')) {
    issues.push('--signing-fingerprint: 期望 32 字节 SHA-256 指纹')
  }
  if (
    options.appRevision !== undefined &&
    options.appRevision !== '' &&
    !COMMIT_PATTERN.test(options.appRevision)
  ) {
    issues.push('--app-revision: 期望 40 位或 64 位小写提交标识')
  }
  if (
    options.approvalId !== undefined &&
    options.approvalId !== '' &&
    !APPROVAL_PATTERN.test(options.approvalId)
  ) {
    issues.push('--approval-id: 只允许字母、数字、点、下划线与连字符')
  }
  if (issues.length > 0) throw new CliError(issues.join('\n'))

  checkCallbackUrl(options.callbackUrl ?? '')
  if (!options.githubRepo) fail('--github-repo: 缺失')
  if (!options.releaseRepo) fail('--release-repo: 缺失')
  if (options.githubRepo.toLowerCase() !== options.releaseRepo.toLowerCase()) {
    fail(
      `--release-repo: 当前工作流只有本仓库 GITHUB_TOKEN，无法向 ${options.releaseRepo} 写入 Release；请先配置发布仓库令牌（未在凭据清单内）。`,
    )
  }

  const allowedPlatforms = CHANNEL_PLATFORMS.get(options.channel)
  if (!allowedPlatforms.has(options.platform)) {
    fail(
      `--channel: ${options.channel} 渠道不支持 ${options.platform} 构建（允许：${[...allowedPlatforms].join('、')}）`,
    )
  }

  let lock
  try {
    lock = readLock(options.lockFile)
  } catch (error) {
    throw new CliError(`锁文件校验失败：${error.message}`)
  }
  const pluginIds = lock.plugins.map(plugin => plugin.id)
  const sources = readPluginRepos(options.pluginRepos ?? '', pluginIds)

  const work = path.resolve(options.work)
  fs.mkdirSync(work, {recursive: true})
  const sourcesFile = path.join(work, 'inputs', 'sources.json')
  writeFile(sourcesFile, `${JSON.stringify(sources, null, 2)}\n`)
  const emptyArtifacts = path.join(work, 'inputs', 'empty-artifacts.json')
  writeFile(emptyArtifacts, '[]\n')
  const stageFile = path.join(work, 'stage.txt')
  writeFile(stageFile, 'validate\n')
  const dispatchRecord = path.join(work, 'dispatch.json')
  writeFile(
    dispatchRecord,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        buildId: options.buildId,
        profile: options.profile,
        platform: options.platform,
        channel: options.channel,
        version: options.version,
        buildNumber: options.buildNumber,
        lockHash: lock.lockHash,
        appRevision: options.appRevision || null,
        approvalId: options.approvalId || null,
        plugins: lock.plugins.map(plugin => ({
          id: plugin.id,
          version: plugin.version,
          commit: plugin.commit,
        })),
      },
      null,
      2,
    )}\n`,
  )

  return {
    work,
    lockHash: lock.lockHash,
    plugins: lock.plugins.length,
    sourcesFile,
    emptyArtifacts,
    stageFile,
    dispatchRecord,
    signingFingerprint: normalizeFingerprint(options.signingFingerprint),
  }
}

function parseArgs(argv) {
  const options = {appRevision: '', approvalId: ''}
  const valueFlags = new Set([
    '--work',
    '--lock',
    '--build-id',
    '--profile',
    '--platform',
    '--channel',
    '--version',
    '--build-number',
    '--callback-url',
    '--nonce',
    '--signing-fingerprint',
    '--plugin-repos',
    '--github-repo',
    '--release-repo',
    '--app-revision',
    '--approval-id',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return {help: true}
    if (!valueFlags.has(arg)) fail(`未知参数：${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      fail(`${arg} 缺少参数值`)
    }
    index += 1
    if (arg === '--work') options.work = value
    else if (arg === '--lock') options.lockFile = path.resolve(value)
    else if (arg === '--build-id') options.buildId = value
    else if (arg === '--profile') options.profile = value
    else if (arg === '--platform') options.platform = value
    else if (arg === '--channel') options.channel = value
    else if (arg === '--version') options.version = value
    else if (arg === '--build-number') options.buildNumber = value
    else if (arg === '--callback-url') options.callbackUrl = value
    else if (arg === '--nonce') options.nonce = value
    else if (arg === '--signing-fingerprint') options.signingFingerprint = value
    else if (arg === '--plugin-repos') options.pluginRepos = value
    else if (arg === '--github-repo') options.githubRepo = value
    else if (arg === '--release-repo') options.releaseRepo = value
    else if (arg === '--app-revision') options.appRevision = value
    else options.approvalId = value
  }
  if (!options.work) fail('--work: 缺失')
  if (!options.lockFile) fail('--lock: 缺失')
  return options
}

function appendOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file || value === undefined || value === null) return
  fs.appendFileSync(file, `${name}=${value}\n`, 'utf8')
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`派发参数校验失败：${error.message}`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }
  try {
    const result = prepareDispatch(options)
    appendOutput('lock_hash', result.lockHash)
    appendOutput('work_dir', result.work)
    appendOutput('sources_file', result.sourcesFile)
    appendOutput('empty_artifacts', result.emptyArtifacts)
    appendOutput('signing_fingerprint', result.signingFingerprint)
    console.log(`派发参数校验通过：${options.buildId}`)
    console.log(`  平台：${options.platform}；渠道：${options.channel}`)
    console.log(`  版本：${options.version}（构建号 ${options.buildNumber}）`)
    console.log(`  插件 ${result.plugins} 个；锁哈希：${result.lockHash}`)
  } catch (error) {
    console.error(`派发参数校验失败：${error.message}`)
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main(process.argv.slice(2))
}
