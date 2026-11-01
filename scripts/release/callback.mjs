import crypto from 'node:crypto'
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'

/*
 * Shared between the native release workflow and the admin backend. The
 * payload shape and field order are part of the signing contract: always
 * build payloads with buildCallbackPayload and verify them with
 * verifyCallback so both sides serialize identical bytes.
 */
export const CALLBACK_FIELDS = [
  'buildId',
  'platform',
  'channel',
  'version',
  'buildNumber',
  'lockHash',
  'artifacts',
  'signingFingerprint',
  'logUrl',
  'status',
  'stage',
  'errorCode',
  'timestamp',
  'nonce',
]

export const CALLBACK_STATUSES = ['succeeded', 'failed', 'cancelled']

export const CALLBACK_STATUS_LABELS = {
  succeeded: '构建成功',
  failed: '构建失败',
  cancelled: '已取消',
}

export const CALLBACK_MAX_SKEW_MS = 10 * 60 * 1000

const HEX_64_PATTERN = /^[0-9a-f]{64}$/
const LOCK_HASH_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_TEXT_LENGTH = 2048

const USAGE = `用法：
  node scripts/release/callback.mjs sign --payload <载荷文件> --secret-env <环境变量名> --out <签名文件>
  node scripts/release/callback.mjs verify --payload <载荷文件> --signature <签名文件> --secret-env <环境变量名> [--expected-timestamp <毫秒时间戳或 ISO 时间>] [--max-skew-ms <毫秒>]
`

/**
 * Raised when a callback payload or signing input is malformed.
 */
export class CallbackPayloadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CallbackPayloadError'
  }
}

class CliError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliError'
  }
}

function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readText(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CallbackPayloadError(`回调缺少必需字段或字段为空：${field}`)
  }
  if (value.length > maxLength) {
    throw new CallbackPayloadError(
      `回调字段 ${field} 超出允许长度（最多 ${maxLength} 个字符）`,
    )
  }
  return value
}

function readOptionalText(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null || value === '') return null
  return readText(value, field, maxLength)
}

function normalizeBuildNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new CallbackPayloadError(
        '回调字段 buildNumber 必须是非负整数或非空字符串',
      )
    }
    return String(value)
  }
  return readText(value, 'buildNumber', 64)
}

function normalizeLockHash(value) {
  const text = readText(value, 'lockHash', 128).toLowerCase()
  if (!LOCK_HASH_PATTERN.test(text)) {
    throw new CallbackPayloadError(
      '回调字段 lockHash 必须是 SHA-256 摘要（可带 sha256: 前缀）',
    )
  }
  return text
}

function normalizeStatus(value) {
  if (!CALLBACK_STATUSES.includes(value)) {
    throw new CallbackPayloadError(
      `回调字段 status 必须是 ${CALLBACK_STATUSES.join('、')} 之一`,
    )
  }
  return value
}

function normalizeTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new CallbackPayloadError(
        '回调字段 timestamp 必须是正整数毫秒时间戳',
      )
    }
    return value
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new CallbackPayloadError(
        '回调字段 timestamp 必须是毫秒时间戳或有效的 ISO 时间字符串',
      )
    }
    return parsed
  }
  throw new CallbackPayloadError(
    '回调字段 timestamp 必须是毫秒时间戳或有效的 ISO 时间字符串',
  )
}

function normalizeLogUrl(value) {
  const text = readOptionalText(value, 'logUrl')
  if (text === null) return null
  let url
  try {
    url = new URL(text)
  } catch {
    throw new CallbackPayloadError('回调字段 logUrl 必须是有效的 URL')
  }
  if (url.protocol !== 'https:') {
    throw new CallbackPayloadError('回调字段 logUrl 必须使用 HTTPS')
  }
  if (url.username || url.password) {
    throw new CallbackPayloadError('回调字段 logUrl 不得包含凭据')
  }
  return text
}

function normalizeDigestText(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim().toLowerCase()
  if (text.startsWith('sha256:')) return text.slice('sha256:'.length)
  return text
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) {
    throw new CallbackPayloadError('回调字段 artifacts 必须是数组')
  }
  const names = new Set()
  const artifacts = []
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new CallbackPayloadError(`回调产物清单第 ${index + 1} 项必须是对象`)
    }
    const name = readText(entry.name, `artifacts[${index}].name`, 256)
    if (names.has(name)) {
      throw new CallbackPayloadError(`回调产物清单存在重复名称：${name}`)
    }
    const sha256 = normalizeDigestText(entry.sha256)
    if (!HEX_64_PATTERN.test(sha256)) {
      throw new CallbackPayloadError(`回调产物 ${name} 的 SHA-256 摘要格式无效`)
    }
    const size = entry.size
    if (!Number.isInteger(size) || size < 0) {
      throw new CallbackPayloadError(`回调产物 ${name} 的大小必须是非负整数`)
    }
    names.add(name)
    artifacts.push({name, sha256, size})
  }
  artifacts.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  return artifacts
}

