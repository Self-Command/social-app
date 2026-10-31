import {useQuery} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {createQueryKey} from '#/state/queries/util'
import {ADMIN_API_URL} from '#/env'

/**
 * Levels supported by public announcements. Records with any other level are
 * discarded.
 */
export type AnnouncementLevel = 'info' | 'warning' | 'critical'

/**
 * A public announcement shown in the app. Only these fields are consumed;
 * unknown fields from the service are ignored.
 */
export type PublicAnnouncement = {
  title: string
  body: string
  level: AnnouncementLevel
  placement: 'app'
  startsAt?: string
  endsAt?: string
}

const PLACEMENT = 'app'
const LIMIT = 5
const REQUEST_PATH = '/xrpc/com.selfcommand.admin.announcement.public'
const MAX_RETRIES = 2

/**
 * Query key for the public announcements shown in the app.
 */
export const announcementsQueryKey = createQueryKey('announcements', {
  placement: PLACEMENT,
})

/**
 * Error raised when public announcements cannot be fetched or understood.
 * `status` is the HTTP status when a response was received and `undefined` for
 * network failures.
 */
export class PublicAnnouncementsError extends Error {
  readonly status: number | undefined

  constructor(
    message: string,
    {status, cause}: {status?: number; cause?: unknown} = {},
  ) {
    super(message, {cause})
    this.name = 'PublicAnnouncementsError'
    this.status = status
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isAnnouncementLevel(value: unknown): value is AnnouncementLevel {
  return value === 'info' || value === 'warning' || value === 'critical'
}

/**
 * Parse a single public announcement. Returns `undefined` for records missing
 * required fields, using an unknown level, or carrying incorrectly typed
 * fields. Unknown fields are ignored.
 */
function parsePublicAnnouncement(
  value: unknown,
): PublicAnnouncement | undefined {
  if (!isRecord(value)) return undefined
  const {title, body, level, placement, startsAt, endsAt} = value
  if (typeof title !== 'string' || title.trim() === '') return undefined
  if (typeof body !== 'string' || body.trim() === '') return undefined
  if (!isAnnouncementLevel(level)) return undefined
  if (placement !== PLACEMENT) return undefined
  if (startsAt !== undefined && typeof startsAt !== 'string') return undefined
  if (endsAt !== undefined && typeof endsAt !== 'string') return undefined

  const announcement: PublicAnnouncement = {
    title,
    body,
    level,
    placement: PLACEMENT,
  }
  if (typeof startsAt === 'string') announcement.startsAt = startsAt
  if (typeof endsAt === 'string') announcement.endsAt = endsAt
  return announcement
}

/**
 * Parse the public announcement response body. Invalid records are dropped
 * and the remaining records keep the order returned by the service.
 */
export function parsePublicAnnouncements(
  payload: unknown,
): PublicAnnouncement[] {
  if (!isRecord(payload) || !isUnknownArray(payload.announcements)) return []
  const announcements: PublicAnnouncement[] = []
  for (const item of payload.announcements) {
    const announcement = parsePublicAnnouncement(item)
    if (announcement) announcements.push(announcement)
  }
  return announcements
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
}

/**
 * Request and parse public announcements. The request is anonymous: no
 * credentials, cookies, or authentication headers are sent.
 */
async function fetchPublicAnnouncements(
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<PublicAnnouncement[]> {
  const url = `${baseUrl}${REQUEST_PATH}?placement=${PLACEMENT}&limit=${LIMIT}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
      },
      signal,
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new PublicAnnouncementsError('公告服务无法连接', {cause: error})
  }

  if (!response.ok) {
    throw new PublicAnnouncementsError('公告服务请求失败', {
      status: response.status,
    })
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new PublicAnnouncementsError('公告响应格式异常', {
      status: response.status,
      cause: error,
    })
  }

  return parsePublicAnnouncements(payload)
}

/**
 * Retry only network failures and server errors, up to two times. Client
 * errors - including rate limiting - are not retried.
 */
function shouldRetryAnnouncementsRequest(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= MAX_RETRIES) return false
  if (!(error instanceof PublicAnnouncementsError)) return false
  return error.status === undefined || error.status >= 500
}

/**
 * Fetch the public announcements shown in the app. The query is disabled and
 * never issues a request when no admin service URL is configured.
 */
export function useAnnouncementsQuery() {
  const baseUrl = ADMIN_API_URL

  return useQuery({
    queryKey: announcementsQueryKey,
    queryFn: ({signal}) => {
      if (!baseUrl) {
        // The query is disabled without a URL; this only guards direct access
        // to the cache.
        return Promise.resolve([])
      }
      return fetchPublicAnnouncements(baseUrl, signal)
    },
    enabled: Boolean(baseUrl),
    staleTime: STALE.MINUTES.FIVE,
    refetchInterval: STALE.MINUTES.FIVE,
    retry: shouldRetryAnnouncementsRequest,
  })
}
