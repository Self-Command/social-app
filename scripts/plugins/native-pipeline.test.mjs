import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  assembleNative,
  canonicalJson,
  computeManifestHash,
  computePackageHash,
  createNativeLock,
  loadSnapshot,
  parsePipelineArgs,
  serializeNativeLock,
  writeNativeLock,
} from './native-pipeline-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'native-recorder')
const FIXTURE_SNAPSHOT = path.join(FIXTURE_DIR, 'snapshot.json')
const FIXTURE_PLUGIN = path.join(FIXTURE_DIR, 'plugin')
const ASSEMBLE_SCRIPT = path.join(HERE, 'assemble-native.mjs')
const LOCK_SCRIPT = path.join(HERE, 'build-native-lock.mjs')

const LOCK_FILE = 'src/features/plugins/generated/native-plugin-lock.json'
const GENERATED_DIR = 'src/features/plugins/generated'
const CATALOG_DIR = 'src/features/plugins/catalog'
const PLUGIN_ID = 'com.example.nativerecorder'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST_REASON = '用于录制语音评论'

const tempDirs = []

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pipeline-'))
  tempDirs.push(dir)
  return dir
}

function makeOutDir() {
  return path.join(makeTempDir(), 'out')
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function copyFixture() {
  const dir = makeTempDir()
  fs.cpSync(FIXTURE_DIR, dir, {recursive: true})
  assert.ok(fs.existsSync(path.join(dir, 'snapshot.json')))
  return dir
}

function linkDir(target, at) {
  if (process.platform === 'win32') {
    fs.symlinkSync(path.resolve(target), at, 'junction')
  } else {
    fs.symlinkSync(path.resolve(target), at, 'dir')
  }
}

function removeDirLink(linkPath) {
  try {
    fs.unlinkSync(linkPath)
  } catch (error) {
    if (process.platform === 'win32') {
      fs.rmdirSync(linkPath)
      return
    }
    throw error
  }
}

function collectFiles(root) {
  const files = []
  const visit = relative => {
    const absolute = relative ? path.join(root, relative) : root
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(relative ? `${relative}/${name}` : name)
      }
      return
    }
    if (stat.isFile()) {
      files.push(relative)
    }
  }
  visit('')
  return files.sort()
}

function findFiles(root, name) {
  return collectFiles(root).filter(file => path.posix.basename(file) === name)
}

function readTree(root) {
  const tree = new Map()
  for (const file of collectFiles(root)) {
    tree.set(file, fs.readFileSync(path.join(root, file)))
  }
  return tree
}

