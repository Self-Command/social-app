#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..', '..')

const CATALOG_SCHEMA_VERSION = 1

const TARGETS = [
  path.join(
    REPO_ROOT,
    'src/features/plugins/catalog/plugin-catalog.generated.json',
  ),
  path.join(
    WORKSPACE_ROOT,
    'repos/admin-console/apps/api/src/plugins/plugin-catalog.generated.json',
  ),
  path.join(
    WORKSPACE_ROOT,
    'repos/community-plugin-devkit/catalog/plugin-catalog.generated.json',
  ),
]

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        result[key] = canonicalize(value[key])
      }
    }
    return result
  }
  return value
}

function catalogHash(payload) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex')}`
}

export async function buildSlotCatalog() {
  const slotsModule = await import(
    pathToFileURL(
      path.join(REPO_ROOT, 'src/features/plugins/catalog/slots.ts'),
    ).href
  )
  const capabilitiesModule = await import(
    pathToFileURL(
      path.join(REPO_ROOT, 'src/features/plugins/catalog/capabilities.ts'),
    ).href
  )

  const groups = slotsModule.SLOT_GROUPS.map(([id, title]) => ({id, title}))
  const slots = slotsModule.SLOT_CATALOG
  const capabilities = capabilitiesModule.CAPABILITY_DEFINITIONS

  const payload = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    hostApi: slotsModule.SLOT_CATALOG[0]?.sinceHostApi ?? 2,
    groups,
    slots,
    capabilities,
  }

  return {
    ...payload,
    hash: catalogHash(payload),
  }
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`
}

export async function writeSlotCatalog({check = false} = {}) {
  const catalog = await buildSlotCatalog()
  const json = serializeCatalog(catalog)
  const changed = []
  const drift = []

  for (const target of TARGETS) {
    const existing = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8')
      : undefined
    if (existing === json) continue
    if (check) {
      drift.push(target)
      continue
    }
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, json)
    changed.push(target)
  }

  return {catalog, json, changed, drift}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const result = await writeSlotCatalog({check})
  const relative = target =>
    path.relative(WORKSPACE_ROOT, target).split(path.sep).join('/')
  if (result.drift.length > 0) {
    for (const target of result.drift) {
      console.error(`目录已漂移：${relative(target)}`)
    }
    console.error('请运行 node scripts/generate-slot-catalog.mjs 重新生成。')
    process.exitCode = 1
  } else if (result.changed.length > 0) {
    for (const target of result.changed) {
      console.log(`已写入：${relative(target)}`)
    }
  } else {
    console.log('插槽与能力目录已是最新。')
  }
  console.log(
    `插槽 ${result.catalog.slots.length} 个，能力 ${result.catalog.capabilities.length} 项，分组 ${result.catalog.groups.length} 个，哈希 ${result.catalog.hash}`,
  )
}
