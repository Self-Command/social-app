import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {after, afterEach, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import withNativePlugins from '../../plugins/with-native-plugins.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const GENERATED_DIR = path.join(REPO_ROOT, 'src/features/plugins/generated')
const CONFIG_FILE = path.join(GENERATED_DIR, 'native-config.json')
const GENERATED_DIR_EXISTED = fs.existsSync(GENERATED_DIR)
const PACKAGE_LINK = path.join(
  REPO_ROOT,
  'node_modules/@community-plugins/nativerecorder',
)
const PACKAGE_LINK_EXISTED = fs.existsSync(PACKAGE_LINK)

const MICROPHONE_REASON = '用于录制语音评论'
const CAMERA_REASON = '用于拍摄照片'

function writeNativeConfig(value) {
  fs.mkdirSync(GENERATED_DIR, {recursive: true})
  fs.writeFileSync(
    CONFIG_FILE,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  )
}

function removeNativeConfig() {
  fs.rmSync(CONFIG_FILE, {force: true})
}

function configDocument(plugins) {
  return {schemaVersion: 1, plugins}
}

function pluginEntry(overrides = {}) {
  return {
    id: 'com.example.nativerecorder',
    package: '@community-plugins/nativerecorder',
    modules: ['NativeRecorder'],
    views: [{name: 'RecorderView', heightMode: 'content'}],
    permissions: [{name: 'microphone', reason: MICROPHONE_REASON}],
    ...overrides,
  }
}

function emptyConfig() {
  return {name: 'Bluesky', android: {}, ios: {infoPlist: {}}}
}

afterEach(() => {
  removeNativeConfig()
})

after(() => {
  if (!GENERATED_DIR_EXISTED) {
    fs.rmSync(GENERATED_DIR, {recursive: true, force: true})
  }
  if (!PACKAGE_LINK_EXISTED) {
    fs.rmSync(PACKAGE_LINK, {force: true})
    fs.rmSync(path.dirname(PACKAGE_LINK), {recursive: true, force: true})
  }
})

test('未生成配置时原样返回 config', () => {
  removeNativeConfig()
  const config = emptyConfig()
  assert.equal(withNativePlugins(config), config)
})

test('合并合法配置并对 Android 权限去重', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry(),
      pluginEntry({
        id: 'com.example.voicecomment',
        package: '@community-plugins/voicecomment',
        modules: ['VoiceComment'],
      }),
    ]),
  )

  const config = {
    name: 'Bluesky',
    android: {
      permissions: [
        'android.permission.INTERNET',
        'android.permission.RECORD_AUDIO',
      ],
    },
    ios: {infoPlist: {CFBundleSpokenName: 'Blue Sky'}},
  }
  const next = withNativePlugins(config)

  assert.notEqual(next, config)
  assert.deepEqual(next.android.permissions, [
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
  ])
  assert.equal(
    next.ios.infoPlist.NSMicrophoneUsageDescription,
    MICROPHONE_REASON,
  )
  assert.equal(next.ios.infoPlist.CFBundleSpokenName, 'Blue Sky')
  assert.deepEqual(config.ios.infoPlist, {CFBundleSpokenName: 'Blue Sky'})
})

test('按固定顺序映射五种原生权限', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry({
        permissions: [
          {name: 'microphone', reason: MICROPHONE_REASON},
          {name: 'camera', reason: CAMERA_REASON},
          {name: 'photoLibrary', reason: '用于选择照片'},
          {name: 'notifications', reason: '用于接收提醒'},
          {name: 'locationWhenInUse', reason: '用于显示附近内容'},
        ],
      }),
    ]),
  )

  const next = withNativePlugins(emptyConfig())

  assert.deepEqual(next.android.permissions, [
    'android.permission.RECORD_AUDIO',
    'android.permission.CAMERA',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
  ])
  assert.deepEqual(Object.keys(next.ios.infoPlist), [
    'NSMicrophoneUsageDescription',
    'NSCameraUsageDescription',
    'NSPhotoLibraryUsageDescription',
    'NSLocationWhenInUseUsageDescription',
  ])
})

test('跨插件相同权限与相同文案允许合并', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry({
        permissions: [{name: 'camera', reason: CAMERA_REASON}],
      }),
      pluginEntry({
        id: 'com.example.voicecomment',
        package: '@community-plugins/voicecomment',
        permissions: [{name: 'camera', reason: CAMERA_REASON}],
      }),
    ]),
  )

  const next = withNativePlugins(emptyConfig())

  assert.deepEqual(next.android.permissions, ['android.permission.CAMERA'])
  assert.equal(next.ios.infoPlist.NSCameraUsageDescription, CAMERA_REASON)
})

test('跨插件相同权限文案不一致时失败', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry({
        permissions: [{name: 'microphone', reason: '用于录制语音评论'}],
      }),
      pluginEntry({
        id: 'com.example.voicecomment',
        package: '@community-plugins/voicecomment',
        permissions: [{name: 'microphone', reason: '用于发送语音消息'}],
      }),
    ]),
  )

  assert.throws(
    () => withNativePlugins(emptyConfig()),
    /权限 "microphone" 的用途文案与插件 "com\.example\.nativerecorder" 不一致/,
  )
})

test('空用途文案使构建失败', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry({
        permissions: [{name: 'microphone', reason: '   '}],
      }),
    ]),
  )

  assert.throws(
    () => withNativePlugins(emptyConfig()),
    /plugins\[0\]\.permissions\[0\]\.reason: 用途文案不能为空/,
  )
})

