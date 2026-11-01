import {useState} from 'react'
import {Modal, Pressable, ScrollView, View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {type PluginSlotProps} from '../../../sdk'
import {bookmarkAuthorName, type BookmarkItem, bookmarksPostLink} from '../data'
import {useBookmarks} from '../useBookmarks'

export function BookmarksComposerToolbar({
  context,
  host,
}: PluginSlotProps<'composer.toolbar'>) {
  const t = useTheme()
  const storage = host.storage
  const {state} = useBookmarks(storage)
  const [open, setOpen] = useState(false)

  if (!storage) return null

  const insertable = state.items.filter(
    item => bookmarksPostLink(item) !== undefined,
  )

  const close = () => setOpen(false)

  const insert = (item: BookmarkItem) => {
    const link = bookmarksPostLink(item)
    if (!link) return
    context.insertText(link)
    setOpen(false)
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="插入收藏"
        accessibilityHint="从收藏中选择一条帖子并插入链接"
        accessibilityState={{expanded: open}}
        onPress={() => setOpen(true)}
        style={[
          a.flex_row,
          a.align_center,
          a.px_sm,
          a.py_xs,
          a.rounded_sm,
          t.atoms.bg_contrast_25,
        ]}>
        <Text style={[a.text_sm, a.font_medium, t.atoms.text]}>
          <Trans>插入收藏</Trans>
        </Text>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={close}
        accessibilityViewIsModal>
        <View
          style={[
            a.flex_1,
            a.justify_center,
            a.px_xl,
            {backgroundColor: 'rgba(0, 0, 0, 0.4)'},
          ]}>
          <View style={[a.rounded_md, a.p_md, a.gap_sm, t.atoms.bg]}>
            <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
              <Trans>选择要插入的收藏</Trans>
            </Text>

            {state.status === 'loading' ? (
              <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                <Trans>正在读取收藏。</Trans>
              </Text>
            ) : null}

            {state.status === 'error' ? (
              <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                <Trans>收藏读取失败，请稍后重试。</Trans>
              </Text>
            ) : null}

            {state.status === 'ready' && insertable.length === 0 ? (
              <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                <Trans>暂无收藏。收藏帖子后即可在发帖时插入链接。</Trans>
              </Text>
            ) : null}

            {insertable.length > 0 ? (
              <ScrollView style={{maxHeight: 360}}>
                {insertable.map(item => {
                  const author = bookmarkAuthorName(item)
                  return (
                    <View
                      key={item.uri}
                      style={[
                        a.flex_row,
                        a.align_center,
                        a.gap_sm,
                        a.py_sm,
                        a.border_b,
                        t.atoms.border_contrast_low,
                      ]}>
                      <View style={[a.flex_1, a.gap_xs]}>
                        <Text
                          numberOfLines={1}
                          style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
                          {author}
                        </Text>
                        <Text
                          numberOfLines={2}
                          style={[a.text_xs, t.atoms.text_contrast_medium]}>
                          {item.textExcerpt || '（无文字内容）'}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`插入收藏链接：${author}`}
                        accessibilityHint="将帖子链接追加到正文"
                        onPress={() => insert(item)}
                        style={[
                          a.px_sm,
                          a.py_xs,
                          a.rounded_sm,
                          t.atoms.bg_contrast_25,
                        ]}>
                        <Text style={[a.text_sm, a.font_medium, t.atoms.text]}>
                          <Trans>插入</Trans>
                        </Text>
                      </Pressable>
                    </View>
                  )
                })}
              </ScrollView>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭收藏列表"
              accessibilityHint="关闭后返回发帖界面"
              onPress={close}
              style={[
                a.self_end,
                a.px_sm,
                a.py_xs,
                a.rounded_sm,
                t.atoms.bg_contrast_25,
              ]}>
              <Text style={[a.text_sm, a.font_medium, t.atoms.text]}>
                <Trans>关闭</Trans>
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  )
}
