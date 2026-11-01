import {type ComponentType, type ReactElement, type ReactNode} from 'react'
import {Text} from 'react-native'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render, screen} from '@testing-library/react-native'

import {PluginHostContext} from '../runtime/plugin-context'
import {type ResolvedPlugin} from '../runtime/resolve'
import {type PluginSlotId, type PluginSlotProps} from '../sdk/types'
import {SettingsSectionSlot} from './SettingsSectionSlot'

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

function renderSlot(ui: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>)
}

type SectionComponent = ComponentType<PluginSlotProps<'settings.main.section'>>

function resolvedPlugin(
  id: string,
  slotId: PluginSlotId,
  Component: SectionComponent,
): ResolvedPlugin {
  return {
    definition: {
      manifest: {
        schemaVersion: 2,
        id,
        name: id,
        description: '测试插件',
        version: '1.0.0',
        hostApi: 2,
        platforms: ['ios', 'android', 'web'],
        slots: [{id: slotId, order: 1}],
        capabilities: [],
        settings: [],
      },
      slots: {[slotId]: Component},
    },
    capabilities: [],
    settings: {},
    settingsIssues: [],
    host: {},
  }
}

function Host({
  plugins,
  children,
}: {
  plugins: ResolvedPlugin[]
  children: ReactNode
}) {
  return (
    <PluginHostContext.Provider
      value={{
        plugins,
        platform: 'ios',
        resetKey: 'rev-1',
        reportFailure: jest.fn(),
        reportSuccess: jest.fn(),
      }}>
      {children}
    </PluginHostContext.Provider>
  )
}

function SectionBody() {
  return <Text testID="section-body">插件条目</Text>
}

describe('SettingsSectionSlot', () => {
  test('renders nothing outside the plugin host', () => {
    const {toJSON} = renderSlot(<SettingsSectionSlot />)
    expect(toJSON()).toBeNull()
  })

  test('renders nothing when no plugin declares the settings slot', () => {
    const {toJSON} = renderSlot(
      <Host
        plugins={[
          resolvedPlugin(
            'com.example.composer',
            'composer.toolbar',
            SectionBody,
          ),
        ]}>
        <SettingsSectionSlot />
      </Host>,
    )
    expect(toJSON()).toBeNull()
  })

  test('provides the section title and plugin rows when enabled', () => {
    renderSlot(
      <Host
        plugins={[
          resolvedPlugin(
            'com.example.section',
            'settings.main.section',
            SectionBody,
          ),
        ]}>
        <SettingsSectionSlot />
      </Host>,
    )

    expect(screen.getByText('扩展功能')).toBeTruthy()
    expect(screen.getByTestId('section-body')).toBeTruthy()
  })
})
