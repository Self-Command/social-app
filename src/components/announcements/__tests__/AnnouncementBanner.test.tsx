import {fireEvent, render, screen} from '@testing-library/react-native'

import {
  type PublicAnnouncement,
  useAnnouncementsQuery,
} from '#/state/queries/announcements'
import * as Admonition from '#/components/Admonition'
import {getAnnouncementFingerprint} from '../announcement'
import {AnnouncementBanner} from '../AnnouncementBanner'

const mockNavigate = jest.fn()
const mockSetDismissed = jest.fn()
let mockDismissed: string[] | undefined

jest.mock('#/state/queries/announcements', () => ({
  useAnnouncementsQuery: jest.fn(),
}))
jest.mock('#/storage', () => {
  const {useState} = jest.requireActual<typeof import('react')>('react')
  return {
    device: {
      get: jest.fn(),
      set: jest.fn(),
      addOnValueChangedListener: jest.fn(() => ({remove: jest.fn()})),
    },
    useStorage: () => {
      const [value, setValue] = useState<string[] | undefined>(mockDismissed)
      return [
        value,
        (next: string[]) => {
          mockDismissed = next
          mockSetDismissed(next)
          setValue(next)
        },
      ]
    },
  }
})
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
}))
jest.mock('@lingui/react', () => ({
  useLingui: () => ({
    _: (descriptor: {message: string}) => descriptor.message,
  }),
}))
jest.mock('#/components/Typography', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {Text}
})
/*
 * The real ALF entry pulls in Layout, which initializes Reanimated's native
 * worklets at import time. Only the style primitives used by the banner are
 * needed here.
 */
jest.mock('#/alf', () => {
  const {select} = jest.requireActual<
    typeof import('#/alf/util/themeSelector')
  >('#/alf/util/themeSelector')
  const {flatten} =
    jest.requireActual<typeof import('#/alf/util/flatten')>(
      '#/alf/util/flatten',
    )
  return {
    atoms: new Proxy({}, {get: () => ({})}),
    web: (style: unknown) => style,
    flatten,
    select,
    tokens: {gradients: {}},
    useTheme: () => ({
      name: 'light',
      atoms: new Proxy({}, {get: () => ({color: '#000000'})}),
      palette: new Proxy({}, {get: () => '#000000'}),
    }),
    useBreakpoints: () => ({gtPhone: false, gtMobile: false, gtTablet: false}),
  }
})

