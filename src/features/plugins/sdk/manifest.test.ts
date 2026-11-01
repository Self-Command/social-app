import {
  isPluginCapability,
  isPluginId,
  isPluginPlatform,
  isPluginSlotId,
  isPluginVersion,
  parsePluginManifest,
  PluginManifestError,
  validatePluginDefinition,
  validatePluginDefinitions,
  validatePluginManifest,
} from './manifest'
import {type PluginDefinition, type PluginManifest} from './types'

const validSettings = [
  {
    key: 'title',
    type: 'string',
    label: '标题',
    description: '显示的标题',
    default: '你好',
    minLength: 1,
    maxLength: 10,
  },
  {
    key: 'count',
    type: 'number',
    label: '数量',
    description: '显示的数量',
    default: 5,
    min: 0,
    max: 10,
  },
  {
    key: 'enabled',
    type: 'boolean',
    label: '启用',
    description: '是否启用',
    default: true,
  },
  {
    key: 'mode',
    type: 'select',
    label: '模式',
    description: '显示模式',
    default: 'compact',
    options: ['compact', 'full'],
  },
]

function rawManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'com.example.demo',
    name: '示例插件',
    description: '用于验证清单契约的示例插件。',
    version: '1.0.0',
    hostApi: 2,
    platforms: ['ios', 'android', 'web'],
    slots: [{id: 'feed.item.footer', order: 10}],
    capabilities: ['feed.read'],
    settings: validSettings,
    ...overrides,
  }
}

const validNativeBlock = {
  package: '@community-plugins/demo',
  modules: ['DemoModule'],
  views: [
    {name: 'DemoView', heightMode: 'content'},
    {name: 'DemoPanel', heightMode: 'fixed'},
  ],
  permissions: [{name: 'microphone', reason: '录制语音评论需要访问麦克风。'}],
  minAppVersion: '2.0.0',
  network: {outbound: []},
}

function rawNativeManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return rawManifest({
    capabilities: ['feed.read', 'native.host', 'native.ui'],
    nativeApi: 1,
    native: validNativeBlock,
    ...overrides,
  })
}

function expectValidManifest(value: unknown = rawManifest()): PluginManifest {
  const result = validatePluginManifest(value)
  if (!result.ok) {
    throw new Error(`expected valid manifest: ${result.errors.join(', ')}`)
  }
  return result.manifest
}

function expectInvalid(value: unknown, fragment?: string) {
  const result = validatePluginManifest(value)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThan(0)
    if (fragment) {
      expect(result.errors.join('\n')).toContain(fragment)
    }
  }
}

function DemoComponent() {
  return null
}

