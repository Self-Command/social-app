import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {
  type PublicAnnouncement,
  useAnnouncementsQuery,
} from '#/state/queries/announcements'
import {atoms as a, useTheme} from '#/alf'
import {ANNOUNCEMENT_LEVEL_META} from '#/components/announcements/announcement'
import {Button, ButtonText} from '#/components/Button'
import * as Layout from '#/components/Layout'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'

const announcementDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/**
 * Format an optional announcement timestamp. Returns undefined when the value
 * is missing or cannot be parsed, in which case the time window is omitted.
 */
function formatAnnouncementDate(value: string | undefined) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return announcementDateFormatter.format(date)
}

export function AnnouncementsScreen() {
  const t = useTheme()
  const {t: l} = useLingui()
  const {data, isLoading, isError, isFetching, refetch} =
    useAnnouncementsQuery()
  const announcements = data ?? []
  const showCenteredState =
    isLoading || (isError && data === undefined) || announcements.length === 0

  return (
    <Layout.Screen testID="announcementsScreen">
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          <Layout.Header.TitleText>{l`公告`}</Layout.Header.TitleText>
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      <Layout.Content
        testID="announcementsContent"
        contentContainerStyle={[
          a.flex_grow,
          a.px_lg,
          a.py_lg,
          showCenteredState && a.justify_center,
        ]}>
        {isLoading ? (
          <StateView
            testID="announcementsLoading"
            accessibilityRole="progressbar"
            accessibilityLabel={l`正在加载公告`}
            accessibilityHint="">
            <Loader size="xl" />
            <Text
              style={[
                a.text_md,
                a.leading_snug,
                a.text_center,
                t.atoms.text_contrast_medium,
              ]}>
              {l`正在加载公告`}
            </Text>
          </StateView>
        ) : isError && data === undefined ? (
          <StateView testID="announcementsError">
            <Text style={[a.text_xl, a.font_bold, a.text_center, t.atoms.text]}>
              {l`公告加载失败`}
            </Text>
            <Text
              style={[
                a.text_md,
                a.leading_snug,
                a.text_center,
                t.atoms.text_contrast_medium,
              ]}>
              {l`请检查网络连接后重试。`}
            </Text>
            <Button
              testID="announcementsRetryButton"
              label={l`重试`}
              onPress={() => void refetch()}
              disabled={isFetching}
              color="secondary"
              size="small">
              <ButtonText>{l`重试`}</ButtonText>
            </Button>
          </StateView>
        ) : announcements.length === 0 ? (
          <StateView testID="announcementsEmpty">
            <Text style={[a.text_xl, a.font_bold, a.text_center, t.atoms.text]}>
              {l`当前没有公告`}
            </Text>
            <Text
              style={[
                a.text_md,
                a.leading_snug,
                a.text_center,
                t.atoms.text_contrast_medium,
              ]}>
              {l`有新公告发布后会显示在这里。`}
            </Text>
          </StateView>
        ) : (
          <View style={[a.gap_lg]}>
            {isError ? (
              <View
                testID="announcementsRefreshError"
                style={[
                  a.flex_row,
                  a.align_center,
                  a.justify_between,
                  a.gap_md,
                  a.p_md,
                  a.rounded_sm,
                  a.border,
                  t.atoms.border_contrast_low,
                ]}>
                <Text
                  style={[
                    a.flex_1,
                    a.text_sm,
                    a.leading_snug,
                    t.atoms.text_contrast_medium,
                  ]}>
                  {l`公告可能不是最新内容，请稍后重试。`}
                </Text>
                <Button
                  label={l`重试`}
                  onPress={() => void refetch()}
                  disabled={isFetching}
                  color="secondary"
                  size="small">
                  <ButtonText>{l`重试`}</ButtonText>
                </Button>
              </View>
            ) : undefined}
            {announcements.map((announcement, index) => (
              <AnnouncementItem
                key={`${announcement.level}-${index}`}
                announcement={announcement}
              />
            ))}
          </View>
        )}
      </Layout.Content>
    </Layout.Screen>
  )
}

function StateView({children, ...props}: React.ComponentProps<typeof View>) {
  return (
    <View
      style={[a.flex_1, a.align_center, a.justify_center, a.gap_md, a.py_5xl]}
      {...props}>
      {children}
    </View>
  )
}

function AnnouncementItem({announcement}: {announcement: PublicAnnouncement}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const meta = ANNOUNCEMENT_LEVEL_META[announcement.level]
  const levelColor = {
    info: t.palette.primary_500,
    warning: t.palette.yellow,
    error: t.palette.negative_500,
  }[meta.admonition]
  const startsAt = formatAnnouncementDate(announcement.startsAt)
  const endsAt = formatAnnouncementDate(announcement.endsAt)
  const hasUnparseableDate =
    (announcement.startsAt !== undefined && startsAt === undefined) ||
    (announcement.endsAt !== undefined && endsAt === undefined)

  let timeWindow: string | undefined
  if (!hasUnparseableDate) {
    if (startsAt && endsAt) {
      timeWindow = l`展示时间：${startsAt} 至 ${endsAt}`
    } else if (startsAt) {
      timeWindow = l`开始时间：${startsAt}`
    } else if (endsAt) {
      timeWindow = l`结束时间：${endsAt}`
    }
  }

  return (
    <View
      testID="announcementItem"
      style={[
        a.gap_sm,
        a.p_lg,
        a.rounded_sm,
        a.border,
        t.atoms.bg_contrast_25,
        t.atoms.border_contrast_low,
      ]}>
      <View style={[a.flex_row, a.align_center]}>
        <View
          style={[
            a.px_sm,
            a.py_2xs,
            a.rounded_sm,
            a.border,
            {borderColor: levelColor},
          ]}>
          <Text
            testID="announcementLevel"
            style={[a.text_xs, a.font_medium, t.atoms.text]}>
            {meta.label}
          </Text>
        </View>
      </View>
      <Text
        emoji
        accessibilityRole="header"
        testID="announcementTitle"
        style={[a.text_lg, a.font_bold, t.atoms.text]}>
        {announcement.title}
      </Text>
      <Text
        emoji
        testID="announcementBody"
        style={[a.text_md, a.leading_snug, t.atoms.text]}>
        {announcement.body}
      </Text>
      {timeWindow ? (
        <Text
          testID="announcementTimeWindow"
          style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
          {timeWindow}
        </Text>
      ) : undefined}
    </View>
  )
}
