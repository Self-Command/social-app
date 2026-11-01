import {type ComponentType, type ReactElement, type ReactNode} from 'react'
import {Text} from 'react-native'
import {render, screen} from '@testing-library/react-native'

import {type PluginSlotId, type PluginSlotProps} from '../sdk/types'
import {PluginHostContext, type PluginHostContextValue} from './plugin-context'
import {getPluginsForSlot, PluginSlot} from './PluginSlot'
import {type ResolvedPlugin} from './resolve'

const FOOTER_CONTEXT = {
  uri: 'at://did:plc:alice/app.bsky.feed.post/1',
  cid: 'cid-1',
  authorDid: 'did:plc:alice',
  authorHandle: 'alice.test',
  text: '你好',
  createdAt: '2026-10-31T12:00:00.000Z',
}

type FooterComponent = ComponentType<PluginSlotProps<'feed.item.footer'>>

function resolvedPlugin(
  id: string,
  order: number,
  Component: FooterComponent,
  slotId: PluginSlotId = 'feed.item.footer',
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
        slots: [{id: slotId, order}],
        capabilities: ['feed.read'],
        settings: [],
      },
      slots: {[slotId]: Component},
    },
    capabilities: ['feed.read'],
    settings: {},
    settingsIssues: [],
    host: {},
  }
}

function footerWithLabel(label: string): FooterComponent {
  return function Footer() {
    return <Text testID={`plugin-${label}`}>{label}</Text>
  }
}

function GoodFooter(props: PluginSlotProps<'feed.item.footer'>) {
  return (
    <Text testID="plugin-good">
      good:{props.context.uri}:{props.settings.title ?? 'none'}
    </Text>
  )
}

function ThrowingFooter(): ReactElement {
  throw new Error('render exploded')
}

function Host({
  plugins,
  resetKey = 'rev-1',
  onFailure = jest.fn(),
  onSuccess = jest.fn(),
  children,
}: {
  plugins: ResolvedPlugin[]
  resetKey?: string
  onFailure?: PluginHostContextValue['reportFailure']
  onSuccess?: PluginHostContextValue['reportSuccess']
  children: ReactNode
}) {
  return (
    <PluginHostContext.Provider
      value={{
        plugins,
        platform: 'ios',
        resetKey,
        reportFailure: onFailure,
        reportSuccess: onSuccess,
      }}>
      {children}
    </PluginHostContext.Provider>
  )
}

describe('getPluginsForSlot', () => {
  test('orders by manifest order ascending, then by plugin id', () => {
    const plugins = [
      resolvedPlugin('com.example.beta', 10, footerWithLabel('beta')),
      resolvedPlugin('com.example.alpha', 10, footerWithLabel('alpha')),
      resolvedPlugin('com.example.zero', 5, footerWithLabel('zero')),
    ]

    expect(
      getPluginsForSlot(plugins, 'feed.item.footer').map(
        plugin => plugin.definition.manifest.id,
      ),
    ).toEqual(['com.example.zero', 'com.example.alpha', 'com.example.beta'])
  })

  test('ignores plugins that did not declare the slot', () => {
    const footer = resolvedPlugin(
      'com.example.footer',
      1,
      footerWithLabel('footer'),
    )
    const composer = resolvedPlugin(
      'com.example.composer',
      1,
      footerWithLabel('composer'),
      'composer.toolbar',
    )

    expect(
      getPluginsForSlot([footer, composer], 'settings.main.section'),
    ).toEqual([])
    expect(
      getPluginsForSlot([footer, composer], 'composer.toolbar').map(
        plugin => plugin.definition.manifest.id,
      ),
    ).toEqual(['com.example.composer'])
  })
})

describe('PluginSlot', () => {
  test('renders enabled plugins in a stable order', () => {
    const plugins = [
      resolvedPlugin('com.example.beta', 10, footerWithLabel('beta')),
      resolvedPlugin('com.example.alpha', 10, footerWithLabel('alpha')),
      resolvedPlugin('com.example.zero', 5, footerWithLabel('zero')),
    ]
    const expected = ['plugin-zero', 'plugin-alpha', 'plugin-beta']

    const {rerender} = render(
      <Host plugins={plugins}>
        <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />
      </Host>,
    )

    expect(
      screen.getAllByTestId(/^plugin-/).map(node => node.props.testID),
    ).toEqual(expected)

    rerender(
      <Host plugins={[...plugins].reverse()}>
        <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />
      </Host>,
    )
    expect(
      screen.getAllByTestId(/^plugin-/).map(node => node.props.testID),
    ).toEqual(expected)
  })

  test('isolates a failing plugin and keeps siblings rendered', () => {
    const onFailure = jest.fn()
    const onSuccess = jest.fn()
    const plugins = [
      resolvedPlugin('com.example.good', 1, GoodFooter),
      resolvedPlugin('com.example.bad', 2, ThrowingFooter),
    ]

    render(
      <Host plugins={plugins} onFailure={onFailure} onSuccess={onSuccess}>
        <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />
      </Host>,
    )

    expect(screen.getByTestId('plugin-good')).toBeTruthy()
    expect(screen.queryByTestId('plugin-com.example.bad')).toBeNull()
    expect(onFailure).toHaveBeenCalledWith('com.example.bad', expect.any(Error))
    expect(onSuccess).toHaveBeenCalledWith('com.example.good')
  })

  test('recovers an errored plugin when the reset key changes', () => {
    let shouldThrow = true
    function ToggleFooter() {
      if (shouldThrow) {
        throw new Error('temporary failure')
      }
      return <Text testID="plugin-toggle">recovered</Text>
    }

    const plugins = [resolvedPlugin('com.example.toggle', 1, ToggleFooter)]

    const {rerender} = render(
      <Host plugins={plugins} resetKey="rev-1">
        <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />
      </Host>,
    )
    expect(screen.queryByTestId('plugin-toggle')).toBeNull()

    shouldThrow = false
    rerender(
      <Host plugins={plugins} resetKey="rev-2">
        <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />
      </Host>,
    )
    expect(screen.getByTestId('plugin-toggle')).toBeTruthy()
  })

  test('renders nothing without a plugin host', () => {
    const {toJSON} = render(
      <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />,
    )
    expect(toJSON()).toBeNull()
  })

  test('renders nothing when there are no plugins for the slot', () => {
    render(
      <Host plugins={[]}>
        <PluginSlot id="feed.item.footer" context={FOOTER_CONTEXT} />
      </Host>,
    )
    expect(screen.queryByText('good')).toBeNull()
  })
})
