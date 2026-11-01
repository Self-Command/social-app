/* oxlint-disable typescript/no-floating-promises -- node:test owns the promise returned by test(). */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {scanText} from './scan-logs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'scan-logs.mjs')

const CLEAN_LOG = [
  '[2026-10-31T08:00:00Z] 构建开始',
  '[2026-10-31T08:00:05Z] 校验插件清单与锁哈希',
  '[2026-10-31T08:01:00Z] 构建成功',
  '',
].join('\n')

const PRIVATE_KEY = ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ')
const PRIVATE_KEY_BODY =
  'MIIEowIBAAKCAQEA0000000000000000000000000000000000000000000000000000000000000000'
const BASE64_BLOB = 'A'.repeat(400)
const PASSWORD = 'not-a-real-password'
const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`
const FINE_GRAINED_TOKEN = `github_pat_${'b'.repeat(30)}`
const BEARER_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake-payload.fake-signature'
const EXPO_TOKEN = 'not-a-real-expo-token'
const AWS_KEY = `AKIA${'C'.repeat(16)}`
const GOOGLE_KEY = `AIza${'d'.repeat(35)}`

/** @type {string[]} */
const tempDirs = []

/** @returns {string} */
function makeTempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-logs-test-'))
  tempDirs.push(directory)
  return directory
}

/**
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function writeTemp(name, content) {
  const file = path.join(makeTempDir(), name)
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

test('干净日志通过扫描', () => {
  assert.deepEqual(scanText(CLEAN_LOG), [])
})

test('PEM 私钥头被拒绝且不回显内容', () => {
  const findings = scanText(
    `构建输出开始\n${PRIVATE_KEY}\n${PRIVATE_KEY_BODY}\n`,
  )

  assert.deepEqual(findings, [{line: 2, rule: 'pem-private-key'}])
  assert.doesNotMatch(JSON.stringify(findings), /PRIVATE KEY|MIIEow/)
})

test('keystore base64 大块被拒绝', () => {
  const findings = scanText(`keystore=${BASE64_BLOB}\n`)

  assert.deepEqual(findings, [{line: 1, rule: 'base64-blob'}])
  assert.ok(!JSON.stringify(findings).includes(BASE64_BLOB))
})

test('password= 明文被拒绝', () => {
  const findings = scanText(`数据库连接 password=${PASSWORD}\n`)

  assert.deepEqual(findings, [{line: 1, rule: 'plaintext-password'}])
  assert.ok(!JSON.stringify(findings).includes(PASSWORD))
})

test('GitHub 令牌被拒绝', () => {
  const findings = scanText(
    `token ${GITHUB_TOKEN}\npat ${FINE_GRAINED_TOKEN}\n`,
  )

  assert.deepEqual(findings, [
    {line: 1, rule: 'github-token'},
    {line: 2, rule: 'github-token'},
  ])
  const serialized = JSON.stringify(findings)
  assert.ok(!serialized.includes(GITHUB_TOKEN))
  assert.ok(!serialized.includes(FINE_GRAINED_TOKEN))
})

test('Bearer 令牌被拒绝', () => {
  const findings = scanText(`Authorization: Bearer ${BEARER_TOKEN}\n`)

  assert.deepEqual(findings, [{line: 1, rule: 'bearer-token'}])
  assert.ok(!JSON.stringify(findings).includes(BEARER_TOKEN))
})

test('EXPO、AWS 与 Google 密钥标记被拒绝', () => {
  const findings = scanText(
    [
      `EXPO_TOKEN=${EXPO_TOKEN}`,
      `aws_access_key_id=${AWS_KEY}`,
      `google=${GOOGLE_KEY}`,
      '{"type": "service_account", "project_id": "community"}',
    ].join('\n'),
  )

  assert.deepEqual(
    findings.map(finding => finding.rule),
    ['expo-token', 'aws-access-key', 'google-key', 'google-key'],
  )
  const serialized = JSON.stringify(findings)
  assert.ok(!serialized.includes(EXPO_TOKEN))
  assert.ok(!serialized.includes(AWS_KEY))
  assert.ok(!serialized.includes(GOOGLE_KEY))
})

test('证书 PEM 大块被拒绝', () => {
  const findings = scanText(
    '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
  )

  assert.deepEqual(findings, [{line: 1, rule: 'pem-certificate'}])
})

test('keytool 明文口令被拒绝而 :env 形式放行', () => {
  assert.deepEqual(
    scanText(
      'keytool -list -v -keystore app.keystore -alias release -storepass not-a-real-password\n',
    ),
    [{line: 1, rule: 'keystore-passphrase'}],
  )
  assert.deepEqual(
    scanText(
      'keytool -list -v -keystore app.keystore -alias release -storepass:env KEYSTORE_PASS\n',
    ),
    [],
  )
})

test('CLI：多文件聚合输出命中位置并退出 1', () => {
  const directory = makeTempDir()
  const cleanFile = path.join(directory, 'clean.log')
  const passwordFile = path.join(directory, 'android.log')
  const tokenFile = path.join(directory, 'ios.log')
  fs.writeFileSync(cleanFile, CLEAN_LOG)
  fs.writeFileSync(passwordFile, `password=${PASSWORD}\n`)
  fs.writeFileSync(tokenFile, `Authorization: Bearer ${BEARER_TOKEN}\n`)

  const result = runCli([cleanFile, passwordFile, tokenFile])
  const output = result.stdout + result.stderr

  assert.equal(result.status, 1)
  assert.match(result.stdout, /android\.log:1 \[plaintext-password\]/)
  assert.match(result.stdout, /ios\.log:1 \[bearer-token\]/)
  assert.match(result.stderr, /日志扫描失败/)
  assert.ok(!output.includes(PASSWORD))
  assert.ok(!output.includes(BEARER_TOKEN))
})

test('CLI：干净日志退出 0', () => {
  const file = writeTemp('clean.log', CLEAN_LOG)

  const result = runCli([file])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /日志扫描通过/)
  assert.equal(result.stderr, '')
})