test('非中文用途文案使构建失败', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry({
        permissions: [{name: 'microphone', reason: 'record voice'}],
      }),
    ]),
  )

  assert.throws(() => withNativePlugins(emptyConfig()), /用途文案必须包含中文/)
})

test('未知原生权限使构建失败', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry({
        permissions: [{name: 'contacts', reason: '用于读取联系人'}],
      }),
    ]),
  )

  assert.throws(() => withNativePlugins(emptyConfig()), /未知原生权限/)
})

test('同一插件重复声明权限使构建失败', () => {
  writeNativeConfig(
    configDocument([
      pluginEntry({
        permissions: [
          {name: 'microphone', reason: MICROPHONE_REASON},
          {name: 'microphone', reason: MICROPHONE_REASON},
        ],
      }),
    ]),
  )

  assert.throws(
    () => withNativePlugins(emptyConfig()),
    /权限 "microphone" 重复/,
  )
})

test('未知字段使构建失败', () => {
  writeNativeConfig(configDocument([pluginEntry({unknownField: true})]))

  assert.throws(
    () => withNativePlugins(emptyConfig()),
    /plugins\[0\]\.unknownField: 未知字段/,
  )
})

test('schemaVersion 不是 1 时失败', () => {
  writeNativeConfig({schemaVersion: 2, plugins: []})

  assert.throws(() => withNativePlugins(emptyConfig()), /schemaVersion: 期望 1/)
})

test('非法 JSON 使构建失败', () => {
  writeNativeConfig('{"schemaVersion": 1,')

  assert.throws(() => withNativePlugins(emptyConfig()), /不是合法 JSON/)
})

test('宿主已有不同用途文案时失败', () => {
  writeNativeConfig(configDocument([pluginEntry()]))

  const config = {
    name: 'Bluesky',
    android: {},
    ios: {infoPlist: {NSMicrophoneUsageDescription: '宿主已有文案'}},
  }

  assert.throws(
    () => withNativePlugins(config),
    /ios\.infoPlist\.NSMicrophoneUsageDescription: 插件 "com\.example\.nativerecorder" 的用途文案与宿主已有文案不一致/,
  )
})

test('移除宿主对插件权限的移除指令并补齐权限', async () => {
  writeNativeConfig(configDocument([pluginEntry()]))
  const config = {
    ...emptyConfig(),
    mods: {
      android: {manifest: input => input},
      ios: {infoPlist: input => input},
    },
  }
  const next = withNativePlugins(config)
  const result = await next.mods.android.manifest({
    modResults: {
      manifest: {
        'uses-permission': [
          {
            $: {
              'android:name': 'android.permission.RECORD_AUDIO',
              'tools:node': 'remove',
            },
          },
          {$: {'android:name': 'android.permission.INTERNET'}},
        ],
      },
    },
  })

  assert.deepEqual(result.modResults.manifest['uses-permission'], [
    {$: {'android:name': 'android.permission.INTERNET'}},
    {$: {'android:name': 'android.permission.RECORD_AUDIO'}},
  ])
})

test('Info.plist 被宿主移除后重新写入插件用途文案', async () => {
  writeNativeConfig(configDocument([pluginEntry()]))
  const config = {
    ...emptyConfig(),
    mods: {
      android: {manifest: input => input},
      ios: {infoPlist: input => input},
    },
  }
  const next = withNativePlugins(config)
  const result = await next.mods.ios.infoPlist({
    modResults: {CFBundleName: 'Bluesky'},
  })

  assert.equal(
    result.modResults.NSMicrophoneUsageDescription,
    MICROPHONE_REASON,
  )
  assert.equal(result.modResults.CFBundleName, 'Bluesky')
})

test('不修改传入的 config 对象', () => {
  writeNativeConfig(configDocument([pluginEntry()]))

  const config = {
    name: 'Bluesky',
    android: {permissions: ['android.permission.INTERNET']},
    ios: {infoPlist: {CFBundleSpokenName: 'Blue Sky'}},
  }
  const snapshot = JSON.parse(JSON.stringify(config))

  const next = withNativePlugins(config)

  assert.deepEqual(config, snapshot)
  assert.notEqual(next, config)
  assert.notEqual(next.android, config.android)
  assert.notEqual(next.ios.infoPlist, config.ios.infoPlist)
})

test('按生成配置重建原生包链接且可重复执行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-links-'))
  const moduleDir = path.join(root, 'modules/plugin-demo')
  fs.mkdirSync(moduleDir, {recursive: true})
  const config = configDocument([
    pluginEntry({
      id: 'com.example.demo',
      package: '@community-plugins/demo',
      permissions: [],
    }),
  ])

  withNativePlugins.ensureNativePackageLinks(config, root)
  const link = path.join(root, 'node_modules/@community-plugins/demo')
  const same = (left, right) =>
    process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
  assert.equal(same(fs.realpathSync(link), fs.realpathSync(moduleDir)), true)

  withNativePlugins.ensureNativePackageLinks(config, root)
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)

  fs.rmSync(root, {recursive: true, force: true})
})

test('包链接位置被真实目录占用时失败', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-links-'))
  fs.mkdirSync(path.join(root, 'modules/plugin-demo'), {recursive: true})
  fs.mkdirSync(path.join(root, 'node_modules/@community-plugins/demo'), {
    recursive: true,
  })
  const config = configDocument([
    pluginEntry({
      id: 'com.example.demo',
      package: '@community-plugins/demo',
      permissions: [],
    }),
  ])

  assert.throws(
    () => withNativePlugins.ensureNativePackageLinks(config, root),
    /已存在同名真实目录，拒绝替换/,
  )

  fs.rmSync(root, {recursive: true, force: true})
})
