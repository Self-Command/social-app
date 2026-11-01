import {useCallback, useMemo} from 'react'
import {RichText} from '@bsky/sdk/richtext'

import {PluginSlot} from '../runtime/PluginSlot'
import {type ComposerToolbarContext} from '../sdk'

/**
 * Appends plugin text without replacing what the user already wrote. A single
 * space separates the insertion when the existing text does not end with
 * whitespace, so the link stays readable.
 */
export function appendPluginText(current: string, insertion: string): string {
  if (insertion.length === 0) return current
  if (current.length === 0) return insertion
  return /\s$/.test(current) ? current + insertion : `${current} ${insertion}`
}

export type ComposerToolbarSlotProps = {
  text: string
  onChangeRichText: (richText: RichText) => void
  onCloseComposer: () => void
}

export function ComposerToolbarSlot({
  text,
  onChangeRichText,
  onCloseComposer,
}: ComposerToolbarSlotProps) {
  const insertText = useCallback(
    (insertion: string) => {
      const nextText = appendPluginText(text, insertion)
      if (nextText === text) return
      const richText = new RichText({text: nextText})
      richText.detectFacetsWithoutResolution()
      onChangeRichText(richText)
    },
    [onChangeRichText, text],
  )

  const context = useMemo<ComposerToolbarContext>(
    () => ({
      insertText,
      getText: () => text,
      closeComposer: onCloseComposer,
    }),
    [insertText, onCloseComposer, text],
  )

  return <PluginSlot id="composer.toolbar" context={context} />
}
