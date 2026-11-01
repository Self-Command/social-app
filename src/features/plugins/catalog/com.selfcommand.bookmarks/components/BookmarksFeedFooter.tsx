import {useState} from 'react'
import {Pressable, View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {type PluginSlotProps} from '../../../sdk'
import {readMaxItems} from '../data'
import {useBookmarks} from '../useBookmarks'

export function BookmarksFeedFooter({
  context,
  settings,
  host,
}: PluginSlotProps<'feed.item.footer'>) {
  const t = useTheme()
  const storage = host.storage
  const toast = host.toast
  const {store, state} = useBookmarks(storage)
  const [busy, setBusy] = useState(false)

  if (!storage) return null

  const maxItems = readMaxItems(settings)
  const saved = state.items.some(item => item.uri === context.uri)
  const ready = state.status === 'ready' && store !== undefined

  const toggle = async () => {
    if (!store || busy) return
    setBusy(true)
    try {
      if (saved) {
        await store.remove(context.uri)
        toast?.show('已取消收藏。')
        return
      }
      const result = await store.add(
        {
          uri: context.uri,
          cid: context.cid,
          authorDid: context.authorDid,
          authorHandle: context.authorHandle,
          authorDisplayName: context.authorDisplayName,
          text: context.text,
          createdAt: context.createdAt,
        },
        maxItems,
      )
      if (result === 'added') {
        toast?.show('已收藏该帖子。')
      } else if (result === 'limit') {
        toast?.show(
          `收藏数量已达上限（${maxItems} 条）。请先在设置中删除部分收藏后再试。`,
        )
      }
    } catch {
      toast?.show('收藏操作失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[a.flex_row, a.align_center, a.justify_end, a.px_xl, a.pb_sm]}>
      <Pressable
        testID="bookmarks-feed-toggle"
        accessibilityRole="button"
        accessibilityLabel={saved ? '取消收藏' : '收藏帖子'}
        accessibilityHint={
          saved ? '从本地收藏中移除这条帖子' : '将这条帖子保存到本地收藏'
        }
        accessibilityState={{selected: saved, disabled: !ready || busy}}
        disabled={!ready || busy}
        onPress={toggle}
        style={[
          a.flex_row,
          a.align_center,
          a.gap_xs,
          a.px_sm,
          a.py_xs,
          a.rounded_sm,
          t.atoms.bg_contrast_25,
        ]}>
        <Text
          style={[
            a.text_sm,
            saved ? a.font_semi_bold : a.font_medium,
            saved
              ? {color: t.palette.primary_500}
              : t.atoms.text_contrast_medium,
          ]}>
          {saved ? <Trans>已收藏</Trans> : <Trans>收藏</Trans>}
        </Text>
      </Pressable>
    </View>
  )
}
