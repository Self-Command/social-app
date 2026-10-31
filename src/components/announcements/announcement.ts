import {type PublicAnnouncement} from '#/state/queries/announcements'

type AnnouncementLevelMeta = {
  /** Admonition type used to render an announcement of this level. */
  admonition: 'info' | 'warning' | 'error'
  /** Chinese label shown next to an announcement of this level. */
  label: string
}

/**
 * Presentation metadata for each supported announcement level.
 */
export const ANNOUNCEMENT_LEVEL_META: Record<
  PublicAnnouncement['level'],
  AnnouncementLevelMeta
> = {
  info: {admonition: 'info', label: '通知'},
  warning: {admonition: 'warning', label: '警告'},
  critical: {admonition: 'error', label: '紧急'},
}

/**
 * Maximum number of dismissed announcement fingerprints kept on this device.
 */
export const MAX_DISMISSED_ANNOUNCEMENTS = 50

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * 32-bit FNV-1a hash over a string's UTF-16 code units. Operating on code
 * units keeps the result deterministic on every JS engine.
 */
function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * A deterministic fingerprint for a public announcement. Public announcements
 * have no stable identifier, so the fingerprint is derived from the public
 * fields plus their length. It is used only for local dismissal and is not a
 * security boundary.
 */
export function getAnnouncementFingerprint(
  announcement: PublicAnnouncement,
): string {
  const payload = [
    announcement.level,
    announcement.title,
    announcement.body,
    announcement.startsAt ?? '',
    announcement.endsAt ?? '',
  ].join('|')
  const hash = fnv1a32(payload).toString(16).padStart(8, '0')
  return `${hash}-${payload.length}`
}

/**
 * The newest announcement that was not dismissed on this device. Announcements
 * arrive newest first, so the first remaining entry is the one to show.
 */
export function selectBannerAnnouncement(
  announcements: PublicAnnouncement[],
  dismissed: string[] = [],
): PublicAnnouncement | undefined {
  if (dismissed.length === 0) return announcements[0]
  const dismissedFingerprints = new Set(dismissed)
  return announcements.find(
    announcement =>
      !dismissedFingerprints.has(getAnnouncementFingerprint(announcement)),
  )
}

/**
 * Append a fingerprint to the local dismissal list and keep only the most
 * recent entries.
 */
export function addDismissedAnnouncement(
  dismissed: string[] | undefined,
  fingerprint: string,
): string[] {
  const next = (dismissed ?? []).filter(entry => entry !== fingerprint)
  next.push(fingerprint)
  return next.slice(-MAX_DISMISSED_ANNOUNCEMENTS)
}
