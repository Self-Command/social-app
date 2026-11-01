import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Platform, useWindowDimensions, View} from 'react-native'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {createNativePluginError, mapNativePluginError} from './errors'
import {resolveNativeView} from './native-view-resolver'
import {
  validateNativeViewEventPayload,
  validateNativeViewProps,
} from './payload'
import {
  type NativeViewDiagnostic,
  useNativePluginViewContext,
} from './registry-context'
import {type NativePluginError, type NativePluginViewProps} from './types'

export const NATIVE_PLUGIN_VIEW_MAX_HEIGHT_RATIO = 0.8
const MAX_EVENT_NAME_LENGTH = 64

export type NativePluginViewContentProps = NativePluginViewProps & {
  readonly maxHeight: number
}

/**
 * Inline container for one compiled plugin view. The registry is the only
 * source of renderable plugin/view pairs; the host owns sizing, payload limits
 * and the error state.
 */
export function NativePluginView(props: NativePluginViewProps) {
  const {height} = useWindowDimensions()
  const maxHeight = Math.max(
    0,
    Math.floor(height * NATIVE_PLUGIN_VIEW_MAX_HEIGHT_RATIO),
  )
  return <NativePluginViewContent {...props} maxHeight={maxHeight} />
}

export function NativePluginViewContent({
  pluginId,
  view,
  heightMode,
  props: viewProps,
  accessibilityLabel,
  accessibilityHint,
  maxHeight,
  onEvent,
  onResize,
  onError,
}: NativePluginViewContentProps) {
  const t = useTheme()
  const bridge = useNativePluginViewContext()

  const onEventRef = useRef(onEvent)
  const onResizeRef = useRef(onResize)
  const onErrorRef = useRef(onError)
  onEventRef.current = onEvent
  onResizeRef.current = onResize
  onErrorRef.current = onError

  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const [runtimeError, setRuntimeError] = useState<
    NativePluginError | undefined
  >()

  const entry = useMemo(
    () => bridge.entries.find(candidate => candidate.id === pluginId),
    [bridge.entries, pluginId],
  )
  const declaration = useMemo(
    () => entry?.views.find(candidate => candidate.name === view),
    [entry, view],
  )
  const isNativePlatform = Platform.OS === 'ios' || Platform.OS === 'android'

  const propsResult = useMemo(
    () => validateNativeViewProps(viewProps),
    [viewProps],
  )
  const propsError = propsResult.ok ? undefined : propsResult.error

  const modeError = useMemo(() => {
    if (!declaration) return undefined
    if (heightMode && heightMode !== declaration.heightMode) {
      return createNativePluginError(
        'invalid_argument',
        '视图高度模式与已安装版本不一致，无法显示。',
      )
    }
    return undefined
  }, [declaration, heightMode])

  const resolved = useMemo(() => {
    if (!isNativePlatform || !entry || !declaration) return undefined
    return resolveNativeView(entry, view)
  }, [declaration, entry, isNativePlatform, view])

  const missingError = useMemo(() => {
    if (!isNativePlatform) return undefined
    if (!entry) {
      return createNativePluginError(
        'unavailable',
        '当前应用版本未包含该插件，请更新应用后重试。',
      )
    }
    if (!declaration) {
      return createNativePluginError(
        'unavailable',
        '当前应用版本不包含该插件视图，请更新应用后重试。',
      )
    }
    if (resolved?.status === 'missing') {
      return createNativePluginError(
        'unavailable',
        resolved.reason === 'native_view_load_failed'
          ? '插件视图加载失败，请更新应用后重试。'
          : '当前应用版本不包含该插件视图，请更新应用后重试。',
      )
    }
    return undefined
  }, [declaration, entry, isNativePlatform, resolved])

  const error = missingError ?? propsError ?? modeError ?? runtimeError

  const diagnostic = useMemo<NativeViewDiagnostic | undefined>(() => {
    if (!isNativePlatform) return undefined
    if (!entry || !declaration) return 'native_view_not_found'
    if (resolved?.status === 'missing') return resolved.reason
    return undefined
  }, [declaration, entry, isNativePlatform, resolved])

  const reportDiagnostic = bridge.reportDiagnostic
  useEffect(() => {
    if (diagnostic) {
      reportDiagnostic(pluginId, diagnostic)
    }
  }, [diagnostic, pluginId, reportDiagnostic])

  const reportError = bridge.reportError
  const reportSuccess = bridge.reportSuccess
  const lastReportedErrorRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    lastReportedErrorRef.current = undefined
    setRuntimeError(undefined)
    setContentHeight(null)
  }, [pluginId, view])

  useEffect(() => {
    if (!error) {
      lastReportedErrorRef.current = undefined
      return
    }
    const key = `${error.code}:${error.message}`
    if (lastReportedErrorRef.current === key) return
    lastReportedErrorRef.current = key
    onErrorRef.current?.(error.code, error.message)
    reportError(pluginId, error)
  }, [error, pluginId, reportError])

  useEffect(() => {
    if (isNativePlatform && resolved?.status === 'resolved' && !error) {
      reportSuccess?.(pluginId)
    }
  }, [error, isNativePlatform, pluginId, reportSuccess, resolved])

  const reportEventError = useCallback((next: NativePluginError) => {
    setRuntimeError(current =>
      current?.code === next.code && current.message === next.message
        ? current
        : next,
    )
  }, [])

  const handleEvent = useCallback(
    (name: unknown, payload: unknown) => {
      if (
        typeof name !== 'string' ||
        name.trim().length === 0 ||
        name.length > MAX_EVENT_NAME_LENGTH
      ) {
        reportEventError(
          createNativePluginError(
            'invalid_argument',
            '插件事件名称无效，已忽略。',
          ),
        )
        return
      }
      const result = validateNativeViewEventPayload(payload)
      if (!result.ok) {
        reportEventError(result.error)
        return
      }
      onEventRef.current?.(name, result.value)
    },
    [reportEventError],
  )

  const handleResize = useCallback(
    (value: unknown) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        reportEventError(
          createNativePluginError(
            'invalid_argument',
            '插件视图高度无效，已忽略。',
          ),
        )
        return
      }
      const next = Math.min(Math.round(value), maxHeight)
      setContentHeight(current => (current === next ? current : next))
      onResizeRef.current?.(next)
    },
    [maxHeight, reportEventError],
  )

  const handleNativeError = useCallback(
    (value: unknown) => {
      reportEventError(mapNativePluginError(value))
    },
    [reportEventError],
  )

  if (!isNativePlatform) {
    return (
      <View
        testID="native-plugin-view-fallback"
        style={[a.w_full, a.p_md, a.rounded_md, t.atoms.bg_contrast_25]}>
        <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
          当前平台不支持原生视图，请使用 App。
        </Text>
      </View>
    )
  }

  if (error || !resolved || resolved.status !== 'resolved') {
    return (
      <View
        testID="native-plugin-view-error"
        style={[
          a.w_full,
          a.p_md,
          a.gap_xs,
          a.rounded_md,
          t.atoms.bg_contrast_25,
        ]}>
        <Text style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
          无法显示插件视图
        </Text>
        <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
          {error?.message ?? '插件视图暂时不可用，请稍后重试。'}
        </Text>
      </View>
    )
  }

  const NativeComponent = resolved.Component
  const heightStyle =
    declaration?.heightMode === 'content'
      ? {height: contentHeight ?? undefined, maxHeight}
      : {maxHeight}

  return (
    <View
      testID="native-plugin-view"
      style={[a.w_full, a.overflow_hidden, heightStyle]}>
      <NativeComponent
        {...viewProps}
        onEvent={handleEvent}
        onResize={handleResize}
        onError={handleNativeError}
        {...(accessibilityLabel ? {accessibilityLabel} : {})}
        {...(accessibilityHint ? {accessibilityHint} : {})}
      />
    </View>
  )
}