function makeAnnouncement(
  overrides: Partial<PublicAnnouncement> = {},
): PublicAnnouncement {
  return {
    title: '服务维护通知',
    body: '系统将于今晚 22:00 进行维护。',
    level: 'info',
    placement: 'app',
    startsAt: '2026-10-31T00:00:00.000Z',
    endsAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function mockAnnouncements(data?: PublicAnnouncement[], isError = false) {
  jest.mocked(useAnnouncementsQuery).mockReturnValue({
    data,
    isError,
  } as ReturnType<typeof useAnnouncementsQuery>)
}

beforeEach(() => {
  mockDismissed = undefined
  mockNavigate.mockReset()
  mockSetDismissed.mockReset()
  jest.mocked(useAnnouncementsQuery).mockReset()
  mockAnnouncements([makeAnnouncement()])
})

describe('AnnouncementBanner', () => {
  it('shows only the newest announcement when several are returned', () => {
    const newest = makeAnnouncement({title: '最新公告'})
    const older = makeAnnouncement({title: '较早公告'})
    mockAnnouncements([newest, older])

    render(<AnnouncementBanner />)

    expect(screen.getByText('最新公告')).toBeTruthy()
    expect(screen.queryByText('较早公告')).toBeNull()
  })

  it('skips dismissed announcements and shows the newest remaining one', () => {
    const newest = makeAnnouncement({title: '最新公告'})
    const older = makeAnnouncement({title: '较早公告'})
    mockDismissed = [getAnnouncementFingerprint(newest)]
    mockAnnouncements([newest, older])

    render(<AnnouncementBanner />)

    expect(screen.queryByText('最新公告')).toBeNull()
    expect(screen.getByText('较早公告')).toBeTruthy()
  })

  it.each([
    ['info', '通知', 'info'],
    ['warning', '警告', 'warning'],
    ['critical', '紧急', 'error'],
  ] as const)(
    'maps the %s level to a Chinese label and an admonition style',
    (level, label, admonition) => {
      mockAnnouncements([makeAnnouncement({level})])

      render(<AnnouncementBanner />)

      expect(screen.getByText(label)).toBeTruthy()
      expect(screen.UNSAFE_getByType(Admonition.Outer).props.type).toBe(
        admonition,
      )
    },
  )

  it('clamps the title to one line and the body to three lines', () => {
    const title = '这是一条很长很长的公告标题，长到必须在单行内省略显示'
    const body = '这是一段很长很长的公告正文，用于确认正文最多显示三行。'
    mockAnnouncements([makeAnnouncement({title, body})])

    render(<AnnouncementBanner />)

    expect(screen.getByText(title).props.numberOfLines).toBe(1)
    expect(screen.getByText(body).props.numberOfLines).toBe(3)
  })

  it('renders the body as plain text without links', () => {
    const body = '<b>维护</b>期间请勿发布内容，详见 https://example.com/notice'
    mockAnnouncements([makeAnnouncement({body})])

    render(<AnnouncementBanner />)

    expect(screen.getByText(body)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('hides the announcement immediately and stores its fingerprint on close', () => {
    const announcement = makeAnnouncement()
    mockAnnouncements([announcement])

    render(<AnnouncementBanner />)
    expect(screen.getByText(announcement.title)).toBeTruthy()

    fireEvent.press(screen.getByLabelText('关闭公告'))

    expect(screen.queryByTestId('announcementBanner')).toBeNull()
    expect(screen.queryByText(announcement.title)).toBeNull()
    expect(mockSetDismissed).toHaveBeenCalledWith([
      getAnnouncementFingerprint(announcement),
    ])
  })

  it('renders nothing when every announcement was dismissed', () => {
    const announcements = [
      makeAnnouncement({title: '公告一'}),
      makeAnnouncement({title: '公告二', body: '另一条正文'}),
    ]
    mockDismissed = announcements.map(getAnnouncementFingerprint)
    mockAnnouncements(announcements)

    render(<AnnouncementBanner />)

    expect(screen.queryByTestId('announcementBanner')).toBeNull()
    expect(screen.queryByText('公告一')).toBeNull()
    expect(screen.queryByText('公告二')).toBeNull()
  })

  it('renders nothing when the request failed', () => {
    mockAnnouncements(undefined, true)

    render(<AnnouncementBanner />)

    expect(screen.queryByTestId('announcementBanner')).toBeNull()
  })

  it('renders nothing when the service returns no announcements', () => {
    mockAnnouncements([])

    render(<AnnouncementBanner />)

    expect(screen.queryByTestId('announcementBanner')).toBeNull()
  })

  it('renders nothing when the announcement service is not configured', () => {
    mockAnnouncements(undefined)

    render(<AnnouncementBanner />)

    expect(screen.queryByTestId('announcementBanner')).toBeNull()
  })

  it('opens the announcements screen from the details button', () => {
    render(<AnnouncementBanner />)

    fireEvent.press(screen.getByText('查看详情'))

    expect(mockNavigate).toHaveBeenCalledWith('Announcements')
  })

  it('opens the announcements screen when the banner text is pressed', () => {
    const announcement = makeAnnouncement()
    mockAnnouncements([announcement])

    render(<AnnouncementBanner />)

    fireEvent.press(screen.getByText(announcement.title))

    expect(mockNavigate).toHaveBeenCalledWith('Announcements')
  })
})
