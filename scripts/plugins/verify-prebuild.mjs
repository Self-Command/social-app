#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

import {assembleNative} from './native-pipeline-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const GENERATED = 'src/features/plugins/generated'
const PREBUILD_DIR = '.plugin-build/verify-prebuild'

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

const IOS_USAGE_KEYS = {
  microphone: 'NSMicrophoneUsageDescription',
  camera: 'NSCameraUsageDescription',
  photoLibrary: 'NSPhotoLibraryUsageDescription',
  locationWhenInUse: 'NSLocationWhenInUseUsageDescription',
}

const INSTALL_PACKAGES = 'android.permission.REQUEST_INSTALL_PACKAGES'

function fail(message) {
  throw new Error(message)
}

function readJson(file) {
  let source
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    fail(`无法读取文件：${path.relative(REPO_ROOT, file)}`)
  }
  try {
    return JSON.parse(source)
  } catch {
    fail(`不是合法 JSON：${path.relative(REPO_ROOT, file)}`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: {...process.env, ...options.env},
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) fail(`命令执行失败：${result.error.message}`)
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    fail(
      `命令失败（${result.status}）：${command} ${args.join(' ')}\n${output.slice(-2000)}`,
    )
  }
  return result.stdout ?? ''
}

function expoIntrospect(repoRoot) {
  const cli = path.join(repoRoot, 'node_modules', 'expo', 'bin', 'cli')
  // Introspection runs dangerous mods, which write share/notification
  // extension files into ios/ and android/. Fixture mode starts without a
  // native project, so anything created here is a probe artifact.
  const absent = ['android', 'ios'].filter(
    dir => !fs.existsSync(path.join(repoRoot, dir)),
  )
  try {
    const output = run(
      process.execPath,
      [cli, 'config', '--type', 'introspect', '--json'],
      {
        cwd: repoRoot,
        env: {CI: '1', EXPO_NO_GIT_STATUS: '1', EXPO_NO_TELEMETRY: '1'},
      },
    )
    const start = output.indexOf('{')
    if (start < 0) fail('expo config 未返回 JSON。')
    const config = JSON.parse(output.slice(start))
    const entries =
      config?._internal?.modResults?.android?.manifest?.manifest?.[
        'uses-permission'
      ] ?? []
    const permissions = []
    const removed = []
    for (const entry of entries) {
      const attributes = entry?.$ ?? {}
      const name = attributes['android:name']
      if (typeof name !== 'string' || name.length === 0) continue
      if (attributes['tools:node'] === 'remove') removed.push(name)
      else permissions.push(name)
    }
    return {
      permissions,
      removed,
      infoPlist: config?._internal?.modResults?.ios?.infoPlist ?? {},
    }
  } finally {
    for (const dir of absent) {
      fs.rmSync(path.join(repoRoot, dir), {recursive: true, force: true})
    }
  }
}

function autolinkingModules(repoRoot, platform) {
  const cli = path.join(
    repoRoot,
    'node_modules',
    'expo-modules-autolinking',
    'bin',
    'expo-modules-autolinking.js',
  )
  const output = run(
    process.execPath,
    [
      cli,
      'resolve',
      '--platform',
      platform,
      '--json',
      '--project-root',
      repoRoot,
    ],
    {cwd: repoRoot, env: {EXPO_NO_TELEMETRY: '1'}},
  )
  const parsed = JSON.parse(output.slice(output.indexOf('{')))
  const modules = Array.isArray(parsed.modules) ? parsed.modules : []
  return modules.map(module => module.packageName).filter(Boolean)
}

function expectedAndroidPermissions(config) {
  const permissions = new Set()
  for (const plugin of config.plugins) {
    for (const permission of plugin.permissions) {
      for (const name of ANDROID_PERMISSIONS[permission.name] ?? []) {
        permissions.add(name)
      }
    }
  }
  return permissions
}

function expectedIosUsages(config) {
  const usages = new Map()
  for (const plugin of config.plugins) {
    for (const permission of plugin.permissions) {
      const key = IOS_USAGE_KEYS[permission.name]
      if (key) usages.set(key, permission.reason)
    }
  }
  return usages
}