describe('validatePluginManifest', () => {
  test('accepts a complete manifest and keeps all fields', () => {
    const manifest = expectValidManifest()
    expect(manifest.id).toBe('com.example.demo')
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.hostApi).toBe(2)
    expect(manifest.nativeApi).toBeUndefined()
    expect(manifest.native).toBeUndefined()
    expect(manifest.platforms).toEqual(['ios', 'android', 'web'])
    expect(manifest.slots).toEqual([{id: 'feed.item.footer', order: 10}])
    expect(manifest.capabilities).toEqual(['feed.read'])
    expect(manifest.settings).toHaveLength(4)
    expect(manifest.settings[0]).toMatchObject({
      key: 'title',
      type: 'string',
      default: '你好',
    })
  })

  test('rejects unknown fields instead of forwarding them', () => {
    expectInvalid(rawManifest({extra: true}), 'manifest.extra')
    expectInvalid(
      rawManifest({
        slots: [{id: 'feed.item.footer', order: 1, extra: true}],
      }),
      'slots[0].extra',
    )
    expectInvalid(
      rawManifest({
        settings: [{...validSettings[2], extra: true}],
      }),
      'settings[0].extra',
    )
  })

  test('rejects unsupported schema and host API versions', () => {
    expectInvalid(rawManifest({schemaVersion: 1}), 'schemaVersion')
    expectInvalid(rawManifest({hostApi: 1}), 'hostApi')
  })

  test('rejects malformed identity and text fields', () => {
    expectInvalid(rawManifest({id: 'Demo'}), 'id')
    expectInvalid(rawManifest({id: 'com'}), 'id')
    expectInvalid(rawManifest({name: ''}), 'name')
    expectInvalid(rawManifest({name: 'x'.repeat(41)}), 'name')
    expectInvalid(rawManifest({description: ''}), 'description')
    expectInvalid(rawManifest({description: 'x'.repeat(201)}), 'description')
    expectInvalid(rawManifest({version: '1.0'}), 'version')
  })

  test('rejects empty, unknown and duplicate platforms', () => {
    expectInvalid(rawManifest({platforms: []}), 'platforms')
    expectInvalid(rawManifest({platforms: ['ios', 'linux']}), 'platforms[1]')
    expectInvalid(
      rawManifest({platforms: ['ios', 'ios']}),
      'duplicate platform',
    )
  })

  test('rejects unknown, duplicate and malformed slot declarations', () => {
    expectInvalid(rawManifest({slots: []}), 'slots')
    expectInvalid(
      rawManifest({slots: [{id: 'unknown.slot', order: 1}]}),
      'slots[0].id',
    )
    expectInvalid(
      rawManifest({
        slots: [
          {id: 'feed.item.footer', order: 1},
          {id: 'feed.item.footer', order: 2},
        ],
      }),
      'duplicate slot',
    )
    expectInvalid(
      rawManifest({slots: [{id: 'feed.item.footer', order: -1}]}),
      'order',
    )
    expectInvalid(
      rawManifest({slots: [{id: 'feed.item.footer', order: 1.5}]}),
      'order',
    )
    expectInvalid(
      rawManifest({slots: [{id: 'feed.item.footer', order: 1000}]}),
      'order',
    )
  })

  test('rejects unknown and duplicate capabilities', () => {
    expectInvalid(
      rawManifest({capabilities: ['feed.read', 'network']}),
      'capabilities[1]',
    )
    expectInvalid(
      rawManifest({capabilities: ['feed.read', 'feed.read']}),
      'duplicate capability',
    )
  })

  test('rejects malformed string setting definitions', () => {
    expectInvalid(
      rawManifest({
        settings: [{...validSettings[0], minLength: 5, maxLength: 2}],
      }),
      'minLength',
    )
    expectInvalid(
      rawManifest({
        settings: [{...validSettings[0], default: 'x'.repeat(20)}],
      }),
      'outside the declared length range',
    )
    expectInvalid(
      rawManifest({
        settings: [{...validSettings[0], default: 5}],
      }),
      'expected string',
    )
  })

  test('rejects malformed number setting definitions', () => {
    expectInvalid(
      rawManifest({settings: [{...validSettings[1], min: 10, max: 1}]}),
      'min',
    )
    expectInvalid(
      rawManifest({settings: [{...validSettings[1], default: 11}]}),
      'outside the declared range',
    )
    expectInvalid(
      rawManifest({settings: [{...validSettings[1], default: Infinity}]}),
      'finite number',
    )
    expectInvalid(
      rawManifest({settings: [{...validSettings[1], min: NaN}]}),
      'finite number',
    )
  })

  test('rejects malformed boolean and select setting definitions', () => {
    expectInvalid(
      rawManifest({settings: [{...validSettings[2], default: 'yes'}]}),
      'expected boolean',
    )
    expectInvalid(
      rawManifest({
        settings: [{...validSettings[3], options: []}],
      }),
      'options',
    )
    expectInvalid(
      rawManifest({
        settings: [{...validSettings[3], options: ['a', 'a']}],
      }),
      'duplicate option',
    )
    expectInvalid(
      rawManifest({
        settings: [{...validSettings[3], default: 'missing'}],
      }),
      'declared options',
    )
    expectInvalid(
      rawManifest({
        settings: [
          {type: 'object', key: 'x', label: 'x', description: 'x', default: {}},
        ],
      }),
      'unknown setting type',
    )
  })

  test('rejects duplicate and invalid setting keys', () => {
    expectInvalid(
      rawManifest({
        settings: [validSettings[2], {...validSettings[3], key: 'enabled'}],
      }),
      'duplicate setting',
    )
    expectInvalid(
      rawManifest({settings: [{...validSettings[2], key: '1invalid'}]}),
      'setting identifier',
    )
  })
})

describe('native manifest', () => {
  test('accepts a native plugin manifest and keeps the native block', () => {
    const manifest = expectValidManifest(rawNativeManifest())
    expect(manifest.nativeApi).toBe(1)
    expect(manifest.native).toEqual(validNativeBlock)
  })

  test('requires nativeApi and native to be declared together', () => {
    expectInvalid(rawManifest({native: validNativeBlock}), 'nativeApi')
    expectInvalid(rawManifest({nativeApi: 1}), 'nativeApi')
    expectInvalid(rawNativeManifest({nativeApi: 2}), 'nativeApi')
  })

  test('requires a native block for native capabilities', () => {
    expectInvalid(
      rawManifest({capabilities: ['feed.read', 'native.host']}),
      'requires a native block',
    )
  })

  test('rejects unknown fields inside native declarations', () => {
    expectInvalid(
      rawNativeManifest({native: {...validNativeBlock, extra: true}}),
      'native.extra',
    )
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          views: [{name: 'DemoView', heightMode: 'content', extra: true}],
        },
      }),
      'native.views[0].extra',
    )
    expectInvalid(
      rawNativeManifest({
        native: {...validNativeBlock, network: {outbound: [], extra: true}},
      }),
      'native.network.extra',
    )
  })

  test('rejects duplicate modules and views', () => {
    expectInvalid(
      rawNativeManifest({
        native: {...validNativeBlock, modules: ['DemoModule', 'DemoModule']},
      }),
      'duplicate module',
    )
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          views: [
            {name: 'DemoView', heightMode: 'content'},
            {name: 'DemoView', heightMode: 'fixed'},
          ],
        },
      }),
      'duplicate view',
    )
  })

  test('rejects illegal permissions and non-Chinese reasons', () => {
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          permissions: [{name: 'sms', reason: '用于短信验证。'}],
        },
      }),
      'unknown native permission',
    )
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          permissions: [{name: 'microphone', reason: 'microphone access'}],
        },
      }),
      'Chinese explanation',
    )
  })

  test('requires the community package prefix and a matching slug', () => {
    expectInvalid(
      rawNativeManifest({
        native: {...validNativeBlock, package: '@other/demo'},
      }),
      'native.package',
    )
    expectInvalid(
      rawNativeManifest({
        native: {...validNativeBlock, package: '@community-plugins/other'},
      }),
      'plugin id',
    )
  })

  test('rejects invalid view modes, versions and network origins', () => {
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          views: [{name: 'DemoView', heightMode: 'auto'}],
        },
      }),
      'heightMode',
    )
    expectInvalid(
      rawNativeManifest({
        native: {...validNativeBlock, minAppVersion: '2.0'},
      }),
      'minAppVersion',
    )
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          network: {outbound: ['http://api.example.com']},
        },
      }),
      'HTTPS',
    )
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          network: {outbound: ['https://api.example.com/path']},
        },
      }),
      'origin without path',
    )
    expectInvalid(
      rawNativeManifest({
        native: {
          ...validNativeBlock,
          network: {outbound: ['https://user:pass@api.example.com']},
        },
      }),
      'credentials',
    )
  })

  test('treats settings as optional', () => {
    const manifest = rawManifest()
    delete manifest.settings
    expect(expectValidManifest(manifest).settings).toEqual([])
  })
})

