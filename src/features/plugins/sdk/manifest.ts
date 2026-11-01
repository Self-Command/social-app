import {isNativeCapability, isPluginCapability} from '../catalog/capabilities'
import {isPluginSlotId} from '../catalog/slots'
import {type NativePluginLifecycle} from '../native/types'
import {
  PLUGIN_HOST_API_VERSION,
  PLUGIN_NATIVE_API_VERSION,
  PLUGIN_NATIVE_PACKAGE_PREFIX,
  PLUGIN_NATIVE_PERMISSION_KINDS,
  PLUGIN_NATIVE_VIEW_HEIGHT_MODES,
  PLUGIN_PLATFORMS,
  PLUGIN_SCHEMA_VERSION,
  type PluginCapability,
  type PluginDefinition,
  type PluginManifest,
  type PluginNativeManifest,
  type PluginNativePermissionDeclaration,
  type PluginNativePermissionKind,
  type PluginNativeViewDeclaration,
  type PluginNativeViewHeightMode,
  type PluginPlatform,
  type PluginSelectSettingField,
  type PluginSettingField,
  type PluginStringSettingField,
} from './types'

export {isPluginCapability, isPluginSlotId}

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const NATIVE_MODULE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const NATIVE_PACKAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CJK_PATTERN = /[\u4e00-\u9fff]/

const MANIFEST_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'description',
  'version',
  'hostApi',
  'nativeApi',
  'platforms',
  'slots',
  'capabilities',
  'settings',
  'native',
] as const

const SLOT_KEYS = ['id', 'order'] as const
const SETTING_BASE_KEYS = ['key', 'type', 'label', 'description', 'default']
const NATIVE_KEYS = [
  'package',
  'modules',
  'views',
  'permissions',
  'minAppVersion',
  'network',
] as const
const NATIVE_VIEW_KEYS = ['name', 'heightMode'] as const
const NATIVE_PERMISSION_KEYS = ['name', 'reason'] as const
const NATIVE_NETWORK_KEYS = ['outbound'] as const

export type ManifestValidationResult =
  {ok: true; manifest: PluginManifest} | {ok: false; errors: string[]}

export type DefinitionValidationResult =
  {ok: true; definition: PluginDefinition} | {ok: false; errors: string[]}

export type DefinitionsValidationResult =
  {ok: true; definitions: PluginDefinition[]} | {ok: false; errors: string[]}

export class PluginManifestError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid plugin manifest:\n${issues.join('\n')}`)
    this.name = 'PluginManifestError'
    this.issues = issues
  }
}

export function isPluginId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 64 &&
    PLUGIN_ID_PATTERN.test(value)
  )
}

export function isPluginPlatform(value: unknown): value is PluginPlatform {
  return (
    typeof value === 'string' &&
    (PLUGIN_PLATFORMS as readonly string[]).includes(value)
  )
}

export function isPluginVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_PATTERN.test(value)
}

export function isPluginSettingKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    SETTING_KEY_PATTERN.test(value)
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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

function readTextLength(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: string[],
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path}: expected string`)
    return undefined
  }
  if (value.length < min || value.length > max) {
    errors.push(`${path}: expected ${min}-${max} characters`)
    return undefined
  }
  return value
}

function readOptionalInteger(
  value: unknown,
  path: string,
  errors: string[],
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push(`${path}: expected a non-negative integer`)
    return undefined
  }
  return value
}

function readOptionalFiniteNumber(
  value: unknown,
  path: string,
  errors: string[],
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}: expected a finite number`)
    return undefined
  }
  return value
}

function readStringArray(
  value: unknown,
  path: string,
  errors: string[],
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`)
    return []
  }
  const result: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push(`${path}[${index}]: expected non-empty string`)
      continue
    }
    result.push(entry)
  }
  return result
}