function parsePlistStrings(source) {
  const values = new Map()
  const pattern = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g
  for (const match of source.matchAll(pattern)) {
    values.set(match[1], match[2])
  }
  return values
}

function findAppInfoPlist(repoRoot) {
  const iosDir = path.join(repoRoot, 'ios')
  if (!fs.existsSync(iosDir)) fail('iOS 工程未生成：缺少 ios/ 目录。')
  const pending = [iosDir]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'Pods' || entry.name === 'build') continue
        pending.push(full)
      } else if (entry.name === 'Info.plist') {
        return full
      }
    }
  }
  fail('iOS 工程中未找到 Info.plist。')
}

function diffSets(actual, expected) {
  const missing = [...expected].filter(item => !actual.has(item))
  const extra = [...actual].filter(item => !expected.has(item))
  return {missing, extra}
}

function validateGenerated(repoRoot, config) {
  const registryFile = path.join(repoRoot, GENERATED, 'native-registry.ts')
  const lockFile = path.join(repoRoot, GENERATED, 'native-plugin-lock.json')
  if (!fs.existsSync(registryFile)) fail('未生成 native-registry.ts。')
  if (!fs.existsSync(lockFile)) fail('未生成 native-plugin-lock.json。')
  const registry = fs.readFileSync(registryFile, 'utf8')
  const lock = readJson(lockFile)
  for (const plugin of config.plugins) {
    if (!registry.includes(plugin.id))
      fail(`native-registry.ts 缺少插件 ${plugin.id}。`)
    for (const module of plugin.modules) {
      if (!registry.includes(module))
        fail(`native-registry.ts 缺少模块 ${module}。`)
    }
    for (const view of plugin.views) {
      if (!registry.includes(view.name))
        fail(`native-registry.ts 缺少视图 ${view.name}。`)
    }
  }
  return {
    lockHash: lock.lockHash,
    registry: path.relative(repoRoot, registryFile),
  }
}

function parseManifestPermissions(source) {
  const entries = []
  const pattern = /<uses-permission(?:-sdk-\d+)?\b([^>]*)>/g
  for (const match of source.matchAll(pattern)) {
    const attributes = match[1]
    const name = attributes.match(/\bandroid:name\s*=\s*"([^"]+)"/)?.[1]
    if (!name) continue
    entries.push({
      name,
      removed: /\btools:node\s*=\s*"remove"/.test(attributes),
    })
  }
  return entries
}

function validateAndroid(repoRoot, config, baselinePermissions) {
  const manifestFile = path.join(
    repoRoot,
    'android/app/src/main/AndroidManifest.xml',
  )
  if (!fs.existsSync(manifestFile))
    fail('Android 工程未生成 AndroidManifest.xml。')
  const entries = parseManifestPermissions(
    fs.readFileSync(manifestFile, 'utf8'),
  )
  const declared = expectedAndroidPermissions(config)
  const blocked = entries
    .filter(entry => entry.removed && declared.has(entry.name))
    .map(entry => entry.name)
  if (blocked.length > 0) {
    fail(
      `AndroidManifest.xml 对插件权限使用了移除指令：${blocked.join('、')}；请确认 with-native-plugins.js 位于插件数组首位。`,
    )
  }
  const permissions = new Set(
    entries.filter(entry => !entry.removed).map(entry => entry.name),
  )
  const expected = new Set([...baselinePermissions, ...declared])
  const {missing, extra} = diffSets(permissions, expected)
  if (missing.length > 0) {
    fail(`AndroidManifest.xml 缺少声明权限：${missing.join('、')}`)
  }
  if (extra.length > 0) {
    fail(`AndroidManifest.xml 出现未声明权限：${extra.join('、')}`)
  }
  if (permissions.has(INSTALL_PACKAGES)) {
    fail(`AndroidManifest.xml 不应包含 ${INSTALL_PACKAGES}。`)
  }
  return {permissions: [...permissions].sort(), declared: [...declared].sort()}
}

