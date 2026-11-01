#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(HERE, '../..')

export const LIMITS = {
  manifestBytes: 16 * 1024,
  sourceFileBytes: 64 * 1024,
  pluginBytes: 256 * 1024,
}

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
]
const SLOT_KEYS = ['id', 'order']
const SETTING_BASE_KEYS = ['key', 'type', 'label', 'description', 'default']
const NATIVE_KEYS = [
  'package',
  'modules',
  'views',
  'permissions',
  'minAppVersion',
  'network',
]
const NATIVE_VIEW_KEYS = ['name', 'heightMode']
const NATIVE_PERMISSION_KEYS = ['name', 'reason']
const NATIVE_NETWORK_KEYS = ['outbound']
const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const NATIVE_MODULE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const NATIVE_PACKAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PLUGIN_NATIVE_PACKAGE_PREFIX = '@community-plugins/'
const CJK_PATTERN = /[\u4e00-\u9fff]/
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const NATIVE_TEXT_EXTENSIONS = new Set([
  '.swift',
  '.m',
  '.mm',
  '.h',
  '.c',
  '.cc',
  '.cpp',
  '.kt',
  '.kts',
  '.java',
  '.gradle',
  '.podspec',
  '.plist',
])
const BINARY_EXTENSIONS = new Set([
  '.so',
  '.dylib',
  '.dll',
  '.a',
  '.o',
  '.framework',
  '.xcframework',
  '.jar',
  '.aar',
  '.class',
  '.dex',
  '.wasm',
  '.apk',
  '.ipa',
  '.app',
  '.exe',
  '.bin',
  '.node',
  '.zip',
])
const TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ...NATIVE_TEXT_EXTENSIONS,
  '.json',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
  '.lock',
  '.svg',
])

// Presentation-only modules an approved plugin may import. Anything else must
// stay inside the plugin directory or the plugin SDK.
const ALLOWED_MODULES = new Set([
  'react',
  'react-native',
  '@lingui/core/macro',
  '@lingui/react/macro',
  '#/alf',
  '#/components/Typography',
])

