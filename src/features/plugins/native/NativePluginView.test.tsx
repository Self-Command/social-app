import {
  Dimensions,
  Platform,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native'
import {requireNativeViewManager} from 'expo-modules-core'
import {act, render, screen} from '@testing-library/react-native'

import {clearNativeViewCache} from './native-view-resolver'
import {
  NATIVE_PLUGIN_VIEW_MAX_HEIGHT_RATIO,
  NativePluginView,
} from './NativePluginView'
import {type NativePluginRegistryEntry} from './registry'
import {NativePluginViewProvider} from './registry-context'
import {type NativePluginViewProps} from './types'

let mockNativeProps: Record<string, unknown>[] = []

function mockNativeViewComponent(props: Record<string, unknown>) {
  mockNativeProps.push(props)
  return <View testID="mock-native-view" />
}

jest.mock('react-native-reanimated', () => {
  const mockReactNative =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    __esModule: true,
    default: mockReactNative.Animated,
    useReducedMotion: () => false,
  }
})

jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<{Text: typeof View}>('react-native').Text,
}))

const requireNativeViewManagerMock =
  requireNativeViewManager as unknown as jest.Mock

const PLUGIN_ID = 'com.selfcommand.voicecomment'

const ENTRY: NativePluginRegistryEntry = {
  id: PLUGIN_ID,
  version: '1.0.0',
  nativeApi: 1,
  packageName: '@community-plugins/voicecomment',
  modules: ['VoiceCommentModule'],
  views: [
    {name: 'VoiceRecorderView', heightMode: 'content'},
    {name: 'VoicePlayerView', heightMode: 'fixed'},
  ],
}

function renderView(
  props: Partial<NativePluginViewProps> = {},
  entries: readonly NativePluginRegistryEntry[] = [ENTRY],
) {
  const reportDiagnostic = jest.fn()
  const reportError = jest.fn()
  const reportSuccess = jest.fn()
  const viewProps: NativePluginViewProps = {
    pluginId: PLUGIN_ID,
    view: 'VoiceRecorderView',
    ...props,
  }
  const result = render(
    <NativePluginViewProvider
      entries={entries}
      reportDiagnostic={reportDiagnostic}
      reportError={reportError}
      reportSuccess={reportSuccess}>
      <NativePluginView {...viewProps} />
    </NativePluginViewProvider>,
  )
  return {...result, reportDiagnostic, reportError, reportSuccess}
}

function latestNativeProps(): Record<string, unknown> {
  return mockNativeProps[mockNativeProps.length - 1] ?? {}
}

type ContainerStyle = {
  height?: number
  maxHeight?: number
}

/**
 * RNTL types element props as `any`; flatten the style prop into the narrow
 * layout shape these assertions read.
 */
function containerStyle(testID: string): ContainerStyle {
  const {style} = screen.getByTestId(testID).props as {
    style?: StyleProp<ViewStyle>
  }
  return (StyleSheet.flatten(style) as ContainerStyle | undefined) ?? {}
}

function firstReportedError(reportError: jest.Mock) {
  const [call] = reportError.mock.calls as Array<[string, {code: string}]>
  return call?.[1]
}

const windowHeight = Dimensions.get('window').height
const maxInlineHeight = Math.floor(
  windowHeight * NATIVE_PLUGIN_VIEW_MAX_HEIGHT_RATIO,
)

beforeEach(() => {
  jest.clearAllMocks()
  requireNativeViewManagerMock.mockImplementation(() => mockNativeViewComponent)
  mockNativeProps = []
  clearNativeViewCache()
})