function lockEntry(id) {
  return {
    id,
    version: '1.0.0',
    commit: 'a'.repeat(40),
    manifestHash: `sha256:${'1'.repeat(64)}`,
    packageHash: `sha256:${'2'.repeat(64)}`,
    hostApi: 2,
    nativeApi: 1,
    modules: ['NativeRecorder'],
    views: [{name: 'RecorderView', heightMode: 'content'}],
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function runCli(script, args) {
  return spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'})
}

function extractLockHash(stdout) {
  const match = stdout.match(/lockHash=(sha256:[0-9a-f]{64})/)
  assert.ok(match, `输出中没有 lockHash：\n${stdout}`)
  return match[1]
}

test('canonicalJson 递归排序键并压缩空白', () => {
  const value = {z: 0, a: {d: [3, {y: null, x: true}], c: '中文'}, b: '文本'}
  assert.equal(
    canonicalJson(value),
    '{"a":{"c":"中文","d":[3,{"x":true,"y":null}]},"b":"文本","z":0}',
  )
  assert.equal(canonicalJson([1, {b: 2, a: 1}]), '[1,{"a":1,"b":2}]')
})

test('清单哈希只取决于规范化内容', () => {
  const first = computeManifestHash({b: 1, a: 2})
  const second = computeManifestHash({a: 2, b: 1})
  assert.equal(first, second)
  assert.match(first, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(first, computeManifestHash({a: 3, b: 1}))
})

test('包哈希忽略构建产物且随文件内容变化', () => {
  const root = copyFixture()
  const pluginDir = path.join(root, 'plugin')
  const before = computePackageHash(pluginDir)
  assert.equal(before, computePackageHash(pluginDir))
  assert.match(before, /^sha256:[0-9a-f]{64}$/)

  fs.mkdirSync(path.join(pluginDir, 'node_modules', 'ignored'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(pluginDir, 'node_modules', 'ignored', 'index.js'),
    'x',
  )
  fs.writeFileSync(path.join(pluginDir, 'build.log'), 'x')
  assert.equal(computePackageHash(pluginDir), before)

  fs.appendFileSync(path.join(pluginDir, 'src', 'index.ts'), '\n// changed\n')
  assert.notEqual(computePackageHash(pluginDir), before)
})

test('锁按插件 id 排序并生成与宿主一致的哈希载荷', () => {
  const entries = [
    lockEntry('com.example.zeta'),
    lockEntry('com.example.alpha'),
  ]
  const lock = createNativeLock(entries)
  assert.equal(lock.lockVersion, 1)
  assert.deepEqual(
    lock.plugins.map(entry => entry.id),
    ['com.example.alpha', 'com.example.zeta'],
  )
  assert.deepEqual(Object.keys(lock.plugins[0]), [
    'id',
    'version',
    'commit',
    'manifestHash',
    'packageHash',
    'hostApi',
    'nativeApi',
    'modules',
    'views',
  ])
  const expected = `sha256:${sha256(
    JSON.stringify({lockVersion: 1, plugins: lock.plugins}),
  )}`
  assert.equal(lock.lockHash, expected)
  assert.equal(createNativeLock([...entries].reverse()).lockHash, lock.lockHash)
})

test('锁文件以两空格缩进并以换行结尾', () => {
  const lock = createNativeLock([lockEntry('com.example.alpha')])
  const serialized = serializeNativeLock(lock)
  assert.equal(serialized, `${JSON.stringify(lock, null, 2)}\n`)
  assert.ok(serialized.endsWith('\n'))
  assert.ok(!serialized.endsWith('\n\n'))
})

test('CLI 参数解析提供夹具默认输出并拒绝危险组合', () => {
  const options = parsePipelineArgs(['--fixture', 'native-recorder'])
  assert.equal(options.fixtureName, 'native-recorder')
  assert.equal(
    options.snapshotFile,
    path.join(HERE, 'fixtures', 'native-recorder', 'snapshot.json'),
  )
  assert.equal(
    options.outDir,
    path.join(REPO_ROOT, '.plugin-build', 'native-recorder'),
  )
  assert.throws(
    () => parsePipelineArgs(['--snapshot', FIXTURE_SNAPSHOT]),
    /--snapshot 必须同时提供 --out/,
  )
  assert.throws(() => parsePipelineArgs(['--bogus']), /未知参数/)
  assert.throws(
    () => parsePipelineArgs(['--fixture', '../escape']),
    /--fixture 只允许/,
  )
})

test('组装输出包含目录约定、生成文件与包链接', () => {
  const out = makeOutDir()
  const result = assembleNative({snapshotFile: FIXTURE_SNAPSHOT, outDir: out})

  const expectedFiles = [
    'modules/plugin-nativerecorder/android/build.gradle',
    'modules/plugin-nativerecorder/android/src/main/AndroidManifest.xml',
    'modules/plugin-nativerecorder/android/src/main/java/expo/modules/nativerecorder/NativeRecorderModule.kt',
    'modules/plugin-nativerecorder/expo-module.config.json',
    'modules/plugin-nativerecorder/index.ts',
    'modules/plugin-nativerecorder/ios/NativeRecorder.podspec',
    'modules/plugin-nativerecorder/ios/NativeRecorderModule.swift',
    'modules/plugin-nativerecorder/package.json',
    'modules/plugin-nativerecorder/scripts/postinstall.cjs',
    `${CATALOG_DIR}/catalog.generated.ts`,
    `${CATALOG_DIR}/${PLUGIN_ID}/index.ts`,
    `${CATALOG_DIR}/${PLUGIN_ID}/manifest.json`,
    `${GENERATED_DIR}/native-config.json`,
    `${GENERATED_DIR}/native-lock.ts`,
    `${GENERATED_DIR}/native-plugin-lock.json`,
    `${GENERATED_DIR}/native-registry.ts`,
  ].sort()
  assert.deepEqual(result.files, expectedFiles)

  const linkPath = path.join(
    out,
    'node_modules',
    '@community-plugins',
    'nativerecorder',
  )
  const moduleDir = path.join(out, 'modules', 'plugin-nativerecorder')
  assert.ok(fs.lstatSync(linkPath).isSymbolicLink())
  assert.equal(fs.realpathSync(linkPath), fs.realpathSync(moduleDir))
  assert.deepEqual(result.links, [
    {
      link: 'node_modules/@community-plugins/nativerecorder',
      target: 'modules/plugin-nativerecorder',
      status: 'created',
    },
  ])

  const lock = readJson(path.join(out, LOCK_FILE))
  assert.equal(lock.lockVersion, 1)
  assert.equal(lock.plugins.length, 1)
  const entry = lock.plugins[0]
  assert.equal(entry.id, PLUGIN_ID)
  assert.equal(entry.version, '1.0.0')
  assert.equal(entry.commit, COMMIT)
  assert.equal(
    entry.manifestHash,
    computeManifestHash(readJson(path.join(FIXTURE_PLUGIN, 'manifest.json'))),
  )
  assert.equal(entry.packageHash, computePackageHash(FIXTURE_PLUGIN))
  assert.equal(entry.hostApi, 2)
  assert.equal(entry.nativeApi, 1)
  assert.deepEqual(entry.modules, ['NativeRecorder'])
  assert.deepEqual(entry.views, [{name: 'RecorderView', heightMode: 'content'}])
  assert.match(lock.lockHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(lock.lockHash, result.lock.lockHash)

  const registry = fs.readFileSync(
    path.join(out, GENERATED_DIR, 'native-registry.ts'),
    'utf8',
  )
  assert.match(registry, new RegExp(`id: '${PLUGIN_ID}'`))
  assert.match(registry, /packageName: '@community-plugins\/nativerecorder'/)
  assert.match(registry, /modules: \['NativeRecorder'\]/)
  assert.match(registry, /name: 'RecorderView', heightMode: 'content'/)

  const lockModule = fs.readFileSync(
    path.join(out, GENERATED_DIR, 'native-lock.ts'),
    'utf8',
  )
  assert.match(lockModule, /parseNativePluginLock\(lockJson\)/)
  assert.match(
    lockModule,
    /import lockJson from '\.\/native-plugin-lock\.json'/,
  )

  assert.deepEqual(
    readJson(path.join(out, GENERATED_DIR, 'native-config.json')),
    {
      schemaVersion: 1,
      plugins: [
        {
          id: PLUGIN_ID,
          package: '@community-plugins/nativerecorder',
          modules: ['NativeRecorder'],
          views: [{name: 'RecorderView', heightMode: 'content'}],
          permissions: [{name: 'microphone', reason: MANIFEST_REASON}],
        },
      ],
    },
  )

  const catalog = fs.readFileSync(
    path.join(out, CATALOG_DIR, 'catalog.generated.ts'),
    'utf8',
  )
  assert.match(
    catalog,
    /import \{plugin as pluginComExampleNativerecorder\} from '\.\/com\.example\.nativerecorder'/,
  )
  assert.match(catalog, /export const GENERATED_PLUGIN_CATALOG/)

  const copiedIndex = fs.readFileSync(
    path.join(out, CATALOG_DIR, PLUGIN_ID, 'index.ts'),
    'utf8',
  )
  assert.match(copiedIndex, /from '\.\.\/\.\.\/sdk'/)
  assert.match(copiedIndex, /from '\.\/manifest\.json'/)
  assert.equal(
    copiedIndex,
    fs.readFileSync(path.join(FIXTURE_PLUGIN, 'src', 'index.ts'), 'utf8'),
  )
})

test('重复组装生成逐字节一致的文件', () => {
  const out = makeOutDir()
  const first = assembleNative({snapshotFile: FIXTURE_SNAPSHOT, outDir: out})
  const firstTree = readTree(out)
  const second = assembleNative({snapshotFile: FIXTURE_SNAPSHOT, outDir: out})
  const secondTree = readTree(out)

  assert.deepEqual([...secondTree.keys()], [...firstTree.keys()])
  for (const [file, bytes] of firstTree) {
    assert.deepEqual(secondTree.get(file), bytes, `${file} 字节不一致`)
  }
  assert.equal(second.lock.lockHash, first.lock.lockHash)
  assert.equal(second.links[0].status, 'existing')
})

test('夹具中的 postinstall 从未被执行', () => {
  const packageJson = readJson(
    path.join(FIXTURE_PLUGIN, 'native', 'package.json'),
  )
  assert.equal(packageJson.scripts.postinstall, 'node scripts/postinstall.cjs')
  assert.equal(findFiles(FIXTURE_DIR, '.postinstall-ran').length, 0)

  const out = makeOutDir()
  assembleNative({snapshotFile: FIXTURE_SNAPSHOT, outDir: out})
  assert.equal(findFiles(out, '.postinstall-ran').length, 0)
  assert.equal(findFiles(FIXTURE_DIR, '.postinstall-ran').length, 0)
})

test('快照记录的清单或包哈希不一致时拒绝组装', () => {
  const root = copyFixture()
  const snapshotFile = path.join(root, 'snapshot.json')
  const snapshot = readJson(snapshotFile)
  snapshot.plugins[0].manifestHash = `sha256:${'0'.repeat(64)}`
  snapshot.plugins[0].packageHash = `sha256:${'0'.repeat(64)}`
  writeJson(snapshotFile, snapshot)

  assert.throws(
    () => assembleNative({snapshotFile, outDir: makeOutDir()}),
    error => {
      assert.match(error.message, /manifestHash: 与快照记录不一致/)
      assert.match(error.message, /packageHash: 与快照记录不一致/)
      return true
    },
  )
})

test('未知快照字段与未知清单字段使组装失败', () => {
  const snapshotRoot = copyFixture()
  const snapshotFile = path.join(snapshotRoot, 'snapshot.json')
  const snapshot = readJson(snapshotFile)
  snapshot.generatedAt = '2026-01-01T00:00:00Z'
  writeJson(snapshotFile, snapshot)
  assert.throws(
    () => assembleNative({snapshotFile, outDir: makeOutDir()}),
    /snapshot\.generatedAt: 未知字段/,
  )

  const manifestRoot = copyFixture()
  const manifestFile = path.join(manifestRoot, 'plugin', 'manifest.json')
  const manifest = readJson(manifestFile)
  manifest.extra = true
  writeJson(manifestFile, manifest)
  assert.throws(
    () =>
      assembleNative({
        snapshotFile: path.join(manifestRoot, 'snapshot.json'),
        outDir: makeOutDir(),
      }),
    /manifest\.extra: 未知字段/,
  )
})

test('sourceDir 越出快照目录或使用绝对路径时拒绝', () => {
  const root = makeTempDir()
  const snapshotFile = path.join(root, 'snapshot.json')
  const snapshot = {
    schemaVersion: 1,
    plugins: [
      {
        id: PLUGIN_ID,
        version: '1.0.0',
        commit: COMMIT,
        sourceDir: '../outside',
      },
    ],
  }
  writeJson(snapshotFile, snapshot)
  assert.throws(() => loadSnapshot(snapshotFile), /不得越出快照目录/)

  snapshot.plugins[0].sourceDir = FIXTURE_PLUGIN
  writeJson(snapshotFile, snapshot)
  assert.throws(() => loadSnapshot(snapshotFile), /必须是相对路径/)
})

test('sourceDir 为符号链接时拒绝', t => {
  const root = makeTempDir()
  const outside = copyFixture()
  const linkPath = path.join(root, 'plugin-link')
  try {
    linkDir(path.join(outside, 'plugin'), linkPath)
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`当前环境无法创建符号链接（${error.code}）`)
      return
    }
    throw error
  }
  const snapshotFile = path.join(root, 'snapshot.json')
  writeJson(snapshotFile, {
    schemaVersion: 1,
    plugins: [
      {
        id: PLUGIN_ID,
        version: '1.0.0',
        commit: COMMIT,
        sourceDir: './plugin-link',
      },
    ],
  })
  assert.throws(() => loadSnapshot(snapshotFile), /sourceDir: 不允许符号链接/)
})

test('插件包内的符号链接使哈希与组装失败', t => {
  const root = copyFixture()
  const outside = makeTempDir()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside')
  try {
    linkDir(outside, path.join(root, 'plugin', 'linked'))
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`当前环境无法创建符号链接（${error.code}）`)
      return
    }
    throw error
  }

  assert.throws(
    () => computePackageHash(path.join(root, 'plugin')),
    /linked: 不允许符号链接/,
  )
  assert.throws(
    () =>
      assembleNative({
        snapshotFile: path.join(root, 'snapshot.json'),
        outDir: makeOutDir(),
      }),
    /不允许符号链接/,
  )
})

test('清单原生声明不合法时拒绝', () => {
  const packageRoot = copyFixture()
  const packageManifest = path.join(packageRoot, 'plugin', 'manifest.json')
  const manifest = readJson(packageManifest)
  manifest.native.package = '@community-plugins/otherecorder'
  writeJson(packageManifest, manifest)
  assert.throws(
    () =>
      assembleNative({
        snapshotFile: path.join(packageRoot, 'snapshot.json'),
        outDir: makeOutDir(),
      }),
    /与插件标识一致/,
  )

  const permissionRoot = copyFixture()
  const permissionManifest = path.join(
    permissionRoot,
    'plugin',
    'manifest.json',
  )
  const permissionData = readJson(permissionManifest)
  permissionData.native.permissions[0] = {
    name: 'contacts',
    reason: '用于读取联系人',
  }
  writeJson(permissionManifest, permissionData)
  assert.throws(
    () =>
      assembleNative({
        snapshotFile: path.join(permissionRoot, 'snapshot.json'),
        outDir: makeOutDir(),
      }),
    /未知原生权限/,
  )
})

test('零插件快照生成空锁与空注册表', () => {
  const root = makeTempDir()
  const snapshotFile = path.join(root, 'snapshot.json')
  writeJson(snapshotFile, {schemaVersion: 1, plugins: []})
  const out = makeOutDir()
  const result = assembleNative({snapshotFile, outDir: out})

  assert.equal(result.lock.lockVersion, 1)
  assert.deepEqual(result.lock.plugins, [])
  assert.equal(
    result.lock.lockHash,
    `sha256:${sha256(JSON.stringify({lockVersion: 1, plugins: []}))}`,
  )

  const registry = fs.readFileSync(
    path.join(out, GENERATED_DIR, 'native-registry.ts'),
    'utf8',
  )
  assert.match(registry, /NativePluginRegistryEntry\[\] = \[\]/)
  const lockModule = fs.readFileSync(
    path.join(out, GENERATED_DIR, 'native-lock.ts'),
    'utf8',
  )
  assert.match(lockModule, /NativePluginLock \| undefined = undefined/)
  assert.deepEqual(
    readJson(path.join(out, GENERATED_DIR, 'native-config.json')),
    {
      schemaVersion: 1,
      plugins: [],
    },
  )
  const catalog = fs.readFileSync(
    path.join(out, CATALOG_DIR, 'catalog.generated.ts'),
    'utf8',
  )
  assert.match(catalog, /PluginDefinition\[\] = \[\]/)
  assert.deepEqual(result.links, [])
})

test('buildNativeLock 只写锁文件且两次输出一致', () => {
  const outA = makeOutDir()
  const outB = makeOutDir()
  const first = writeNativeLock({snapshotFile: FIXTURE_SNAPSHOT, outDir: outA})
  const second = writeNativeLock({snapshotFile: FIXTURE_SNAPSHOT, outDir: outB})

  assert.deepEqual(collectFiles(outA), [LOCK_FILE])
  assert.deepEqual(collectFiles(outB), [LOCK_FILE])
  assert.equal(first.lock.lockHash, second.lock.lockHash)
  const bytesA = fs.readFileSync(first.lockPath)
  const bytesB = fs.readFileSync(second.lockPath)
  assert.deepEqual(bytesA, bytesB)

  const outC = makeOutDir()
  const assembled = assembleNative({
    snapshotFile: FIXTURE_SNAPSHOT,
    outDir: outC,
  })
  assert.equal(assembled.lock.lockHash, first.lock.lockHash)
  assert.deepEqual(fs.readFileSync(path.join(outC, LOCK_FILE)), bytesA)
})

test('CLI 组装打印文件清单与稳定 lockHash', () => {
  const out = makeOutDir()
  const first = runCli(ASSEMBLE_SCRIPT, [
    '--fixture',
    'native-recorder',
    '--out',
    out,
  ])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /原生插件组装完成/)
  assert.match(
    first.stdout,
    /src\/features\/plugins\/catalog\/com\.example\.nativerecorder\/index\.ts/,
  )
  assert.match(
    first.stdout,
    /node_modules\/@community-plugins\/nativerecorder -> modules\/plugin-nativerecorder/,
  )
  const firstHash = extractLockHash(first.stdout)

  const second = runCli(ASSEMBLE_SCRIPT, [
    '--fixture',
    'native-recorder',
    '--out',
    out,
  ])
  assert.equal(second.status, 0, second.stderr)
  assert.equal(extractLockHash(second.stdout), firstHash)
  assert.equal(findFiles(out, '.postinstall-ran').length, 0)
})

