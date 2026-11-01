import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  createLockEntry,
  createNativeLock,
  preparePlugins,
  serializeNativeLock,
} from '../plugins/native-pipeline-lib.mjs'
import {prepareDispatch} from './prepare-native-dispatch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'prepare-native-dispatch.mjs')
const SNAPSHOT = path.join(
  HERE,
  '../plugins/fixtures/native-recorder/snapshot.json',
)
const PLUGIN_ID = 'com.example.nativerecorder'
const PLUGIN_REPO = 'example/nativerecorder'
const FINGERPRINT = 'ab'.repeat(32)
const NORMALIZED_FINGERPRINT = Array.from({length: 32}, () => 'AB').join(':')

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-dispatch-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const work = path.join(root, 'work')
  const plugins = preparePlugins(SNAPSHOT).map(entry => createLockEntry(entry))
  const lock = createNativeLock(plugins)
  const lockFile = path.join(root, 'native-plugin-lock.json')
  fs.writeFileSync(lockFile, serializeNativeLock(lock), 'utf8')
  return {root, work, lock, lockFile}
}

function createOptions(lockFile, work) {
  return {
    work,
    lockFile,
    buildId: 'build-20261101-001',
    profile: 'enterprise',
    platform: 'android',
    channel: 'enterprise',
    version: '1.2.3',
    buildNumber: '42',
    callbackUrl: 'https://build.example.invalid/native/callback',
    nonce: 'abcdefgh12345678',
    signingFingerprint: FINGERPRINT,
    pluginRepos: JSON.stringify({[PLUGIN_ID]: PLUGIN_REPO}),
    githubRepo: 'Self-Command/social-app',
    releaseRepo: 'Self-Command/social-app',
    appRevision: 'a'.repeat(40),
    approvalId: 'APR-2026-001',
  }
}

test('校验派发参数并写出来源、空产物、阶段与派发记录', t => {
  const {work, lock, lockFile} = createWorkspace(t)
  const result = prepareDispatch(createOptions(lockFile, work))

  assert.equal(result.lockHash, lock.lockHash)
  assert.equal(result.plugins, 1)
  assert.equal(result.signingFingerprint, NORMALIZED_FINGERPRINT)
  assert.equal(
    fs.readFileSync(result.sourcesFile, 'utf8'),
    `${JSON.stringify({[PLUGIN_ID]: PLUGIN_REPO}, null, 2)}\n`,
  )
  assert.equal(fs.readFileSync(result.emptyArtifacts, 'utf8'), '[]\n')
  assert.equal(fs.readFileSync(result.stageFile, 'utf8'), 'validate\n')

  const record = JSON.parse(fs.readFileSync(result.dispatchRecord, 'utf8'))
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.buildId, 'build-20261101-001')
  assert.equal(record.platform, 'android')
  assert.equal(record.channel, 'enterprise')
  assert.equal(record.lockHash, lock.lockHash)
  assert.equal(record.appRevision, 'a'.repeat(40))
  assert.equal(record.approvalId, 'APR-2026-001')
  assert.deepEqual(
    record.plugins,
    lock.plugins.map(plugin => ({
      id: plugin.id,
      version: plugin.version,
      commit: plugin.commit,
    })),
  )
})

test('非法字段汇总报告且不写任何派发文件', t => {
  const {work, lockFile} = createWorkspace(t)
  const cases = [
    [{buildId: '-bad'}, /--build-id/],
    [{profile: 'staging'}, /--profile/],
    [{platform: 'web'}, /--platform/],
    [{channel: 'appstore'}, /--channel/],
    [{version: '1.2'}, /--version/],
    [{buildNumber: '0'}, /--build-number/],
    [{nonce: 'short'}, /--nonce/],
    [{signingFingerprint: 'abcd'}, /--signing-fingerprint/],
    [{appRevision: 'A'.repeat(40)}, /--app-revision/],
    [{approvalId: 'has space'}, /--approval-id/],
  ]
  for (const [patch, pattern] of cases) {
    assert.throws(
      () => prepareDispatch({...createOptions(lockFile, work), ...patch}),
      pattern,
    )
  }
  assert.equal(fs.existsSync(path.join(work, 'dispatch.json')), false)
})

test('渠道与平台不匹配时拒绝', t => {
  const {work, lockFile} = createWorkspace(t)
  const cases = [
    {profile: 'enterprise', channel: 'enterprise', platform: 'ios'},
    {profile: 'production', channel: 'google_play', platform: 'ios'},
    {profile: 'testflight', channel: 'app_store', platform: 'android'},
    {profile: 'production', channel: 'china_store', platform: 'ios'},
  ]
  for (const patch of cases) {
    assert.throws(
      () => prepareDispatch({...createOptions(lockFile, work), ...patch}),
      /渠道不支持/,
    )
  }
  assert.doesNotThrow(() =>
    prepareDispatch({
      ...createOptions(lockFile, work),
      channel: 'development',
      platform: 'ios',
      profile: 'testflight',
    }),
  )
})