function validatePlatforms(value: unknown, errors: string[]): PluginPlatform[] {
  const platforms = readStringArray(value, 'platforms', errors)
  if (platforms.length === 0) {
    errors.push('platforms: expected at least one platform')
  }
  const result: PluginPlatform[] = []
  const seen = new Set<string>()
  for (const [index, platform] of platforms.entries()) {
    if (!isPluginPlatform(platform)) {
      errors.push(`platforms[${index}]: unknown platform "${platform}"`)
      continue
    }
    if (seen.has(platform)) {
      errors.push(`platforms[${index}]: duplicate platform "${platform}"`)
      continue
    }
    seen.add(platform)
    result.push(platform)
  }
  return result
}

function validateSlots(
  value: unknown,
  errors: string[],
): PluginManifest['slots'] {
  if (!Array.isArray(value)) {
    errors.push('slots: expected array')
    return []
  }
  if (value.length === 0) {
    errors.push('slots: expected at least one slot')
  }
  const result: PluginManifest['slots'] = []
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `slots[${index}]`
    if (!isPlainRecord(entry)) {
      errors.push(`${path}: expected object`)
      continue
    }
    checkAllowedKeys(entry, SLOT_KEYS, path, errors)
    if (!isPluginSlotId(entry.id)) {
      errors.push(`${path}.id: unknown slot`)
      continue
    }
    if (seen.has(entry.id)) {
      errors.push(`${path}.id: duplicate slot "${entry.id}"`)
      continue
    }
    if (
      typeof entry.order !== 'number' ||
      !Number.isInteger(entry.order) ||
      entry.order < 0 ||
      entry.order > 999
    ) {
      errors.push(`${path}.order: expected integer 0-999`)
      continue
    }
    seen.add(entry.id)
    result.push({id: entry.id, order: entry.order})
  }
  return result
}

function validateCapabilities(
  value: unknown,
  errors: string[],
): PluginCapability[] {
  if (!Array.isArray(value)) {
    errors.push('capabilities: expected array')
    return []
  }
  const result: PluginCapability[] = []
  const seen = new Set<string>()
  for (const [index, capability] of value.entries()) {
    if (!isPluginCapability(capability)) {
      errors.push(`capabilities[${index}]: unknown capability`)
      continue
    }
    if (seen.has(capability)) {
      errors.push(
        `capabilities[${index}]: duplicate capability "${capability}"`,
      )
      continue
    }
    seen.add(capability)
    result.push(capability)
  }
  return result
}

