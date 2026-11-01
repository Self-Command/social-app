const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
const {withAndroidManifest, withInfoPlist} = require('expo/config-plugins')

/*
 * Build-time permission merge for native community plugins. The assembly
 * script writes native-config.json from the approved plugin snapshot; this
 * plugin only translates that file into Expo config. When the file is missing
 * the project keeps its upstream configuration unchanged.
 */
const CONFIG_FILE = path.resolve(
  __dirname,
  '..',
  'src/features/plugins/generated/native-config.json',
)
const CONFIG_LABEL = 'src/features/plugins/generated/native-config.json'
const REPO_ROOT = path.resolve(__dirname, '..')

const ROOT_KEYS = ['schemaVersion', 'plugins']
const PLUGIN_KEYS = ['id', 'package', 'modules', 'views', 'permissions']
const VIEW_KEYS = ['name', 'heightMode']
const PERMISSION_KEYS = ['name', 'reason']

// Fixed order keeps the generated config stable for assertions and review.
const PERMISSION_ORDER = [
  'microphone',
  'camera',
  'photoLibrary',
  'notifications',
  'locationWhenInUse',
]

/** @type {Record<string, string[]>} */
const ANDROID_PERMISSIONS = {
  microphone: ['android.permission.RECORD_AUDIO'],
  camera: ['android.permission.CAMERA'],
  photoLibrary: ['android.permission.READ_MEDIA_IMAGES'],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  locationWhenInUse: [
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
  ],
}

// Notifications have no Info.plist usage description key.
/** @type {Record<string, string>} */
const IOS_USAGE_DESCRIPTIONS = {
  microphone: 'NSMicrophoneUsageDescription',
  camera: 'NSCameraUsageDescription',
  photoLibrary: 'NSPhotoLibraryUsageDescription',
  locationWhenInUse: 'NSLocationWhenInUseUsageDescription',
}

const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const PACKAGE_PREFIX = '@community-plugins/'
const PACKAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MODULE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const CJK_PATTERN = /[\u4e00-\u9fff]/
const HEIGHT_MODES = new Set(['fixed', 'content'])
const PERMISSION_NAMES = new Set(PERMISSION_ORDER)

/**
 * @typedef {{pluginId: string, reason: string}} Declaration
 */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`${CONFIG_LABEL}: ${message}`)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} allowed
 * @param {string} label
 */
