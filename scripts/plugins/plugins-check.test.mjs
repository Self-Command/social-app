import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, test} from 'node:test'

import {checkPlugins, LIMITS} from './check.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

const SDK_TYPES = `export const PLUGIN_SCHEMA_VERSION = 2
export const PLUGIN_HOST_API_VERSION = 2
export const PLUGIN_NATIVE_API_VERSION = 1
export const PLUGIN_NATIVE_VIEW_HEIGHT_MODES = ['fixed', 'content'] as const
`

const SLOTS_MODULE = `export const PLUGIN_PLATFORMS: readonly PluginPlatform[] = [
  'ios',
  'android',
  'web',
]
`

const NATIVE_TYPES = `export const NATIVE_PERMISSION_KINDS = [
  'microphone',
  'camera',
  'photoLibrary',
  'notifications',
  'locationWhenInUse',
] as const
`

const SLOT_CATALOG = {
  schemaVersion: 1,
  hostApi: 2,
  groups: [['A', '应用']],
  slots: [
    {id: 'composer.toolbar'},
    {id: 'feed.item.footer'},
    {id: 'settings.main.section'},
  ],
  capabilities: [
    {id: 'feed.read', nativeOnly: false},
    {id: 'composer.insertText', nativeOnly: false},
    {id: 'storage.local', nativeOnly: false},
    {id: 'toast.show', nativeOnly: false},
    {id: 'native.host', nativeOnly: true},
    {id: 'native.permissions', nativeOnly: true},
    {id: 'native.ui', nativeOnly: true},
    {id: 'events.subscribe', nativeOnly: true},
  ],
  hash: `sha256:${'0'.repeat(64)}`,
}

const DEFAULT_SLOT = `import {type PluginSlotProps} from '../../sdk'

export function DemoSlot({context}: PluginSlotProps<'composer.toolbar'>) {
  return null
}
`

function baseManifest(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'com.example.demo',
    name: '演示插件',
    description: '用于检查脚本测试的插件清单。',
    version: '1.0.0',
    hostApi: 2,
    platforms: ['ios', 'android', 'web'],
    slots: [{id: 'composer.toolbar', order: 10}],
    capabilities: ['composer.insertText'],
    settings: [
      {
        key: 'maxItems',
        type: 'number',
        label: '数量上限',
        description: '允许保存的最大条目数。',
        default: 100,
        min: 10,
        max: 500,
      },
    ],
    ...overrides,
  }
}

function nativeManifest(overrides = {}) {
  return baseManifest({
    id: 'com.example.voice',
    capabilities: ['native.host', 'composer.insertText'],
    nativeApi: 1,
    native: {
      package: '@community-plugins/voice',
      modules: ['VoiceModule'],
      views: [{name: 'VoiceRecorderView', heightMode: 'content'}],
      permissions: [{name: 'microphone', reason: '录制语音评论时使用麦克风。'}],
      minAppVersion: '1.0.0',
      network: {outbound: ['https://api.example.com']},
    },
    ...overrides,
  })
}

function defaultIndex(slots = `    'composer.toolbar': DemoSlot,`) {
  return `import {parsePluginManifest, type PluginDefinition} from '../../sdk'
import manifestJson from './manifest.json'
import {DemoSlot} from './DemoSlot'

export const demoManifest = parsePluginManifest(manifestJson)

export const demoPlugin: PluginDefinition = {
  manifest: demoManifest,
  slots: {
${slots}
  },
}
`
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-check-'))
  roots.push(root)
  const write = (relative, contents) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, contents)
    return target
  }
  write('src/features/plugins/sdk/types.ts', SDK_TYPES)
  write('src/features/plugins/catalog/slots.ts', SLOTS_MODULE)
  write('src/features/plugins/native/types.ts', NATIVE_TYPES)
  write(
    'src/features/plugins/catalog/plugin-catalog.generated.json',
    JSON.stringify(SLOT_CATALOG, null, 2),
  )
  return {
    root,
    write,
    addPlugin({
      dir = 'com.example.demo',
      manifest = baseManifest(),
      index = defaultIndex(),
      slot = DEFAULT_SLOT,
    } = {}) {
      write(
        `src/features/plugins/catalog/${dir}/manifest.json`,
        JSON.stringify(manifest, null, 2),
      )
      write(`src/features/plugins/catalog/${dir}/index.ts`, index)
      write(`src/features/plugins/catalog/${dir}/DemoSlot.tsx`, slot)
    },
    catalog(dirs = ['com.example.demo']) {
      const imports = dirs
        .map((dir, index) => `import {plugin${index}} from './${dir}'`)
        .join('\n')
      const plugins = dirs.map((_, index) => `plugin${index}`).join(', ')
      write(
        'src/features/plugins/catalog/index.ts',
        `${imports}\n\nexport const pluginCatalog = [${plugins}] as const\n`,
      )
    },
    check() {
      return checkPlugins({repoRoot: root})
    },
  }
}

