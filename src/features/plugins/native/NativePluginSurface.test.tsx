import {
  Dimensions,
  type StyleProp,
  StyleSheet,
  type View,
  type ViewStyle,
} from 'react-native'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native'

import {
  NativePluginSurface,
  NativePluginSurfaceHost,
  resolveNativeSurfaceGesture,
  resolveNativeSurfaceTitle,
} from './NativePluginSurface'
import {type NativePluginRegistryEntry} from './registry'
import {NativePluginViewProvider} from './registry-context'
import {createNativeSurfaceManager} from './surface-manager'
import {
  type NativePluginSurfaceProps,
  type NativePresentationOptions,
  type NativeSheetDetent,
} from './types'

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

const PLUGIN_A = 'com.example.alpha'
const PLUGIN_B = 'com.example.beta'

const ENTRY_A: NativePluginRegistryEntry = {
  id: PLUGIN_A,
  version: '1.0.0',
  nativeApi: 1,
  packageName: '@community-plugins/alpha',
  modules: ['AlphaModule'],
  views: [{name: 'AlphaView', heightMode: 'content'}],
}

const ENTRY_B: NativePluginRegistryEntry = {
  id: PLUGIN_B,
  version: '1.0.0',
  nativeApi: 1,
  packageName: '@community-plugins/beta',
  modules: ['BetaModule'],
  views: [{name: 'BetaView', heightMode: 'fixed'}],
}

const ENTRIES = [ENTRY_A, ENTRY_B]

function renderSurface(
  props: Partial<NativePluginSurfaceProps> = {},
  onDismiss = jest.fn(),
) {
  const surfaceProps: NativePluginSurfaceProps = {
    visible: true,
    pluginId: PLUGIN_A,
    view: 'AlphaView',
    presentation: {mode: 'sheet', title: '语音评论'},
    onDismiss,
    ...props,
  }
  const result = render(
    <NativePluginViewProvider entries={ENTRIES}>
      <NativePluginSurface {...surfaceProps} />
    </NativePluginViewProvider>,
  )
  return {...result, onDismiss}
}