const FORBIDDEN_PATTERNS = [
  [/\bfetch\s*\(/, '禁止网络请求 fetch()'],
  [/\bXMLHttpRequest\b/, '禁止网络请求 XMLHttpRequest'],
  [/\bWebSocket\b/, '禁止网络连接 WebSocket'],
  [/\bEventSource\b/, '禁止网络连接 EventSource'],
  [/\bsendBeacon\b/, '禁止网络请求 sendBeacon'],
  [/\beval\s*\(/, '禁止动态执行 eval()'],
  [/\bnew\s+Function\b/, '禁止动态执行 Function 构造'],
  [/\bFunction\s*\(/, '禁止动态执行 Function 构造'],
  [/\bimport\s*\(/, '禁止动态执行 import()'],
  [/\brequire\s*\(/, '禁止动态执行 require()'],
]

// Native loading and reflection are assembled by the host at build time; a
// plugin may never reach them at runtime.
const FORBIDDEN_NATIVE_PATTERNS = [
  [/\bNativeModules\b/, '禁止反射加载原生模块 NativeModules'],
  [/\bTurboModuleRegistry\b/, '禁止反射加载原生模块 TurboModuleRegistry'],
  [/\brequireNativeComponent\b/, '禁止反射加载原生组件 requireNativeComponent'],
  [/\bcodegenNativeComponent\b/, '禁止反射加载原生组件 codegenNativeComponent'],
  [/\brequireNativeModule\b/, '禁止加载原生模块 requireNativeModule'],
  [/\bNativeEventEmitter\b/, '禁止直接创建原生事件通道 NativeEventEmitter'],
  [/\bgetViewManagerConfig\b/, '禁止反射查询原生视图 getViewManagerConfig'],
  [/\bdlopen\b/, '禁止动态加载动态库 dlopen'],
  [/\bNSClassFromString\b/, '禁止反射加载类 NSClassFromString'],
  [/\bClass\.forName\b/, '禁止反射加载类 Class.forName'],
  [/\bDexClassLoader\b/, '禁止动态加载代码 DexClassLoader'],
  [/\bSystem\.loadLibrary\b/, '禁止加载动态库 System.loadLibrary'],
  [/\bReflect\s*\./, '禁止反射访问 Reflect'],
  [/\bglobalThis\s*\[/, '禁止通过字符串访问全局对象'],
  [/\b(?:global|window)\s*\[/, '禁止通过字符串访问全局对象'],
  [
    /\b(?:NativeModules|TurboModuleRegistry|globalThis|global|window|Reflect)\s*\[\s*[^\]]*\+/,
    '禁止使用字符串拼接的类名加载模块',
  ],
  [
    /['"][A-Z][A-Za-z0-9_]*['"]\s*\+\s*['"][A-Za-z0-9_]*['"]/,
    '禁止使用字符串拼接的类名',
  ],
]

const EXECUTABLE_URL_PATTERN =
  /https?:\/\/[^\s'"`)\\]+\.(?:js|mjs|cjs|jsbundle|bundle|apk|ipa|so|dylib|dll|wasm|zip|framework)(?:[?#][^\s'"`)\\]*)?/i
const URL_PATTERN = /https?:\/\/[^\s'"`)\\]*/g

// Permission APIs and platform constants mapped to the manifest permission
// that must be declared before the source may use them.
const PERMISSION_TOKENS = [
  [/RECORD_AUDIO|NSMicrophoneUsageDescription|AVAudioSession/, 'microphone'],
  [/CAMERA|NSCameraUsageDescription|AVCaptureDevice/, 'camera'],
  [
    /READ_MEDIA_IMAGES|READ_EXTERNAL_STORAGE|NSPhotoLibraryUsageDescription|PHPhotoLibrary/,
    'photoLibrary',
  ],
  [
    /POST_NOTIFICATIONS|NSUserNotificationUsageDescription|UNUserNotificationCenter/,
    'notifications',
  ],
  [
    /ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|NSLocationWhenInUseUsageDescription|CLLocationManager/,
    'locationWhenInUse',
  ],
]

export function checkPlugins({repoRoot = DEFAULT_REPO_ROOT} = {}) {
  const errors = []
  const catalogDir = path.join(repoRoot, 'src/features/plugins/catalog')
  const catalogIndex = path.join(catalogDir, 'index.ts')
  const sdkTypes = path.join(repoRoot, 'src/features/plugins/sdk/types.ts')
  const slotsModule = path.join(catalogDir, 'slots.ts')
  const nativeTypes = path.join(
    repoRoot,
    'src/features/plugins/native/types.ts',
  )
  const slotCatalog = path.join(catalogDir, 'plugin-catalog.generated.json')
  const sdkDir = path.join(repoRoot, 'src/features/plugins/sdk')
  const rel = file => path.relative(repoRoot, file).split(path.sep).join('/')

  const sdk = readSdkContract(
    {sdkTypes, slotsModule, nativeTypes, slotCatalog},
    rel,
    errors,
  )
  if (!sdk) return {errors, pluginCount: 0, fileCount: 0}
  if (!fs.existsSync(catalogDir) || !fs.statSync(catalogDir).isDirectory()) {
    errors.push(`${rel(catalogDir)}: 找不到插件目录`)
    return {errors, pluginCount: 0, fileCount: 0}
  }

  const entries = fs
    .readdirSync(catalogDir, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  const plugins = []
  const seenIds = new Map()
  let fileCount = 0

  for (const dirName of entries) {
    const pluginDir = path.join(catalogDir, dirName)
    const manifestFile = path.join(pluginDir, 'manifest.json')
    const indexFile = path.join(pluginDir, 'index.ts')
    const pluginRel = rel(pluginDir)

    if (!fs.existsSync(manifestFile)) {
      errors.push(`${rel(manifestFile)}: 缺少 manifest.json`)
      continue
    }
    fileCount += 1
    const manifestSize = fs.statSync(manifestFile).size
    if (manifestSize > LIMITS.manifestBytes) {
      errors.push(
        `${rel(manifestFile)}: 清单文件大小 ${manifestSize} 字节，超过上限 ${LIMITS.manifestBytes} 字节`,
      )
    }

    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    } catch (error) {
      errors.push(`${rel(manifestFile)}: 清单不是合法 JSON（${error.message}）`)
      continue
    }

    const manifestErrors = []
    validateManifest(manifest, sdk, manifestErrors)
    for (const message of manifestErrors) {
      errors.push(`${rel(manifestFile)}: ${message}`)
    }

    if (!isPlainObject(manifest)) continue
    if (typeof manifest.id === 'string' && manifest.id.length > 0) {
      if (manifest.id !== dirName) {
        errors.push(
          `${rel(manifestFile)}: 清单标识 "${manifest.id}" 与目录名 "${dirName}" 不一致`,
        )
      }
      const first = seenIds.get(manifest.id)
      if (first) {
        errors.push(
          `${rel(manifestFile)}: 插件标识 "${manifest.id}" 与 ${first} 重复`,
        )
      } else {
        seenIds.set(manifest.id, rel(manifestFile))
      }
    }

    if (!fs.existsSync(indexFile)) {
      errors.push(`${rel(indexFile)}: 缺少插件入口文件`)
      continue
    }
    const indexSource = fs.readFileSync(indexFile, 'utf8')
    checkIndexExports({
      indexSource,
      indexFile: rel(indexFile),
      manifest,
      sdk,
      errors,
    })

    const pluginFiles = walkFiles(pluginDir)
    let pluginBytes = 0
    for (const file of pluginFiles) {
      const ext = path.extname(file).toLowerCase()
      const base = path.basename(file)
      const insidePlugin = path
        .relative(pluginDir, file)
        .split(path.sep)
        .join('/')
      fileCount += 1

      if (
        BINARY_EXTENSIONS.has(ext) ||
        /\.(?:framework|xcframework)(?:\/|$)/.test(insidePlugin)
      ) {
        errors.push(
          `${rel(file)}: 禁止提交二进制或预编译动态库（${ext || '二进制'}）`,
        )
        continue
      }

      const isJsSource = SOURCE_EXTENSIONS.has(ext)
      const isNativeSource = NATIVE_TEXT_EXTENSIONS.has(ext)
      if (!isJsSource && !isNativeSource) {
        if (!TEXT_EXTENSIONS.has(ext) && isBinaryFile(file)) {
          errors.push(`${rel(file)}: 禁止提交二进制文件`)
        }
        continue
      }

      const isTest = /\.(?:test|spec)\.[jt]sx?$/.test(base)
      if (isTest) continue

      const size = fs.statSync(file).size
      if (isJsSource) pluginBytes += size
      if (size > LIMITS.sourceFileBytes) {
        errors.push(
          `${rel(file)}: 源文件大小 ${size} 字节，超过上限 ${LIMITS.sourceFileBytes} 字节`,
        )
      }
      const source = fs.readFileSync(file, 'utf8')
      scanSource({
        source,
        file,
        sdkDir,
        pluginDir,
        repoRoot,
        errors,
        manifest,
        sdk,
        isJsSource,
      })
    }
    if (pluginBytes > LIMITS.pluginBytes) {
      errors.push(
        `${pluginRel}: 插件源码合计 ${pluginBytes} 字节，超过上限 ${LIMITS.pluginBytes} 字节`,
      )
    }

    plugins.push({dirName, manifest})
  }

  checkCatalogRegistration({
    catalogIndex,
    catalogDir,
    plugins,
    errors,
    rel,
  })

  return {errors, pluginCount: plugins.length, fileCount}
}

function readSdkContract(
  {sdkTypes, slotsModule, nativeTypes, slotCatalog},
  rel,
  errors,
) {
  const schemaVersion = readFileNumber(
    sdkTypes,
    'PLUGIN_SCHEMA_VERSION',
    rel,
    errors,
  )
  const hostApi = readFileNumber(
    sdkTypes,
    'PLUGIN_HOST_API_VERSION',
    rel,
    errors,
  )
  const nativeApi = readFileNumber(
    sdkTypes,
    'PLUGIN_NATIVE_API_VERSION',
    rel,
    errors,
  )
  const heightModes = readFileStringArray(
    sdkTypes,
    'PLUGIN_NATIVE_VIEW_HEIGHT_MODES',
    rel,
    errors,
  )
  const platforms = readFileStringArray(
    slotsModule,
    'PLUGIN_PLATFORMS',
    rel,
    errors,
  )
  const permissionKinds = readFileStringArray(
    nativeTypes,
    'NATIVE_PERMISSION_KINDS',
    rel,
    errors,
  )
  const catalog = readSlotCatalog(slotCatalog, rel, errors, hostApi)

  if (
    schemaVersion === undefined ||
    hostApi === undefined ||
    nativeApi === undefined ||
    heightModes.length === 0 ||
    platforms.length === 0 ||
    permissionKinds.length === 0 ||
    !catalog
  ) {
    if (errors.length === 0) {
      errors.push(`${rel(sdkTypes)}: 无法读取插件 SDK 契约常量`)
    }
    return undefined
  }

  return {
    schemaVersion,
    hostApi,
    nativeApi,
    platforms: new Set(platforms),
    slotIds: catalog.slotIds,
    capabilityIds: catalog.capabilityIds,
    nativeCapabilityIds: catalog.nativeCapabilityIds,
    permissionKinds: new Set(permissionKinds),
    heightModes: new Set(heightModes),
  }
}

function readFileNumber(file, name, rel, errors) {
  if (!fs.existsSync(file)) {
    errors.push(`${rel(file)}: 找不到契约文件`)
    return undefined
  }
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(
    fs.readFileSync(file, 'utf8'),
  )
  return match ? Number(match[1]) : undefined
}

function readFileStringArray(file, name, rel, errors) {
  if (!fs.existsSync(file)) {
    errors.push(`${rel(file)}: 找不到契约文件`)
    return []
  }
  const source = fs.readFileSync(file, 'utf8')
  const match = new RegExp(
    `export const ${name}\\b[^=\\n]*=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(source)
  if (!match) return []
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1])
}

/**
 * The generated slot catalog is the single source for slot and capability
 * ids. It is produced by the workspace generator and must agree with the SDK
 * host API version.
 */
function readSlotCatalog(file, rel, errors, hostApi) {
  const label = rel(file)
  if (!fs.existsSync(file)) {
    errors.push(`${label}: 找不到插槽与能力目录`)
    return undefined
  }
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    errors.push(`${label}: 目录不是合法 JSON（${error.message}）`)
    return undefined
  }
  if (
    !isPlainObject(value) ||
    !Array.isArray(value.slots) ||
    !Array.isArray(value.capabilities)
  ) {
    errors.push(`${label}: 目录结构无效`)
    return undefined
  }
  if (value.hostApi !== hostApi) {
    errors.push(
      `${label}: hostApi 为 ${String(value.hostApi)}，与 SDK 的 ${String(hostApi)} 不一致`,
    )
  }
  const slotIds = new Set()
  for (const slot of value.slots) {
    if (isPlainObject(slot) && typeof slot.id === 'string') slotIds.add(slot.id)
  }
  const capabilityIds = new Set()
  const nativeCapabilityIds = new Set()
  for (const capability of value.capabilities) {
    if (!isPlainObject(capability) || typeof capability.id !== 'string')
      continue
    capabilityIds.add(capability.id)
    if (capability.nativeOnly === true) nativeCapabilityIds.add(capability.id)
  }
  if (slotIds.size === 0 || capabilityIds.size === 0) {
    errors.push(`${label}: 目录缺少插槽或能力`)
    return undefined
  }
  return {slotIds, capabilityIds, nativeCapabilityIds}
}

function validateManifest(value, sdk, errors) {
  if (!isPlainObject(value)) {
    errors.push('清单必须是对象')
    return
  }
  if (!sdk) return
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.includes(key)) {
      errors.push(`manifest.${key}: 未知字段`)
    }
  }
  if (value.schemaVersion !== sdk.schemaVersion) {
    errors.push(`schemaVersion: 期望 ${sdk.schemaVersion}`)
  }
  if (
    typeof value.id !== 'string' ||
    value.id.length < 3 ||
    value.id.length > 64 ||
    !ID_PATTERN.test(value.id)
  ) {
    errors.push('id: 期望反向域名标识')
  }
  readText(value.name, 'name', 1, 40, errors)
  readText(value.description, 'description', 1, 200, errors)
  if (
    typeof value.version !== 'string' ||
    !SEMVER_PATTERN.test(value.version)
  ) {
    errors.push('version: 期望语义化版本')
  }
  if (value.hostApi !== sdk.hostApi) {
    errors.push(`hostApi: 期望 ${sdk.hostApi}`)
  }

  readStringArray(value.platforms, 'platforms', errors, {
    allowed: sdk.platforms,
    label: '平台',
    minLength: 1,
  })
  validateSlots(value.slots, sdk, errors)
  validateCapabilities(value.capabilities, sdk, errors)
  if (value.settings !== undefined) validateSettings(value.settings, errors)

  const hasNative = value.native !== undefined
  const hasNativeApi = value.nativeApi !== undefined
  if (hasNative !== hasNativeApi) {
    errors.push('nativeApi: 必须与 native 块同时声明')
  } else if (hasNativeApi && value.nativeApi !== sdk.nativeApi) {
    errors.push(`nativeApi: 期望 ${sdk.nativeApi}`)
  }
  if (hasNative) {
    validateNativeBlock(value.native, value.id, sdk, errors)
  } else if (Array.isArray(value.capabilities)) {
    for (const [index, capability] of value.capabilities.entries()) {
      if (sdk.nativeCapabilityIds.has(capability)) {
        errors.push(
          `capabilities[${index}]: 原生能力 "${capability}" 仅在声明 native 块时可用`,
        )
      }
    }
  }
}

function validateSlots(value, sdk, errors) {
  if (!Array.isArray(value)) {
    errors.push('slots: 期望数组')
    return
  }
  if (value.length === 0) errors.push('slots: 至少声明一个插槽')
  const seen = new Set()
  for (const [index, entry] of value.entries()) {
    const label = `slots[${index}]`
    if (!isPlainObject(entry)) {
      errors.push(`${label}: 期望对象`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!SLOT_KEYS.includes(key)) errors.push(`${label}.${key}: 未知字段`)
    }
    if (typeof entry.id !== 'string' || !sdk.slotIds.has(entry.id)) {
      errors.push(`${label}.id: 未知插槽 "${String(entry.id)}"`)
      continue
    }
    if (seen.has(entry.id)) {
      errors.push(`${label}.id: 插槽 "${entry.id}" 重复`)
      continue
    }
    if (
      typeof entry.order !== 'number' ||
      !Number.isInteger(entry.order) ||
      entry.order < 0 ||
      entry.order > 999
    ) {
      errors.push(`${label}.order: 期望 0-999 的整数`)
      continue
    }
    seen.add(entry.id)
  }
}

function validateCapabilities(value, sdk, errors) {
  if (!Array.isArray(value)) {
    errors.push('capabilities: 期望数组')
    return
  }
  const seen = new Set()
  for (const [index, capability] of value.entries()) {
    if (typeof capability !== 'string' || !sdk.capabilityIds.has(capability)) {
      errors.push(`capabilities[${index}]: 未知能力 "${String(capability)}"`)
      continue
    }
    if (seen.has(capability)) {
      errors.push(`capabilities[${index}]: 能力 "${capability}" 重复`)
      continue
    }
    seen.add(capability)
  }
}

function validateSettings(value, errors) {
  if (!Array.isArray(value)) {
    errors.push('settings: 期望数组')
    return
  }
  const seen = new Set()
  for (const [index, field] of value.entries()) {
    const label = `settings[${index}]`
    if (!isPlainObject(field)) {
      errors.push(`${label}: 期望对象`)
      continue
    }
    if (
      typeof field.key !== 'string' ||
      field.key.length === 0 ||
      field.key.length > 64 ||
      !SETTING_KEY_PATTERN.test(field.key)
    ) {
      errors.push(`${label}.key: 期望设置标识`)
      continue
    }
    if (seen.has(field.key)) {
      errors.push(`${label}.key: 设置 "${field.key}" 重复`)
      continue
    }
    seen.add(field.key)

    const type = field.type
    if (!['string', 'number', 'boolean', 'select'].includes(type)) {
      errors.push(`${label}.type: 未知设置类型`)
      continue
    }
    const allowedKeys =
      type === 'string'
        ? [...SETTING_BASE_KEYS, 'minLength', 'maxLength']
        : type === 'number'
          ? [...SETTING_BASE_KEYS, 'min', 'max']
          : type === 'select'
            ? [...SETTING_BASE_KEYS, 'options']
            : SETTING_BASE_KEYS
    for (const key of Object.keys(field)) {
      if (!allowedKeys.includes(key)) errors.push(`${label}.${key}: 未知字段`)
    }
    readText(field.label, `${label}.label`, 1, 40, errors)
    readText(field.description, `${label}.description`, 1, 200, errors)

    if (type === 'string') {
      const minLength = readOptionalInteger(
        field.minLength,
        `${label}.minLength`,
        errors,
      )
      const maxLength = readOptionalInteger(
        field.maxLength,
        `${label}.maxLength`,
        errors,
      )
      if (
        minLength !== undefined &&
        maxLength !== undefined &&
        minLength > maxLength
      ) {
        errors.push(`${label}: minLength 不能大于 maxLength`)
      }
      if (typeof field.default !== 'string') {
        errors.push(`${label}.default: 期望字符串`)
        continue
      }
      if (
        (minLength !== undefined && field.default.length < minLength) ||
        (maxLength !== undefined && field.default.length > maxLength)
      ) {
        errors.push(`${label}.default: 不在声明范围内`)
      }
      continue
    }

    if (type === 'number') {
      const min = readOptionalNumber(field.min, `${label}.min`, errors)
      const max = readOptionalNumber(field.max, `${label}.max`, errors)
      if (min !== undefined && max !== undefined && min > max) {
        errors.push(`${label}: min 不能大于 max`)
      }
      if (
        typeof field.default !== 'number' ||
        !Number.isFinite(field.default)
      ) {
        errors.push(`${label}.default: 期望有限数字`)
        continue
      }
      if (
        (min !== undefined && field.default < min) ||
        (max !== undefined && field.default > max)
      ) {
        errors.push(`${label}.default: 不在声明范围内`)
      }
      continue
    }

    if (type === 'boolean') {
      if (typeof field.default !== 'boolean') {
        errors.push(`${label}.default: 期望布尔值`)
      }
      continue
    }

    const options = readStringArray(field.options, `${label}.options`, errors)
    if (options.length === 0) {
      errors.push(`${label}.options: 至少一个选项`)
    }
    if (new Set(options).size !== options.length) {
      errors.push(`${label}.options: 选项重复`)
    }
    if (typeof field.default !== 'string') {
      errors.push(`${label}.default: 期望字符串`)
      continue
    }
    if (!options.includes(field.default)) {
      errors.push(`${label}.default: 必须是已声明的选项`)
    }
  }
}

function validateNativeBlock(value, pluginId, sdk, errors) {
  if (!isPlainObject(value)) {
    errors.push('native: 期望对象')
    return
  }
  for (const key of Object.keys(value)) {
    if (!NATIVE_KEYS.includes(key)) errors.push(`native.${key}: 未知字段`)
  }

  if (
    typeof value.package !== 'string' ||
    !value.package.startsWith(PLUGIN_NATIVE_PACKAGE_PREFIX)
  ) {
    errors.push(
      `native.package: 期望以 "${PLUGIN_NATIVE_PACKAGE_PREFIX}" 开头的包名`,
    )
  } else {
    const slug = value.package.slice(PLUGIN_NATIVE_PACKAGE_PREFIX.length)
    const idTail =
      typeof pluginId === 'string' ? (pluginId.split('.').pop() ?? '') : ''
    if (!NATIVE_PACKAGE_SLUG_PATTERN.test(slug)) {
      errors.push('native.package: 期望小写包标识')
    } else if (idTail && slug !== idTail) {
      errors.push(
        `native.package: 期望 "${PLUGIN_NATIVE_PACKAGE_PREFIX}${idTail}"，与插件标识一致`,
      )
    }
  }

  if (!Array.isArray(value.modules) || value.modules.length === 0) {
    errors.push('native.modules: 期望非空数组')
  } else {
    const seen = new Set()
    for (const [index, module] of value.modules.entries()) {
      if (
        typeof module !== 'string' ||
        module.length > 64 ||
        !NATIVE_MODULE_PATTERN.test(module)
      ) {
        errors.push(`native.modules[${index}]: 期望模块标识符`)
        continue
      }
      if (seen.has(module)) {
        errors.push(`native.modules[${index}]: 模块 "${module}" 重复`)
        continue
      }
      seen.add(module)
    }
  }

  if (!Array.isArray(value.views)) {
    errors.push('native.views: 期望数组')
  } else {
    const seen = new Set()
    for (const [index, view] of value.views.entries()) {
      const label = `native.views[${index}]`
      if (!isPlainObject(view)) {
        errors.push(`${label}: 期望对象`)
        continue
      }
      for (const key of Object.keys(view)) {
        if (!NATIVE_VIEW_KEYS.includes(key))
          errors.push(`${label}.${key}: 未知字段`)
      }
      if (
        typeof view.name !== 'string' ||
        view.name.length > 64 ||
        !NATIVE_MODULE_PATTERN.test(view.name)
      ) {
        errors.push(`${label}.name: 期望视图标识符`)
        continue
      }
      if (seen.has(view.name)) {
        errors.push(`${label}.name: 视图 "${view.name}" 重复`)
        continue
      }
      if (
        typeof view.heightMode !== 'string' ||
        !sdk.heightModes.has(view.heightMode)
      ) {
        errors.push(`${label}.heightMode: 期望 fixed 或 content`)
        continue
      }
      seen.add(view.name)
    }
  }

  if (!Array.isArray(value.permissions)) {
    errors.push('native.permissions: 期望数组')
  } else {
    const seen = new Set()
    for (const [index, permission] of value.permissions.entries()) {
      const label = `native.permissions[${index}]`
      if (!isPlainObject(permission)) {
        errors.push(`${label}: 期望对象`)
        continue
      }
      for (const key of Object.keys(permission)) {
        if (!NATIVE_PERMISSION_KEYS.includes(key)) {
          errors.push(`${label}.${key}: 未知字段`)
        }
      }
      if (
        typeof permission.name !== 'string' ||
        !sdk.permissionKinds.has(permission.name)
      ) {
        errors.push(`${label}.name: 未知原生权限`)
        continue
      }
      if (seen.has(permission.name)) {
        errors.push(`${label}.name: 权限 "${permission.name}" 重复`)
        continue
      }
      readText(permission.reason, `${label}.reason`, 4, 120, errors)
      if (
        typeof permission.reason === 'string' &&
        !CJK_PATTERN.test(permission.reason)
      ) {
        errors.push(`${label}.reason: 必须提供中文说明`)
      }
      seen.add(permission.name)
    }
  }

  if (
    typeof value.minAppVersion !== 'string' ||
    !SEMVER_PATTERN.test(value.minAppVersion)
  ) {
    errors.push('native.minAppVersion: 期望语义化版本')
  }

  if (!isPlainObject(value.network)) {
    errors.push('native.network: 期望对象')
  } else {
    for (const key of Object.keys(value.network)) {
      if (!NATIVE_NETWORK_KEYS.includes(key)) {
        errors.push(`native.network.${key}: 未知字段`)
      }
    }
    const outbound = readStringArray(
      value.network.outbound,
      'native.network.outbound',
      errors,
    )
    for (const [index, origin] of outbound.entries()) {
      validateOrigin(origin, `native.network.outbound[${index}]`, errors)
    }
  }
}

function validateOrigin(origin, label, errors) {
  let url
  try {
    url = new URL(origin)
  } catch {
    errors.push(`${label}: 期望 HTTPS 来源`)
    return false
  }
  if (url.protocol !== 'https:') {
    errors.push(`${label}: 期望 HTTPS 来源`)
    return false
  }
  if (url.username || url.password) {
    errors.push(`${label}: 来源中不得包含凭据`)
    return false
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    errors.push(`${label}: 期望不含路径、查询或片段的来源`)
    return false
  }
  return true
}

function readText(value, label, min, max, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label}: 期望字符串`)
    return
  }
  if (value.length < min || value.length > max) {
    errors.push(`${label}: 期望 ${min}-${max} 个字符`)
  }
}

function readOptionalInteger(value, label, errors) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push(`${label}: 期望非负整数`)
    return undefined
  }
  return value
}

function readOptionalNumber(value, label, errors) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label}: 期望有限数字`)
    return undefined
  }
  return value
}

function readStringArray(
  value,
  label,
  errors,
  {allowed, label: kind, minLength = 0} = {},
) {
  if (!Array.isArray(value)) {
    errors.push(`${label}: 期望数组`)
    return []
  }
  if (value.length < minLength) {
    errors.push(`${label}: 至少 ${minLength} 项`)
  }
  const result = []
  const seen = new Set()
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push(`${label}[${index}]: 期望非空字符串`)
      continue
    }
    if (allowed && !allowed.has(entry)) {
      errors.push(`${label}[${index}]: 未知${kind ?? '取值'} "${entry}"`)
      continue
    }
    if (seen.has(entry)) {
      errors.push(`${label}[${index}]: 取值 "${entry}" 重复`)
      continue
    }
    seen.add(entry)
    result.push(entry)
  }
  return result
}

function checkIndexExports({indexSource, indexFile, manifest, sdk, errors}) {
  const manifestImport =
    /import\s+([A-Za-z0-9_$]+)\s+from\s+['"]\.\/manifest\.json['"]/.exec(
      indexSource,
    )
  if (!manifestImport) {
    errors.push(`${indexFile}: 缺少来自 ./manifest.json 的清单导入`)
  }
  const parsed = /parsePluginManifest\s*\(\s*([A-Za-z0-9_$]+)\s*\)/.exec(
    indexSource,
  )
  if (!parsed) {
    errors.push(`${indexFile}: 必须通过 parsePluginManifest 校验 manifest.json`)
  } else if (manifestImport && parsed[1] !== manifestImport[1]) {
    errors.push(
      `${indexFile}: parsePluginManifest 的参数必须来自 ./manifest.json`,
    )
  }

  const body = extractObjectBody(indexSource, 'slots')
  if (body === undefined) {
    errors.push(`${indexFile}: 缺少 slots 导出`)
    return
  }
  const exported = new Set(
    [...body.matchAll(/(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:/g)].map(
      match => match[1] ?? match[2],
    ),
  )
  const declared = new Set(
    isPlainObject(manifest) && Array.isArray(manifest.slots)
      ? manifest.slots
          .filter(slot => isPlainObject(slot) && typeof slot.id === 'string')
          .map(slot => slot.id)
      : [],
  )
  for (const slot of exported) {
    if (!sdk.slotIds.has(slot)) {
      errors.push(`${indexFile}: 导出包含未知插槽 "${slot}"`)
    }
    if (!declared.has(slot)) {
      errors.push(`${indexFile}: 插槽 "${slot}" 未在清单中声明`)
    }
  }
  for (const slot of declared) {
    if (!exported.has(slot)) {
      errors.push(`${indexFile}: 缺少插槽 "${slot}" 的渲染组件`)
    }
  }
}

function scanSource({
  source,
  file,
  sdkDir,
  pluginDir,
  repoRoot,
  errors,
  manifest,
  sdk,
  isJsSource,
}) {
  const label = path.relative(repoRoot, file).split(path.sep).join('/')
  if (isJsSource) {
    for (const [pattern, message] of FORBIDDEN_PATTERNS) {
      if (pattern.test(source)) errors.push(`${label}: ${message}`)
    }
  }
  for (const [pattern, message] of FORBIDDEN_NATIVE_PATTERNS) {
    if (pattern.test(source)) errors.push(`${label}: ${message}`)
  }
  if (EXECUTABLE_URL_PATTERN.test(source)) {
    errors.push(`${label}: 禁止下载可执行代码`)
  }

  const nativeBlock =
    isPlainObject(manifest) && isPlainObject(manifest.native)
      ? manifest.native
      : undefined
  if (nativeBlock) {
    checkDeclaredPermissions({source, label, nativeBlock, sdk, errors})
    checkDeclaredNetwork({source, label, nativeBlock, errors})
  }

  if (!isJsSource) return

  const specifiers = []
  for (const match of source.matchAll(
    /^\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]/gm,
  )) {
    specifiers.push(match[1])
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1])
  }
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), specifier)
      if (!isInside(resolved, pluginDir) && !isInside(resolved, sdkDir)) {
        errors.push(
          `${label}: 受限导入 "${specifier}"，只能引用插件自身或插件 SDK`,
        )
      }
      continue
    }
    if (!ALLOWED_MODULES.has(specifier)) {
      errors.push(
        `${label}: 受限导入 "${specifier}"，只允许 react、react-native、Lingui 宏、ALF 与插件 SDK`,
      )
    }
  }
}

function checkDeclaredPermissions({source, label, nativeBlock, sdk, errors}) {
  const declared = new Set()
  if (Array.isArray(nativeBlock.permissions)) {
    for (const permission of nativeBlock.permissions) {
      if (isPlainObject(permission) && typeof permission.name === 'string') {
        declared.add(permission.name)
      }
    }
  }
  for (const [pattern, kind] of PERMISSION_TOKENS) {
    if (!pattern.test(source) || !sdk.permissionKinds.has(kind)) continue
    if (!declared.has(kind)) {
      errors.push(`${label}: 使用未声明的原生权限 "${kind}"`)
    }
  }
}

function checkDeclaredNetwork({source, label, nativeBlock, errors}) {
  const declared = new Set()
  if (
    isPlainObject(nativeBlock.network) &&
    Array.isArray(nativeBlock.network.outbound)
  ) {
    for (const origin of nativeBlock.network.outbound) {
      if (typeof origin === 'string') declared.add(origin)
    }
  }
  const seen = new Set()
  for (const match of source.matchAll(URL_PATTERN)) {
    const raw = match[0]
    if (seen.has(raw)) continue
    seen.add(raw)
    let url
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'https:') {
      errors.push(`${label}: 原生插件禁止非 HTTPS 网络地址 "${raw}"`)
      continue
    }
    if (!declared.has(url.origin)) {
      errors.push(`${label}: 未声明网络来源 "${url.origin}"`)
    }
  }
}

function isBinaryFile(file) {
  const sample = fs.readFileSync(file).subarray(0, 8000)
  return sample.includes(0)
}

const CATALOG_MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

function isCatalogModule(catalogDir, specifier) {
  return CATALOG_MODULE_EXTENSIONS.some(extension =>
    fs.existsSync(path.join(catalogDir, `${specifier}${extension}`)),
  )
}

function checkCatalogRegistration({
  catalogIndex,
  catalogDir,
  plugins,
  errors,
  rel,
}) {
  if (!fs.existsSync(catalogIndex)) {
    errors.push(`${rel(catalogIndex)}: 找不到插件注册文件`)
    return
  }
  const source = fs.readFileSync(catalogIndex, 'utf8')
  const imports = new Map()
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]\.\/([^'"]+)['"]/g,
  )) {
    const bindings = match[1]
      .split(',')
      .map(item =>
        item
          .replace(/^\s*type\s+/, '')
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean)
    addImports(imports, match[2], bindings)
  }
  for (const match of source.matchAll(
    /import\s+([A-Za-z0-9_$]+)\s+from\s+['"]\.\/([^'"]+)['"]/g,
  )) {
    addImports(imports, match[2], [match[1]])
  }

  const dirs = new Set(plugins.map(plugin => plugin.dirName))
  for (const dirName of imports.keys()) {
    if (dirs.has(dirName) || isCatalogModule(catalogDir, dirName)) continue
    errors.push(`${rel(catalogIndex)}: 引用了不存在的插件目录 "${dirName}"`)
  }

  const catalogBody = extractBracketBody(source, 'pluginCatalog')
  if (catalogBody === undefined) {
    errors.push(`${rel(catalogIndex)}: 缺少 pluginCatalog 列表`)
    return
  }
  for (const plugin of plugins) {
    const bindings = imports.get(plugin.dirName)
    if (!bindings || bindings.size === 0) {
      errors.push(
        `${rel(catalogIndex)}: 插件目录 "${plugin.dirName}" 未在注册文件中导入`,
      )
      continue
    }
    const registered = [...bindings].some(binding =>
      new RegExp(`\\b${escapeRegExp(binding)}\\b`).test(catalogBody),
    )
    if (!registered) {
      errors.push(
        `${rel(catalogIndex)}: 插件 "${plugin.dirName}" 的导出未加入 pluginCatalog`,
      )
    }
  }
  if (plugins.length === 0) {
    errors.push(`${rel(catalogDir)}: 目录中没有任何插件`)
  }
}

function addImports(imports, dirName, bindings) {
  if (!imports.has(dirName)) imports.set(dirName, new Set())
  for (const binding of bindings) imports.get(dirName).add(binding)
}

function extractObjectBody(source, key) {
  return extractBody(source, key, '{', '}')
}

function extractBracketBody(source, key) {
  return extractBody(source, key, '[', ']')
}

function extractBody(source, key, open, close) {
  const match = new RegExp(`${key}\\s*[=:]\\s*\\${open}`).exec(source)
  if (!match) return undefined
  let depth = 0
  for (
    let index = match.index + match[0].length - 1;
    index < source.length;
    index += 1
  ) {
    if (source[index] === open) depth += 1
    else if (source[index] === close) {
      depth -= 1
      if (depth === 0) return source.slice(match.index + match[0].length, index)
    }
  }
  return undefined
}

function walkFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(target))
    else if (entry.isFile()) files.push(target)
  }
  return files.sort()
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(target, root) {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  const result = checkPlugins()
  if (result.errors.length > 0) {
    console.error(`插件检查未通过，共 ${result.errors.length} 项：`)
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log(
      `插件检查通过：${result.pluginCount} 个插件，${result.fileCount} 个文件。`,
    )
  }
}