test('回调地址必须是干净的 HTTPS 地址', t => {
  const {work, lockFile} = createWorkspace(t)
  const cases = [
    ['http://build.example.invalid/callback', /必须使用 HTTPS/],
    ['https://user:pass@build.example.invalid/cb', /不得包含凭据/],
    ['https://build.example.invalid/cb?run=1', /查询参数/],
    ['not-a-url', /有效的 HTTPS 地址/],
  ]
  for (const [callbackUrl, pattern] of cases) {
    assert.throws(
      () => prepareDispatch({...createOptions(lockFile, work), callbackUrl}),
      pattern,
    )
  }
})

test('发布仓库必须与当前仓库一致', t => {
  const {work, lockFile} = createWorkspace(t)
  assert.throws(
    () =>
      prepareDispatch({
        ...createOptions(lockFile, work),
        releaseRepo: 'other/repo',
      }),
    /无法向 other\/repo 写入 Release/,
  )
})

test('插件仓库映射必须与锁完全一致', t => {
  const {work, lockFile} = createWorkspace(t)
  const cases = [
    ['{}', /缺少仓库地址/],
    [
      JSON.stringify({[PLUGIN_ID]: PLUGIN_REPO, 'com.example.extra': 'a/b'}),
      /锁中没有该插件/,
    ],
    [JSON.stringify({[PLUGIN_ID]: 'example/../evil'}), /路径回溯/],
    [JSON.stringify({[PLUGIN_ID]: 'example/nativerecorder.git'}), /owner/],
    ['not-json', /必须是合法 JSON/],
    ['[]', /期望对象/],
  ]
  for (const [pluginRepos, pattern] of cases) {
    assert.throws(
      () => prepareDispatch({...createOptions(lockFile, work), pluginRepos}),
      pattern,
    )
  }
})

test('锁文件被篡改时拒绝', t => {
  const {work, lock, lockFile} = createWorkspace(t)
  fs.writeFileSync(
    lockFile,
    serializeNativeLock({...lock, lockHash: `sha256:${'0'.repeat(64)}`}),
    'utf8',
  )
  assert.throws(
    () => prepareDispatch(createOptions(lockFile, work)),
    /锁文件校验失败/,
  )
})

test('命令行成功时写入 GITHUB_OUTPUT', t => {
  const {root, work, lock, lockFile} = createWorkspace(t)
  const outputFile = path.join(root, 'output.txt')
  fs.writeFileSync(outputFile, '', 'utf8')
  const options = createOptions(lockFile, work)
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--work',
      work,
      '--lock',
      lockFile,
      '--build-id',
      options.buildId,
      '--profile',
      options.profile,
      '--platform',
      options.platform,
      '--channel',
      options.channel,
      '--version',
      options.version,
      '--build-number',
      options.buildNumber,
      '--callback-url',
      options.callbackUrl,
      '--nonce',
      options.nonce,
      '--signing-fingerprint',
      options.signingFingerprint,
      '--plugin-repos',
      options.pluginRepos,
      '--github-repo',
      options.githubRepo,
      '--release-repo',
      options.releaseRepo,
      '--app-revision',
      options.appRevision,
      '--approval-id',
      options.approvalId,
    ],
    {encoding: 'utf8', env: {...process.env, GITHUB_OUTPUT: outputFile}},
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /派发参数校验通过/)
  const output = fs.readFileSync(outputFile, 'utf8')
  assert.match(output, new RegExp(`lock_hash=${lock.lockHash}`))
  assert.equal(output.includes(`work_dir=${work}`), true)
  assert.match(output, /empty_artifacts=.*empty-artifacts\.json/)
  assert.match(output, /signing_fingerprint=AB:AB:/)
})

test('命令行校验失败时退出码为 1 且不写产物', t => {
  const {work, lockFile} = createWorkspace(t)
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--work',
      work,
      '--lock',
      lockFile,
      '--build-id',
      'build-20261101-001',
      '--profile',
      'enterprise',
      '--platform',
      'ios',
      '--channel',
      'enterprise',
      '--version',
      '1.2.3',
      '--build-number',
      '42',
      '--callback-url',
      'https://build.example.invalid/native/callback',
      '--nonce',
      'abcdefgh12345678',
      '--signing-fingerprint',
      FINGERPRINT,
      '--plugin-repos',
      JSON.stringify({[PLUGIN_ID]: PLUGIN_REPO}),
      '--github-repo',
      'Self-Command/social-app',
      '--release-repo',
      'Self-Command/social-app',
    ],
    {encoding: 'utf8', env: {...process.env, GITHUB_OUTPUT: ''}},
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /渠道不支持/)
  assert.equal(fs.existsSync(path.join(work, 'dispatch.json')), false)
})