test('CLI build-native-lock 两次输出相同哈希与字节', () => {
  const outA = makeOutDir()
  const outB = makeOutDir()
  const first = runCli(LOCK_SCRIPT, [
    '--fixture',
    'native-recorder',
    '--out',
    outA,
  ])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /原生插件锁已写入/)
  const second = runCli(LOCK_SCRIPT, [
    '--fixture',
    'native-recorder',
    '--out',
    outB,
  ])
  assert.equal(second.status, 0, second.stderr)

  const firstHash = extractLockHash(first.stdout)
  assert.equal(extractLockHash(second.stdout), firstHash)
  const bytesA = fs.readFileSync(path.join(outA, LOCK_FILE))
  const bytesB = fs.readFileSync(path.join(outB, LOCK_FILE))
  assert.equal(sha256(bytesA), sha256(bytesB))
  assert.deepEqual(bytesA, bytesB)
})

test('CLI 参数错误返回非零退出码', () => {
  const missingOut = runCli(ASSEMBLE_SCRIPT, ['--snapshot', FIXTURE_SNAPSHOT])
  assert.equal(missingOut.status, 1)
  assert.match(missingOut.stderr, /--snapshot 必须同时提供 --out/)

  const unknownFlag = runCli(LOCK_SCRIPT, ['--bogus'])
  assert.equal(unknownFlag.status, 1)
  assert.match(unknownFlag.stderr, /未知参数 --bogus/)
})