function createManager(entries = ENTRIES) {
  const onError = jest.fn()
  const manager = createNativeSurfaceManager({
    getPlugin: pluginId => entries.find(entry => entry.id === pluginId),
    onError,
  })
  return {manager, onError}
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

const windowHeight = Dimensions.get('window').height

describe('NativePluginSurface', () => {
  test('renders host chrome, focus trap and the plugin view', () => {
    renderSurface()

    expect(screen.getByText('语音评论')).toBeTruthy()
    expect(screen.getByTestId('native-plugin-view')).toBeTruthy()
    expect(screen.getByTestId('native-plugin-surface-close')).toBeTruthy()
    expect(
      screen.getByTestId('native-plugin-surface-backdrop', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy()

    const sheet = screen.getByTestId('native-plugin-surface-sheet')
    expect(sheet.props.accessibilityViewIsModal).toBe(true)
    expect(
      screen.getByTestId('native-plugin-surface-header').props
        .onResponderRelease,
    ).toEqual(expect.any(Function))
  })

  test('close button and accessibility escape dismiss exactly once', () => {
    const {onDismiss} = renderSurface()

    fireEvent.press(screen.getByTestId('native-plugin-surface-close'))
    fireEvent.press(screen.getByTestId('native-plugin-surface-close'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('host gesture can request dismissal from the focus-trapped sheet', () => {
    const {onDismiss} = renderSurface()

    fireEvent(
      screen.getByTestId('native-plugin-surface-sheet'),
      'accessibilityEscape',
    )

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('renders fullscreen presentation without a backdrop or drag gesture', () => {
    renderSurface({
      presentation: {mode: 'fullscreen', title: '语音评论'},
    })

    expect(screen.getByTestId('native-plugin-surface-fullscreen')).toBeTruthy()
    expect(screen.queryByTestId('native-plugin-surface-sheet')).toBeNull()
    expect(screen.queryByTestId('native-plugin-surface-backdrop')).toBeNull()
    expect(screen.getByText('语音评论')).toBeTruthy()
    expect(
      screen.getByTestId('native-plugin-surface-header').props
        .onResponderRelease,
    ).toBeUndefined()
  })

  test('uses a formal default title when the plugin omits one', () => {
    renderSurface({presentation: {mode: 'sheet'}})

    expect(screen.getByText('扩展功能')).toBeTruthy()
  })

  test('honours medium and large detent heights', () => {
    const first = renderSurface({
      presentation: {mode: 'sheet', detents: ['medium', 'large']},
    })
    const mediumHeight = Math.min(windowHeight, Math.round(windowHeight * 0.55))
    expect(containerStyle('native-plugin-surface-sheet').height).toBe(
      mediumHeight,
    )
    first.unmount()

    renderSurface({presentation: {mode: 'sheet', detents: ['large']}})
    expect(containerStyle('native-plugin-surface-sheet').height).toBe(
      Math.round(windowHeight * 0.92),
    )
  })

  test('does not render while hidden', () => {
    renderSurface({visible: false})

    expect(screen.queryByTestId('native-plugin-surface-sheet')).toBeNull()
    expect(screen.queryByText('语音评论')).toBeNull()
  })
})

describe('NativePluginSurface helpers', () => {
  test('normalizes titles', () => {
    expect(resolveNativeSurfaceTitle(undefined)).toBe('扩展功能')
    expect(resolveNativeSurfaceTitle('')).toBe('扩展功能')
    expect(resolveNativeSurfaceTitle('  语音评论  ')).toBe('语音评论')
    expect(resolveNativeSurfaceTitle('x'.repeat(100))).toHaveLength(80)
  })

  test('maps drag gestures to expand, collapse and dismiss', () => {
    expect(
      resolveNativeSurfaceGesture({dy: -100, detentIndex: 0, detentCount: 2}),
    ).toBe('expand')
    expect(
      resolveNativeSurfaceGesture({dy: -100, detentIndex: 1, detentCount: 2}),
    ).toBe('none')
    expect(
      resolveNativeSurfaceGesture({dy: 100, detentIndex: 1, detentCount: 2}),
    ).toBe('collapse')
    expect(
      resolveNativeSurfaceGesture({dy: 100, detentIndex: 0, detentCount: 2}),
    ).toBe('dismiss')
    expect(
      resolveNativeSurfaceGesture({dy: 100, detentIndex: 0, detentCount: 1}),
    ).toBe('dismiss')
    expect(
      resolveNativeSurfaceGesture({dy: 10, detentIndex: 0, detentCount: 2}),
    ).toBe('none')
    expect(
      resolveNativeSurfaceGesture({
        dy: Number.NaN,
        detentIndex: 0,
        detentCount: 2,
      }),
    ).toBe('none')
  })
})

describe('createNativeSurfaceManager', () => {
  test('opens and closes one registered surface', async () => {
    const {manager} = createManager()

    await manager.present(
      PLUGIN_A,
      'AlphaView',
      {maxDurationSeconds: 60},
      {mode: 'sheet', title: '语音评论'},
    )
    expect(manager.getActive()).toMatchObject({
      pluginId: PLUGIN_A,
      view: 'AlphaView',
      props: {maxDurationSeconds: 60},
      presentation: {mode: 'sheet', title: '语音评论'},
    })

    await manager.dismiss(PLUGIN_A, 'AlphaView')
    expect(manager.getActive()).toBeUndefined()
  })

  test('rejects unregistered views and invalid payloads', async () => {
    const {manager, onError} = createManager()

    await expect(
      manager.present(PLUGIN_A, 'MissingView'),
    ).rejects.toHaveProperty('code', 'invalid_argument')
    await expect(
      manager.present(PLUGIN_A, 'AlphaView', {payload: 'x'.repeat(64 * 1024)}),
    ).rejects.toHaveProperty('code', 'too_large')
    await expect(
      manager.present(
        PLUGIN_A,
        'AlphaView',
        {},
        {
          detents: ['huge'] as unknown as NativeSheetDetent[],
        },
      ),
    ).rejects.toHaveProperty('code', 'invalid_argument')
    await expect(
      manager.present(
        PLUGIN_A,
        'AlphaView',
        {},
        {
          mode: 'drawer' as unknown as NativePresentationOptions['mode'],
        },
      ),
    ).rejects.toHaveProperty('code', 'invalid_argument')

    expect(onError).toHaveBeenCalledTimes(4)
    expect(manager.getActive()).toBeUndefined()
  })

  test('a plugin cannot dismiss or replace another plugin surface', async () => {
    const {manager} = createManager()
    await manager.present(PLUGIN_A, 'AlphaView')

    await expect(manager.dismiss(PLUGIN_B)).rejects.toHaveProperty(
      'code',
      'invalid_argument',
    )
    expect(manager.getActive()?.pluginId).toBe(PLUGIN_A)

    await expect(manager.present(PLUGIN_B, 'BetaView')).rejects.toHaveProperty(
      'code',
      'unavailable',
    )
    expect(manager.getActive()?.pluginId).toBe(PLUGIN_A)

    await expect(manager.dismiss(PLUGIN_A, 'BetaView')).rejects.toHaveProperty(
      'code',
      'invalid_argument',
    )
    expect(manager.getActive()?.pluginId).toBe(PLUGIN_A)

    manager.dismissPlugin(PLUGIN_B)
    expect(manager.getActive()?.pluginId).toBe(PLUGIN_A)

    manager.dismissPlugin(PLUGIN_A)
    expect(manager.getActive()).toBeUndefined()
  })

  test('rejects dismissal when nothing is open', async () => {
    const {manager} = createManager()

    await expect(manager.dismiss(PLUGIN_A)).rejects.toHaveProperty(
      'code',
      'invalid_argument',
    )
  })

  test('shuts down all surfaces on dispose', async () => {
    const {manager} = createManager()
    await manager.present(PLUGIN_A, 'AlphaView')

    manager.dispose()

    expect(manager.getActive()).toBeUndefined()
    await expect(manager.present(PLUGIN_A, 'AlphaView')).rejects.toHaveProperty(
      'code',
      'host_shutdown',
    )
  })
})

describe('NativePluginSurfaceHost', () => {
  test('renders the active surface and removes it after dismissal', async () => {
    const {manager} = createManager()
    render(
      <NativePluginViewProvider entries={ENTRIES}>
        <NativePluginSurfaceHost manager={manager} />
      </NativePluginViewProvider>,
    )

    expect(screen.queryByText('语音评论')).toBeNull()

    await act(async () => {
      await manager.present(PLUGIN_A, 'AlphaView', {}, {title: '语音评论'})
    })
    expect(screen.getByText('语音评论')).toBeTruthy()

    act(() => {
      manager.dismissPlugin(PLUGIN_A)
    })
    await waitFor(() => expect(screen.queryByText('语音评论')).toBeNull())
  })

  test('host chrome closes the manager surface', async () => {
    const {manager} = createManager()
    render(
      <NativePluginViewProvider entries={ENTRIES}>
        <NativePluginSurfaceHost manager={manager} />
      </NativePluginViewProvider>,
    )

    await act(async () => {
      await manager.present(PLUGIN_A, 'AlphaView', {}, {title: '语音评论'})
    })

    fireEvent.press(screen.getByTestId('native-plugin-surface-close'))

    await waitFor(() => expect(manager.getActive()).toBeUndefined())
  })
})
