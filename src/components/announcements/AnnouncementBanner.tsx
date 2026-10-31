import {Pressable, View} from 'react-native'
import {msg} from '@lingui/core/macro'
import {useLingui} from '@lingui/react'
import {type NavigationProp, useNavigation} from '@react-navigation/native'

import {type AllNavigatorParams} from '#/lib/routes/types'
import {useAnnouncementsQuery} from '#/state/queries/announcements'
import {atoms as a, useTheme, web} from '#/alf'
import * as Admonition from '#/components/Admonition'
import {Button, ButtonText} from '#/components/Button'
import {TimesLarge_Stroke2_Corner0_Rounded as CloseIcon} from '#/components/icons/Times'
import {Text} from '#/components/Typography'
import {device, useStorage} from '#/storage'
import {
  addDismissedAnnouncement,
  ANNOUNCEMENT_LEVEL_META,
  getAnnouncementFingerprint,
  selectBannerAnnouncement,
} from './announcement'

/**
 * The newest announcement that has not been dismissed on this device. It is
 * shown as the header of the home feed and scrolls with it.
 *
 * Announcement text is untrusted input: it is rendered as plain text and is
 * never parsed as HTML or Markdown, or turned into links. When there is
 * nothing to show, an empty view is returned so the feed header keeps a valid
 * element without taking up space.
 */
export function AnnouncementBanner(): React.ReactElement {
  const t = useTheme()
  const {_} = useLingui()
  const navigation = useNavigation<NavigationProp<AllNavigatorParams>>()
  const {data} = useAnnouncementsQuery()
  const [dismissed = [], setDismissed] = useStorage(device, [
    'dismissedAnnouncements',
  ])

  const announcement = selectBannerAnnouncement(data ?? [], dismissed)

  if (!announcement) {
    return <View />
  }

  const meta = ANNOUNCEMENT_LEVEL_META[announcement.level]

  const onPressDetails = () => {
    navigation.navigate('Announcements')
  }

  const onPressClose = () => {
    setDismissed(
      addDismissedAnnouncement(
        dismissed,
        getAnnouncementFingerprint(announcement),
      ),
    )
  }

  return (
    <View testID="announcementBanner" style={[a.px_lg, a.pt_md, a.pb_xs]}>
      <Admonition.Outer type={meta.admonition}>
        <Admonition.Row>
          <Admonition.Icon />
          <Admonition.Content>
            <Pressable
              onPress={onPressDetails}
              accessibilityRole="button"
              accessibilityLabel={_(msg`查看公告`)}
              accessibilityHint={_(msg`打开公告列表查看全部公告`)}
              style={[a.gap_sm, web({cursor: 'pointer'})]}>
              <Text
                style={[a.text_xs, a.font_bold, t.atoms.text_contrast_medium]}>
                {meta.label}
              </Text>
              <Text
                emoji
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[a.text_md, a.font_bold, t.atoms.text]}>
                {announcement.title}
              </Text>
              <Text
                emoji
                numberOfLines={3}
                ellipsizeMode="tail"
                style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_high]}>
                {announcement.body}
              </Text>
            </Pressable>
            <Button
              label={_(msg`查看公告详情`)}
              size="small"
              color="secondary"
              onPress={onPressDetails}
              style={[a.self_start]}>
              <ButtonText>
                {_(msg({message: '查看详情', context: '公告横幅'}))}
              </ButtonText>
            </Button>
          </Admonition.Content>
          <Admonition.Button
            label={_(msg`关闭公告`)}
            shape="round"
            onPress={onPressClose}>
            <CloseIcon size="sm" fill={t.atoms.text_contrast_medium.color} />
          </Admonition.Button>
        </Admonition.Row>
      </Admonition.Outer>
    </View>
  )
}
