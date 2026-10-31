import {type PublicAnnouncement} from '#/state/queries/announcements'
import {
  addDismissedAnnouncement,
  ANNOUNCEMENT_LEVEL_META,
  getAnnouncementFingerprint,
  MAX_DISMISSED_ANNOUNCEMENTS,
  selectBannerAnnouncement,
} from '../announcement'

function makeAnnouncement(
  overrides: Partial<PublicAnnouncement> = {},
): PublicAnnouncement {
  return {
    title: '服务维护通知',
    body: '系统将于今晚进行维护。',
    level: 'info',
    placement: 'app',
    startsAt: '2026-10-31T00:00:00.000Z',
    endsAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('ANNOUNCEMENT_LEVEL_META', () => {
  it('maps every supported level to an admonition type and Chinese label', () => {
    expect(ANNOUNCEMENT_LEVEL_META).toEqual({
      info: {admonition: 'info', label: '通知'},
      warning: {admonition: 'warning', label: '警告'},
      critical: {admonition: 'error', label: '紧急'},
    })
  })
})

describe('getAnnouncementFingerprint', () => {
  it('is stable for equal announcement content', () => {
    const first = getAnnouncementFingerprint(makeAnnouncement())
    const second = getAnnouncementFingerprint(makeAnnouncement())

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-\d+$/)
  })

  it.each([
    {field: 'level', overrides: {level: 'warning' as const}},
    {field: 'title', overrides: {title: '其他标题'}},
    {field: 'body', overrides: {body: '其他正文'}},
    {
      field: 'startsAt',
      overrides: {startsAt: '2026-11-02T00:00:00.000Z'},
    },
    {field: 'endsAt', overrides: {endsAt: undefined}},
  ])('changes when $field changes', ({overrides}) => {
    expect(getAnnouncementFingerprint(makeAnnouncement(overrides))).not.toBe(
      getAnnouncementFingerprint(makeAnnouncement()),
    )
  })
})

describe('selectBannerAnnouncement', () => {
  it('returns the first announcement in service order when none is dismissed', () => {
    const announcements = [
      makeAnnouncement({title: '第一条'}),
      makeAnnouncement({title: '第二条'}),
    ]

    expect(selectBannerAnnouncement(announcements, [])).toBe(announcements[0])
  })

  it('skips dismissed announcements and returns the newest remaining one', () => {
    const announcements = [
      makeAnnouncement({title: '第一条'}),
      makeAnnouncement({title: '第二条'}),
      makeAnnouncement({title: '第三条'}),
    ]
    const dismissed = [
      getAnnouncementFingerprint(announcements[0]),
      getAnnouncementFingerprint(announcements[1]),
    ]

    expect(selectBannerAnnouncement(announcements, dismissed)).toBe(
      announcements[2],
    )
  })

  it('returns undefined when every announcement is dismissed', () => {
    const announcements = [
      makeAnnouncement({title: '第一条'}),
      makeAnnouncement({title: '第二条'}),
    ]
    const dismissed = announcements.map(announcement =>
      getAnnouncementFingerprint(announcement),
    )

    expect(selectBannerAnnouncement(announcements, dismissed)).toBeUndefined()
  })
})

describe('addDismissedAnnouncement', () => {
  it('moves an existing fingerprint to the end', () => {
    expect(addDismissedAnnouncement(['first', 'second'], 'first')).toEqual([
      'second',
      'first',
    ])
  })

  it('keeps only the most recent 50 fingerprints', () => {
    let dismissed: string[] = []
    for (let i = 0; i < 60; i++) {
      dismissed = addDismissedAnnouncement(dismissed, `fingerprint-${i}`)
    }

    expect(dismissed).toHaveLength(MAX_DISMISSED_ANNOUNCEMENTS)
    expect(dismissed[0]).toBe('fingerprint-10')
    expect(dismissed[dismissed.length - 1]).toBe('fingerprint-59')
  })
})
