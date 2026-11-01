#!/usr/bin/env node
import {
  assembleNative,
  parsePipelineArgs,
  reportPipelineError,
  usageText,
} from './native-pipeline-lib.mjs'

const SCRIPT_NAME = 'assemble-native.mjs'

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usageText(SCRIPT_NAME))
    return
  }
  const options = parsePipelineArgs(argv)
  const result = assembleNative(options)

  console.log(
    `原生插件组装完成：${result.files.length} 个文件，${result.links.length} 个包链接。`,
  )
  for (const file of result.files) {
    console.log(`  文件 ${file}`)
  }
  for (const link of result.links) {
    const status = link.status === 'created' ? '新建' : '已存在'
    console.log(`  链接 ${link.link} -> ${link.target}（${status}）`)
  }
  console.log(`lockHash=${result.lock.lockHash}`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  reportPipelineError(SCRIPT_NAME, error)
}
