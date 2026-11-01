import {type Text} from 'react-native'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render, screen} from '@testing-library/react-native'

import {type NativeHostDiagnostics} from '../native/host-runtime'
import {PluginHostContext} from '../runtime/plugin-context'
import {PluginDiagnostics} from './PluginDiagnostics'

jest.mock('react-native-reanimated', () => {
  const {View} = jest.requireActual<{View: typeof Text}>('react-native')
  return {
    __esModule: true,
    default: {View},
    useReducedMotion: () => false,
  }
})

jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<{Text: typeof Text}>('react-native').Text,
}))

i18n.loadAndActivate({locale: 'zh', messages: {}})

const DIAGNOSTICS: NativeHostDiagnostics = {
  nativeApi: 1,
  lockVersion: 1,
  lockHash: `sha256:${'a'.repeat(64)}`,
  compiled: [
    {
      id: 'com.example.voice',
      version: '1.0.0',
      nativeApi: 1,
      packageName: '@community-plugins/voice',
      modules: ['VoiceModule'],
      views: [{name: 'VoiceView', heightMode: 'content'}],
    },
  ],
  loaded: ['com.example.voice'],
  skips: [{pluginId: 'com.example.locked', reason: 'native_not_compiled'}],
  recentErrors: [
    {
      pluginId: 'com.example.voice',
      code: 'permission_denied',
      at: Date.UTC(2026, 10, 1, 8, 30),
    },
  ],
  brokenIds: ['com.example.broken'],
}

function renderDiagnostics(diagnostics?: NativeHostDiagnostics) {
  return render(
    <I18nProvider i18n={i18n}>
      <PluginHostContext.Provider
        value={{
          plugins: [],
          platform: 'ios',
          resetKey: 'rev-1',
          reportFailure: jest.fn(),
          reportSuccess: jest.fn(),
          nativeDiagnostics: diagnostics,
        }}>
        <PluginDiagnostics />
      </PluginHostContext.Provider>
    </I18nProvider>,
  )
}

describe('PluginDiagnostics', () => {
  test('shows the lock, compiled plugins, skips and recent errors', () => {
    renderDiagnostics(DIAGNOSTICS)

    expect(screen.getByText('插件诊断')).toBeTruthy()
    expect(screen.getByText('锁版本')).toBeTruthy()
    expect(screen.getByText('com.example.voice@1.0.0')).toBeTruthy()
    expect(
      screen.getByText('com.example.locked：未编译进当前客户端'),
    ).toBeTruthy()
    expect(screen.getByText(/permission_denied/)).toBeTruthy()
    expect(screen.getByText('com.example.broken')).toBeTruthy()
  })

  test('explains the missing runtime on platforms without native plugins', () => {
    renderDiagnostics(undefined)

    expect(screen.getByText('当前平台未启用原生插件运行时。')).toBeTruthy()
  })

  test('renders nothing outside the plugin host', () => {
    const result = render(
      <I18nProvider i18n={i18n}>
        <PluginDiagnostics />
      </I18nProvider>,
    )
    expect(result.toJSON()).toBeNull()
  })
})
