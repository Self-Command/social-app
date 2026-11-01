import {type ComponentType, type ReactNode} from 'react'
import {Text} from 'react-native'
import {render, screen} from '@testing-library/react-native'

import {type app} from '#/lexicons'
import {PluginHostContext} from '../runtime/plugin-context'
import {type ResolvedPlugin} from '../runtime/resolve'
import {type PluginSlotProps} from '../sdk/types'
import {FeedItemFooterSlot} from './FeedItemFooterSlot'

type FooterComponent = ComponentType<PluginSlotProps<'feed.item.footer'>>

function resolvedPlugin(
  id: string,
  Component: FooterComponent,
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
        slots: [{id: 'feed.item.footer', order: 1}],
        capabilities: ['feed.read'],
        settings: [],
      },
      slots: {'feed.item.footer': Component},
    },
    capabilities: ['feed.read'],
    settings: {},
    settingsIssues: [],
    host: {},
  }
}

function Host({
  plugins,
  onFailure = jest.fn(),
  children,
}: {
  plugins: ResolvedPlugin[]
  onFailure?: (pluginId: string, error: unknown) => void
  children: ReactNode
}) {
  return (
    <PluginHostContext.Provider
      value={{
        plugins,
        platform: 'ios',
        resetKey: 'rev-1',
        reportFailure: onFailure,
        reportSuccess: jest.fn(),
      }}>
      {children}
    </PluginHostContext.Provider>
  )
}

function post(uri: string, handle: string): app.bsky.feed.defs.PostView {
  return {
    uri,
    cid: `cid-${handle}`,
    author: {
      did: `did:plc:${handle}`,
      handle,
      displayName: `${handle} 的昵称`,
    },
  } as unknown as app.bsky.feed.defs.PostView
}

function record(text: string): app.bsky.feed.post.Main {
  return {
    text,
    createdAt: '2026-10-31T12:00:00.000Z',
  } as unknown as app.bsky.feed.post.Main
}

function ContextFooter({context}: PluginSlotProps<'feed.item.footer'>) {
  return (
    <Text testID="ctx">
      {context.uri}|{context.authorDid}|{context.text}
    </Text>
  )
}

describe('FeedItemFooterSlot', () => {
  test('exposes only the public post fields', () => {
    const seen: string[][] = []
    function KeyProbe({context}: PluginSlotProps<'feed.item.footer'>) {
      seen.push(Object.keys(context).sort())
      return <Text testID="probe">探针</Text>
    }

    render(
      <Host plugins={[resolvedPlugin('com.example.keys', KeyProbe)]}>
        <FeedItemFooterSlot
          post={post('at://did:plc:alice/app.bsky.feed.post/1', 'alice.test')}
          record={record('你好')}
        />
      </Host>,
    )

    expect(seen[0]).toEqual([
      'authorDid',
      'authorDisplayName',
      'authorHandle',
      'cid',
      'createdAt',
      'text',
      'uri',
    ])
  })

  test('renders each post with its own context', () => {
    const Plugin = ContextFooter
    render(
      <Host plugins={[resolvedPlugin('com.example.context', Plugin)]}>
        <FeedItemFooterSlot
          post={post('at://did:plc:alice/app.bsky.feed.post/1', 'alice.test')}
          record={record('第一条')}
        />
        <FeedItemFooterSlot
          post={post('at://did:plc:bob/app.bsky.feed.post/2', 'bob.test')}
          record={record('第二条')}
        />
      </Host>,
    )

    expect(
      screen.getAllByTestId('ctx').map(node => {
        const props = node.props as {children: string[]}
        return props.children.join('')
      }),
    ).toEqual([
      'at://did:plc:alice/app.bsky.feed.post/1|did:plc:alice.test|第一条',
      'at://did:plc:bob/app.bsky.feed.post/2|did:plc:bob.test|第二条',
    ])
  })

  test('isolates a failing footer and keeps siblings rendered', () => {
    const onFailure = jest.fn()
    function BrokenFooter(): never {
      throw new Error('渲染失败')
    }

    render(
      <Host
        plugins={[
          resolvedPlugin('com.example.good', ContextFooter),
          resolvedPlugin('com.example.bad', BrokenFooter),
        ]}
        onFailure={onFailure}>
        <FeedItemFooterSlot
          post={post('at://did:plc:alice/app.bsky.feed.post/1', 'alice.test')}
          record={record('你好')}
        />
      </Host>,
    )

    expect(screen.getByTestId('ctx')).toBeTruthy()
    expect(onFailure).toHaveBeenCalledWith('com.example.bad', expect.any(Error))
  })

  test('renders nothing when the plugin is disabled or unavailable', () => {
    const {toJSON} = render(
      <FeedItemFooterSlot
        post={post('at://did:plc:alice/app.bsky.feed.post/1', 'alice.test')}
        record={record('你好')}
      />,
    )
    expect(toJSON()).toBeNull()
  })
})