function validateSettingField(
  value: unknown,
  index: number,
  seenKeys: Set<string>,
  errors: string[],
): PluginSettingField | undefined {
  const path = `settings[${index}]`
  if (!isPlainRecord(value)) {
    errors.push(`${path}: expected object`)
    return undefined
  }
  const key = value.key
  if (!isPluginSettingKey(key)) {
    errors.push(`${path}.key: expected a setting identifier`)
    return undefined
  }
  if (seenKeys.has(key)) {
    errors.push(`${path}.key: duplicate setting "${key}"`)
    return undefined
  }
  seenKeys.add(key)

  const type = value.type
  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'boolean' &&
    type !== 'select'
  ) {
    errors.push(`${path}.type: unknown setting type`)
    return undefined
  }

  const allowedKeys =
    type === 'string'
      ? [...SETTING_BASE_KEYS, 'minLength', 'maxLength']
      : type === 'number'
        ? [...SETTING_BASE_KEYS, 'min', 'max']
        : type === 'select'
          ? [...SETTING_BASE_KEYS, 'options']
          : SETTING_BASE_KEYS
  checkAllowedKeys(value, allowedKeys, path, errors)

  const label = readTextLength(value.label, `${path}.label`, 1, 40, errors)
  const description = readTextLength(
    value.description,
    `${path}.description`,
    1,
    200,
    errors,
  )

  if (type === 'string') {
    const minLength = readOptionalInteger(
      value.minLength,
      `${path}.minLength`,
      errors,
    )
    const maxLength = readOptionalInteger(
      value.maxLength,
      `${path}.maxLength`,
      errors,
    )
    if (
      minLength !== undefined &&
      maxLength !== undefined &&
      minLength > maxLength
    ) {
      errors.push(`${path}: minLength must not exceed maxLength`)
    }
    if (typeof value.default !== 'string') {
      errors.push(`${path}.default: expected string`)
      return undefined
    }
    if (
      (minLength !== undefined && value.default.length < minLength) ||
      (maxLength !== undefined && value.default.length > maxLength)
    ) {
      errors.push(`${path}.default: outside the declared length range`)
    }
    return {
      key,
      type,
      label: label ?? '',
      description: description ?? '',
      default: value.default,
      minLength,
      maxLength,
    } satisfies PluginStringSettingField
  }

  if (type === 'number') {
    const min = readOptionalFiniteNumber(value.min, `${path}.min`, errors)
    const max = readOptionalFiniteNumber(value.max, `${path}.max`, errors)
    if (min !== undefined && max !== undefined && min > max) {
      errors.push(`${path}: min must not exceed max`)
    }
    if (typeof value.default !== 'number' || !Number.isFinite(value.default)) {
      errors.push(`${path}.default: expected finite number`)
      return undefined
    }
    if (
      (min !== undefined && value.default < min) ||
      (max !== undefined && value.default > max)
    ) {
      errors.push(`${path}.default: outside the declared range`)
    }
    return {
      key,
      type,
      label: label ?? '',
      description: description ?? '',
      default: value.default,
      min,
      max,
    }
  }

  if (type === 'boolean') {
    if (typeof value.default !== 'boolean') {
      errors.push(`${path}.default: expected boolean`)
      return undefined
    }
    return {
      key,
      type,
      label: label ?? '',
      description: description ?? '',
      default: value.default,
    }
  }

  const options = readStringArray(value.options, `${path}.options`, errors)
  if (options.length === 0) {
    errors.push(`${path}.options: expected at least one option`)
  }
  if (new Set(options).size !== options.length) {
    errors.push(`${path}.options: duplicate option`)
  }
  if (typeof value.default !== 'string') {
    errors.push(`${path}.default: expected string`)
    return undefined
  }
  if (!options.includes(value.default)) {
    errors.push(`${path}.default: must be one of the declared options`)
  }
  return {
    key,
    type,
    label: label ?? '',
    description: description ?? '',
    default: value.default,
    options,
  } satisfies PluginSelectSettingField
}

function validateSettings(
  value: unknown,
  errors: string[],
): PluginSettingField[] {
  if (!Array.isArray(value)) {
    errors.push('settings: expected array')
    return []
  }
  const result: PluginSettingField[] = []
  const seenKeys = new Set<string>()
  for (const [index, field] of value.entries()) {
    const parsed = validateSettingField(field, index, seenKeys, errors)
    if (parsed) result.push(parsed)
  }
  return result
}

function validateNativeViews(
  value: unknown,
  errors: string[],
): PluginNativeViewDeclaration[] {
  if (!Array.isArray(value)) {
    errors.push('native.views: expected array')
    return []
  }
  const result: PluginNativeViewDeclaration[] = []
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `native.views[${index}]`
    if (!isPlainRecord(entry)) {
      errors.push(`${path}: expected object`)
      continue
    }
    checkAllowedKeys(entry, NATIVE_VIEW_KEYS, path, errors)
    const name = entry.name
    if (
      typeof name !== 'string' ||
      name.length > 64 ||
      !NATIVE_MODULE_PATTERN.test(name)
    ) {
      errors.push(`${path}.name: expected a view identifier`)
      continue
    }
    if (seen.has(name)) {
      errors.push(`${path}.name: duplicate view "${name}"`)
      continue
    }
    const heightMode = entry.heightMode
    if (
      typeof heightMode !== 'string' ||
      !(PLUGIN_NATIVE_VIEW_HEIGHT_MODES as readonly string[]).includes(
        heightMode,
      )
    ) {
      errors.push(`${path}.heightMode: expected "fixed" or "content"`)
      continue
    }
    seen.add(name)
    result.push({name, heightMode: heightMode as PluginNativeViewHeightMode})
  }
  return result
}

