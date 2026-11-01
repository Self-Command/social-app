import {useMemo} from 'react'

import {type app} from '#/lexicons'
import {PluginSlot} from '../runtime/PluginSlot'
import {type FeedItemFooterContext} from '../sdk'

export type FeedItemFooterSlotProps = {
  post: app.bsky.feed.defs.PostView
  record: app.bsky.feed.post.Main
}

/**
 * Exposes only the public post fields described by the slot contract. The
 * moderation decision, viewer state and embeddings stay in the host.
 */
export function FeedItemFooterSlot({post, record}: FeedItemFooterSlotProps) {
  const {uri, cid, author} = post
  const {did, handle, displayName} = author
  const {text, createdAt} = record

  const context = useMemo<FeedItemFooterContext>(
    () => ({
      uri,
      cid,
      authorDid: did,
      authorHandle: handle,
      authorDisplayName: displayName,
      text,
      createdAt,
    }),
    [uri, cid, did, handle, displayName, text, createdAt],
  )

  return <PluginSlot id="feed.item.footer" context={context} />
}
