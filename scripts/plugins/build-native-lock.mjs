#!/usr/bin/env node
import path from 'node:path'

import {
  parsePipelineArgs,
  reportPipelineError,
  usageText,
  writeNativeLock,
} from './native-pipeline-lib.mjs'

const SCRIPT_NAME = 'build-native-lock.mjs'

function displayPath(absolutePath) {
  const relative = path.relative(process.cwd(), absolutePath)
  if (relative === '') return '.'
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return absolutePath.split(path.sep).join('/')
  }
  return relative.split(path.sep).join('/')
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usageText(SCRIPT_NAME))
    return
  }
  const options = parsePipelineArgs(argv)
  const result = writeNativeLock(options)

  console.log(`原生插件锁已写入：${displayPath(result.lockPath)}`)
  console.log(`lockHash=${result.lock.lockHash}`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  reportPipelineError(SCRIPT_NAME, error)
}
