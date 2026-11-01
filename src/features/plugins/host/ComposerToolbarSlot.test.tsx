import {type ComponentType, type ReactNode} from 'react'
import {Pressable, Text} from 'react-native'
import {type RichText} from '@bsky/sdk/richtext'
import {fireEvent, render, screen} from '@testing-library/react-native'

import {
  PluginHostContext,
  type PluginHostContextValue,
} from '../runtime/plugin-context'
import {type ResolvedPlugin} from '../runtime/resolve'
import {type PluginSlotProps} from '../sdk/types'
import {appendPluginText, ComposerToolbarSlot} from './ComposerToolbarSlot'

type ToolbarComponent = ComponentType<PluginSlotProps<'composer.toolbar'>>

function resolvedPlugin(
  id: string,
  Component: ToolbarComponent,
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
        slots: [{id: 'composer.toolbar', order: 1}],
        capabilities: ['composer.insertText'],
        settings: [],
      },
      slots: {'composer.toolbar': Component},
    },
    capabilities: ['composer.insertText'],
    settings: {},
    settingsIssues: [],
    host: {},
  }
}

function Host({
  plugins,
  onFailure = jest.fn(),
  onSuccess = jest.fn(),
  children,
}: {
  plugins: ResolvedPlugin[]
  onFailure?: PluginHostContextValue['reportFailure']
  onSuccess?: PluginHostContextValue['reportSuccess']
  children: ReactNode
}) {
  return (
    <PluginHostContext.Provider
      value={{
        plugins,
        platform: 'ios',
        resetKey: 'rev-1',
        reportFailure: onFailure,
        reportSuccess: onSuccess,
      }}>
      {children}
    </PluginHostContext.Provider>
  )
}

function InsertButton({context}: PluginSlotProps<'composer.toolbar'>) {
  return (
    <Pressable
      testID="insert"
      accessibilityRole="button"
      accessibilityLabel="插入收藏链接"
      accessibilityHint="将收藏链接追加到正文"
      onPress={() =>
        context.insertText('https://bsky.app/profile/alice.test/post/1')
      }>
      <Text>插入</Text>
    </Pressable>
  )
}

describe('appendPluginText', () => {
  test('keeps existing text and separates with a space', () => {
    expect(appendPluginText('已有正文', '链接')).toBe('已有正文 链接')
  })

  test('does not add a space when the existing text ends with whitespace', () => {
    expect(appendPluginText('已有正文\n', '链接')).toBe('已有正文\n链接')
  })

  test('returns the insertion for empty text and the original for empty insertion', () => {
    expect(appendPluginText('', '链接')).toBe('链接')
    expect(appendPluginText('已有正文', '')).toBe('已有正文')
  })
})

describe('ComposerToolbarSlot', () => {
  test('inserts text without overwriting the existing body', () => {
    const onChangeRichText = jest.fn((_richText: RichText) => {})
    render(
      <Host plugins={[resolvedPlugin('com.example.bookmarks', InsertButton)]}>
        <ComposerToolbarSlot
          text="已有正文"
          onChangeRichText={onChangeRichText}
          onCloseComposer={jest.fn()}
        />
      </Host>,
    )

    fireEvent.press(screen.getByTestId('insert'))

    expect(onChangeRichText).toHaveBeenCalledTimes(1)
    expect(onChangeRichText.mock.calls[0][0].text).toBe(
      '已有正文 https://bsky.app/profile/alice.test/post/1',
    )
  })

  test('exposes the current text and closes the composer', () => {
    const onCloseComposer = jest.fn()
    const seen: string[] = []
    function ContextProbe({context}: PluginSlotProps<'composer.toolbar'>) {
      return (
        <Pressable
          testID="probe"
          accessibilityRole="button"
          accessibilityLabel="读取正文"
          accessibilityHint="读取当前正文并关闭输入框"
          onPress={() => {
            seen.push(context.getText())
            context.closeComposer()
          }}>
          <Text>探针</Text>
        </Pressable>
      )
    }

    render(
      <Host plugins={[resolvedPlugin('com.example.probe', ContextProbe)]}>
        <ComposerToolbarSlot
          text="当前正文"
          onChangeRichText={jest.fn()}
          onCloseComposer={onCloseComposer}
        />
      </Host>,
    )

    fireEvent.press(screen.getByTestId('probe'))

    expect(seen).toEqual(['当前正文'])
    expect(onCloseComposer).toHaveBeenCalledTimes(1)
  })

  test('renders nothing when disabled or outside the plugin host', () => {
    const {toJSON} = render(
      <ComposerToolbarSlot
        text=""
        onChangeRichText={jest.fn()}
        onCloseComposer={jest.fn()}
      />,
    )
    expect(toJSON()).toBeNull()
  })

  test('isolates a failing plugin and keeps siblings rendered', () => {
    const onFailure = jest.fn()
    function BrokenToolbar(): never {
      throw new Error('渲染失败')
    }

    render(
      <Host
        plugins={[
          resolvedPlugin('com.example.good', InsertButton),
          resolvedPlugin('com.example.bad', BrokenToolbar),
        ]}
        onFailure={onFailure}>
        <ComposerToolbarSlot
          text=""
          onChangeRichText={jest.fn()}
          onCloseComposer={jest.fn()}
        />
      </Host>,
    )

    expect(screen.getByTestId('insert')).toBeTruthy()
    expect(onFailure).toHaveBeenCalledWith('com.example.bad', expect.any(Error))
  })
})