function validateIos(repoRoot, config) {
  const plistFile = findAppInfoPlist(repoRoot)
  const values = parsePlistStrings(fs.readFileSync(plistFile, 'utf8'))
  const usages = expectedIosUsages(config)
  for (const [key, reason] of usages) {
    const actual = values.get(key)
    if (actual === undefined) fail(`Info.plist 缺少 ${key}。`)
    if (actual !== reason) fail(`Info.plist ${key} 与插件声明不一致。`)
  }
  return {
    file: path.relative(repoRoot, plistFile),
    usages: Object.fromEntries(usages),
  }
}

function validateAutolinking(repoRoot, config, platform) {
  const resolvedPlatform = platform === 'ios' ? 'apple' : platform
  const modules = new Set(autolinkingModules(repoRoot, resolvedPlatform))
  const packages = config.plugins.map(plugin => plugin.package)
  const missing = packages.filter(packageName => !modules.has(packageName))
  if (missing.length > 0) {
    fail(`${platform} 自动链接缺少插件包：${missing.join('、')}`)
  }
  return {modules: [...modules].sort(), packages}
}

function mkdirTracked(dir, createdFiles) {
  if (fs.existsSync(dir)) return
  mkdirTracked(path.dirname(dir), createdFiles)
  fs.mkdirSync(dir)
  createdFiles.add(dir)
}

function applyOverlay(repoRoot, outDir, result, backups, createdFiles) {
  for (const relativePath of result.files) {
    const source = path.join(outDir, relativePath)
    const target = path.join(repoRoot, relativePath)
    if (fs.existsSync(target)) {
      backups.set(target, fs.readFileSync(target))
    } else {
      createdFiles.add(target)
    }
    mkdirTracked(path.dirname(target), createdFiles)
    fs.copyFileSync(source, target)
  }
  const linkRoot = path.join(repoRoot, 'node_modules', '@community-plugins')
  if (fs.existsSync(linkRoot)) {
    fail('node_modules/@community-plugins 已存在，拒绝覆盖。')
  }
  mkdirTracked(linkRoot, createdFiles)
  createdFiles.add(linkRoot)
  for (const link of result.links) {
    const linkPath = path.join(repoRoot, link.link)
    const targetDir = path.join(repoRoot, link.target)
    fs.symlinkSync(
      targetDir,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    createdFiles.add(linkPath)
  }
}

function cleanupOverlay(repoRoot, backups, createdFiles) {
  const failures = []
  for (const target of [...createdFiles].sort((a, b) => b.length - a.length)) {
    try {
      if (!fs.existsSync(target)) continue
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fs.unlinkSync(target)
      } else {
        fs.rmSync(target, {recursive: true, force: true})
      }
    } catch (error) {
      failures.push(`${target}: ${error.message}`)
    }
  }
  for (const [target, content] of backups) {
    try {
      fs.writeFileSync(target, content)
    } catch (error) {
      failures.push(`${target}: ${error.message}`)
    }
  }
  if (failures.length > 0) {
    fail(`工作区还原失败，请手动检查：\n${failures.join('\n')}`)
  }
}

