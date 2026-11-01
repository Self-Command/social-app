#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

import {buildCallbackPayload, signCallback} from './callback.mjs'

const STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const BUILD_NUMBER_PATTERN = /^[1-9]\d{0,8}$/
const LOCK_HASH_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/
const MAX_FILE_BYTES = 1024 * 1024 * 1024

const USAGE = `用法：
  node scripts/release/send-callback.mjs --url <HTTPS> --secret-env <环境变量名> \\
    --build-id <构建单号> --platform <平台> --channel <渠道> \\
    --version <版本> --build-number <构建号> --lock-hash <锁哈希> \\
    --status <succeeded|failed|cancelled> --nonce <nonce> \\
    (--package-dir <产物目录> | --artifacts <JSON 文件>) \\
    [--signing-fingerprint <指纹>] [--log-url <HTTPS>] \\
    [--stage <阶段>] [--error-code <错误码>] [--retries <次数>] \\
    [--retry-delay-ms <毫秒>] [--timeout-ms <毫秒>]

按固定字段顺序组装回调载荷，HMAC-SHA256 签名后 POST 到后台。
只输出 HTTP 状态码，不输出响应正文、签名或密钥。`

class CliError extends Error {}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message) {
  throw new CliError(message)
}

function isLoopback(hostname) {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

function checkUrl(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${label}: 必须是有效的 URL`)
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopback(url.hostname))
  ) {
    fail(`${label}: 必须使用 HTTPS（仅测试允许本机回环地址使用 HTTP）`)
  }
  if (url.username || url.password) {
    fail(`${label}: 不得包含凭据`)
  }
  if (url.search || url.hash) {
    fail(`${label}: 不得包含查询参数或片段`)
  }
  return url
}

function hashFile(file) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let size = 0
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      size += read
      if (size > MAX_FILE_BYTES) {
        fail(`${file}: 文件超过 1 GB 上限`)
      }
      hash.update(chunk.subarray(0, read))
    }
    return {sha256: hash.digest('hex'), size}
  } finally {
    fs.closeSync(descriptor)
  }
}

function walkFiles(root, relative, files) {
  const current = path.join(root, relative)
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    const next = relative ? `${relative}/${entry.name}` : entry.name
    const absolute = path.join(root, next)
    if (entry.isSymbolicLink()) {
      fail(`${next}: 产物目录不允许符号链接`)
    }
    if (entry.isDirectory()) {
      walkFiles(root, next, files)
    } else if (entry.isFile()) {
      files.push({name: next, path: absolute})
    }
  }
}

/**
 * Hashes every file in the packaged artifact directory. The callback lists
 * exactly what was uploaded, so a later mismatch is detectable by the backend.
 */
export function collectArtifactsFromDir(packageDir) {
  const root = path.resolve(packageDir)
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink()) fail('--package-dir: 不允许符号链接')
  if (!stat.isDirectory()) fail('--package-dir: 期望目录')
  const files = []
  walkFiles(root, '', files)
  if (files.length === 0) fail('--package-dir: 目录中没有任何产物')
  return files
    .map(file => ({name: file.name, ...hashFile(file.path)}))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
}

export function readArtifactsFile(file) {
  let value
  try {
    value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) fail(`--artifacts: 不是合法 JSON`)
    fail(`--artifacts: 无法读取文件`)
  }
  if (!Array.isArray(value)) fail('--artifacts: 期望数组')
  return value
}

function requestCallback(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      {method: 'POST', headers, timeout: timeoutMs},
      response => {
        response.resume()
        resolve({status: response.statusCode ?? 0})
      },
    )
    request.on('timeout', () => {
      request.destroy(new Error('回调请求超时'))
    })
    request.on('error', reject)
    request.end(body)
  })
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Sends one callback with bounded retries. Retries reuse the same nonce and
 * idempotency key so a lost response cannot create a second build result.
 */
export async function sendCallback(options) {
  if (!STATUSES.has(options.status)) {
    fail('--status: 期望 succeeded、failed 或 cancelled')
  }
  if (!BUILD_NUMBER_PATTERN.test(options.buildNumber ?? '')) {
    fail('--build-number: 期望 1-9 位正整数')
  }
  if (!LOCK_HASH_PATTERN.test((options.lockHash ?? '').toLowerCase())) {
    fail('--lock-hash: 期望 SHA-256 摘要')
  }
  const url = checkUrl(options.url ?? '', '--url')
  if (options.logUrl !== undefined && options.logUrl !== '') {
    checkUrl(options.logUrl, '--log-url')
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.secretEnv ?? '')) {
    fail('--secret-env: 必须是有效的环境变量名称')
  }
  const secret = process.env[options.secretEnv]
  if (typeof secret !== 'string' || secret.length === 0) {
    fail(`--secret-env: 环境变量 ${options.secretEnv} 未配置`)
  }

  const artifacts =
    options.packageDir !== undefined
      ? collectArtifactsFromDir(options.packageDir)
      : readArtifactsFile(options.artifactsFile)

  const payload = buildCallbackPayload({
    buildId: options.buildId,
    platform: options.platform,
    channel: options.channel,
    version: options.version,
    buildNumber: options.buildNumber,
    lockHash: options.lockHash,
    artifacts,
    signingFingerprint: options.signingFingerprint,
    logUrl: options.logUrl,
    status: options.status,
    stage: options.stage,
    errorCode: options.errorCode,
    timestamp: Date.now(),
    nonce: options.nonce,
  })
  const body = JSON.stringify(payload)
  const signature = signCallback(payload, secret)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'user-agent': 'selfcommand-native-release/1',
    'x-native-callback-signature': signature,
    'x-native-callback-timestamp': String(payload.timestamp),
    'x-native-build-id': payload.buildId,
    'x-native-idempotency-key': `${payload.buildId}:${payload.status}`,
  }

  const attempts = (options.retries ?? 2) + 1
  const retryDelayMs = options.retryDelayMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 15000
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const {status} = await requestCallback(url, body, headers, timeoutMs)
      if (status >= 200 && status < 300) {
        return {attempts: attempt, status}
      }
      lastError = `HTTP ${status}`
      if (!shouldRetry(status)) break
    } catch (error) {
      lastError = error.message
    }
    if (attempt < attempts) {
      await delay(retryDelayMs * 2 ** (attempt - 1))
    }
  }
  fail(`回调发送失败：${lastError || '未知错误'}`)
}

function parseArgs(argv) {
  const options = {retries: 2, retryDelayMs: 1000, timeoutMs: 15000}
  const valueFlags = new Set([
    '--url',
    '--secret-env',
    '--build-id',
    '--platform',
    '--channel',
    '--version',
    '--build-number',
    '--lock-hash',
    '--status',
    '--nonce',
    '--package-dir',
    '--artifacts',
    '--signing-fingerprint',
    '--log-url',
    '--stage',
    '--error-code',
    '--retries',
    '--retry-delay-ms',
    '--timeout-ms',
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
    if (arg === '--url') options.url = value
    else if (arg === '--secret-env') options.secretEnv = value
    else if (arg === '--build-id') options.buildId = value
    else if (arg === '--platform') options.platform = value
    else if (arg === '--channel') options.channel = value
    else if (arg === '--version') options.version = value
    else if (arg === '--build-number') options.buildNumber = value
    else if (arg === '--lock-hash') options.lockHash = value
    else if (arg === '--status') options.status = value
    else if (arg === '--nonce') options.nonce = value
    else if (arg === '--package-dir') options.packageDir = value
    else if (arg === '--artifacts') options.artifactsFile = value
    else if (arg === '--signing-fingerprint') options.signingFingerprint = value
    else if (arg === '--log-url') options.logUrl = value
    else if (arg === '--stage') options.stage = value
    else if (arg === '--error-code') options.errorCode = value
    else if (arg === '--retries') options.retries = Number(value)
    else if (arg === '--retry-delay-ms') options.retryDelayMs = Number(value)
    else options.timeoutMs = Number(value)
  }
  if (options.packageDir !== undefined && options.artifactsFile !== undefined) {
    fail('--package-dir 与 --artifacts 只能提供一个')
  }
  if (options.packageDir === undefined && options.artifactsFile === undefined) {
    fail('必须提供 --package-dir 或 --artifacts')
  }
  for (const [name, value] of [
    ['--retries', options.retries],
    ['--retry-delay-ms', options.retryDelayMs],
    ['--timeout-ms', options.timeoutMs],
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      fail(`${name}: 期望非负整数`)
    }
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`回调发送失败：${error.message}`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }
  try {
    const result = await sendCallback(options)
    console.log(
      `回调已送达（HTTP ${result.status}，尝试 ${result.attempts} 次）。`,
    )
  } catch (error) {
    console.error(`回调发送失败：${error.message}`)
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main(process.argv.slice(2))
}
