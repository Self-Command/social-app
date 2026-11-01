import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  ArtifactPackageError,
  packageArtifacts,
  readStoreZip,
} from './package-artifacts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'package-artifacts.mjs')
const REPO_ROOT = path.resolve(HERE, '../..')

const LOCK_HASH = `sha256:${'a'.repeat(64)}`
const PLUGIN = {
  id: 'com.example.voicerecorder',
  version: '1.2.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
  manifestHash: `sha256:${'b'.repeat(64)}`,
  packageHash: `sha256:${'c'.repeat(64)}`,
}
const GENERATED_AT = '2026-01-01T00:00:00.000Z'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-artifacts-'))
  roots.push(root)
  return root
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), {recursive: true})
  fs.writeFileSync(target, content)
  return target
}

function writeLock(root, overrides = {}) {
  return write(
    root,
    'native-plugin-lock.json',
    JSON.stringify(
      {lockVersion: 1, plugins: [PLUGIN], lockHash: LOCK_HASH, ...overrides},
      null,
      2,
    ),
  )
}

function baseOptions(root, overrides = {}) {
  const apk = write(root, 'build/app-release.apk', 'apk-bytes')
  const mapping = write(root, 'build/mapping.txt', 'mapping-bytes')
  return {
    platform: 'android',
    buildId: 'build-001',
    channel: 'google_play',
    version: '1.138.0',
    buildNumber: '42',
    lockFile: writeLock(root),
    artifacts: [
      {name: 'app-release.apk', path: apk},
      {name: 'mapping.txt', path: mapping},
    ],
    outDir: path.join(root, 'out'),
    generatedAt: GENERATED_AT,
    sourceRevision: PLUGIN.commit,
    ...overrides,
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function expectFailure(callback, pattern) {
  assert.throws(
    callback,
    error =>
      error instanceof ArtifactPackageError && pattern.test(error.message),
    `期望错误匹配 ${pattern}`,
  )
}

function sha256Of(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

test('为每个产物生成正确的 SHA-256 与字节数', () => {
  const root = tempRoot()
  const result = packageArtifacts(baseOptions(root))

  const apk = result.artifacts.find(
    artifact => artifact.name === 'app-release.apk',
  )
  const mapping = result.artifacts.find(
    artifact => artifact.name === 'mapping.txt',
  )
  assert.equal(apk.sha256, sha256Of(Buffer.from('apk-bytes')))
  assert.equal(apk.size, Buffer.byteLength('apk-bytes'))
  assert.equal(mapping.sha256, sha256Of(Buffer.from('mapping-bytes')))

  const checksums = fs.readFileSync(
    path.join(result.outDir, 'checksums.txt'),
    'utf8',
  )
  assert.equal(
    checksums,
    `${sha256Of(Buffer.from('apk-bytes'))}  app-release.apk\n` +
      `${sha256Of(Buffer.from('mapping-bytes'))}  mapping.txt\n`,
  )
  assert.ok(checksums.endsWith('\n'))
})

test('按文件名排序且重复执行字节一致', () => {
  const root = tempRoot()
  const options = baseOptions(root, {
    artifacts: [
      {name: 'zeta.apk', path: write(root, 'build/zeta.apk', 'z')},
      {name: 'Alpha.apk', path: write(root, 'build/Alpha.apk', 'A')},
      {name: 'alpha.apk', path: write(root, 'build/alpha.apk', 'a')},
    ],
    outDir: path.join(root, 'out-a'),
  })
  const first = packageArtifacts(options)
  const second = packageArtifacts({
    ...options,
    outDir: path.join(root, 'out-b'),
  })

  for (const name of [
    'checksums.txt',
    'artifacts.json',
    'sbom.json',
    'source-manifest.json',
    'store-packet.zip',
  ]) {
    assert.deepEqual(
      fs.readFileSync(path.join(first.outDir, name)),
      fs.readFileSync(path.join(second.outDir, name)),
      `${name} 应在相同输入下保持一致`,
    )
  }

  const lines = fs
    .readFileSync(path.join(first.outDir, 'checksums.txt'), 'utf8')
    .trimEnd()
    .split('\n')
  assert.deepEqual(
    lines.map(line => line.split('  ')[1]),
    ['Alpha.apk', 'alpha.apk', 'zeta.apk'],
  )
})

test('拒绝重名产物', () => {
  const root = tempRoot()
  const apk = write(root, 'build/app-release.apk', 'apk')
  expectFailure(
    () =>
      packageArtifacts(
        baseOptions(root, {
          artifacts: [
            {name: 'app-release.apk', path: apk},
            {name: 'app-release.apk', path: apk},
          ],
        }),
      ),
    /重复/,
  )
})

test('拒绝路径穿越的产物名称', () => {
  const root = tempRoot()
  const apk = write(root, 'build/app-release.apk', 'apk')
  for (const name of ['../evil.apk', 'nested/app.apk', '..\\evil.apk']) {
    expectFailure(
      () =>
        packageArtifacts(
          baseOptions(root, {
            artifacts: [{name, path: apk}],
            outDir: path.join(root, `out-${name.length}`),
          }),
        ),
      /文件名/,
    )
  }
})

test('拒绝非法产物文件名', () => {
  const root = tempRoot()
  const apk = write(root, 'build/app-release.apk', 'apk')
  for (const [index, name] of ['bad name.apk', '..', ''].entries()) {
    expectFailure(
      () =>
        packageArtifacts(
          baseOptions(root, {
            artifacts: [{name, path: apk}],
            outDir: path.join(root, `invalid-${index}`),
          }),
        ),
      /文件名/,
    )
  }
})

test('锁缺少 lockHash 或 plugins 时失败', () => {
  const root = tempRoot()
  const missingHash = write(
    root,
    'lock-missing-hash.json',
    JSON.stringify({plugins: [PLUGIN]}),
  )
  expectFailure(
    () => packageArtifacts(baseOptions(root, {lockFile: missingHash})),
    /lockHash/,
  )

  const missingPlugins = write(
    root,
    'lock-missing-plugins.json',
    JSON.stringify({lockHash: LOCK_HASH}),
  )
  expectFailure(
    () =>
      packageArtifacts(
        baseOptions(root, {
          lockFile: missingPlugins,
          outDir: path.join(root, 'out-plugins'),
        }),
      ),
    /plugins/,
  )

  const missingHashField = write(
    root,
    'lock-missing-package-hash.json',
    JSON.stringify({
      lockHash: LOCK_HASH,
      plugins: [{...PLUGIN, packageHash: undefined}],
    }),
  )
  expectFailure(
    () =>
      packageArtifacts(
        baseOptions(root, {
          lockFile: missingHashField,
          outDir: path.join(root, 'out-hash'),
        }),
      ),
    /packageHash/,
  )
})

test('SBOM 包含依赖与原生插件组件', () => {
  const root = tempRoot()
  const licensesFile = write(
    root,
    'licenses.json',
    JSON.stringify({
      MIT: [
        {
          name: 'left-pad',
          versions: ['1.3.0'],
          license: 'MIT',
          paths: ['/home/example/project/node_modules/left-pad'],
        },
      ],
      'Apache-2.0': [{name: '@scope/widget', versions: ['2.0.0']}],
    }),
  )
  const result = packageArtifacts(baseOptions(root, {licensesFile}))
  const sbom = readJson(path.join(result.outDir, 'sbom.json'))

  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.specVersion, '1.5')
  assert.equal(sbom.version, 1)
  assert.equal(sbom.metadata.component.name, 'bsky.app')
  assert.equal(sbom.metadata.component.version, '1.138.0')

  const names = sbom.components.map(component => component.name)
  assert.ok(names.includes('left-pad'))
  assert.ok(names.includes('@scope/widget'))
  assert.ok(names.includes(PLUGIN.id))

  const leftPad = sbom.components.find(
    component => component.name === 'left-pad',
  )
  assert.deepEqual(leftPad.licenses, [{license: {id: 'MIT'}}])
  assert.ok(!JSON.stringify(sbom).includes('/home/example'))
})

test('没有 licenses 时 SBOM 只含原生插件组件', () => {
  const root = tempRoot()
  const result = packageArtifacts(baseOptions(root))
  const sbom = readJson(path.join(result.outDir, 'sbom.json'))

  assert.equal(sbom.components.length, 1)
  assert.equal(sbom.components[0].name, PLUGIN.id)
  assert.equal(sbom.components[0].version, PLUGIN.version)
})

test('store-packet 可被自身解析器列出且不含秘密文件', () => {
  const root = tempRoot()
  const result = packageArtifacts(baseOptions(root))
  const entries = readStoreZip(
    fs.readFileSync(path.join(result.outDir, 'store-packet.zip')),
  )

  assert.deepEqual(
    entries.map(entry => entry.name),
    [
      'manifest.json',
      'native-plugin-lock.json',
      'sbom.json',
      'checksums.txt',
      'signing/fingerprint.txt',
    ],
  )
  for (const entry of entries) {
    assert.ok(
      !/\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(entry.name),
      `资料包不应包含 ${entry.name}`,
    )
  }

  const manifest = JSON.parse(entries[0].data.toString('utf8'))
  assert.equal(manifest.lockHash, LOCK_HASH)
  const lock = JSON.parse(entries[1].data.toString('utf8'))
  assert.equal(lock.lockHash, LOCK_HASH)
})

test('资料包拒绝包含私钥内容', () => {
  const root = tempRoot()
  const privateKeyHeader = ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ')
  const lockFile = write(
    root,
    'lock-with-key.json',
    JSON.stringify({
      lockVersion: 1,
      plugins: [PLUGIN],
      lockHash: LOCK_HASH,
      note: privateKeyHeader,
    }),
  )
  expectFailure(() => packageArtifacts(baseOptions(root, {lockFile})), /私钥/)
})

test('签名指纹写入资料包且未配置时使用固定文案', () => {
  const root = tempRoot()
  const withFingerprint = packageArtifacts(
    baseOptions(root, {
      signingFingerprint: ' AB:CD:EF ',
      outDir: path.join(root, 'out-fingerprint'),
    }),
  )
  const entries = readStoreZip(
    fs.readFileSync(path.join(withFingerprint.outDir, 'store-packet.zip')),
  )
  const fingerprint = entries.find(
    entry => entry.name === 'signing/fingerprint.txt',
  )
  assert.equal(fingerprint.data.toString('utf8'), 'AB:CD:EF\n')

  const withoutFingerprint = packageArtifacts(
    baseOptions(root, {outDir: path.join(root, 'out-no-fingerprint')}),
  )
  const unconfigured = readStoreZip(
    fs.readFileSync(path.join(withoutFingerprint.outDir, 'store-packet.zip')),
  ).find(entry => entry.name === 'signing/fingerprint.txt')
  assert.equal(unconfigured.data.toString('utf8'), '未配置\n')
})

test('artifacts.json 与回调契约一致', () => {
  const root = tempRoot()
  const result = packageArtifacts(baseOptions(root))
  const artifacts = readJson(path.join(result.outDir, 'artifacts.json'))
  const checksums = fs.readFileSync(
    path.join(result.outDir, 'checksums.txt'),
    'utf8',
  )

  assert.deepEqual(
    artifacts.map(artifact => artifact.name),
    ['app-release.apk', 'mapping.txt'],
  )
  for (const entry of artifacts) {
    assert.deepEqual(Object.keys(entry), ['name', 'sha256', 'size'])
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    const file = path.join(result.outDir, entry.name)
    assert.equal(entry.size, fs.statSync(file).size)
    assert.equal(entry.sha256, sha256Of(fs.readFileSync(file)))
    assert.ok(checksums.includes(`${entry.sha256}  ${entry.name}\n`))
  }
})

test('拒绝仓库根目录、上级目录与非空输出目录', () => {
  const root = tempRoot()
  expectFailure(
    () => packageArtifacts(baseOptions(root, {outDir: REPO_ROOT})),
    /仓库根目录/,
  )
  expectFailure(
    () =>
      packageArtifacts(baseOptions(root, {outDir: path.dirname(REPO_ROOT)})),
    /上级目录/,
  )

  const nonEmpty = path.join(root, 'non-empty')
  fs.mkdirSync(nonEmpty)
  write(nonEmpty, 'existing.txt', 'existing')
  expectFailure(
    () => packageArtifacts(baseOptions(root, {outDir: nonEmpty})),
    /非空/,
  )
})

test('拒绝签名密钥或凭据名称的产物', () => {
  const root = tempRoot()
  const key = write(root, 'build/release.keystore', 'secret')
  expectFailure(
    () =>
      packageArtifacts(
        baseOptions(root, {
          artifacts: [{name: 'release.keystore', path: key}],
        }),
      ),
    /签名密钥/,
  )
})

test('拒绝与生成文件冲突的产物名称', () => {
  const root = tempRoot()
  const file = write(root, 'build/checksums.txt', 'checksums')
  expectFailure(
    () =>
      packageArtifacts(
        baseOptions(root, {
          artifacts: [{name: 'checksums.txt', path: file}],
        }),
      ),
    /生成文件冲突/,
  )
})

test('来源清单记录构建输入与产物摘要', () => {
  const root = tempRoot()
  const result = packageArtifacts(baseOptions(root))
  const manifest = readJson(path.join(result.outDir, 'source-manifest.json'))

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.generatedAt, GENERATED_AT)
  assert.equal(manifest.application.name, 'bsky.app')
  assert.equal(manifest.application.commit, PLUGIN.commit)
  assert.equal(manifest.platform, 'android')
  assert.equal(manifest.channel, 'google_play')
  assert.equal(manifest.version, '1.138.0')
  assert.equal(manifest.buildNumber, 42)
  assert.equal(manifest.lockHash, LOCK_HASH)
  assert.deepEqual(manifest.plugins, [
    {
      id: PLUGIN.id,
      version: PLUGIN.version,
      commit: PLUGIN.commit,
      manifestHash: PLUGIN.manifestHash,
      packageHash: PLUGIN.packageHash,
    },
  ])
  assert.deepEqual(manifest.artifacts, result.artifacts)
})

test('命令行参数完成打包并使用 SOURCE_DATE_EPOCH', () => {
  const root = tempRoot()
  const apk = write(root, 'build/app-release.apk', 'apk-bytes')
  const lockFile = writeLock(root)
  const outDir = path.join(root, 'out')

  const run = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--platform',
      'android',
      '--build-id',
      'build-001',
      '--channel',
      'enterprise',
      '--version',
      '1.138.0',
      '--build-number',
      '42',
      '--lock',
      lockFile,
      '--artifact',
      `app-release.apk=${apk}`,
      '--out',
      outDir,
    ],
    {
      encoding: 'utf8',
      env: {...process.env, SOURCE_DATE_EPOCH: '1767225600'},
    },
  )

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /产物打包完成/)
  for (const name of [
    'app-release.apk',
    'checksums.txt',
    'artifacts.json',
    'sbom.json',
    'source-manifest.json',
    'store-packet.zip',
    'native-plugin-lock.json',
    'signing/fingerprint.txt',
  ]) {
    assert.ok(fs.existsSync(path.join(outDir, name)), `${name} 应存在`)
  }
  const manifest = readJson(path.join(outDir, 'source-manifest.json'))
  assert.equal(manifest.generatedAt, GENERATED_AT)
})

test('命令行缺少必需参数时以失败状态退出', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--platform', 'android'], {
    encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /缺少必需参数/)
})