function fixtureMode(fixtureName, options) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixtureName)) {
    fail('--fixture 只允许小写字母、数字与连字符。')
  }
  const requested = options.platform ?? 'both'
  if (!['android', 'ios', 'both'].includes(requested)) {
    fail('--platform 只允许 android、ios 或 both。')
  }
  const skipped = []
  let platforms = requested === 'both' ? ['android', 'ios'] : [requested]
  if (platforms.includes('ios') && process.platform === 'win32') {
    if (requested === 'ios') {
      fail('Windows 无法生成 iOS 工程，请在 macOS 或 Linux 执行 iOS 校验。')
    }
    platforms = platforms.filter(platform => platform !== 'ios')
    skipped.push({
      platform: 'ios',
      reason:
        '当前主机为 Windows，无法生成 iOS 工程，请在 macOS 或 Linux 执行完整校验。',
    })
  }
  for (const dir of ['android', 'ios']) {
    if (fs.existsSync(path.join(REPO_ROOT, dir))) {
      fail(
        `仓库已存在 ${dir}/，拒绝预构建演练；请使用 --app-root 校验现有工程。`,
      )
    }
  }
  if (
    fs.existsSync(path.join(REPO_ROOT, 'node_modules', '@community-plugins'))
  ) {
    fail('node_modules/@community-plugins 已存在，拒绝覆盖。')
  }

  const baseline = expoIntrospect(REPO_ROOT)
  const baselinePermissions = new Set(baseline.permissions)
  const baselinePlist = baseline.infoPlist

  const snapshotFile = path.join(HERE, 'fixtures', fixtureName, 'snapshot.json')
  if (!fs.existsSync(snapshotFile)) fail(`fixture 不存在：${fixtureName}`)
  const outDir = path.join(REPO_ROOT, PREBUILD_DIR, 'out')
  const assembled = assembleNative({snapshotFile, outDir})
  const nativeConfigFile = path.join(outDir, GENERATED, 'native-config.json')
  const config = readJson(nativeConfigFile)

  for (const plugin of config.plugins) {
    for (const permission of plugin.permissions) {
      const reason = permission.reason
      if (!reason || !/[\u4e00-\u9fff]/.test(reason)) {
        fail(`插件 ${plugin.id} 的权限 ${permission.name} 缺少中文用途文案。`)
      }
      const key = IOS_USAGE_KEYS[permission.name]
      if (key && baselinePlist[key] && baselinePlist[key] !== reason) {
        fail(`宿主已有 ${key}，与插件 ${plugin.id} 的用途文案冲突。`)
      }
    }
  }

  const backups = new Map()
  const createdFiles = new Set()
  const record = {
    fixture: fixtureName,
    platforms,
    skipped,
    lockHash: assembled.lock.lockHash,
    nativeConfig: path
      .relative(REPO_ROOT, nativeConfigFile)
      .split(path.sep)
      .join('/'),
    plugins: config.plugins.map(plugin => ({
      id: plugin.id,
      package: plugin.package,
      modules: plugin.modules,
      views: plugin.views,
      permissions: plugin.permissions.map(permission => permission.name),
    })),
  }

  try {
    applyOverlay(REPO_ROOT, outDir, assembled, backups, createdFiles)
    createdFiles.add(path.join(REPO_ROOT, 'android'))
    createdFiles.add(path.join(REPO_ROOT, 'ios'))
    const cli = path.join(REPO_ROOT, 'node_modules', 'expo', 'bin', 'cli')
    run(
      process.execPath,
      [
        cli,
        'prebuild',
        '--no-install',
        '--platform',
        platforms.length === 2 ? 'all' : platforms[0],
      ],
      {
        cwd: REPO_ROOT,
        env: {
          CI: '1',
          EXPO_NO_GIT_STATUS: '1',
          EXPO_NO_TELEMETRY: '1',
          EXPO_PUBLIC_ENV: 'production',
          DISABLE_UPDATES: '1',
        },
      },
    )
    record.generated = validateGenerated(REPO_ROOT, config)
    if (record.generated.lockHash !== assembled.lock.lockHash) {
      fail('生成的锁哈希与装配结果不一致。')
    }
    record.autolinking = {}
    if (platforms.includes('android')) {
      record.android = validateAndroid(REPO_ROOT, config, baselinePermissions)
      record.autolinking.android = validateAutolinking(
        REPO_ROOT,
        config,
        'android',
      )
    }
    if (platforms.includes('ios')) {
      record.ios = validateIos(REPO_ROOT, config)
      record.autolinking.ios = validateAutolinking(REPO_ROOT, config, 'ios')
    }
    record.ok = true
  } finally {
    cleanupOverlay(REPO_ROOT, backups, createdFiles)
    if (!options.keep) {
      fs.rmSync(path.join(REPO_ROOT, PREBUILD_DIR), {
        recursive: true,
        force: true,
      })
    }
  }
  return record
}

function appMode(options) {
  const appRoot = path.resolve(options.appRoot ?? REPO_ROOT)
  const configFile = path.resolve(
    appRoot,
    options.configFile ?? path.join(GENERATED, 'native-config.json'),
  )
  const config = readJson(configFile)
  const platform = options.platform ?? 'both'
  if (!['android', 'ios', 'both'].includes(platform)) {
    fail('--platform 只允许 android、ios 或 both。')
  }
  const record = {
    appRoot,
    nativeConfig: configFile,
    platform,
    plugins: config.plugins,
  }
  if (platform === 'android' || platform === 'both') {
    const baseline = options.baselineFile
      ? new Set(readJson(path.resolve(options.baselineFile)).permissions ?? [])
      : undefined
    record.android = baseline
      ? validateAndroid(appRoot, config, baseline)
      : validateDeclaredAndroid(appRoot, config)
    record.autolinking = {
      ...record.autolinking,
      android: validateAutolinking(appRoot, config, 'android'),
    }
  }
  if (platform === 'ios' || platform === 'both') {
    record.ios = validateIos(appRoot, config)
    record.autolinking = {
      ...record.autolinking,
      ios: validateAutolinking(appRoot, config, 'ios'),
    }
  }
  record.ok = true
  return record
}