describe('parsePluginManifest', () => {
  test('throws PluginManifestError with issues', () => {
    expect(() => parsePluginManifest(rawManifest({hostApi: 9}))).toThrow(
      PluginManifestError,
    )
    try {
      parsePluginManifest(rawManifest({hostApi: 9}))
    } catch (error) {
      expect(error).toBeInstanceOf(PluginManifestError)
      expect((error as PluginManifestError).issues.join('\n')).toContain(
        'hostApi',
      )
    }
  })
})

describe('validatePluginDefinition', () => {
  function makeDefinition(
    slots: Record<string, unknown> = {'feed.item.footer': DemoComponent},
    manifest: unknown = rawManifest(),
  ): unknown {
    return {manifest, slots}
  }

  test('accepts a definition with one renderer per declared slot', () => {
    const result = validatePluginDefinition(makeDefinition())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.definition.slots['feed.item.footer']).toBe(DemoComponent)
    }
  })

  test('rejects missing renderers for declared slots', () => {
    const result = validatePluginDefinition(makeDefinition({}))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('missing renderer')
    }
  })

  test('rejects renderers for undeclared and unknown slots', () => {
    const undeclared = validatePluginDefinition(
      makeDefinition({
        'feed.item.footer': DemoComponent,
        'composer.toolbar': DemoComponent,
      }),
    )
    expect(undeclared.ok).toBe(false)

    const unknown = validatePluginDefinition(
      makeDefinition({
        'feed.item.footer': DemoComponent,
        'unknown.slot': DemoComponent,
      }),
    )
    expect(unknown.ok).toBe(false)
  })

  test('rejects non-component renderers and malformed manifests', () => {
    const nonComponent = validatePluginDefinition(
      makeDefinition({'feed.item.footer': 42}),
    )
    expect(nonComponent.ok).toBe(false)

    const badManifest = validatePluginDefinition(
      makeDefinition(
        {'feed.item.footer': DemoComponent},
        rawManifest({id: 'x'}),
      ),
    )
    expect(badManifest.ok).toBe(false)
  })
})

describe('validatePluginDefinitions', () => {
  function definition(id: string): PluginDefinition {
    return {
      manifest: expectValidManifest(rawManifest({id})),
      slots: {'feed.item.footer': DemoComponent},
    }
  }

  test('accepts unique definitions', () => {
    const result = validatePluginDefinitions([
      definition('com.example.one'),
      definition('com.example.two'),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.definitions.map(d => d.manifest.id)).toEqual([
        'com.example.one',
        'com.example.two',
      ])
    }
  })

  test('rejects duplicate plugin ids', () => {
    const result = validatePluginDefinitions([
      definition('com.example.one'),
      definition('com.example.one'),
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('duplicate plugin')
    }
  })
})

describe('type guards', () => {
  test('recognize contract values only', () => {
    expect(isPluginId('com.example.demo')).toBe(true)
    expect(isPluginId('com')).toBe(false)
    expect(isPluginPlatform('ios')).toBe(true)
    expect(isPluginPlatform('desktop')).toBe(false)
    expect(isPluginSlotId('settings.main.section')).toBe(true)
    expect(isPluginSlotId('app.drawer.section')).toBe(true)
    expect(isPluginSlotId('settings')).toBe(false)
    expect(isPluginCapability('toast.show')).toBe(true)
    expect(isPluginCapability('native.host')).toBe(true)
    expect(isPluginCapability('network')).toBe(false)
    expect(isPluginVersion('1.2.3-beta.1+build')).toBe(true)
    expect(isPluginVersion('v1')).toBe(false)
  })
})
