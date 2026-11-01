import {View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {type NativeSkipReason} from '../native/errors'
import {usePluginHost} from '../runtime/plugin-context'

const SKIP_REASON_LABELS: Record<NativeSkipReason, string> = {
  native_api_mismatch: '原生接口版本不匹配',
  host_api_mismatch: '宿主接口版本不匹配',
  manifest_mismatch: '清单与锁不一致',
  native_not_compiled: '未编译进当前客户端',
  native_module_missing: '原生模块缺失',
  native_view_missing: '原生视图缺失',
  min_app_version: 'App 版本过低',
  revoked: '授权已撤回',
  disabled: '已禁用',
  circuit_open: '连续失败已熔断',
}

function Row({label, value}: {label: string; value: string}) {
  const t = useTheme()
  return (
    <View style={[a.flex_row, a.gap_md, a.py_2xs]}>
      <Text
        style={[
          a.text_sm,
          t.atoms.text_contrast_medium,
          a.flex_shrink_0,
          {minWidth: 96},
        ]}>
        {label}
      </Text>
      <Text style={[a.text_sm, a.flex_1, t.atoms.text]} selectable>
        {value}
      </Text>
    </View>
  )
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', {hour12: false})
}

/**
 * Native lock, compiled plugins, skip reasons and recent errors. Rendered only
 * by the internal developer options, which are absent from production builds.
 */
export function PluginDiagnostics() {
  const t = useTheme()
  const host = usePluginHost()

  if (!host) return null

  const details = host.nativeDiagnostics

  return (
    <View style={[a.p_xl, a.gap_sm]}>
      <Text style={[a.text_lg, a.font_semi_bold, t.atoms.text]}>
        <Trans>插件诊断</Trans>
      </Text>
      {!details ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>当前平台未启用原生插件运行时。</Trans>
        </Text>
      ) : (
        <>
          <Row label="原生接口版本" value={String(details.nativeApi)} />
          <Row
            label="锁版本"
            value={
              details.lockVersion === null ? '无' : String(details.lockVersion)
            }
          />
          <Row label="锁哈希" value={details.lockHash ?? '无'} />
          <Row
            label="已编译插件"
            value={
              details.compiled.length === 0
                ? '无'
                : details.compiled
                    .map(entry => `${entry.id}@${entry.version}`)
                    .join('、')
            }
          />
          <Row
            label="已加载插件"
            value={
              details.loaded.length === 0 ? '无' : details.loaded.join('、')
            }
          />
          <Row
            label="跳过原因"
            value={
              details.skips.length === 0
                ? '无'
                : details.skips
                    .map(
                      skip =>
                        `${skip.pluginId}：${SKIP_REASON_LABELS[skip.reason]}`,
                    )
                    .join('；')
            }
          />
          <Row
            label="熔断插件"
            value={
              details.brokenIds.length === 0
                ? '无'
                : details.brokenIds.join('、')
            }
          />
          <Row
            label="最近错误"
            value={
              details.recentErrors.length === 0
                ? '无'
                : details.recentErrors
                    .map(
                      error =>
                        `${formatTime(error.at)} ${error.pluginId} ${error.code}`,
                    )
                    .join('；')
            }
          />
        </>
      )}
    </View>
  )
}