function validateNativePermissions(
  value: unknown,
  errors: string[],
): PluginNativePermissionDeclaration[] {
  if (!Array.isArray(value)) {
    errors.push('native.permissions: expected array')
    return []
  }
  const result: PluginNativePermissionDeclaration[] = []
  const seen = new Set<PluginNativePermissionKind>()
  for (const [index, entry] of value.entries()) {
    const path = `native.permissions[${index}]`
    if (!isPlainRecord(entry)) {
      errors.push(`${path}: expected object`)
      continue
    }
    checkAllowedKeys(entry, NATIVE_PERMISSION_KEYS, path, errors)
    const name = entry.name
    if (
      typeof name !== 'string' ||
      !(PLUGIN_NATIVE_PERMISSION_KINDS as readonly string[]).includes(name)
    ) {
      errors.push(`${path}.name: unknown native permission`)
      continue
    }
    if (seen.has(name as PluginNativePermissionKind)) {
      errors.push(`${path}.name: duplicate permission "${name}"`)
      continue
    }
    const reason = readTextLength(
      entry.reason,
      `${path}.reason`,
      4,
      120,
      errors,
    )
    if (reason !== undefined && !CJK_PATTERN.test(reason)) {
      errors.push(`${path}.reason: expected a Chinese explanation`)
    }
    seen.add(name as PluginNativePermissionKind)
    result.push({
      name: name as PluginNativePermissionKind,
      reason: reason ?? '',
    })
  }
  return result
}

function validateNativeNetwork(
  value: unknown,
  errors: string[],
): PluginNativeManifest['network'] {
  if (!isPlainRecord(value)) {
    errors.push('native.network: expected object')
    return {outbound: []}
  }
  checkAllowedKeys(value, NATIVE_NETWORK_KEYS, 'native.network', errors)
  const entries = readStringArray(
    value.outbound,
    'native.network.outbound',
    errors,
  )
  const result: string[] = []
  const seen = new Set<string>()
  for (const [index, origin] of entries.entries()) {
    const path = `native.network.outbound[${index}]`
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      errors.push(`${path}: expected an HTTPS origin`)
      continue
    }
    if (url.protocol !== 'https:') {
      errors.push(`${path}: expected an HTTPS origin`)
      continue
    }
    if (url.username || url.password) {
      errors.push(`${path}: credentials are not allowed in an origin`)
      continue
    }
    if (
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash
    ) {
      errors.push(`${path}: expected an origin without path, query or fragment`)
      continue
    }
    if (seen.has(origin)) {
      errors.push(`${path}: duplicate origin "${origin}"`)
      continue
    }
    seen.add(origin)
    result.push(origin)
  }
  return {outbound: result}
}

function validateNativeBlock(
  value: unknown,
  pluginId: string,
  errors: string[],
): PluginNativeManifest | undefined {
  if (!isPlainRecord(value)) {
    errors.push('native: expected object')
    return undefined
  }
  checkAllowedKeys(value, NATIVE_KEYS, 'native', errors)

  let packageName = ''
  if (
    typeof value.package !== 'string' ||
    !value.package.startsWith(PLUGIN_NATIVE_PACKAGE_PREFIX)
  ) {
    errors.push(
      `native.package: expected a package starting with "${PLUGIN_NATIVE_PACKAGE_PREFIX}"`,
    )
  } else {
    packageName = value.package
    const slug = packageName.slice(PLUGIN_NATIVE_PACKAGE_PREFIX.length)
    if (!NATIVE_PACKAGE_SLUG_PATTERN.test(slug)) {
      errors.push('native.package: expected a lower-case package slug')
    }
    const idTail = pluginId.split('.').pop() ?? ''
    if (idTail && slug !== idTail) {
      errors.push(
        `native.package: expected "${PLUGIN_NATIVE_PACKAGE_PREFIX}${idTail}" to match the plugin id`,
      )
    }
  }

  const modules: string[] = []
  if (!Array.isArray(value.modules) || value.modules.length === 0) {
    errors.push('native.modules: expected a non-empty array')
  } else {
    const seenModules = new Set<string>()
    for (const [index, module] of value.modules.entries()) {
      const path = `native.modules[${index}]`
      if (
        typeof module !== 'string' ||
        module.length > 64 ||
        !NATIVE_MODULE_PATTERN.test(module)
      ) {
        errors.push(`${path}: expected a module identifier`)
        continue
      }
      if (seenModules.has(module)) {
        errors.push(`${path}: duplicate module "${module}"`)
        continue
      }
      seenModules.add(module)
      modules.push(module)
    }
  }

  const views = validateNativeViews(value.views, errors)
  const permissions = validateNativePermissions(value.permissions, errors)
  const minAppVersion = isPluginVersion(value.minAppVersion)
    ? value.minAppVersion
    : ''
  if (!minAppVersion) {
    errors.push('native.minAppVersion: expected a semantic version')
  }
  const network = validateNativeNetwork(value.network, errors)

  return {
    package: packageName,
    modules,
    views,
    permissions,
    minAppVersion,
    network,
  }
}

