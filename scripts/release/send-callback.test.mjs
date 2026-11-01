import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {signCallback} from './callback.mjs'
import {
  collectArtifactsFromDir,
  readArtifactsFile,
  sendCallback,
} from './send-callback.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'send-callback.mjs')
const SECRET = 'native-callback-test-secret'
const NONCE = 'abcdefgh12345678'
const LOCK_HASH = 'c'.repeat(64)
const FINGERPRINT = Array.from({length: 32}, () => 'AB').join(':')
const LOG_URL = 'https://github.example.invalid/actions/runs/1'
const FIELD_ORDER = [
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

process.env.NATIVE_CALLBACK_TEST_SECRET = SECRET

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-callback-'))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  return dir
}

function writeArtifactsFile(dir, value = []) {
  const file = path.join(dir, 'artifacts.json')
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}

function createOptions(artifactsFile, overrides = {}) {
  return {
    url: '',
    secretEnv: 'NATIVE_CALLBACK_TEST_SECRET',
    buildId: 'build-20261101-001',
    platform: 'android',
    channel: 'enterprise',
    version: '1.2.3',
    buildNumber: '42',
    lockHash: LOCK_HASH,
    status: 'succeeded',
    nonce: NONCE,
    artifactsFile,
    signingFingerprint: FINGERPRINT,
    logUrl: LOG_URL,
    retries: 0,
    retryDelayMs: 0,
    timeoutMs: 5000,
    ...overrides,
  }
}

async function startServer(t, handler) {
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({headers: request.headers, body})
      handler(requests.length, response)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const {port} = server.address()
  return {requests, url: `http://127.0.0.1:${port}/native/callback`}
}

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {...process.env, ...env},
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('close', code => resolve({code, stdout, stderr}))
  })
}

test('产物目录按名称排序并计算摘要', t => {
  const dir = createTempDir(t)
  const packageDir = path.join(dir, 'package')
  fs.mkdirSync(path.join(packageDir, 'nested'), {recursive: true})
  fs.writeFileSync(path.join(packageDir, 'app.aab'), 'aab-bytes')
  fs.writeFileSync(path.join(packageDir, 'nested', 'mapping.txt'), 'mapping')

  const artifacts = collectArtifactsFromDir(packageDir)
  assert.deepEqual(
    artifacts.map(artifact => artifact.name),
    ['app.aab', 'nested/mapping.txt'],
  )
  assert.equal(
    artifacts[0].sha256,
    crypto.createHash('sha256').update('aab-bytes').digest('hex'),
  )
  assert.equal(artifacts[0].size, 9)
  assert.equal(artifacts[1].size, 7)
})

test('产物目录拒绝空目录、普通文件与符号链接', t => {
  const dir = createTempDir(t)
  const emptyDir = path.join(dir, 'empty')
  fs.mkdirSync(emptyDir)
  assert.throws(() => collectArtifactsFromDir(emptyDir), /没有任何产物/)
  assert.throws(
    () => collectArtifactsFromDir(path.join(dir, 'missing')),
    /ENOENT/,
  )

  const file = path.join(dir, 'file.txt')
  fs.writeFileSync(file, 'x')
  assert.throws(() => collectArtifactsFromDir(file), /期望目录/)

  const target = path.join(dir, 'target.txt')
  fs.writeFileSync(target, 'x')
  const link = path.join(dir, 'link.txt')
  try {
    fs.symlinkSync(target, link, 'file')
  } catch {
    t.skip('当前系统不允许创建符号链接')
    return
  }
  assert.throws(() => collectArtifactsFromDir(dir), /不允许符号链接/)
})

test('读取产物清单文件时校验 JSON 结构', t => {
  const dir = createTempDir(t)
  const valid = writeArtifactsFile(dir)
  assert.deepEqual(readArtifactsFile(valid), [])

  const invalid = path.join(dir, 'invalid.json')
  fs.writeFileSync(invalid, '{', 'utf8')
  assert.throws(() => readArtifactsFile(invalid), /不是合法 JSON/)

  const object = path.join(dir, 'object.json')
  fs.writeFileSync(object, '{}\n', 'utf8')
  assert.throws(() => readArtifactsFile(object), /期望数组/)
  assert.throws(
    () => readArtifactsFile(path.join(dir, 'missing.json')),
    /无法读取文件/,
  )
})

test('成功回调按固定字段顺序签名并携带幂等键', async t => {
  const dir = createTempDir(t)
  const artifactsFile = writeArtifactsFile(dir)
  const server = await startServer(t, (count, response) => {
    response.writeHead(200)
    response.end('ok')
  })

  const result = await sendCallback(
    createOptions(artifactsFile, {url: server.url}),
  )
  assert.deepEqual(result, {attempts: 1, status: 200})
  assert.equal(server.requests.length, 1)

  const [{headers, body}] = server.requests
  const payload = JSON.parse(body)
  assert.deepEqual(Object.keys(payload), FIELD_ORDER)
  assert.equal(payload.buildId, 'build-20261101-001')
  assert.equal(payload.status, 'succeeded')
  assert.deepEqual(payload.artifacts, [])
  assert.equal(
    headers['x-native-callback-signature'],
    signCallback(payload, SECRET),
  )
  assert.equal(
    headers['x-native-callback-timestamp'],
    String(payload.timestamp),
  )
  assert.equal(headers['x-native-build-id'], payload.buildId)
  assert.equal(
    headers['x-native-idempotency-key'],
    'build-20261101-001:succeeded',
  )
})