test('accepts a valid plugin catalog', () => {
  const project = makeProject()
  project.addPlugin()
  project.catalog()

  const result = project.check()

  assert.deepEqual(result.errors, [])
  assert.equal(result.pluginCount, 1)
  assert.ok(result.fileCount >= 3)
})

test('accepts generated catalog modules in the registry', () => {
  const project = makeProject()
  project.addPlugin()
  project.write(
    'src/features/plugins/catalog/catalog.generated.ts',
    `export const GENERATED_PLUGIN_CATALOG = [] as const\n`,
  )
  project.write(
    'src/features/plugins/catalog/index.ts',
    `import {plugin0} from './com.example.demo'\nimport {GENERATED_PLUGIN_CATALOG} from './catalog.generated'\n\nexport const pluginCatalog = [plugin0, ...GENERATED_PLUGIN_CATALOG] as const\n`,
  )

  const result = project.check()

  assert.deepEqual(result.errors, [])
  assert.equal(result.pluginCount, 1)
})

test('accepts the repository catalog', () => {
  const result = checkPlugins()

  assert.deepEqual(result.errors, [])
  assert.ok(result.pluginCount >= 1)
})

test('rejects duplicate plugin identifiers', () => {
  const project = makeProject()
  project.addPlugin()
  project.addPlugin({
    dir: 'com.example.other',
    manifest: baseManifest({id: 'com.example.demo'}),
  })
  project.catalog(['com.example.demo', 'com.example.other'])

  const result = project.check()

  assert.ok(
    result.errors.some(
      error =>
        error.includes('com.example.other/manifest.json') &&
        error.includes('重复'),
    ),
  )
})

test('rejects unknown slots and capabilities', () => {
  const project = makeProject()
  project.addPlugin({
    manifest: baseManifest({
      slots: [{id: 'composer.unknown', order: 10}],
      capabilities: ['network.fetch'],
    }),
  })
  project.catalog()

  const result = project.check()

  assert.ok(result.errors.some(error => error.includes('未知插槽')))
  assert.ok(result.errors.some(error => error.includes('未知能力')))
})

test('rejects invalid setting definitions', () => {
  const project = makeProject()
  project.addPlugin({
    manifest: baseManifest({
      settings: [
        {
          key: 'maxItems',
          type: 'number',
          label: '数量上限',
          description: '允许保存的最大条目数。',
          default: 5,
          min: 10,
          max: 500,
        },
        {
          key: 'maxItems',
          type: 'boolean',
          label: '重复字段',
          description: '用于验证重复设置键。',
          default: true,
        },
      ],
    }),
  })
  project.catalog()

  const result = project.check()

  assert.ok(
    result.errors.some(
      error => error.includes('default') && error.includes('不在声明范围内'),
    ),
  )
  assert.ok(result.errors.some(error => error.includes('重复')))
})

test('rejects renderers that are not declared in the manifest', () => {
  const project = makeProject()
  project.addPlugin({
    index: defaultIndex(
      `    'composer.toolbar': DemoSlot,\n    'settings.main.section': DemoSlot,`,
    ),
  })
  project.catalog()

  const result = project.check()

  assert.ok(
    result.errors.some(
      error => error.includes('index.ts') && error.includes('未在清单中声明'),
    ),
  )
})

test('rejects declared slots without a renderer', () => {
  const project = makeProject()
  project.addPlugin()
  project.write(
    'src/features/plugins/catalog/com.example.demo/index.ts',
    defaultIndex(''),
  )
  project.catalog()

  const result = project.check()

  assert.ok(
    result.errors.some(
      error => error.includes('缺少插槽') && error.includes('composer.toolbar'),
    ),
  )
})

