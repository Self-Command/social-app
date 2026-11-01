#!/usr/bin/env node
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

/**
 * Fingerprint verification for release signing identities.
 *
 * This module never reads private keys, keystores or passwords. It only parses
 * already captured `keytool -list -v` or `openssl x509` output, normalizes the
 * SHA-256 fingerprint, and compares it with the value recorded by the admin
 * console. Mismatches are returned as data so callers can record a security
 * event before aborting the build.
 */

export const FINGERPRINT_MISMATCH_REASON = '签名指纹与后台记录不一致'

const FINGERPRINT_COMPACT_PATTERN = /^[0-9A-F]{64}$/
const ANDROID_SHA256_PATTERN =
  /^[ \t]*SHA256:[ \t]*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{64})[ \t]*\r?$/gm
const IOS_SHA256_PATTERN =
  /^[ \t]*SHA256 Fingerprint[ \t]*=[ \t]*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{64})[ \t]*\r?$/gim

/**
 * Normalize a SHA-256 fingerprint to 32 uppercase, colon-separated bytes.
 * Accepts colon-separated or compact input in any letter case.
 */
export function normalizeFingerprint(value) {
  if (typeof value !== 'string') {
    throw new Error('签名指纹必须是字符串')
  }
  const compact = value.trim().replaceAll(':', '').toUpperCase()
  if (!FINGERPRINT_COMPACT_PATTERN.test(compact)) {
    throw new Error(
      '签名指纹格式无效：应为 32 字节 SHA-256 的 64 位十六进制字符',
    )
  }
  const pairs = []
  for (let index = 0; index < compact.length; index += 2) {
    pairs.push(compact.slice(index, index + 2))
  }
  return pairs.join(':')
}

function assertText(text) {
  if (typeof text !== 'string') {
    throw new Error('待解析的文本必须是字符串')
  }
}

/**
 * @param {string[]} matches
 * @param {string} source
 * @returns {string}
 */
function selectFingerprint(matches, source) {
  const fingerprints = [
    ...new Set(matches.map(match => normalizeFingerprint(match))),
  ]
  if (fingerprints.length === 0) {
    throw new Error(`${source}中未找到 SHA-256 指纹`)
  }
  if (fingerprints.length > 1) {
    throw new Error(`${source}包含多个不同的 SHA-256 指纹`)
  }
  return fingerprints[0]
}

/**
 * Parse the SHA-256 fingerprint from `keytool -list -v` output.
 *
 * @param {string} text
 * @returns {string}
 */
export function parseAndroidFingerprint(text) {
  assertText(text)
  const matches = [...text.matchAll(ANDROID_SHA256_PATTERN)].map(
    match => match[1],
  )
  return selectFingerprint(matches, 'keytool 输出')
}

/**
 * Parse the SHA-256 fingerprint from `openssl x509 -fingerprint` output.
 *
 * @param {string} text
 * @returns {string}
 */
export function parseIosFingerprint(text) {
  assertText(text)
  const matches = [...text.matchAll(IOS_SHA256_PATTERN)].map(match => match[1])
  return selectFingerprint(matches, 'openssl 输出')
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function tryNormalize(value) {
  try {
    return normalizeFingerprint(value)
  } catch {
    return null
  }
}

/**
 * Compare the fingerprint recorded by the admin console with the fingerprint
 * observed on the signing identity. Returns a result instead of throwing so
 * the caller can record a security event and decide how to abort the build.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {{
 *   ok: boolean,
 *   expected: string | null,
 *   actual: string | null,
 *   reason: string,
 * }}
 */
export function compareFingerprint(expected, actual) {
  const normalizedExpected = tryNormalize(expected)
  const normalizedActual = tryNormalize(actual)
  if (normalizedExpected === null) {
    return {
      ok: false,
      expected: null,
      actual: normalizedActual,
      reason: '后台记录的签名指纹格式无效',
    }
  }
  if (normalizedActual === null) {
    return {
      ok: false,
      expected: normalizedExpected,
      actual: null,
      reason: '构建签名的指纹格式无效',
    }
  }
  if (normalizedExpected !== normalizedActual) {
    return {
      ok: false,
      expected: normalizedExpected,
      actual: normalizedActual,
      reason: FINGERPRINT_MISMATCH_REASON,
    }
  }
  return {
    ok: true,
    expected: normalizedExpected,
    actual: normalizedActual,
    reason: '签名指纹一致',
  }
}

const USAGE =
  '用法：node scripts/release/fingerprint.mjs --platform android|ios --expected <指纹> --input <文本文件>'

/**
 * @param {string[]} argv
 * @returns {{platform: 'android' | 'ios', expected: string, input: string}}
 */
function parseArguments(argv) {
  /** @type {{platform?: string, expected?: string, input?: string}} */
  const options = {}
  const allowed = new Set(['platform', 'expected', 'input'])
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) {
      throw new Error(`未知参数：${flag}`)
    }
    const name = flag.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${flag} 缺少取值`)
    }
    if (
      (name === 'platform' && options.platform !== undefined) ||
      (name === 'expected' && options.expected !== undefined) ||
      (name === 'input' && options.input !== undefined)
    ) {
      throw new Error(`参数 ${flag} 重复`)
    }
    if (name === 'platform') {
      options.platform = value
    } else if (name === 'expected') {
      options.expected = value
    } else {
      options.input = value
    }
    index++
  }
  if (!options.platform || !options.expected || !options.input) {
    throw new Error(USAGE)
  }
  if (options.platform !== 'android' && options.platform !== 'ios') {
    throw new Error('参数 --platform 仅支持 android 或 ios')
  }
  return {
    platform: options.platform,
    expected: options.expected,
    input: options.input,
  }
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function run(argv) {
  const options = parseArguments(argv)
  let text
  try {
    text = readFileSync(resolve(options.input), 'utf8')
  } catch {
    throw new Error(`无法读取输入文件：${options.input}`)
  }
  const actual =
    options.platform === 'android'
      ? parseAndroidFingerprint(text)
      : parseIosFingerprint(text)
  const result = compareFingerprint(options.expected, actual)
  if (!result.ok) {
    process.stderr.write(`签名指纹校验失败：${result.reason}\n`)
    process.stderr.write(`期望指纹：${result.expected ?? '无法解析'}\n`)
    process.stderr.write(`实际指纹：${result.actual ?? '无法解析'}\n`)
    return 1
  }
  process.stdout.write(`签名指纹校验通过：${result.actual}\n`)
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