test('5xx 重试复用同一载荷与签名，成功后停止', async t => {
  const dir = createTempDir(t)
  const artifactsFile = writeArtifactsFile(dir)
  const server = await startServer(t, (count, response) => {
    response.writeHead(count < 3 ? 503 : 200)
    response.end()
  })

  const result = await sendCallback(
    createOptions(artifactsFile, {
      url: server.url,
      retries: 2,
      retryDelayMs: 0,
    }),
  )
  assert.deepEqual(result, {attempts: 3, status: 200})
  assert.equal(server.requests.length, 3)
  const bodies = new Set(server.requests.map(request => request.body))
  assert.equal(bodies.size, 1)
  const signatures = new Set(
    server.requests.map(
      request => request.headers['x-native-callback-signature'],
    ),
  )
  assert.equal(signatures.size, 1)
})

test('4xx 不重试并报告状态码', async t => {
  const dir = createTempDir(t)
  const artifactsFile = writeArtifactsFile(dir)
  const server = await startServer(t, (count, response) => {
    response.writeHead(400)
    response.end()
  })

  await assert.rejects(
    sendCallback(
      createOptions(artifactsFile, {
        url: server.url,
        retries: 2,
        retryDelayMs: 0,
      }),
    ),
    /HTTP 400/,
  )
  assert.equal(server.requests.length, 1)
})

test('失败回调缺少阶段或错误码时拒绝', async t => {
  const dir = createTempDir(t)
  const artifactsFile = writeArtifactsFile(dir)
  const server = await startServer(t, (count, response) => {
    response.writeHead(200)
    response.end()
  })

  await assert.rejects(
    sendCallback(
      createOptions(artifactsFile, {url: server.url, status: 'failed'}),
    ),
    /缺少失败阶段/,
  )
  await assert.rejects(
    sendCallback(
      createOptions(artifactsFile, {
        url: server.url,
        status: 'failed',
        stage: 'signing',
      }),
    ),
    /缺少错误码/,
  )
  assert.equal(server.requests.length, 0)
})

test('回调地址、状态与密钥在发送前校验', async t => {
  const dir = createTempDir(t)
  const artifactsFile = writeArtifactsFile(dir)
  const base = createOptions(artifactsFile)

  await assert.rejects(sendCallback({...base, status: 'done'}), /--status/)
  await assert.rejects(
    sendCallback({...base, url: 'http://example.invalid/callback'}),
    /必须使用 HTTPS/,
  )
  await assert.rejects(
    sendCallback({...base, url: 'https://user:pass@example.invalid/cb'}),
    /不得包含凭据/,
  )
  await assert.rejects(
    sendCallback({...base, url: 'https://example.invalid/cb?run=1'}),
    /查询参数/,
  )
  await assert.rejects(
    sendCallback({
      ...base,
      url: 'http://127.0.0.1:9/native/callback',
      secretEnv: 'NATIVE_CALLBACK_MISSING_SECRET',
    }),
    /未配置/,
  )
})

test('命令行成功时只输出状态码，不泄露密钥', async t => {
  const dir = createTempDir(t)
  const artifactsFile = writeArtifactsFile(dir)
  const server = await startServer(t, (count, response) => {
    response.writeHead(200)
    response.end('ok')
  })

  const result = await runCli(
    [
      '--url',
      server.url,
      '--secret-env',
      'NATIVE_CALLBACK_TEST_SECRET',
      '--build-id',
      'build-20261101-001',
      '--platform',
      'android',
      '--channel',
      'enterprise',
      '--version',
      '1.2.3',
      '--build-number',
      '42',
      '--lock-hash',
      LOCK_HASH,
      '--status',
      'failed',
      '--nonce',
      NONCE,
      '--artifacts',
      artifactsFile,
      '--stage',
      'signing',
      '--error-code',
      'STAGE_SIGNING_FAILED',
      '--log-url',
      LOG_URL,
      '--retries',
      '0',
      '--retry-delay-ms',
      '0',
    ],
    {NATIVE_CALLBACK_TEST_SECRET: SECRET},
  )
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /HTTP 200/)
  assert.equal(result.stdout.includes(SECRET), false)
  assert.equal(result.stderr, '')
  assert.equal(server.requests.length, 1)
  const payload = JSON.parse(server.requests[0].body)
  assert.equal(payload.status, 'failed')
  assert.equal(payload.stage, 'signing')
  assert.equal(payload.errorCode, 'STAGE_SIGNING_FAILED')
  assert.deepEqual(payload.artifacts, [])
})

test('命令行同时提供两个产物来源时拒绝', async t => {
  const dir = createTempDir(t)
  const artifactsFile = writeArtifactsFile(dir)
  const result = await runCli(
    [
      '--url',
      'http://127.0.0.1:9/native/callback',
      '--secret-env',
      'NATIVE_CALLBACK_TEST_SECRET',
      '--build-id',
      'build-20261101-001',
      '--platform',
      'android',
      '--channel',
      'enterprise',
      '--version',
      '1.2.3',
      '--build-number',
      '42',
      '--lock-hash',
      LOCK_HASH,
      '--status',
      'succeeded',
      '--nonce',
      NONCE,
      '--artifacts',
      artifactsFile,
      '--package-dir',
      dir,
      '--signing-fingerprint',
      FINGERPRINT,
      '--log-url',
      LOG_URL,
    ],
    {NATIVE_CALLBACK_TEST_SECRET: SECRET},
  )
  assert.equal(result.code, 1)
  assert.match(result.stderr, /只能提供一个/)
  assert.equal(result.stdout.includes(SECRET), false)
})
