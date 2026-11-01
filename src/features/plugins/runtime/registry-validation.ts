import {
  isPluginCapability,
  isPluginId,
  isPluginPlatform,
  isPluginSettingKey,
  isPluginVersion,
} from '../sdk/manifest'
import {type PluginCapability, type PluginPlatform} from '../sdk/types'
import {isJsonSerializable, isPlainRecord} from './json'
import {
  type PluginRegistryEntry,
  type PluginRegistrySnapshot,
} from './registry-types'

export const PLUGIN_REGISTRY_MAX_PLUGINS = 50

const SNAPSHOT_KEYS = ['revision', 'generatedAt', 'plugins'] as const
const ENTRY_KEYS = [
  'id',
  'version',
  'hostApi',
  'platforms',
  'capabilities',
  'settings',
] as const

export type PluginRegistryValidationResult =
  | {ok: true; snapshot: PluginRegistrySnapshot}
  | {
      ok: false
      reason: 'invalid-structure' | 'too-many-plugins'
      errors: string[]
    }

function checkAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}.${key}: unknown field`)
    }
  }
}

function validatePlatforms(
  value: unknown,
  path: string,
  errors: string[],
): PluginPlatform[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`)
    return undefined
  }
  if (value.length === 0) {
    errors.push(`${path}: expected at least one platform`)
    return undefined
  }
  const result: PluginPlatform[] = []
  const seen = new Set<string>()
  for (const [index, platform] of value.entries()) {
    if (!isPluginPlatform(platform)) {
      errors.push(`${path}[${index}]: unknown platform`)
      return undefined
    }
    if (seen.has(platform)) {
      errors.push(`${path}[${index}]: duplicate platform`)
      return undefined
    }
    seen.add(platform)
    result.push(platform)
  }
  return result
}

function validateCapabilities(
  value: unknown,
  path: string,
  errors: string[],
): PluginCapability[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`)
    return undefined
  }
  const result: PluginCapability[] = []
  const seen = new Set<string>()
  for (const [index, capability] of value.entries()) {
    if (!isPluginCapability(capability)) {
      errors.push(`${path}[${index}]: unknown capability`)
      return undefined
    }
    if (seen.has(capability)) {
      errors.push(`${path}[${index}]: duplicate capability`)
      return undefined
    }
    seen.add(capability)
    result.push(capability)
  }
  return result
}

function validateSettings(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) {
    errors.push(`${path}: expected object`)
    return undefined
  }
  const result: Record<string, unknown> = {}
  for (const [key, settingValue] of Object.entries(value)) {
    if (!isPluginSettingKey(key)) {
      errors.push(`${path}.${String(key)}: invalid setting key`)
      return undefined
    }
    if (!isJsonSerializable(settingValue)) {
      errors.push(`${path}.${key}: value is not JSON-serializable`)
      return undefined
    }
    result[key] = settingValue
  }
  return result
}

function validateEntry(
  value: unknown,
  index: number,
  seenIds: Set<string>,
  errors: string[],
): PluginRegistryEntry | undefined {
  const path = `plugins[${index}]`
  if (!isPlainRecord(value)) {
    errors.push(`${path}: expected object`)
    return undefined
  }
  checkAllowedKeys(value, ENTRY_KEYS, path, errors)

  if (!isPluginId(value.id)) {
    errors.push(`${path}.id: expected a plugin identifier`)
    return undefined
  }
  if (seenIds.has(value.id)) {
    errors.push(`${path}.id: duplicate plugin`)
    return undefined
  }
  if (!isPluginVersion(value.version)) {
    errors.push(`${path}.version: expected a semantic version`)
    return undefined
  }
  if (
    typeof value.hostApi !== 'number' ||
    !Number.isInteger(value.hostApi) ||
    value.hostApi < 1
  ) {
    errors.push(`${path}.hostApi: expected a positive integer`)
    return undefined
  }
  const platforms = validatePlatforms(
    value.platforms,
    `${path}.platforms`,
    errors,
  )
  const capabilities = validateCapabilities(
    value.capabilities,
    `${path}.capabilities`,
    errors,
  )
  const settings = validateSettings(value.settings, `${path}.settings`, errors)
  if (!platforms || !capabilities || !settings) {
    return undefined
  }

  seenIds.add(value.id)
  return {
    id: value.id,
    version: value.version,
    hostApi: value.hostApi,
    platforms,
    capabilities,
    settings,
  }
}

/**
 * Validates and sanitizes a public registry response. The whole response is
 * rejected when any entry is invalid so a single malformed plugin cannot
 * silently drop or alter the rest.
 */
export function validatePluginRegistrySnapshot(
  value: unknown,
): PluginRegistryValidationResult {
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      reason: 'invalid-structure',
      errors: ['response: expected object'],
    }
  }

  const errors: string[] = []
  checkAllowedKeys(value, SNAPSHOT_KEYS, 'response', errors)

  if (
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.revision)
  ) {
    errors.push('revision: expected a non-negative safe integer')
  }
  if (
    typeof value.generatedAt !== 'string' ||
    value.generatedAt.length === 0 ||
    Number.isNaN(Date.parse(value.generatedAt))
  ) {
    errors.push('generatedAt: expected an ISO timestamp')
  }
  if (!Array.isArray(value.plugins)) {
    errors.push('plugins: expected array')
    return {ok: false, reason: 'invalid-structure', errors}
  }
  if (value.plugins.length > PLUGIN_REGISTRY_MAX_PLUGINS) {
    return {
      ok: false,
      reason: 'too-many-plugins',
      errors: [
        `plugins: expected at most ${PLUGIN_REGISTRY_MAX_PLUGINS} entries`,
      ],
    }
  }

  const plugins: PluginRegistryEntry[] = []
  const seenIds = new Set<string>()
  for (const [index, entry] of value.plugins.entries()) {
    const parsed = validateEntry(entry, index, seenIds, errors)
    if (parsed) plugins.push(parsed)
  }

  if (errors.length > 0) {
    return {ok: false, reason: 'invalid-structure', errors}
  }

  return {
    ok: true,
    snapshot: {
      revision: value.revision as number,
      generatedAt: value.generatedAt as string,
      plugins,
    },
  }
}
