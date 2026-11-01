#!/usr/bin/env node
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

/**
 * Secret scanner for captured build logs.
 *
 * Findings only contain the line number and rule name. Matched content is
 * never copied into findings or printed, so a failed scan cannot leak the
 * secret it detected.
 */

export const SCAN_RULES = [
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    name: 'pem-certificate',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*CERTIFICATE-----/,
  },
  {
    name: 'base64-blob',
    pattern: /[A-Za-z0-9+/]{256,}={0,2}/,
  },
  {
    name: 'plaintext-password',
    pattern: /[A-Za-z0-9_]*password\s*[=:]\s*\S+/i,
  },
  {
    name: 'keystore-passphrase',
    pattern:
      /(?:-?storepass|-?keypass|storepassword|keypassword)(?:\s*[:=]\s*|\s+)(?!env\b)\S+/i,
  },
  {
    name: 'github-token',
    pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    name: 'expo-token',
    pattern: /\bEXPO_TOKEN\b/i,
  },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: 'aws-secret-key',
    pattern: /aws_secret_access_key\s*[=:]\s*\S+/i,
  },
  {
    name: 'google-key',
    pattern:
      /AIza[0-9A-Za-z_-]{35}|"type"\s*:\s*"service_account"|"private_key_id"\s*:/,
  },
  {
    name: 'bearer-token',
    pattern: /authorization\s*:\s*bearer\s+\S+/i,
  },
]

/**
 * Scan text line by line and return `{line, rule}` findings without content.
 *
 * @param {string} text
 * @returns {{line: number, rule: string}[]}
 */
export function scanText(text) {
  if (typeof text !== 'string') {
    throw new Error('日志内容必须是字符串')
  }
  /** @type {{line: number, rule: string}[]} */
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    for (const rule of SCAN_RULES) {
      if (rule.pattern.test(lines[index])) {
        findings.push({line: index + 1, rule: rule.name})
      }
    }
  }
  return findings
}

const USAGE =
  '用法：node scripts/release/scan-logs.mjs <日志文件> [日志文件...]'

/**
 * @param {string[]} argv
 * @returns {number}
 */
function run(argv) {
  if (argv.length === 0) {
    throw new Error(USAGE)
  }
  for (const file of argv) {
    if (file.startsWith('-')) {
      throw new Error(`未知参数：${file}`)
    }
  }
  let total = 0
  for (const file of argv) {
    let text
    try {
      text = readFileSync(resolve(file), 'utf8')
    } catch {
      throw new Error(`无法读取日志文件：${file}`)
    }
    for (const finding of scanText(text)) {
      process.stdout.write(`${file}:${finding.line} [${finding.rule}]\n`)
      total++
    }
  }
  if (total > 0) {
    process.stderr.write(`日志扫描失败：命中 ${total} 处疑似秘密内容。\n`)
    return 1
  }
  process.stdout.write('日志扫描通过：未发现秘密内容。\n')
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
