#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const CHANNELS = [
  'development',
  'enterprise',
  'google_play',
  'app_store',
  'china_store',
]

const USAGE = `用法：
  node scripts/release/prepare-native-eas.mjs --eas <eas.json> --profile <档案> --channel <渠道> [--out <输出文件>]

从既有 EAS 档案派生 native-release 档案：本地凭据、固定构建号、
appVersionSource=local，并写入构建渠道。仅用于工作流内的临时构建配置。`

class CliError extends Error {}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new CliError(`无法读取 ${file}（${error.code ?? error.message}）`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliError(`${file} 不是合法 JSON（${error.message}）`)
  }
}

function parseArgs(argv) {
  const options = {
    eas: undefined,
    profile: undefined,
    channel: undefined,
    out: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (!['--eas', '--profile', '--channel', '--out'].includes(arg)) {
      throw new CliError(`未知参数：${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`${arg} 缺少参数值`)
    }
    index += 1
    if (arg === '--eas') options.eas = path.resolve(value)
    else if (arg === '--profile') options.profile = value
    else if (arg === '--channel') options.channel = value
    else options.out = path.resolve(value)
  }
  if (!options.eas) throw new CliError('必须提供 --eas')
  if (!options.profile) throw new CliError('必须提供 --profile')
  if (!options.channel) throw new CliError('必须提供 --channel')
  if (!CHANNELS.includes(options.channel)) {
    throw new CliError(`不支持的渠道：${options.channel}`)
  }
  options.out = options.out ?? options.eas
  return options
}

function deriveProfile(eas, profile, channel) {
  const source = eas?.build?.[profile]
  if (!isPlainObject(source)) {
    throw new CliError(`eas.json 中不存在构建档案：${profile}`)
  }
  return {
    ...source,
    channel,
    credentialsSource: 'local',
    developmentClient: false,
    env: {
      ...(isPlainObject(source.env) ? source.env : {}),
      NATIVE_RELEASE_CHANNEL: channel,
      EXPO_PUBLIC_CHANNEL: channel,
    },
    android: {
      ...(isPlainObject(source.android) ? source.android : {}),
      buildType: 'app-bundle',
      autoIncrement: false,
    },
    ios: {
      ...(isPlainObject(source.ios) ? source.ios : {}),
      autoIncrement: false,
      simulator: false,
    },
  }
}

function prepare(easFile, profile, channel, outFile = easFile) {
  const eas = readJson(easFile)
  if (!isPlainObject(eas)) throw new CliError('eas.json 顶层必须是对象')
  if (!isPlainObject(eas.build)) throw new CliError('eas.json 缺少 build 配置')
  eas.build['native-release'] = deriveProfile(eas, profile, channel)
  eas.cli = {
    ...(isPlainObject(eas.cli) ? eas.cli : {}),
    appVersionSource: 'local',
  }
  fs.writeFileSync(outFile, `${JSON.stringify(eas, null, 2)}\n`, 'utf8')
  return eas.build['native-release']
}

function main(argv) {
  try {
    const options = parseArgs(argv)
    const profile = prepare(
      options.eas,
      options.profile,
      options.channel,
      options.out,
    )
    console.log(`已生成 native-release 档案（派生自 ${options.profile}）`)
    console.log(`  渠道：${profile.channel}`)
    console.log(`  凭据来源：${profile.credentialsSource}`)
    console.log(`  Android 产物：${profile.android.buildType}`)
  } catch (error) {
    console.error(`prepare-native-eas: ${error.message}`)
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main(process.argv.slice(2))
}

export {deriveProfile, prepare}