function validateDeclaredAndroid(repoRoot, config) {
  const manifestFile = path.join(
    repoRoot,
    'android/app/src/main/AndroidManifest.xml',
  )
  if (!fs.existsSync(manifestFile))
    fail('Android 工程未生成 AndroidManifest.xml。')
  const entries = parseManifestPermissions(
    fs.readFileSync(manifestFile, 'utf8'),
  )
  const declared = expectedAndroidPermissions(config)
  const blocked = entries
    .filter(entry => entry.removed && declared.has(entry.name))
    .map(entry => entry.name)
  if (blocked.length > 0) {
    fail(
      `AndroidManifest.xml 对插件权限使用了移除指令：${blocked.join('、')}；请确认 with-native-plugins.js 位于插件数组首位。`,
    )
  }
  const permissions = new Set(
    entries.filter(entry => !entry.removed).map(entry => entry.name),
  )
  const missing = [...declared].filter(
    permission => !permissions.has(permission),
  )
  if (missing.length > 0) {
    fail(`AndroidManifest.xml 缺少声明权限：${missing.join('、')}`)
  }
  if (permissions.has(INSTALL_PACKAGES)) {
    fail(`AndroidManifest.xml 不应包含 ${INSTALL_PACKAGES}。`)
  }
  return {permissions: [...permissions].sort(), declared: [...declared].sort()}
}

function parseArgs(argv) {
  const options = {fixture: undefined, out: undefined, keep: false}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return {help: true}
    if (arg === '--keep') {
      options.keep = true
      continue
    }
    if (
      ![
        '--fixture',
        '--out',
        '--app-root',
        '--config',
        '--platform',
        '--baseline',
      ].includes(arg)
    ) {
      fail(`未知参数：${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`${arg} 缺少参数值`)
    index += 1
    if (arg === '--fixture') options.fixture = value
    else if (arg === '--out') options.out = value
    else if (arg === '--app-root') options.appRoot = value
    else if (arg === '--config') options.configFile = value
    else if (arg === '--platform') options.platform = value
    else options.baselineFile = value
  }
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(
      [
        '用法：',
        '  node scripts/plugins/verify-prebuild.mjs --fixture <名称> [--platform android|ios|both] [--out <记录文件>] [--keep]',
        '  node scripts/plugins/verify-prebuild.mjs --app-root <目录> [--config <native-config.json>] [--platform android|ios|both] [--baseline <权限 JSON>] [--out <记录文件>]',
        '',
        '--fixture 会临时叠加生成物并执行 expo prebuild --no-install，结束后还原工作区。',
      ].join('\n'),
    )
    return
  }
  if (!options.fixture && !options.appRoot) {
    fail('必须提供 --fixture 或 --app-root。')
  }
  const record = options.fixture
    ? fixtureMode(options.fixture, options)
    : appMode(options)
  if (options.out) {
    const target = path.resolve(options.out)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }
  console.log(`预构建校验通过：${options.fixture ?? record.appRoot}`)
  if (record.android)
    console.log(`  Android 权限 ${record.android.permissions.length} 项。`)
  if (record.ios)
    console.log(
      `  iOS usage description ${Object.keys(record.ios.usages ?? {}).length} 项。`,
    )
  if (record.skipped) {
    for (const item of record.skipped) {
      console.log(`  ${item.platform} 已跳过：${item.reason}`)
    }
  }
  if (record.lockHash) console.log(`  lockHash=${record.lockHash}`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(`预构建校验失败：${error.message}`)
  if (process.env.PREBUILD_DEBUG === '1') console.error(error.stack)
  process.exitCode = 1
}