function normalizeCallbackPayload(value) {
  if (!isRecord(value)) {
    return {ok: false, reason: '回调载荷必须是对象'}
  }
  try {
    const status = normalizeStatus(value.status)
    const signingFingerprint = readOptionalText(
      value.signingFingerprint,
      'signingFingerprint',
      256,
    )
    const logUrl = normalizeLogUrl(value.logUrl)
    const stage = readOptionalText(value.stage, 'stage', 64)
    const errorCode = readOptionalText(value.errorCode, 'errorCode', 64)

    if (status === 'succeeded') {
      if (signingFingerprint === null) {
        throw new CallbackPayloadError('构建成功的回调缺少签名指纹')
      }
      if (logUrl === null) {
        throw new CallbackPayloadError('构建成功的回调缺少日志链接')
      }
    }
    if (status === 'failed') {
      if (stage === null) {
        throw new CallbackPayloadError('构建失败的回调缺少失败阶段')
      }
      if (errorCode === null) {
        throw new CallbackPayloadError('构建失败的回调缺少错误码')
      }
      if (logUrl === null) {
        throw new CallbackPayloadError('构建失败的回调缺少日志链接')
      }
    }

    const payload = {
      buildId: readText(value.buildId, 'buildId', 128),
      platform: readText(value.platform, 'platform', 64),
      channel: readText(value.channel, 'channel', 64),
      version: readText(value.version, 'version', 64),
      buildNumber: normalizeBuildNumber(value.buildNumber),
      lockHash: normalizeLockHash(value.lockHash),
      artifacts: normalizeArtifacts(value.artifacts),
      signingFingerprint,
      logUrl,
      status,
      stage,
      errorCode,
      timestamp: normalizeTimestamp(value.timestamp),
      nonce: readText(value.nonce, 'nonce', 128),
    }
    return {ok: true, payload}
  } catch (error) {
    if (error instanceof CallbackPayloadError) {
      return {ok: false, reason: error.message}
    }
    throw error
  }
}

/**
 * Validates and normalizes a callback payload into the fixed field order.
 */
export function buildCallbackPayload(input) {
  const result = normalizeCallbackPayload(input)
  if (!result.ok) throw new CallbackPayloadError(result.reason)
  return result.payload
}

/**
 * Serializes a payload deterministically: fixed field order, sorted
 * artifacts, no insignificant whitespace.
 */
export function serializeCallbackPayload(payload) {
  const result = normalizeCallbackPayload(payload)
  if (!result.ok) throw new CallbackPayloadError(result.reason)
  return JSON.stringify(result.payload)
}

/**
 * Returns a lowercase HMAC-SHA256 signature over the canonical payload.
 */
export function signCallback(payload, secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new CallbackPayloadError('回调签名密钥未配置，无法生成签名')
  }
  const serialized = serializeCallbackPayload(payload)
  return crypto
    .createHmac('sha256', secret)
    .update(serialized, 'utf8')
    .digest('hex')
}

function normalizeSignature(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {ok: false, reason: '回调签名缺失'}
  }
  const signature = value.trim().toLowerCase()
  if (!SIGNATURE_PATTERN.test(signature)) {
    return {ok: false, reason: '回调签名格式无效'}
  }
  return {ok: true, signature}
}

