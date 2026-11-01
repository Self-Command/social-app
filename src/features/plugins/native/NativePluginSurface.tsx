import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  AccessibilityInfo,
  Modal,
  PanResponder,
  Pressable,
  useWindowDimensions,
  View,
} from 'react-native'
import {useSafeAreaInsets} from 'react-native-safe-area-context'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {NativePluginViewContent} from './NativePluginView'
import {
  NATIVE_SURFACE_TITLE_MAX_LENGTH,
  type NativeSurfaceManager,
} from './surface-manager'
import {type NativePluginSurfaceProps, type NativeSheetDetent} from './types'

const DEFAULT_SURFACE_TITLE = '扩展功能'
const HEADER_HEIGHT = 64
const MEDIUM_HEIGHT_RATIO = 0.55
const LARGE_HEIGHT_RATIO = 0.92
const DRAG_THRESHOLD = 72
const BACKDROP_COLOR = 'rgba(0, 0, 0, 0.45)'

export type NativeSurfaceGestureAction =
  'dismiss' | 'expand' | 'collapse' | 'none'

export function resolveNativeSurfaceTitle(title: unknown): string {
  if (typeof title !== 'string') return DEFAULT_SURFACE_TITLE
  const trimmed = title.trim().slice(0, NATIVE_SURFACE_TITLE_MAX_LENGTH)
  return trimmed || DEFAULT_SURFACE_TITLE
}

export function resolveNativeSurfaceGesture({
  dy,
  detentIndex,
  detentCount,
}: {
  dy: number
  detentIndex: number
  detentCount: number
}): NativeSurfaceGestureAction {
  if (!Number.isFinite(dy) || detentCount <= 0) return 'none'
  const index = Math.max(0, Math.min(detentIndex, detentCount - 1))
  if (dy <= -DRAG_THRESHOLD) {
    return index < detentCount - 1 ? 'expand' : 'none'
  }
  if (dy >= DRAG_THRESHOLD) {
    return index > 0 ? 'collapse' : 'dismiss'
  }
  return 'none'
}

function normalizeDetents(
  detents: readonly NativeSheetDetent[] | undefined,
): NativeSheetDetent[] {
  const result: NativeSheetDetent[] = []
  for (const detent of detents ?? ['medium']) {
    if (
      (detent === 'medium' || detent === 'large') &&
      !result.includes(detent)
    ) {
      result.push(detent)
    }
  }
  return result.length > 0 ? result : ['medium']
}

/**
 * Host-owned modal surface. The plugin only supplies its native view and JSON
 * props; the title, close button, safe area, gesture and focus handling stay
 * outside the plugin's reach.
 */