test('替换指向别处的包链接且拒绝删除真实目录', t => {
  const out = makeOutDir()
  assembleNative({snapshotFile: FIXTURE_SNAPSHOT, outDir: out})
  const linkPath = path.join(
    out,
    'node_modules',
    '@community-plugins',
    'nativerecorder',
  )
  const moduleDir = path.join(out, 'modules', 'plugin-nativerecorder')
  const other = makeTempDir()

  removeDirLink(linkPath)
  try {
    linkDir(other, linkPath)
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`当前环境无法创建符号链接（${error.code}）`)
      return
    }
    throw error
  }
  assembleNative({snapshotFile: FIXTURE_SNAPSHOT, outDir: out})
  assert.equal(fs.realpathSync(linkPath), fs.realpathSync(moduleDir))

  removeDirLink(linkPath)
  fs.mkdirSync(linkPath)
  fs.writeFileSync(path.join(linkPath, 'keep.txt'), 'keep')
  assert.throws(
    () => assembleNative({snapshotFile: FIXTURE_SNAPSHOT, outDir: out}),
    /已存在同名真实文件或目录，拒绝替换/,
  )
  assert.equal(fs.readFileSync(path.join(linkPath, 'keep.txt'), 'utf8'), 'keep')
})

test('拒绝把仓库根目录或其上级作为输出目录', () => {
  assert.throws(
    () =>
      assembleNative({
        snapshotFile: FIXTURE_SNAPSHOT,
        outDir: REPO_ROOT,
      }),
    /不能指向仓库根目录/,
  )
  assert.throws(
    () =>
      assembleNative({
        snapshotFile: FIXTURE_SNAPSHOT,
        outDir: path.dirname(REPO_ROOT),
      }),
    /不能是仓库根目录或它的上级目录/,
  )
})