function signaturesMatch(expected, provided) {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(provided, 'utf8')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function nonceContainerOf(seenNonces, nonce) {
  if (seenNonces === undefined || seenNonces === null) return false
  if (Array.isArray(seenNonces)) return seenNonces.includes(nonce)
  if (
    typeof seenNonces.has === 'function' &&
    typeof seenNonces.add === 'function'
  ) {
    return seenNonces.has(nonce)
  }
  throw new CallbackPayloadError('回调 nonce 记录容器必须是 Set 或数组')
}

function rememberNonce(seenNonces, nonce) {
  if (seenNonces === undefined || seenNonces === null) return
  if (Array.isArray(seenNonces)) {
    seenNonces.push(nonce)
    return
  }
  seenNonces.add(nonce)
}

/**
 * Verifies signature, required fields, the +/-10 minute window and nonce
 * replay. Accepts the nonce into seenNonces only after every check passes.
 */
export function verifyCallback({
  payload,
  signature,
  secret,
  now = Date.now(),
  maxSkewMs = CALLBACK_MAX_SKEW_MS,
  seenNonces,
} = {}) {
  const normalized = normalizeCallbackPayload(payload)
  if (!normalized.ok) return {ok: false, reason: normalized.reason}

  if (typeof secret !== 'string' || secret.length === 0) {
    return {ok: false, reason: '回调签名密钥未配置，无法校验签名'}
  }

  const signatureResult = normalizeSignature(signature)
  if (!signatureResult.ok) {
    return {ok: false, reason: signatureResult.reason}
  }

  const expected = signCallback(normalized.payload, secret)
  if (!signaturesMatch(expected, signatureResult.signature)) {
    return {ok: false, reason: '回调签名校验失败，回调可能被伪造或篡改'}
  }

  const nowMs = now instanceof Date ? now.getTime() : now
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    return {ok: false, reason: '回调校验时间无效'}
  }
  if (!Number.isInteger(maxSkewMs) || maxSkewMs <= 0) {
    return {ok: false, reason: '回调时间窗口配置无效'}
  }

  const skew = normalized.payload.timestamp - nowMs
  if (skew < -maxSkewMs) {
    return {ok: false, reason: '回调时间戳已过期，超出允许的时间窗口'}
  }
  if (skew > maxSkewMs) {
    return {ok: false, reason: '回调时间戳来自未来，超出允许的时间窗口'}
  }

  try {
    if (nonceContainerOf(seenNonces, normalized.payload.nonce)) {
      return {ok: false, reason: '回调 nonce 已使用，疑似重放'}
    }
    rememberNonce(seenNonces, normalized.payload.nonce)
  } catch (error) {
    if (error instanceof CallbackPayloadError) {
      return {ok: false, reason: error.message}
    }
    throw error
  }

  return {ok: true, reason: ''}
}

function normalizeActualDigests(value) {
  const entries = []
  if (value instanceof Map) {
    entries.push(...value.entries())
  } else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (!isRecord(entry)) {
        return {ok: false, reason: `实际产物摘要第 ${index + 1} 项必须是对象`}
      }
      entries.push([entry.name, entry.sha256])
    }
  } else if (isRecord(value)) {
    entries.push(...Object.entries(value))
  } else {
    return {ok: false, reason: '实际产物摘要必须是对象、Map 或数组'}
  }

  const digests = new Map()
  for (const [name, digest] of entries) {
    if (typeof name !== 'string' || name.length === 0) {
      return {ok: false, reason: '实际产物名称必须是非空字符串'}
    }
    const sha256 = normalizeDigestText(digest)
    if (!HEX_64_PATTERN.test(sha256)) {
      return {ok: false, reason: `实际产物 ${name} 的 SHA-256 摘要格式无效`}
    }
    digests.set(name, sha256)
  }
  return {ok: true, digests}
}

/**
 * Compares declared artifact digests with the digests of uploaded files.
 */
export function verifyArtifactDigests(payload, actualDigests) {
  const normalized = normalizeCallbackPayload(payload)
  if (!normalized.ok) return {ok: false, reason: normalized.reason}
  const artifacts = normalized.payload.artifacts
  if (artifacts.length === 0) {
    return {ok: false, reason: '回调未声明任何产物，无法校验摘要'}
  }

  const actual = normalizeActualDigests(actualDigests)
  if (!actual.ok) return {ok: false, reason: actual.reason}

  for (const artifact of artifacts) {
    const digest = actual.digests.get(artifact.name)
    if (digest === undefined) {
      return {
        ok: false,
        reason: `产物 ${artifact.name} 缺少实际摘要，无法确认上传结果`,
      }
    }
    if (digest !== artifact.sha256) {
      return {
        ok: false,
        reason: `产物 ${artifact.name} 的 SHA-256 摘要不一致，回调记录与实际上传内容不符`,
      }
    }
  }

  const declared = new Set(artifacts.map(artifact => artifact.name))
  for (const name of actual.digests.keys()) {
    if (!declared.has(name)) {
      return {ok: false, reason: `实际产物 ${name} 未在回调中声明`}
    }
  }

  return {ok: true, reason: ''}
}

/**
 * In-memory callback ledger. The admin backend replaces entries with its
 * database table; the shape is shared so tests exercise the same contract.
 */
export function createCallbackLedger() {
  return {entries: new Map(), seenNonces: new Set()}
}

/**
 * Applies a callback result once per idempotency key. Later calls with the
 * same key keep the first result and report applied: false.
 */