export function NativePluginSurface({
  visible,
  presentation,
  onDismiss,
  pluginId,
  view,
  heightMode,
  props,
  accessibilityLabel,
  accessibilityHint,
  onEvent,
  onResize,
  onError,
}: NativePluginSurfaceProps) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const {height: windowHeight} = useWindowDimensions()

  const mode = presentation?.mode === 'fullscreen' ? 'fullscreen' : 'sheet'
  const title = resolveNativeSurfaceTitle(presentation?.title)
  const detents = useMemo(
    () => normalizeDetents(presentation?.detents),
    [presentation?.detents],
  )

  const [detentIndex, setDetentIndex] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(false)

  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const closedRef = useRef(false)

  useEffect(() => {
    if (visible) closedRef.current = false
  }, [visible, pluginId, view])

  useEffect(() => {
    setDetentIndex(0)
  }, [visible, pluginId, view])

  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then(value => {
        if (mounted) setReduceMotion(Boolean(value))
      })
      .catch(() => {})
    let subscription: {remove: () => void} | undefined
    try {
      subscription = AccessibilityInfo.addEventListener(
        'reduceMotionChanged',
        value => setReduceMotion(Boolean(value)),
      )
    } catch {
      // Older platforms may not expose the reduce-motion subscription.
    }
    return () => {
      mounted = false
      subscription?.remove()
    }
  }, [])

  const handleClose = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    onDismissRef.current()
  }, [])

  const heightLimit = Math.max(0, Math.floor(windowHeight - insets.top))
  const detentHeights = useMemo(
    () =>
      detents.map(detent =>
        Math.min(
          heightLimit,
          Math.round(
            windowHeight *
              (detent === 'large' ? LARGE_HEIGHT_RATIO : MEDIUM_HEIGHT_RATIO),
          ),
        ),
      ),
    [detents, heightLimit, windowHeight],
  )
  const safeDetentIndex = Math.min(detentIndex, detentHeights.length - 1)
  const sheetHeight =
    detentHeights[safeDetentIndex] ??
    Math.min(heightLimit, Math.round(windowHeight * MEDIUM_HEIGHT_RATIO))
  const contentMaxHeight = Math.max(
    0,
    (mode === 'fullscreen'
      ? windowHeight - insets.top - insets.bottom
      : sheetHeight - insets.bottom) - HEADER_HEIGHT,
  )

  const detentCountRef = useRef(detentHeights.length)
  detentCountRef.current = detentHeights.length
  const detentIndexRef = useRef(safeDetentIndex)
  detentIndexRef.current = safeDetentIndex

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > 8 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          const action = resolveNativeSurfaceGesture({
            dy: gesture.dy,
            detentIndex: detentIndexRef.current,
            detentCount: detentCountRef.current,
          })
          if (action === 'dismiss') {
            handleClose()
          } else if (action === 'expand') {
            setDetentIndex(index =>
              Math.min(index + 1, detentCountRef.current - 1),
            )
          } else if (action === 'collapse') {
            setDetentIndex(index => Math.max(index - 1, 0))
          }
        },
      }),
    [handleClose],
  )

  if (!visible) return null

  const header = (
    <View
      testID="native-plugin-surface-header"
      {...(mode === 'sheet' ? panResponder.panHandlers : {})}
      style={[a.flex_row, a.align_center, a.gap_sm, a.px_lg, a.pt_md, a.pb_sm]}>
      <View style={[a.flex_1, a.gap_xs]}>
        {mode === 'sheet' ? (
          <View
            testID="native-plugin-surface-handle"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              a.self_center,
              {width: 36, height: 4, borderRadius: 2, marginBottom: 2},
              t.atoms.bg_contrast_25,
            ]}
          />
        ) : null}
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
          {title}
        </Text>
      </View>
      <Pressable
        testID="native-plugin-surface-close"
        onPress={handleClose}
        accessibilityRole="button"
        accessibilityLabel="关闭"
        accessibilityHint="关闭当前插件界面"
        hitSlop={8}
        style={[
          a.rounded_full,
          a.align_center,
          a.justify_center,
          {minWidth: 44, minHeight: 44},
          t.atoms.bg_contrast_25,
        ]}>
        <Text style={[a.text_sm, a.font_medium, t.atoms.text]}>关闭</Text>
      </Pressable>
    </View>
  )

  const content = (
    <View style={[a.flex_1, {maxHeight: contentMaxHeight}]}>
      <NativePluginViewContent
        pluginId={pluginId}
        view={view}
        heightMode={heightMode}
        props={props}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        maxHeight={contentMaxHeight}
        onEvent={onEvent}
        onResize={onResize}
        onError={onError}
      />
    </View>
  )

  return (
    <Modal
      visible
      transparent={mode === 'sheet'}
      animationType={
        reduceMotion ? 'none' : mode === 'sheet' ? 'fade' : 'slide'
      }
      presentationStyle={
        mode === 'fullscreen' ? 'fullScreen' : 'overFullScreen'
      }
      statusBarTranslucent
      onRequestClose={handleClose}>
      {mode === 'sheet' ? (
        <View style={[a.flex_1, {backgroundColor: BACKDROP_COLOR}]}>
          <Pressable
            testID="native-plugin-surface-backdrop"
            style={a.flex_1}
            onPress={handleClose}
            accessible={false}
          />
          <View
            testID="native-plugin-surface-sheet"
            accessibilityViewIsModal
            onAccessibilityEscape={handleClose}
            style={[
              a.w_full,
              a.border_t,
              t.atoms.border_contrast_low,
              t.atoms.bg,
              {
                height: sheetHeight,
                paddingBottom: insets.bottom,
                borderTopLeftRadius: 16,
                borderTopRightRadius: 16,
              },
            ]}>
            {header}
            {content}
          </View>
        </View>
      ) : (
        <View
          testID="native-plugin-surface-fullscreen"
          accessibilityViewIsModal
          onAccessibilityEscape={handleClose}
          style={[
            a.flex_1,
            t.atoms.bg,
            {paddingTop: insets.top, paddingBottom: insets.bottom},
          ]}>
          {header}
          {content}
        </View>
      )}
    </Modal>
  )
}

/**
 * Bridges the host API surface manager to React. Only the plugin that opened
 * the surface can close it; the close control belongs to the host chrome.
 */
export function NativePluginSurfaceHost({
  manager,
}: {
  manager: NativeSurfaceManager
}) {
  const active = useSyncExternalStore(
    manager.subscribe,
    manager.getActive,
    manager.getActive,
  )

  if (!active) return null

  return (
    <NativePluginSurface
      visible
      pluginId={active.pluginId}
      view={active.view}
      props={active.props}
      presentation={active.presentation}
      onDismiss={() => {
        void manager.dismiss(active.pluginId, active.view).catch(() => {})
      }}
    />
  )
}
