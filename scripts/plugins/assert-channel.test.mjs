import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, test} from 'node:test'

import {
  assertChannel,
  hasSelfUpdateModule,
  parseModules,
  parsePermissions,
} from './assert-channel.mjs'

const roots = []
const FIXTURES = path.join(
  import.meta.dirname,
  'fixtures',
  'channel-enterprise',
)

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-assert-'))
  roots.push(root)
  return root
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), {recursive: true})
  fs.writeFileSync(target, content, 'utf8')
  return target
}

const CLEAN_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
</manifest>
`

test('解析权限并忽略注释外的普通标签', () => {
  const permissions = parsePermissions(
    '<uses-permission android:name="android.permission.CAMERA"/>\n<uses-permission-sdk-23 android:name="android.permission.READ_MEDIA_IMAGES"/>',
  )
  assert.deepEqual(permissions, [
    'android.permission.CAMERA',
    'android.permission.READ_MEDIA_IMAGES',
  ])
})

test('从 Expo autolinking 结构中提取模块名', () => {
  const modules = parseModules(
    JSON.stringify({
      modules: [
        {packageName: 'expo-modules-core'},
        {packageName: 'app-updater'},
      ],
      dependencies: {'react-native': {}},
    }),
  )
  assert.ok(modules.includes('app-updater'))
  assert.ok(hasSelfUpdateModule(modules))
})

test('商店渠道在干净工程上通过', () => {
  const root = tempRoot()
  const result = assertChannel({
    channel: 'google_play',
    repoRoot: root,
    manifestFile: write(root, 'manifest.xml', CLEAN_MANIFEST),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.reasons, [])
})

test('商店渠道拒绝安装权限', () => {
  const root = tempRoot()
  const result = assertChannel({
    channel: 'china_store',
    repoRoot: root,
    manifestFile: path.join(FIXTURES, 'AndroidManifest.xml'),
    modulesFile: write(root, 'modules.json', '{"modules":[]}'),
  })
  assert.equal(result.ok, false)
  assert.ok(
    result.reasons.some(reason => reason.includes('REQUEST_INSTALL_PACKAGES')),
  )
})

test('商店渠道拒绝自更新模块', () => {
  const root = tempRoot()
  const result = assertChannel({
    channel: 'app_store',
    repoRoot: root,
    manifestFile: write(root, 'manifest.xml', CLEAN_MANIFEST),
    modulesFile: path.join(FIXTURES, 'autolinking.json'),
  })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some(reason => reason.includes('app-updater')))
})

test('企业渠道要求安装权限与自更新模块', () => {
  const result = assertChannel({
    channel: 'enterprise',
    manifestFile: path.join(FIXTURES, 'AndroidManifest.xml'),
    modulesFile: path.join(FIXTURES, 'autolinking.json'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.selfUpdateModule, true)
})

test('企业渠道缺少自更新模块时失败', () => {
  const root = tempRoot()
  const result = assertChannel({
    channel: 'enterprise',
    repoRoot: root,
    manifestFile: path.join(FIXTURES, 'AndroidManifest.xml'),
    modulesFile: write(
      root,
      'modules.json',
      '{"modules":[{"packageName":"expo-modules-core"}]}',
    ),
  })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some(reason => reason.includes('app-updater')))
})

test('开发渠道不做商店断言', () => {
  const result = assertChannel({
    channel: 'development',
    manifestFile: path.join(FIXTURES, 'AndroidManifest.xml'),
    modulesFile: path.join(FIXTURES, 'autolinking.json'),
  })
  assert.equal(result.ok, true)
})

test('未知渠道直接失败', () => {
  const result = assertChannel({channel: 'unknown_store'})
  assert.equal(result.ok, false)
})

test('构建后校验要求存在原生工程', () => {
  const result = assertChannel({
    channel: 'google_play',
    repoRoot: tempRoot(),
    requireManifest: true,
  })
  assert.equal(result.ok, false)
  assert.ok(
    result.reasons.some(reason => reason.includes('AndroidManifest.xml')),
  )
})

test('未生成原生工程时按源码断言且不误报', () => {
  const root = tempRoot()
  write(root, 'modules/plugin-native-recorder/package.json', '{}')
  const result = assertChannel({channel: 'google_play', repoRoot: root})
  assert.equal(result.ok, true)
  assert.equal(result.manifestMissing, true)
})