export function applyCallbackOnce(ledger, idempotencyKey, result) {
  if (!isRecord(ledger) || !(ledger.entries instanceof Map)) {
    throw new CallbackPayloadError('回调账本无效，缺少幂等记录表')
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new CallbackPayloadError('回调幂等键必须是非空字符串')
  }

  const existing = ledger.entries.get(idempotencyKey)
  if (existing !== undefined) {
    return {applied: false, entry: existing}
  }

  const entry = {
    idempotencyKey,
    result,
    appliedAt: new Date().toISOString(),
  }
  ledger.entries.set(idempotencyKey, entry)
  return {applied: true, entry}
}

function readOption(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`缺少必需参数 --${name}`)
  }
  return value
}

function readSecretFromEnv(envName) {
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new CliError('--secret-env 必须是有效的环境变量名称')
  }
  const secret = process.env[envName]
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new CliError(`环境变量 ${envName} 未配置回调签名密钥`)
  }
  return secret
}

function readJsonFile(file, label) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new CliError(
      `无法读取${label}：${file}（${error.code ?? '未知错误'}）`,
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError(`${label}不是有效的 JSON：${file}`)
  }
}

function parseCliArgs(argv) {
  if (argv.length === 0) return {command: '', options: {}}
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    if (!flag.startsWith('--') || flag.length === 2) {
      throw new CliError(`无法识别的参数：${flag}`)
    }
    const key = flag.slice(2)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`参数 ${flag} 缺少取值`)
    }
    if (Object.hasOwn(options, key)) {
      throw new CliError(`参数 ${flag} 重复出现`)
    }
    options[key] = value
  }
  return {command, options}
}

function runSign(options) {
  const payloadFile = readOption(options, 'payload')
  const outFile = readOption(options, 'out')
  const envName = readOption(options, 'secret-env')
  const secret = readSecretFromEnv(envName)
  const payload = buildCallbackPayload(readJsonFile(payloadFile, '回调载荷'))
  const signature = signCallback(payload, secret)
  try {
    fs.writeFileSync(outFile, `${signature}\n`, 'utf8')
  } catch (error) {
    throw new CliError(
      `无法写入回调签名：${outFile}（${error.code ?? '未知错误'}）`,
    )
  }
  process.stdout.write(`回调签名已写入：${outFile}\n`)
}

function parseExpectedTimestamp(value) {
  if (/^\d+$/.test(value)) return Number(value)
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new CliError('--expected-timestamp 必须是毫秒时间戳或 ISO 时间字符串')
  }
  return parsed
}

function runVerify(options) {
  const payloadFile = readOption(options, 'payload')
  const signatureFile = readOption(options, 'signature')
  const envName = readOption(options, 'secret-env')
  const secret = readSecretFromEnv(envName)
  const payload = buildCallbackPayload(readJsonFile(payloadFile, '回调载荷'))

  let signature
  try {
    signature = fs.readFileSync(signatureFile, 'utf8').trim()
  } catch (error) {
    throw new CliError(
      `无法读取回调签名：${signatureFile}（${error.code ?? '未知错误'}）`,
    )
  }

  let maxSkewMs = CALLBACK_MAX_SKEW_MS
  if (options['max-skew-ms'] !== undefined) {
    if (!/^\d+$/.test(options['max-skew-ms'])) {
      throw new CliError('--max-skew-ms 必须是正整数毫秒数')
    }
    maxSkewMs = Number(options['max-skew-ms'])
    if (maxSkewMs <= 0) {
      throw new CliError('--max-skew-ms 必须是正整数毫秒数')
    }
  }

  const result = verifyCallback({
    payload,
    signature,
    secret,
    maxSkewMs,
    seenNonces: new Set(),
  })
  if (!result.ok) {
    process.stderr.write(`回调签名校验失败：${result.reason}\n`)
    process.exitCode = 1
    return
  }

  if (options['expected-timestamp'] !== undefined) {
    const expected = parseExpectedTimestamp(options['expected-timestamp'])
    if (payload.timestamp !== expected) {
      process.stderr.write(
        `回调时间戳与期望值不一致（期望 ${expected}，实际 ${payload.timestamp}）\n`,
      )
      process.exitCode = 1
      return
    }
  }

  process.stdout.write(`回调签名校验通过：${payloadFile}\n`)
}

function main(argv = process.argv.slice(2)) {
  try {
    const {command, options} = parseCliArgs(argv)
    if (command === 'sign') {
      runSign(options)
      return
    }
    if (command === 'verify') {
      runVerify(options)
      return
    }
    process.stderr.write(`未知命令：${command || '（空）'}\n${USAGE}`)
    process.exitCode = 2
  } catch (error) {
    if (error instanceof CliError || error instanceof CallbackPayloadError) {
      process.stderr.write(`回调命令执行失败：${error.message}\n`)
      process.exitCode = error instanceof CallbackPayloadError ? 1 : 2
      return
    }
    throw error
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
