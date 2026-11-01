import {View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {usePluginHost} from '../runtime/plugin-context'
import {getPluginsForSlot, PluginSlot} from '../runtime/PluginSlot'
import {type SettingsSectionContext} from '../sdk'

const SETTINGS_CONTEXT: SettingsSectionContext = {}

/**
 * Host-owned section container and title for the settings slot. Plugins render
 * their own rows inside it; when no plugin is active nothing is rendered, so
 * the existing settings layout is unchanged.
 */
export function SettingsSectionSlot() {
  const host = usePluginHost()
  const t = useTheme()

  if (!host) return null
  if (getPluginsForSlot(host.plugins, 'settings.main.section').length === 0) {
    return null
  }

  return (
    <>
      <View
        style={[a.border_t, t.atoms.border_contrast_low, a.w_full, a.my_sm]}
      />
      <View style={[a.px_xl, a.pt_md, a.pb_sm]}>
        <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
          <Trans>扩展功能</Trans>
        </Text>
      </View>
      <PluginSlot id="settings.main.section" context={SETTINGS_CONTEXT} />
    </>
  )
}
