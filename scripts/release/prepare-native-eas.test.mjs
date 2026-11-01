import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {deriveProfile, prepare} from './prepare-native-eas.mjs'

function sourceEas() {
  return {
    cli: {version: '>=25', appVersionSource: 'remote'},
    build: {
      base: {node: '24.22.1'},
      enterprise: {
        extends: 'base',
        channel: 'enterprise',
        env: {EXPO_PUBLIC_ENV: 'production'},
      },
      production: {
        extends: 'base',
        channel: 'production',
        ios: {autoIncrement: true},
        android: {autoIncrement: true},
        env: {EXPO_PUBLIC_ENV: 'production'},
      },
    },
  }
}

test('派生档案使用本地凭据并固定构建号', () => {
  const derived = deriveProfile(sourceEas(), 'production', 'google_play')
  assert.equal(derived.channel, 'google_play')
  assert.equal(derived.credentialsSource, 'local')
  assert.equal(derived.developmentClient, false)
  assert.equal(derived.android.buildType, 'app-bundle')
  assert.equal(derived.android.autoIncrement, false)
  assert.equal(derived.ios.autoIncrement, false)
  assert.equal(derived.ios.simulator, false)
  assert.equal(derived.env.EXPO_PUBLIC_ENV, 'production')
  assert.equal(derived.env.NATIVE_RELEASE_CHANNEL, 'google_play')
  assert.equal(derived.env.EXPO_PUBLIC_CHANNEL, 'google_play')
})

test('写入临时档案并切换为本地版本来源', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-eas-'))
  try {
    const easFile = path.join(root, 'eas.json')
    const outFile = path.join(root, 'eas.local.json')
    fs.writeFileSync(easFile, `${JSON.stringify(sourceEas(), null, 2)}\n`)
    const profile = prepare(easFile, 'enterprise', 'enterprise', outFile)
    assert.equal(profile.channel, 'enterprise')

    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    assert.equal(written.cli.appVersionSource, 'local')
    assert.equal(written.build['native-release'].credentialsSource, 'local')
    assert.equal(written.build.enterprise.channel, 'enterprise')
    assert.equal(written.build.production.channel, 'production')

    const original = JSON.parse(fs.readFileSync(easFile, 'utf8'))
    assert.equal(original.cli.appVersionSource, 'remote')
    assert.equal(original.build['native-release'], undefined)
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
})

test('未知档案失败', () => {
  assert.throws(
    () => deriveProfile(sourceEas(), 'missing', 'enterprise'),
    /不存在构建档案/,
  )
})