test('rejects network access and dynamic execution', () => {
  const project = makeProject()
  project.addPlugin()
  project.write(
    'src/features/plugins/catalog/com.example.demo/Network.ts',
    `export const load = () => fetch('/api/plugins')\n`,
  )
  project.write(
    'src/features/plugins/catalog/com.example.demo/Dynamic.ts',
    `export const load = () => import('./Network')\n`,
  )
  project.catalog()

  const result = project.check()

  assert.ok(
    result.errors.some(
      error => error.includes('Network.ts') && error.includes('禁止网络'),
    ),
  )
  assert.ok(
    result.errors.some(
      error => error.includes('Dynamic.ts') && error.includes('禁止动态执行'),
    ),
  )
})

test('rejects restricted imports', () => {
  const project = makeProject()
  project.addPlugin()
  project.write(
    'src/features/plugins/catalog/com.example.demo/Imports.ts',
    `import {useSession} from '#/state/session'\n\nexport const session = useSession\n`,
  )
  project.catalog()

  const result = project.check()

  assert.ok(
    result.errors.some(
      error =>
        error.includes('Imports.ts') &&
        error.includes('受限导入') &&
        error.includes('#/state/session'),
    ),
  )
})

test('rejects oversized source files', () => {
  const project = makeProject()
  project.addPlugin()
  project.write(
    'src/features/plugins/catalog/com.example.demo/Big.ts',
    `export const big = '${'x'.repeat(LIMITS.sourceFileBytes)}'\n`,
  )
  project.catalog()

  const result = project.check()

  assert.ok(
    result.errors.some(
      error => error.includes('Big.ts') && error.includes('文件大小'),
    ),
  )
})

test('rejects plugins that are not registered in the catalog', () => {
  const project = makeProject()
  project.addPlugin()
  project.write(
    'src/features/plugins/catalog/index.ts',
    `export const pluginCatalog = [] as const\n`,
  )

  const result = project.check()

  assert.ok(result.errors.some(error => error.includes('未在注册文件中导入')))
})

test('rejects imports of missing plugin directories', () => {
  const project = makeProject()
  project.addPlugin()
  project.write(
    'src/features/plugins/catalog/index.ts',
    `import {missing} from './com.example.missing'\n\nexport const pluginCatalog = [missing] as const\n`,
  )

  const result = project.check()

  assert.ok(
    result.errors.some(error => error.includes('引用了不存在的插件目录')),
  )
})

test('rejects a plugin folder without a manifest', () => {
  const project = makeProject()
  project.write(
    'src/features/plugins/catalog/com.example.demo/index.ts',
    defaultIndex(),
  )
  project.catalog()

  const result = project.check()

  assert.ok(result.errors.some(error => error.includes('缺少 manifest.json')))
})

test('accepts a native plugin with declared permissions and network', () => {
  const project = makeProject()
  project.addPlugin({dir: 'com.example.voice', manifest: nativeManifest()})
  project.write(
    'src/features/plugins/catalog/com.example.voice/Voice.ts',
    `export const endpoint = 'https://api.example.com/v1/voice'\nexport const audio = 'RECORD_AUDIO'\n`,
  )
  project.catalog(['com.example.voice'])

  const result = project.check()

  assert.deepEqual(result.errors, [])
})

test('rejects binaries and precompiled dynamic libraries', () => {
  const project = makeProject()
  project.addPlugin({dir: 'com.example.voice', manifest: nativeManifest()})
  project.write(
    'src/features/plugins/catalog/com.example.voice/libvoice.so',
    Buffer.from([0, 1, 2, 3]),
  )
  project.write(
    'src/features/plugins/catalog/com.example.voice/Frameworks/Voice.framework/Voice',
    Buffer.from([0, 1, 2, 3]),
  )
  project.catalog(['com.example.voice'])

  const result = project.check()

  assert.ok(
    result.errors.some(
      error => error.includes('libvoice.so') && error.includes('二进制'),
    ),
  )
  assert.ok(
    result.errors.some(
      error => error.includes('Voice.framework') && error.includes('二进制'),
    ),
  )
})