describe('NativePluginView', () => {
  test('renders a registered view with JSON props and accessibility metadata', () => {
    const {reportSuccess} = renderView({
      props: {maxDurationSeconds: 60},
      accessibilityLabel: '语音录制',
      accessibilityHint: '轻触开始录音',
    })

    expect(screen.getByTestId('native-plugin-view')).toBeTruthy()
    expect(screen.getByTestId('mock-native-view')).toBeTruthy()

    const nativeProps = latestNativeProps()
    expect(nativeProps.maxDurationSeconds).toBe(60)
    expect(nativeProps.accessibilityLabel).toBe('语音录制')
    expect(nativeProps.accessibilityHint).toBe('轻触开始录音')
    expect(typeof nativeProps.onEvent).toBe('function')
    expect(typeof nativeProps.onResize).toBe('function')
    expect(typeof nativeProps.onError).toBe('function')
    expect(reportSuccess).toHaveBeenCalledWith(PLUGIN_ID)
  })

  test('does not render a plugin that is missing from the generated registry', () => {
    const onError = jest.fn()
    const {reportDiagnostic, reportError} = renderView({
      pluginId: 'com.example.missing',
      view: 'MissingView',
      onError,
    })

    expect(screen.getByTestId('native-plugin-view-error')).toBeTruthy()
    expect(
      screen.getByText('当前应用版本未包含该插件，请更新应用后重试。'),
    ).toBeTruthy()
    expect(mockNativeProps).toHaveLength(0)
    expect(reportDiagnostic).toHaveBeenCalledWith(
      'com.example.missing',
      'native_view_not_found',
    )
    expect(onError).toHaveBeenCalledWith(
      'unavailable',
      '当前应用版本未包含该插件，请更新应用后重试。',
    )
    expect(firstReportedError(reportError)).toHaveProperty(
      'code',
      'unavailable',
    )
  })

  test('does not render an unregistered view of a registered plugin', () => {
    const {reportDiagnostic} = renderView({view: 'UnknownView'})

    expect(screen.getByTestId('native-plugin-view-error')).toBeTruthy()
    expect(
      screen.getByText('当前应用版本不包含该插件视图，请更新应用后重试。'),
    ).toBeTruthy()
    expect(reportDiagnostic).toHaveBeenCalledWith(
      PLUGIN_ID,
      'native_view_not_found',
    )
  })

  test('reports a failed native view load as a load failure', () => {
    requireNativeViewManagerMock.mockImplementationOnce(() => {
      throw new Error('module is not linked')
    })
    const {reportDiagnostic} = renderView()

    expect(
      screen.getByText('插件视图加载失败，请更新应用后重试。'),
    ).toBeTruthy()
    expect(reportDiagnostic).toHaveBeenCalledWith(
      PLUGIN_ID,
      'native_view_load_failed',
    )
  })

  test('rejects a height mode that differs from the generated registry', () => {
    renderView({heightMode: 'fixed'})

    expect(
      screen.getByText('视图高度模式与已安装版本不一致，无法显示。'),
    ).toBeTruthy()
    expect(mockNativeProps).toHaveLength(0)
  })

  test('rejects non JSON props and oversized props before rendering', () => {
    const first = renderView({props: {onPress: () => {}}})
    expect(screen.getByText('插件视图参数无效，无法显示。')).toBeTruthy()
    expect(mockNativeProps).toHaveLength(0)
    first.unmount()

    renderView({props: {payload: 'x'.repeat(64 * 1024)}})
    expect(
      screen.getByText('插件视图参数超出允许的大小，无法显示。'),
    ).toBeTruthy()
    expect(mockNativeProps).toHaveLength(0)
  })

  test('applies content height and clamps it to 80% of the screen', () => {
    const onResize = jest.fn()
    renderView({heightMode: 'content', onResize})

    act(() => {
      ;(latestNativeProps().onResize as (height: number) => void)(320)
    })
    expect(containerStyle('native-plugin-view').height).toBe(320)
    expect(onResize).toHaveBeenLastCalledWith(320)

    act(() => {
      ;(latestNativeProps().onResize as (height: number) => void)(
        maxInlineHeight + 500,
      )
    })
    expect(containerStyle('native-plugin-view').height).toBe(maxInlineHeight)
    expect(onResize).toHaveBeenLastCalledWith(maxInlineHeight)
  })

  test('fixed views only receive the 80% maximum height', () => {
    renderView({view: 'VoicePlayerView'})

    const style = containerStyle('native-plugin-view')
    expect(style.maxHeight).toBe(maxInlineHeight)
    expect(style.height).toBeUndefined()
  })

  test('forwards valid view events', () => {
    const onEvent = jest.fn()
    renderView({onEvent})

    act(() => {
      ;(latestNativeProps().onEvent as (...args: unknown[]) => void)('state', {
        status: 'recording',
      })
    })

    expect(onEvent).toHaveBeenCalledWith('state', {status: 'recording'})
  })

  test('drops oversized and malformed view events', () => {
    const onEvent = jest.fn()
    const onError = jest.fn()
    renderView({onEvent, onError})

    act(() => {
      ;(latestNativeProps().onEvent as (...args: unknown[]) => void)('state', {
        blob: 'x'.repeat(32 * 1024),
      })
    })
    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'too_large',
      '插件事件数据超出允许的大小，已忽略。',
    )
    expect(
      screen.getByText('插件事件数据超出允许的大小，已忽略。'),
    ).toBeTruthy()

    act(() => {
      ;(latestNativeProps().onEvent as (...args: unknown[]) => void)(
        'state',
        'invalid',
      )
    })
    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'invalid_argument',
      '插件事件数据无效，已忽略。',
    )

    act(() => {
      ;(latestNativeProps().onEvent as (...args: unknown[]) => void)('', {})
    })
    expect(onError).toHaveBeenCalledWith(
      'invalid_argument',
      '插件事件名称无效，已忽略。',
    )
  })

  test('sanitizes native view errors and reports them to the host', () => {
    const onError = jest.fn()
    const {reportError} = renderView({onError})

    act(() => {
      ;(latestNativeProps().onError as (...args: unknown[]) => void)({
        code: 'unavailable',
        message: 'native stack trace',
      })
    })

    expect(onError).toHaveBeenCalledWith(
      'unavailable',
      '当前功能不可用，请稍后重试。',
    )
    expect(screen.getByText('当前功能不可用，请稍后重试。')).toBeTruthy()
    expect(firstReportedError(reportError)).toHaveProperty(
      'code',
      'unavailable',
    )
  })

  test('does not load native modules on web', () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web')
    try {
      renderView()

      expect(screen.getByTestId('native-plugin-view-fallback')).toBeTruthy()
      expect(
        screen.getByText('当前平台不支持原生视图，请使用 App。'),
      ).toBeTruthy()
      expect(requireNativeViewManagerMock).not.toHaveBeenCalled()
    } finally {
      platform.restore()
    }
  })
})
