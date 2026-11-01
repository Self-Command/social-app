/* oxlint-disable typescript/no-floating-promises -- node:test owns the promise returned by test(). */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  compareFingerprint,
  FINGERPRINT_MISMATCH_REASON,
  normalizeFingerprint,
  parseAndroidFingerprint,
  parseIosFingerprint,
} from './fingerprint.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'fingerprint.mjs')

/**
 * @param {number} seed
 * @returns {string}
 */
function fingerprint(seed) {
  return Array.from({length: 32}, (_, index) =>
    ((seed + index) % 256).toString(16).padStart(2, '0').toUpperCase(),
  ).join(':')
}

const ANDROID_FINGERPRINT = fingerprint(0x10)
const IOS_FINGERPRINT = fingerprint(0xa0)
const OTHER_FINGERPRINT = fingerprint(0x30)

function androidOutput(sha256) {
  return [
    'Keystore type: PKCS12',
    'Keystore provider: SUN',
    '',
    'Your keystore contains 1 entry',
    '',
    'Alias name: community-release',
    'Creation date: 2026年10月31日',
    'Entry type: PrivateKeyEntry',
    'Certificate chain length: 1',
    'Certificate[1]:',
    'Owner: CN=Community Release, O=Community, C=CN',
    'Issuer: CN=Community Release, O=Community, C=CN',
    'Serial number: 1',
    'Valid from: Sat Oct 31 00:00:00 CST 2026 until: Mon Oct 31 00:00:00 CST 2033',
    'Certificate fingerprints:',
    '\t SHA1: AB:CD:EF:01:23:45:67:89',
    `\t SHA256: ${sha256}`,
    'Signature algorithm name: SHA256withRSA',
    'Subject Public Key Algorithm: 2048-bit RSA key',
    'Version: 3',
    '',
  ].join('\n')
}

/** @type {string[]} */
const tempDirs = []

/**
 * @param {string} content
 * @returns {string}
 */
function writeTemp(content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-test-'))
  tempDirs.push(directory)
  const file = path.join(directory, 'captured.txt')
  fs.writeFileSync(file, content)
  return file
}

/**
 * @param {string[]} args
 */
function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8'})
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, {recursive: true, force: true})
  }
})

test('Android：解析 keytool 输出并匹配后台指纹', () => {
  const parsed = parseAndroidFingerprint(
    androidOutput(ANDROID_FINGERPRINT.toLowerCase()),
  )

  assert.equal(parsed, ANDROID_FINGERPRINT)
  assert.deepEqual(compareFingerprint(ANDROID_FINGERPRINT, parsed), {
    ok: true,
    expected: ANDROID_FINGERPRINT,
    actual: ANDROID_FINGERPRINT,
    reason: '签名指纹一致',
  })
})

test('Android：指纹不一致时返回正式原因', () => {
  const result = compareFingerprint(ANDROID_FINGERPRINT, OTHER_FINGERPRINT)

  assert.equal(result.ok, false)
  assert.equal(result.reason, FINGERPRINT_MISMATCH_REASON)
  assert.equal(FINGERPRINT_MISMATCH_REASON, '签名指纹与后台记录不一致')
  assert.equal(result.expected, ANDROID_FINGERPRINT)
  assert.equal(result.actual, OTHER_FINGERPRINT)
})

test('iOS：解析 openssl 输出并匹配后台指纹', () => {
  const parsed = parseIosFingerprint(
    `SHA256 Fingerprint=${IOS_FINGERPRINT}\r\n`,
  )

  assert.equal(parsed, IOS_FINGERPRINT)
  assert.equal(
    compareFingerprint(IOS_FINGERPRINT.toLowerCase(), parsed).ok,
    true,
  )
})

test('格式归一化：接受无分隔与小写输入', () => {
  const compact = ANDROID_FINGERPRINT.replaceAll(':', '').toLowerCase()

  assert.equal(normalizeFingerprint(compact), ANDROID_FINGERPRINT)
  assert.equal(
    normalizeFingerprint(`  ${ANDROID_FINGERPRINT.toLowerCase()}  `),
    ANDROID_FINGERPRINT,
  )
})

test('非法指纹被拒绝', () => {
  assert.throws(() => normalizeFingerprint('ABCD'), /签名指纹格式无效/)
  assert.throws(
    () => normalizeFingerprint(`${ANDROID_FINGERPRINT}:AA`),
    /签名指纹格式无效/,
  )
  assert.throws(() => normalizeFingerprint('ZZ'.repeat(32)), /签名指纹格式无效/)

  const result = compareFingerprint('not-a-fingerprint', ANDROID_FINGERPRINT)
  assert.equal(result.ok, false)
  assert.equal(result.expected, null)
  assert.equal(result.actual, ANDROID_FINGERPRINT)
  assert.match(result.reason, /格式无效/)
})

test('解析器拒绝不含指纹或含多个不同指纹的文本', () => {
  assert.throws(
    () => parseAndroidFingerprint('Keystore type: PKCS12'),
    /未找到 SHA-256 指纹/,
  )
  assert.throws(
    () => parseIosFingerprint('unable to load certificate'),
    /未找到 SHA-256 指纹/,
  )

  const ambiguous =
    androidOutput(ANDROID_FINGERPRINT) + androidOutput(OTHER_FINGERPRINT)
  assert.throws(
    () => parseAndroidFingerprint(ambiguous),
    /多个不同的 SHA-256 指纹/,
  )
})

test('CLI：指纹匹配时退出码为 0', () => {
  const file = writeTemp(androidOutput(ANDROID_FINGERPRINT))
  const expected = ANDROID_FINGERPRINT.replaceAll(':', '').toLowerCase()
  const result = runCli([
    '--platform',
    'android',
    '--expected',
    expected,
    '--input',
    file,
  ])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /签名指纹校验通过/)
  assert.equal(result.stderr, '')
})

test('CLI：指纹不一致时退出码为 1 且不回显捕获内容', () => {
  const file = writeTemp(androidOutput(OTHER_FINGERPRINT))
  const result = runCli([
    '--platform',
    'android',
    '--expected',
    ANDROID_FINGERPRINT,
    '--input',
    file,
  ])
  const output = result.stdout + result.stderr

  assert.equal(result.status, 1)
  assert.match(result.stderr, /签名指纹与后台记录不一致/)
  assert.doesNotMatch(output, /PrivateKeyEntry|Certificate\[1\]|Owner:/)
})

test('CLI：输入无法解析时不回显敏感内容', () => {
  const privateKeyHeader = ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ')
  const file = writeTemp(`${privateKeyHeader}\npassword=not-a-real-password\n`)
  const result = runCli([
    '--platform',
    'ios',
    '--expected',
    IOS_FINGERPRINT,
    '--input',
    file,
  ])
  const output = result.stdout + result.stderr

  assert.equal(result.status, 1)
  assert.match(result.stderr, /未找到 SHA-256 指纹/)
  assert.doesNotMatch(output, /PRIVATE KEY|not-a-real-password/)
})

test('CLI：缺少参数时以非零退出码拒绝', () => {
  const result = runCli(['--platform', 'android'])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /用法/)
})
