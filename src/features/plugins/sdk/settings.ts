import {
  type PluginSettingField,
  type PluginSettingsValues,
  type PluginSettingValue,
} from './types'

/**
 * Why a registry-provided setting value was not applied. Deliberately contains
 * no values so issues can be logged without exposing user or admin data.
 */
export type PluginSettingIssue = {
  key: string
  reason: 'unknown-setting' | 'invalid-type' | 'out-of-range' | 'invalid-option'
}

export type ResolvedPluginSettings = {
  values: PluginSettingsValues
  issues: PluginSettingIssue[]
}

export function isValidPluginSettingValue(
  field: PluginSettingField,
  value: unknown,
): value is PluginSettingValue {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return false
      if (field.minLength !== undefined && value.length < field.minLength) {
        return false
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return false
      }
      return true
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false
      if (field.min !== undefined && value < field.min) return false
      if (field.max !== undefined && value > field.max) return false
      return true
    case 'boolean':
      return typeof value === 'boolean'
    case 'select':
      return typeof value === 'string' && field.options.includes(value)
  }
}

function invalidReason(
  field: PluginSettingField,
  value: unknown,
): PluginSettingIssue['reason'] {
  switch (field.type) {
    case 'string':
      return typeof value === 'string' ? 'out-of-range' : 'invalid-type'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? 'out-of-range'
        : 'invalid-type'
    case 'boolean':
      return 'invalid-type'
    case 'select':
      return typeof value === 'string' ? 'invalid-option' : 'invalid-type'
  }
}

/**
 * Merges the manifest defaults with registry-provided values. Every invalid or
 * unknown value falls back to the manifest default and is reported as an issue
 * without the offending value.
 */
export function resolvePluginSettings(
  fields: readonly PluginSettingField[],
  raw: Record<string, unknown> | undefined,
): ResolvedPluginSettings {
  const values: Record<string, PluginSettingValue> = {}
  const issues: PluginSettingIssue[] = []

  for (const field of fields) {
    if (!raw || !Object.prototype.hasOwnProperty.call(raw, field.key)) {
      values[field.key] = field.default
      continue
    }
    const value = raw[field.key]
    if (isValidPluginSettingValue(field, value)) {
      values[field.key] = value
      continue
    }
    issues.push({key: field.key, reason: invalidReason(field, value)})
    values[field.key] = field.default
  }

  if (raw) {
    const knownKeys = new Set(fields.map(field => field.key))
    for (const key of Object.keys(raw)) {
      if (!knownKeys.has(key)) {
        issues.push({key, reason: 'unknown-setting'})
      }
    }
  }

  return {values: Object.freeze(values), issues}
}
