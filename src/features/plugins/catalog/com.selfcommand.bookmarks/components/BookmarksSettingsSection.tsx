import {useState} from 'react'
import {Pressable, View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {type PluginSlotProps} from '../../../sdk'
import {
  bookmarkAuthorName,
  type BookmarkItem,
  formatSavedAt,
  readMaxItems,
} from '../data'
import {useBookmarks} from '../useBookmarks'

const buttonText = [a.text_sm, a.font_medium] as const

export function BookmarksSettingsSection({
  settings,
  host,
}: PluginSlotProps<'settings.main.section'>) {
  const t = useTheme()
  const storage = host.storage
  const toast = host.toast
  const {store, state} = useBookmarks(storage)
  const [busy, setBusy] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)

  if (!storage) return null

  const maxItems = readMaxItems(settings)

  const deleteItem = async (item: BookmarkItem) => {
    if (!store || busy) return
    setBusy(true)
    try {
      await store.remove(item.uri)
      toast?.show('已删除该收藏。')
    } catch {
      toast?.show('删除失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  const clearAll = async () => {
    if (!store || busy) return
    setBusy(true)
    try {
      await store.clear()
      setConfirmingClear(false)
      toast?.show('已清空全部收藏。')
    } catch {
      toast?.show('清空失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[a.px_xl, a.gap_sm, a.pb_md]}>
      <View style={[a.flex_row, a.align_center, a.justify_between, a.gap_sm]}>
        <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
          <Trans>本地收藏</Trans>
        </Text>
        <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
          <Trans>
            已收藏 {state.items.length} 条，上限 {maxItems} 条
          </Trans>
        </Text>
      </View>

      {state.status === 'loading' ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>正在读取收藏。</Trans>
        </Text>
      ) : null}

      {state.status === 'error' ? (
        <View style={[a.gap_sm]}>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>收藏读取失败，请稍后重试。</Trans>
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重新加载收藏"
            accessibilityHint="重新读取当前账号的收藏列表"
            onPress={() => {
              void store?.reload()
            }}
            style={[
              a.self_start,
              a.px_sm,
              a.py_xs,
              a.rounded_sm,
              t.atoms.bg_contrast_25,
            ]}>
            <Text style={[buttonText, t.atoms.text]}>
              <Trans>重新加载</Trans>
            </Text>
          </Pressable>
        </View>
      ) : null}

      {state.status === 'ready' && state.items.length === 0 ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>
            暂无收藏。在帖子底部点击“收藏”，即可将帖子保存在当前账号中。
          </Trans>
        </Text>
      ) : null}

      {state.status === 'ready' && state.items.length > 0 ? (
        <>
          <View>
            {state.items.map(item => {
              const author = bookmarkAuthorName(item)
              return (
                <View
                  key={item.uri}
                  testID="bookmarks-item"
                  style={[
                    a.flex_row,
                    a.align_center,
                    a.gap_sm,
                    a.py_sm,
                    a.border_t,
                    t.atoms.border_contrast_low,
                  ]}>
                  <View style={[a.flex_1, a.gap_xs]}>
                    <Text
                      numberOfLines={1}
                      style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
                      {author}
                    </Text>
                    <Text
                      numberOfLines={3}
                      style={[a.text_sm, t.atoms.text_contrast_medium]}>
                      {item.textExcerpt || '（无文字内容）'}
                    </Text>
                    <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
                      <Trans>收藏于 {formatSavedAt(item.savedAt)}</Trans>
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`删除收藏：${author}`}
                    accessibilityHint="从本地收藏中移除这条帖子"
                    accessibilityState={{disabled: busy}}
                    disabled={busy}
                    onPress={() => {
                      void deleteItem(item)
                    }}
                    style={[
                      a.px_sm,
                      a.py_xs,
                      a.rounded_sm,
                      t.atoms.bg_contrast_25,
                    ]}>
                    <Text style={[buttonText, {color: t.palette.negative_500}]}>
                      <Trans>删除</Trans>
                    </Text>
                  </Pressable>
                </View>
              )
            })}
          </View>

          {confirmingClear ? (
            <View style={[a.gap_sm, a.pt_sm]}>
              <Text style={[a.text_sm, t.atoms.text]}>
                <Trans>确认清空全部收藏？此操作不可撤销。</Trans>
              </Text>
              <View style={[a.flex_row, a.gap_sm]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="确认清空收藏"
                  accessibilityHint="永久删除当前账号的全部收藏"
                  accessibilityState={{disabled: busy}}
                  disabled={busy}
                  onPress={() => {
                    void clearAll()
                  }}
                  style={[
                    a.px_sm,
                    a.py_xs,
                    a.rounded_sm,
                    t.atoms.bg_contrast_25,
                  ]}>
                  <Text style={[buttonText, {color: t.palette.negative_500}]}>
                    <Trans>确认清空</Trans>
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="取消清空"
                  accessibilityHint="保留全部收藏并返回收藏列表"
                  onPress={() => setConfirmingClear(false)}
                  style={[
                    a.px_sm,
                    a.py_xs,
                    a.rounded_sm,
                    t.atoms.bg_contrast_25,
                  ]}>
                  <Text style={[buttonText, t.atoms.text]}>
                    <Trans>取消</Trans>
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="清空全部收藏"
              accessibilityHint="清空当前账号的全部收藏，操作前需要确认"
              onPress={() => setConfirmingClear(true)}
              style={[
                a.self_start,
                a.px_sm,
                a.py_xs,
                a.rounded_sm,
                t.atoms.bg_contrast_25,
              ]}>
              <Text style={[buttonText, {color: t.palette.negative_500}]}>
                <Trans>清空全部收藏</Trans>
              </Text>
            </Pressable>
          )}
        </>
      ) : null}
    </View>
  )
}