/**
 * Validates an unknown value against the manifest contract and returns a
 * sanitized manifest. Unknown fields are rejected rather than forwarded.
 */
export function validatePluginManifest(
  value: unknown,
): ManifestValidationResult {
  if (!isPlainRecord(value)) {
    return {ok: false, errors: ['manifest: expected object']}
  }

  const errors: string[] = []
  checkAllowedKeys(value, MANIFEST_KEYS, 'manifest', errors)

  if (value.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: expected ${PLUGIN_SCHEMA_VERSION}, got ${String(
        value.schemaVersion,
      )}`,
    )
  }
  const id = isPluginId(value.id) ? value.id : ''
  if (!id) {
    errors.push('id: expected a reverse-domain identifier')
  }
  const name = readTextLength(value.name, 'name', 1, 40, errors) ?? ''
  const description =
    readTextLength(value.description, 'description', 1, 200, errors) ?? ''
  const version = isPluginVersion(value.version) ? value.version : ''
  if (!version) {
    errors.push('version: expected a semantic version')
  }
  if (value.hostApi !== PLUGIN_HOST_API_VERSION) {
    errors.push(
      `hostApi: expected ${PLUGIN_HOST_API_VERSION}, got ${String(
        value.hostApi,
      )}`,
    )
  }
  const platforms = validatePlatforms(value.platforms, errors)
  const slots = validateSlots(value.slots, errors)
  const capabilities = validateCapabilities(value.capabilities, errors)
  const settings =
    value.settings === undefined ? [] : validateSettings(value.settings, errors)

  const hasNativeBlock = value.native !== undefined
  const hasNativeApi = value.nativeApi !== undefined
  if (hasNativeBlock !== hasNativeApi) {
    errors.push('nativeApi: must be declared exactly when native is declared')
  }
  if (hasNativeApi && value.nativeApi !== PLUGIN_NATIVE_API_VERSION) {
    errors.push(
      `nativeApi: expected ${PLUGIN_NATIVE_API_VERSION}, got ${String(
        value.nativeApi,
      )}`,
    )
  }
  let native: PluginNativeManifest | undefined
  if (hasNativeBlock) {
    native = validateNativeBlock(value.native, id, errors)
  }
  for (const [index, capability] of capabilities.entries()) {
    if (isNativeCapability(capability) && !hasNativeBlock) {
      errors.push(
        `capabilities[${index}]: native capability "${capability}" requires a native block`,
      )
    }
  }

  if (errors.length > 0) {
    return {ok: false, errors}
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: PLUGIN_SCHEMA_VERSION,
      id,
      name,
      description,
      version,
      hostApi: PLUGIN_HOST_API_VERSION,
      ...(native ? {nativeApi: PLUGIN_NATIVE_API_VERSION, native} : {}),
      platforms,
      slots,
      capabilities,
      settings,
    },
  }
}

/**
 * Parses a manifest and throws when it violates the contract.
 */
export function parsePluginManifest(value: unknown): PluginManifest {
  const result = validatePluginManifest(value)
  if (!result.ok) throw new PluginManifestError(result.errors)
  return result.manifest
}

function isRenderableComponent(value: unknown): boolean {
  return (
    typeof value === 'function' || (typeof value === 'object' && value !== null)
  )
}

const NATIVE_LIFECYCLE_HOOKS = [
  'activate',
  'deactivate',
  'settingsChanged',
  'capabilitiesChanged',
  'appStateChanged',
  'dispose',
] as const

function validateNativeLifecycle(
  value: unknown,
  errors: string[],
): Partial<NativePluginLifecycle> | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) {
    errors.push('native: expected object')
    return undefined
  }
  checkAllowedKeys(value, NATIVE_LIFECYCLE_HOOKS, 'native', errors)

  const lifecycle: Record<string, unknown> = {}
  for (const hook of NATIVE_LIFECYCLE_HOOKS) {
    const handler = value[hook]
    if (handler === undefined) continue
    if (typeof handler !== 'function') {
      errors.push(`native.${hook}: expected a function`)
      continue
    }
    lifecycle[hook] = handler
  }
  return lifecycle
}

/**
 * Validates a plugin definition: the manifest plus one renderer per declared
 * slot, and no renderers for undeclared slots.
 */
export function validatePluginDefinition(
  value: unknown,
): DefinitionValidationResult {
  if (!isPlainRecord(value)) {
    return {ok: false, errors: ['plugin: expected object']}
  }

  const errors: string[] = []
  checkAllowedKeys(value, ['manifest', 'slots', 'native'], 'plugin', errors)
  const manifestResult = validatePluginManifest(value.manifest)
  if (!manifestResult.ok) {
    errors.push(...manifestResult.errors)
  }
  const nativeLifecycle = validateNativeLifecycle(value.native, errors)
  if (
    nativeLifecycle !== undefined &&
    manifestResult.ok &&
    !manifestResult.manifest.native
  ) {
    errors.push('native: only native plugins may declare a lifecycle')
  }

  const slotsValue = value.slots
  if (!isPlainRecord(slotsValue)) {
    errors.push('slots: expected object')
    return {ok: false, errors}
  }

  const declaredSlots = new Set<string>(
    manifestResult.ok ? manifestResult.manifest.slots.map(slot => slot.id) : [],
  )
  const renderers: Record<string, unknown> = {}

  for (const [key, renderer] of Object.entries(slotsValue)) {
    if (!isPluginSlotId(key)) {
      errors.push(`slots.${key}: unknown slot`)
      continue
    }
    if (!isRenderableComponent(renderer)) {
      errors.push(`slots.${key}: expected a React component`)
      continue
    }
    if (manifestResult.ok && !declaredSlots.has(key)) {
      errors.push(`slots.${key}: slot is not declared in the manifest`)
      continue
    }
    renderers[key] = renderer
  }

  if (manifestResult.ok) {
    for (const slot of manifestResult.manifest.slots) {
      if (!(slot.id in slotsValue)) {
        errors.push(`slots.${slot.id}: missing renderer for declared slot`)
      }
    }
  }

  if (!manifestResult.ok || errors.length > 0) {
    return {ok: false, errors}
  }

  return {
    ok: true,
    definition: {
      manifest: manifestResult.manifest,
      slots: renderers,
      ...(nativeLifecycle ? {native: nativeLifecycle} : {}),
    },
  }
}

/**
 * Validates a list of plugin definitions and rejects duplicate plugin ids.
 */
export function validatePluginDefinitions(
  values: unknown,
): DefinitionsValidationResult {
  if (!Array.isArray(values)) {
    return {ok: false, errors: ['plugins: expected array']}
  }
  const errors: string[] = []
  const definitions: PluginDefinition[] = []
  const seenIds = new Set<string>()

  for (const [index, value] of values.entries()) {
    const result = validatePluginDefinition(value)
    if (!result.ok) {
      errors.push(...result.errors.map(error => `plugins[${index}]: ${error}`))
      continue
    }
    if (seenIds.has(result.definition.manifest.id)) {
      errors.push(
        `plugins[${index}].id: duplicate plugin "${result.definition.manifest.id}"`,
      )
      continue
    }
    seenIds.add(result.definition.manifest.id)
    definitions.push(result.definition)
  }

  if (errors.length > 0) {
    return {ok: false, errors}
  }
  return {ok: true, definitions}
}
