import {sha256} from 'js-sha256'

import {
  CAPABILITY_DEFINITIONS,
  isNativeCapability,
  isPluginCapability,
  NATIVE_CAPABILITY_IDS,
  PLUGIN_CAPABILITY_IDS,
} from './capabilities'
import generated from './plugin-catalog.generated.json'
import {
  isPluginSlotId,
  PLUGIN_SLOT_IDS,
  SLOT_CATALOG,
  SLOT_GROUPS,
} from './slots'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) result[key] = canonicalize(entry)
    }
    return result
  }
  return value
}

function hashPayload(payload: unknown): string {
  return `sha256:${sha256
    .create()
    .update(JSON.stringify(canonicalize(payload)))
    .hex()}`
}

describe('plugin slot catalog', () => {
  test('contains 100 slots across 13 groups', () => {
    expect(SLOT_CATALOG).toHaveLength(100)
    expect(PLUGIN_SLOT_IDS).toHaveLength(100)
    expect(SLOT_GROUPS).toHaveLength(13)
    expect(new Set(PLUGIN_SLOT_IDS).size).toBe(100)
  })

  test('assigns every slot to a declared group with a valid platform set', () => {
    const groupIds = new Set(SLOT_GROUPS.map(([id]) => id))
    for (const slot of SLOT_CATALOG) {
      expect(groupIds.has(slot.group)).toBe(true)
      expect(slot.platforms.length).toBeGreaterThan(0)
      expect(slot.title.length).toBeGreaterThan(0)
      expect(slot.contextType.length).toBeGreaterThan(0)
      expect(slot.sinceHostApi).toBe(2)
      expect(slot.stability).toBe('stable')
    }
  })

  test('uses only declared capabilities and keeps native capabilities native-only', () => {
    for (const slot of SLOT_CATALOG) {
      expect(slot.capabilities.length).toBeGreaterThan(0)
      for (const capability of slot.capabilities) {
        expect(isPluginCapability(capability)).toBe(true)
        expect(isNativeCapability(capability)).toBe(false)
      }
    }
  })

  test('classifies exactly four capabilities as native-only', () => {
    expect(CAPABILITY_DEFINITIONS).toHaveLength(33)
    expect(PLUGIN_CAPABILITY_IDS).toHaveLength(33)
    expect(new Set(PLUGIN_CAPABILITY_IDS).size).toBe(33)
    const nativeOnly = CAPABILITY_DEFINITIONS.filter(
      capability => capability.nativeOnly,
    ).map(capability => capability.id)
    expect(nativeOnly).toEqual([...NATIVE_CAPABILITY_IDS])
    expect(
      CAPABILITY_DEFINITIONS.every(capability => capability.title.length > 0),
    ).toBe(true)
  })

  test('guards slot and capability identifiers', () => {
    expect(isPluginSlotId('app.root.before')).toBe(true)
    expect(isPluginSlotId('settings.main.section')).toBe(true)
    expect(isPluginSlotId('settings.section')).toBe(false)
    expect(isPluginCapability('preferences.read')).toBe(true)
    expect(isPluginCapability('native.permissions')).toBe(true)
    expect(isPluginCapability('admin.slots')).toBe(false)
  })
})

describe('generated catalog', () => {
  test('matches the runtime catalog and its content hash', () => {
    const payload = {
      schemaVersion: generated.schemaVersion,
      hostApi: generated.hostApi,
      groups: generated.groups,
      slots: generated.slots,
      capabilities: generated.capabilities,
    }
    expect(generated.hash).toBe(hashPayload(payload))
    expect(generated.groups).toEqual(
      SLOT_GROUPS.map(([id, title]) => ({id, title})),
    )
    expect(generated.slots).toEqual(JSON.parse(JSON.stringify(SLOT_CATALOG)))
    expect(generated.capabilities).toEqual(
      JSON.parse(JSON.stringify(CAPABILITY_DEFINITIONS)),
    )
  })
})