test('rejects reflection loading and concatenated class names', () => {
  const project = makeProject()
  project.addPlugin({dir: 'com.example.voice', manifest: nativeManifest()})
  project.write(
    'src/features/plugins/catalog/com.example.voice/Native.ts',
    `import {NativeModules} from 'react-native'\nexport const voice = NativeModules\n`,
  )
  project.write(
    'src/features/plugins/catalog/com.example.voice/Dynamic.ts',
    `const name = 'Voice' + 'Module'\nexport const module = globalThis[name]\n`,
  )
  project.catalog(['com.example.voice'])

  const result = project.check()

  assert.ok(
    result.errors.some(
      error =>
        error.includes('Native.ts') && error.includes('反射加载原生模块'),
    ),
  )
  assert.ok(
    result.errors.some(
      error =>
        error.includes('Dynamic.ts') && error.includes('字符串拼接的类名'),
    ),
  )
})

test('rejects downloads of executable code', () => {
  const project = makeProject()
  project.addPlugin({dir: 'com.example.voice', manifest: nativeManifest()})
  project.write(
    'src/features/plugins/catalog/com.example.voice/Remote.ts',
    `export const runtime = 'https://cdn.example.com/runtime.js'\n`,
  )
  project.catalog(['com.example.voice'])

  const result = project.check()

  assert.ok(result.errors.some(error => error.includes('禁止下载可执行代码')))
})

test('rejects permissions and origins that are not declared', () => {
  const project = makeProject()
  const manifest = nativeManifest()
  manifest.native.permissions = []
  project.addPlugin({dir: 'com.example.voice', manifest})
  project.write(
    'src/features/plugins/catalog/com.example.voice/Recorder.ts',
    `export const audio = 'RECORD_AUDIO'\nexport const upload = 'https://collector.example.net/upload'\nexport const insecure = 'http://api.example.com/v1'\n`,
  )
  project.catalog(['com.example.voice'])

  const result = project.check()

  assert.ok(
    result.errors.some(
      error =>
        error.includes('未声明的原生权限') && error.includes('microphone'),
    ),
  )
  assert.ok(
    result.errors.some(
      error =>
        error.includes('未声明网络来源') &&
        error.includes('https://collector.example.net'),
    ),
  )
  assert.ok(result.errors.some(error => error.includes('禁止非 HTTPS')))
})

test('validates native api, package, views and versions', () => {
  const project = makeProject()
  project.addPlugin({
    dir: 'com.example.voice',
    manifest: nativeManifest({nativeApi: 2}),
  })
  project.catalog(['com.example.voice'])
  assert.ok(
    project.check().errors.some(error => error.includes('nativeApi: 期望 1')),
  )

  const projectTwo = makeProject()
  projectTwo.addPlugin({
    dir: 'com.example.voice',
    manifest: nativeManifest({
      native: {
        package: 'voice',
        modules: [],
        views: [
          {name: 'Bad View', heightMode: 'content'},
          {name: 'Recorder', heightMode: 'auto'},
        ],
        permissions: [{name: 'sms', reason: '发送短信通知用户。'}],
        minAppVersion: '1.0',
        network: {outbound: ['http://api.example.com/path']},
      },
    }),
  })
  projectTwo.catalog(['com.example.voice'])
  const errors = projectTwo.check().errors
  assert.ok(errors.some(error => error.includes('native.package')))
  assert.ok(errors.some(error => error.includes('native.modules')))
  assert.ok(errors.some(error => error.includes('native.views[0].name')))
  assert.ok(errors.some(error => error.includes('native.views[1].heightMode')))
  assert.ok(errors.some(error => error.includes('native.permissions[0].name')))
  assert.ok(errors.some(error => error.includes('native.minAppVersion')))
  assert.ok(errors.some(error => error.includes('native.network.outbound[0]')))
})

test('requires the native block and native capabilities to pair up', () => {
  const project = makeProject()
  project.addPlugin({
    manifest: baseManifest({capabilities: ['native.host']}),
  })
  project.catalog()
  assert.ok(
    project
      .check()
      .errors.some(error => error.includes('仅在声明 native 块时可用')),
  )

  const projectTwo = makeProject()
  projectTwo.addPlugin({manifest: baseManifest({nativeApi: 1})})
  projectTwo.catalog()
  assert.ok(
    projectTwo
      .check()
      .errors.some(error => error.includes('必须与 native 块同时声明')),
  )
})
