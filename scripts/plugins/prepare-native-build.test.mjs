import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
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
} from './native-pipeline-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const SCRIPT = path.join(HERE, 'prepare-native-build.mjs')
const FIXTURE = path.join(HERE, 'fixtures/native-recorder')
const PLUGIN_ID = 'com.example.nativerecorder'

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-'))
  const work = path.join(root, 'work')
  const appRoot = path.join(root, 'app')
  fs.mkdirSync(path.join(work, 'plugins', PLUGIN_ID), {recursive: true})
  fs.mkdirSync(appRoot, {recursive: true})
  fs.cpSync(
    path.join(FIXTURE, 'plugin'),
    path.join(work, 'plugins', PLUGIN_ID),
    {
      recursive: true,
    },
  )
  return {root, work, appRoot}
}

function writeInputs({work, commit}) {
  const plugins = preparePlugins(path.join(FIXTURE, 'snapshot.json')).map(
    entry => {
      const lockEntry = createLockEntry(entry)
      return commit ? {...lockEntry, commit} : lockEntry
    },
  )
  const lock = createNativeLock(plugins)
  const lockFile = path.join(work, 'lock.json')
  fs.writeFileSync(lockFile, serializeNativeLock(lock), 'utf8')
  const sourcesFile = path.join(work, 'sources.json')
  fs.writeFileSync(
    sourcesFile,
    `${JSON.stringify({[PLUGIN_ID]: 'example/nativerecorder'}, null, 2)}\n`,
    'utf8',
  )
  return {lock, lockFile, sourcesFile}
}

function runPrepare({work, appRoot, lockFile, sourcesFile, extra = []}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--lock',
      lockFile,
      '--sources',
      sourcesFile,
      '--work',
      work,
      '--app-root',
      appRoot,
      ...extra,
    ],
    {encoding: 'utf8'},
  )
}

test('校验锁与来源、装配并覆盖到应用仓库', () => {
  const {root, work, appRoot} = createWorkspace()
  try {
    const {lock, lockFile, sourcesFile} = writeInputs({work})
    const result = runPrepare({
      work,
      appRoot,
      lockFile,
      sourcesFile,
      extra: ['--skip-git-check'],
    })
    assert.equal(result.status, 0, result.stderr)

    const catalogIndex = path.join(
      appRoot,
      'src/features/plugins/catalog',
      PLUGIN_ID,
      'index.ts',
    )
    assert.equal(fs.existsSync(catalogIndex), true)
    assert.equal(
      fs.existsSync(
        path.join(appRoot, 'modules/plugin-nativerecorder/package.json'),
      ),
      true,
    )

    const config = JSON.parse(
      fs.readFileSync(
        path.join(appRoot, 'src/features/plugins/generated/native-config.json'),
        'utf8',
      ),
    )
    assert.equal(config.plugins[0].id, PLUGIN_ID)
    assert.equal(config.plugins[0].permissions[0].name, 'microphone')

    const catalog = fs.readFileSync(
      path.join(appRoot, 'src/features/plugins/catalog/catalog.generated.ts'),
      'utf8',
    )
    assert.match(catalog, /GENERATED_PLUGIN_CATALOG/)
    assert.match(catalog, /com\.example\.nativerecorder/)

    const link = path.join(
      appRoot,
      'node_modules/@community-plugins/nativerecorder',
    )
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)

    const record = JSON.parse(
      fs.readFileSync(path.join(work, 'assembly-record.json'), 'utf8'),
    )
    assert.equal(record.lockHash, lock.lockHash)
    assert.equal(record.plugins[0].commit, lock.plugins[0].commit)
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

test('锁哈希被篡改时失败', () => {
  const {root, work, appRoot} = createWorkspace()
  try {
    const {lock, lockFile, sourcesFile} = writeInputs({work})
    fs.writeFileSync(
      lockFile,
      serializeNativeLock({...lock, lockHash: `sha256:${'0'.repeat(64)}`}),
      'utf8',
    )
    const result = runPrepare({
      work,
      appRoot,
      lockFile,
      sourcesFile,
      extra: ['--skip-git-check'],
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /lock\.lockHash: 与锁内容不一致/)
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

test('来源映射缺少插件时失败', () => {
  const {root, work, appRoot} = createWorkspace()
  try {
    const {lockFile, sourcesFile} = writeInputs({work})
    fs.writeFileSync(sourcesFile, '{}\n', 'utf8')
    const result = runPrepare({
      work,
      appRoot,
      lockFile,
      sourcesFile,
      extra: ['--skip-git-check'],
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /缺少仓库地址/)
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

test('插件 HEAD 与锁记录不一致时失败', () => {
  const {root, work, appRoot} = createWorkspace()
  try {
    const pluginDir = path.join(work, 'plugins', PLUGIN_ID)
    execFileSync('git', ['init', '-q'], {cwd: pluginDir})
    execFileSync('git', ['add', '.'], {cwd: pluginDir})
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Native Build Test',
        '-c',
        'user.email=native-build@example.invalid',
        'commit',
        '-q',
        '-m',
        'fixture',
      ],
      {cwd: pluginDir},
    )
    const {lockFile, sourcesFile} = writeInputs({work})
    const result = runPrepare({work, appRoot, lockFile, sourcesFile})
    assert.equal(result.status, 1)
    assert.match(result.stderr, /提交不一致/)
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
})