function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${label ? `${label}.` : ''}${key}: 未知字段`)
    }
  }
}

/**
 * @returns {unknown}
 */
function readNativeConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return undefined

  let source = ''
  try {
    source = fs.readFileSync(CONFIG_FILE, 'utf8')
  } catch {
    fail('无法读取配置文件')
  }

  try {
    return JSON.parse(source)
  } catch {
    fail('不是合法 JSON')
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateModules(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label}: 期望非空数组`)
  }
  for (const [index, module] of value.entries()) {
    if (typeof module !== 'string' || !MODULE_PATTERN.test(module)) {
      fail(`${label}[${index}]: 期望模块标识符`)
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateViews(value, label) {
  if (!Array.isArray(value)) fail(`${label}: 期望数组`)
  for (const [index, view] of value.entries()) {
    const viewLabel = `${label}[${index}]`
    if (!isPlainObject(view)) fail(`${viewLabel}: 期望对象`)
    assertKnownKeys(view, VIEW_KEYS, viewLabel)

    const name = view.name
    if (typeof name !== 'string' || !MODULE_PATTERN.test(name)) {
      fail(`${viewLabel}.name: 期望视图标识符`)
    }
    const heightMode = view.heightMode
    if (typeof heightMode !== 'string' || !HEIGHT_MODES.has(heightMode)) {
      fail(`${viewLabel}.heightMode: 期望 fixed 或 content`)
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string} pluginId
 * @param {Map<string, Declaration>} declarations
 */
function validatePermissions(value, label, pluginId, declarations) {
  const fieldLabel = `${label}.permissions`
  if (!Array.isArray(value)) fail(`${fieldLabel}: 期望数组`)

  const seen = new Set()
  for (const [index, permission] of value.entries()) {
    const permissionLabel = `${fieldLabel}[${index}]`
    if (!isPlainObject(permission)) fail(`${permissionLabel}: 期望对象`)
    assertKnownKeys(permission, PERMISSION_KEYS, permissionLabel)

    const name = permission.name
    if (typeof name !== 'string' || !PERMISSION_NAMES.has(name)) {
      fail(`${permissionLabel}.name: 未知原生权限`)
    }
    if (seen.has(name)) {
      fail(`${permissionLabel}.name: 权限 "${name}" 重复`)
    }
    seen.add(name)

    const reason = permission.reason
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      fail(`${permissionLabel}.reason: 用途文案不能为空`)
    }
    if (!CJK_PATTERN.test(reason)) {
      fail(`${permissionLabel}.reason: 用途文案必须包含中文`)
    }

    const existing = declarations.get(name)
    if (existing && existing.reason !== reason) {
      fail(
        `${permissionLabel}.reason: 权限 "${name}" 的用途文案与插件 "${existing.pluginId}" 不一致`,
      )
    }
    if (!existing) {
      declarations.set(name, {pluginId, reason})
    }
  }
}

/**
 * @param {unknown} value
 * @returns {Map<string, Declaration>}
 */
function validateNativeConfig(value) {
  if (!isPlainObject(value)) fail('配置必须是对象')
  assertKnownKeys(value, ROOT_KEYS, '')
  if (value.schemaVersion !== 1) fail('schemaVersion: 期望 1')
  if (!Array.isArray(value.plugins)) fail('plugins: 期望数组')

  /** @type {Map<string, Declaration>} */
  const declarations = new Map()
  for (const [index, plugin] of value.plugins.entries()) {
    const label = `plugins[${index}]`
    if (!isPlainObject(plugin)) fail(`${label}: 期望对象`)
    assertKnownKeys(plugin, PLUGIN_KEYS, label)

    const id = plugin.id
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      fail(`${label}.id: 期望不含连字符的反向域名标识`)
    }
    const packageName = plugin.package
    const packageSlug =
      typeof packageName === 'string' && packageName.startsWith(PACKAGE_PREFIX)
        ? packageName.slice(PACKAGE_PREFIX.length)
        : ''
    if (!PACKAGE_SLUG_PATTERN.test(packageSlug)) {
      fail(`${label}.package: 期望以 "${PACKAGE_PREFIX}" 开头的包名`)
    }

    validateModules(plugin.modules, `${label}.modules`)
    validateViews(plugin.views, `${label}.views`)
    validatePermissions(plugin.permissions, label, id, declarations)
  }
  return declarations
}

/**
 * @param {Record<string, unknown>} nextConfig
 * @param {Record<string, unknown>} appConfig
 * @param {Map<string, Declaration>} declarations
 */
function applyAndroidPermissions(nextConfig, appConfig, declarations) {
  const android = appConfig.android
  if (android !== undefined && !isPlainObject(android)) {
    fail('android: 期望对象')
  }

  /** @type {string[]} */
  const permissions = []
  const existing = android?.permissions
  if (existing !== undefined) {
    if (!Array.isArray(existing)) fail('android.permissions: 期望字符串数组')
    for (const permission of existing) {
      if (typeof permission !== 'string') {
        fail('android.permissions: 期望字符串数组')
      }
      if (permission.length === 0) {
        fail('android.permissions: 期望非空字符串')
      }
      permissions.push(permission)
    }
  }

  for (const kind of PERMISSION_ORDER) {
    if (!declarations.has(kind)) continue
    for (const permission of ANDROID_PERMISSIONS[kind]) {
      if (!permissions.includes(permission)) permissions.push(permission)
    }
  }
  nextConfig.android = {...android, permissions}
}

/**
 * @param {Record<string, unknown>} nextConfig
 * @param {Record<string, unknown>} appConfig
 * @param {Map<string, Declaration>} declarations
 */
function applyIosUsageDescriptions(nextConfig, appConfig, declarations) {
  const ios = appConfig.ios
  if (ios !== undefined && !isPlainObject(ios)) fail('ios: 期望对象')

  const existing = ios?.infoPlist
  if (existing !== undefined && !isPlainObject(existing)) {
    fail('ios.infoPlist: 期望对象')
  }

  /** @type {Record<string, unknown>} */
  const infoPlist = existing === undefined ? {} : {...existing}
  let changed = false
  for (const kind of PERMISSION_ORDER) {
    const key = IOS_USAGE_DESCRIPTIONS[kind]
    const declaration = declarations.get(kind)
    if (!key || !declaration) continue

    if (Object.prototype.hasOwnProperty.call(infoPlist, key)) {
      if (infoPlist[key] !== declaration.reason) {
        fail(
          `ios.infoPlist.${key}: 插件 "${declaration.pluginId}" 的用途文案与宿主已有文案不一致`,
        )
      }
      continue
    }
    infoPlist[key] = declaration.reason
    changed = true
  }
  if (changed) {
    nextConfig.ios = {...ios, infoPlist}
  }
}

/**
 * Host plugins such as expo-camera declare `RECORD_AUDIO` with
 * `tools:node="remove"` to keep the permission out of their builds. A native
 * plugin that actually records audio must replace that directive, otherwise
 * the manifest merger silently strips the permission again.
 *
 * @param {Record<string, unknown>} appConfig
 * @param {Map<string, Declaration>} declarations
 */
function stripPermissionRemovals(appConfig, declarations) {
  const declared = new Set()
  for (const kind of PERMISSION_ORDER) {
    if (!declarations.has(kind)) continue
    for (const permission of ANDROID_PERMISSIONS[kind]) declared.add(permission)
  }
  if (declared.size === 0) return appConfig

  return withAndroidManifest(appConfig, config => {
    const manifest = config.modResults?.manifest
    if (!isPlainObject(manifest)) return config
    const entries = Array.isArray(manifest['uses-permission'])
      ? manifest['uses-permission']
      : []
    const kept = entries.filter(entry => {
      if (!isPlainObject(entry) || !isPlainObject(entry.$)) return true
      const name = entry.$['android:name']
      const removal = entry.$['tools:node'] === 'remove'
      return !(removal && declared.has(name))
    })
    for (const name of [...declared].sort()) {
      const present = kept.some(
        entry =>
          isPlainObject(entry) &&
          isPlainObject(entry.$) &&
          entry.$['android:name'] === name,
      )
      if (!present) kept.push({$: {'android:name': name}})
    }
    manifest['uses-permission'] = kept
    return config
  })
}

/**
 * expo-camera and expo-image-picker are configured with
 * `microphonePermission: false`, which removes `NSMicrophoneUsageDescription`
 * during the Info.plist mod. Re-apply declared descriptions after those mods
 * so a native plugin that needs the microphone can opt back in.
 *
 * @param {Record<string, unknown>} appConfig
 * @param {Map<string, Declaration>} declarations
 */
function reapplyIosUsageDescriptions(appConfig, declarations) {
  /** @type {Map<string, string>} */
  const wanted = new Map()
  for (const kind of PERMISSION_ORDER) {
    const key = IOS_USAGE_DESCRIPTIONS[kind]
    const declaration = declarations.get(kind)
    if (key && declaration) wanted.set(key, declaration.reason)
  }
  if (wanted.size === 0) return appConfig

  return withInfoPlist(appConfig, config => {
    for (const [key, reason] of wanted) {
      config.modResults[key] = reason
    }
    return config
  })
}

/**
 * EAS local builds reinstall node_modules in a temporary copy, which drops the
 * package links created by the assembly step. Recreate them from the generated
 * config so autolinking can still resolve each native module. Missing module
 * directories are ignored here; the assembly step is responsible for copying
 * them and already fails when a plugin is incomplete.
 *
 * @param {Record<string, unknown>} nativeConfig
 * @param {string} repoRoot
 */
function ensureNativePackageLinks(nativeConfig, repoRoot = REPO_ROOT) {
  const plugins = Array.isArray(nativeConfig.plugins)
    ? nativeConfig.plugins
    : []
  if (plugins.length === 0) return

  const linkRoot = path.join(repoRoot, 'node_modules', '@community-plugins')
  for (const plugin of plugins) {
    if (!isPlainObject(plugin)) continue
    const packageName = plugin.package
    if (
      typeof packageName !== 'string' ||
      !packageName.startsWith(PACKAGE_PREFIX)
    ) {
      continue
    }
    const slug = packageName.slice(PACKAGE_PREFIX.length)
    if (!PACKAGE_SLUG_PATTERN.test(slug)) continue

    const target = path.join(repoRoot, 'modules', `plugin-${slug}`)
    let targetStat
    try {
      targetStat = fs.lstatSync(target)
    } catch {
      continue
    }
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      fail(`modules/plugin-${slug}: 期望普通的原生模块目录`)
    }

    fs.mkdirSync(linkRoot, {recursive: true})
    const linkPath = path.join(linkRoot, slug)
    let linkStat
    try {
      linkStat = fs.lstatSync(linkPath)
    } catch {
      linkStat = undefined
    }
    if (linkStat) {
      if (!linkStat.isSymbolicLink()) {
        fail(
          `node_modules/@community-plugins/${slug}: 已存在同名真实目录，拒绝替换`,
        )
      }
      let currentReal = ''
      try {
        currentReal = fs.realpathSync(linkPath)
      } catch {
        currentReal = ''
      }
      const targetReal = fs.realpathSync(target)
      const same =
        process.platform === 'win32'
          ? currentReal.toLowerCase() === targetReal.toLowerCase()
          : currentReal === targetReal
      if (same) continue
      try {
        fs.unlinkSync(linkPath)
      } catch {
        fs.rmdirSync(linkPath)
      }
    }

    fs.symlinkSync(
      target,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }
}

/**
 * Expo config plugin that merges native plugin permissions into the app
 * config. Without a generated native-config.json it is a no-op.
 *
 * @param {Record<string, unknown>} appConfig
 * @returns {Record<string, unknown>}
 */
module.exports = function withNativePlugins(appConfig) {
  const nativeConfig = readNativeConfig()
  if (nativeConfig === undefined) return appConfig

  const declarations = validateNativeConfig(nativeConfig)
  ensureNativePackageLinks(nativeConfig)
  if (declarations.size === 0) return appConfig

  const nextConfig = {...appConfig}
  applyAndroidPermissions(nextConfig, appConfig, declarations)
  applyIosUsageDescriptions(nextConfig, appConfig, declarations)
  return reapplyIosUsageDescriptions(
    stripPermissionRemovals(nextConfig, declarations),
    declarations,
  )
}

module.exports.ensureNativePackageLinks = ensureNativePackageLinks
