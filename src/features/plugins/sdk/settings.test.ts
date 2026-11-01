import {
  isValidPluginSettingValue,
  type PluginSettingIssue,
  resolvePluginSettings,
} from './settings'
import {type PluginSettingField} from './types'

const fields: PluginSettingField[] = [
  {
    key: 'title',
    type: 'string',
    label: '标题',
    description: '显示的标题',
    default: '你好',
    minLength: 2,
    maxLength: 4,
  },
  {
    key: 'count',
    type: 'number',
    label: '数量',
    description: '显示的数量',
    default: 10,
    min: 0,
    max: 100,
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

describe('resolvePluginSettings', () => {
  test('uses manifest defaults when the registry has no values', () => {
    const result = resolvePluginSettings(fields, undefined)
    expect(result.values).toEqual({
      title: '你好',
      count: 10,
      enabled: true,
      mode: 'compact',
    })
    expect(result.issues).toEqual([])
    expect(Object.isFrozen(result.values)).toBe(true)
  })

  test('merges valid registry values by field type', () => {
    const result = resolvePluginSettings(fields, {
      title: '欢迎',
      count: 25,
      enabled: false,
      mode: 'full',
    })
    expect(result.values).toEqual({
      title: '欢迎',
      count: 25,
      enabled: false,
      mode: 'full',
    })
    expect(result.issues).toEqual([])
  })

  test('falls back per field for invalid types and ranges', () => {
    const result = resolvePluginSettings(fields, {
      title: 'x',
      count: 500,
      enabled: 'yes',
      mode: 'unknown',
    })
    expect(result.values).toEqual({
      title: '你好',
      count: 10,
      enabled: true,
      mode: 'compact',
    })
    expect(result.issues).toEqual([
      {key: 'title', reason: 'out-of-range'},
      {key: 'count', reason: 'out-of-range'},
      {key: 'enabled', reason: 'invalid-type'},
      {key: 'mode', reason: 'invalid-option'},
    ] satisfies PluginSettingIssue[])
  })

  test('reports unknown settings without applying them', () => {
    const result = resolvePluginSettings(fields, {
      title: '欢迎',
      unknownKey: 'secret-value',
    })
    expect(result.values.title).toBe('欢迎')
    expect(result.values).not.toHaveProperty('unknownKey')
    expect(result.issues).toEqual([
      {key: 'unknownKey', reason: 'unknown-setting'},
    ])
    expect(JSON.stringify(result.issues)).not.toContain('secret-value')
  })

  test('never includes the rejected value in an issue', () => {
    const secret = 'private-registry-value'
    const result = resolvePluginSettings(fields, {mode: secret})
    expect(result.issues).toEqual([{key: 'mode', reason: 'invalid-option'}])
    expect(JSON.stringify(result.issues)).not.toContain(secret)
  })

  test('does not mutate the registry values object', () => {
    const raw = {count: 50}
    resolvePluginSettings(fields, raw)
    expect(raw).toEqual({count: 50})
  })
})

describe('isValidPluginSettingValue', () => {
  const [title, count, enabled, mode] = fields

  test('validates strings by length', () => {
    expect(isValidPluginSettingValue(title, '你好')).toBe(true)
    expect(isValidPluginSettingValue(title, '你')).toBe(false)
    expect(isValidPluginSettingValue(title, '你好世界啊')).toBe(false)
    expect(isValidPluginSettingValue(title, 5)).toBe(false)
  })

  test('validates numbers by range and finiteness', () => {
    expect(isValidPluginSettingValue(count, 0)).toBe(true)
    expect(isValidPluginSettingValue(count, 100)).toBe(true)
    expect(isValidPluginSettingValue(count, -1)).toBe(false)
    expect(isValidPluginSettingValue(count, 101)).toBe(false)
    expect(isValidPluginSettingValue(count, NaN)).toBe(false)
    expect(isValidPluginSettingValue(count, '10')).toBe(false)
  })

  test('validates booleans and select options', () => {
    expect(isValidPluginSettingValue(enabled, false)).toBe(true)
    expect(isValidPluginSettingValue(enabled, 0)).toBe(false)
    expect(isValidPluginSettingValue(mode, 'full')).toBe(true)
    expect(isValidPluginSettingValue(mode, 'other')).toBe(false)
  })
})
