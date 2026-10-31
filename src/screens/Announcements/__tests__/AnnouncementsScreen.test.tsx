import type * as ReactNative from 'react-native'
import {fireEvent, render, screen} from '@testing-library/react-native'

import {
  type PublicAnnouncement,
  useAnnouncementsQuery,
} from '#/state/queries/announcements'
import {AnnouncementsScreen} from '..'

jest.mock('@lingui/react', () => {
  function format(
    value: {message?: string; values?: Record<string, unknown>} | string,
  ) {
    if (typeof value === 'string') return value
    return (value.message ?? '').replace(/\{(\w+)\}/g, (_, key: string) => {
      const replacement = value.values?.[key]
      return typeof replacement === 'string' ? replacement : ''
    })
  }
  return {
    useLingui: () => ({_: format}),
    Trans: ({
      message,
      values,
    }: {
      message?: string
      values?: Record<string, unknown>
    }) => format({message, values}),
  }
})

jest.mock('#/state/queries/announcements', () => ({
  useAnnouncementsQuery: jest.fn(),
}))

jest.mock('#/alf', () => {
  const atoms = new Proxy({}, {get: () => ({})})
  const theme = {
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000000'}),
  }
  return {atoms, useTheme: () => theme}
})

jest.mock('#/components/Layout', () => {
  const {Text, View} = jest.requireActual<typeof ReactNative>('react-native')
  return {
    Screen: ({children, ...props}: React.ComponentProps<typeof View>) => (
      <View {...props}>{children}</View>
    ),
    Content: ({children, ...props}: React.ComponentProps<typeof View>) => (
      <View {...props}>{children}</View>
    ),
    Center: View,
    Header: {
      Outer: ({children}: {children: React.ReactNode}) => (
        <View>{children}</View>
      ),
      BackButton: () => null,
      Content: ({children}: {children: React.ReactNode}) => (
        <View>{children}</View>
      ),
      TitleText: ({children}: {children: React.ReactNode}) => (
        <Text>{children}</Text>
      ),
      Slot: () => null,
    },
  }
})

jest.mock('#/components/Loader', () => {
  const {View} = jest.requireActual<typeof ReactNative>('react-native')
  return {Loader: () => <View testID="announcementsLoader" />}
})

jest.mock('#/components/Button', () => {
  const {Pressable, Text} =
    jest.requireActual<typeof ReactNative>('react-native')
  return {
    Button: ({
      children,
      label,
      onPress,
      disabled,
      testID,
    }: {
      children: React.ReactNode
      label: string
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) => (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint=""
        disabled={disabled}
        onPress={onPress}>
        {children}
      </Pressable>
    ),
    ButtonText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})

jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<typeof ReactNative>('react-native')
  return {Text}
})

const mockQuery = jest.mocked(useAnnouncementsQuery)
const refetch = jest.fn()

function setQuery(result: Partial<ReturnType<typeof useAnnouncementsQuery>>) {
  mockQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch,
    ...result,
  } as never)
}

function announcement(
  overrides: Partial<PublicAnnouncement> = {},
): PublicAnnouncement {
  return {
    title: '公告标题',
    body: '公告正文',
    level: 'info',
    placement: 'app',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('AnnouncementsScreen', () => {
  it('renders every announcement in service order with level labels and full text', () => {
    const longBody =
      '这是一条较长的公告正文，用于确认公告屏幕会完整展示全部内容，而不是只展示摘要。'.repeat(
        40,
      )

    setQuery({
      data: [
        announcement({
          level: 'warning',
          title: '第一条公告',
          body: longBody,
        }),
        announcement({
          level: 'info',
          title: '第二条公告',
          body: '第二条公告正文',
        }),
        announcement({
          level: 'critical',
          title: '第三条公告',
          body: '第三条公告正文',
        }),
      ],
    })
    render(<AnnouncementsScreen />)

    expect(screen.getByText('公告')).toBeTruthy()
    expect(
      screen
        .getAllByTestId('announcementTitle')
        .map(node => node.props.children),
    ).toEqual(['第一条公告', '第二条公告', '第三条公告'])
    expect(screen.getByText('警告')).toBeTruthy()
    expect(screen.getByText('通知')).toBeTruthy()
    expect(screen.getByText('紧急')).toBeTruthy()

    const longBodyNode = screen.getByText(longBody)
    expect(longBodyNode).toBeTruthy()
    expect(longBodyNode.props.numberOfLines).toBeUndefined()
  })

  it('shows a time window only when its dates can be parsed', () => {
    setQuery({
      data: [
        announcement({
          title: '有时间窗的公告',
          startsAt: '2026-10-01T00:00:00.000Z',
          endsAt: '2026-10-31T23:59:59.000Z',
        }),
        announcement({
          title: '时间窗异常的公告',
          startsAt: 'not-a-date',
          endsAt: 'also-not-a-date',
        }),
        announcement({
          title: '部分时间窗异常的公告',
          startsAt: '2026-10-01T00:00:00.000Z',
          endsAt: 'also-not-a-date',
        }),
      ],
    })
    render(<AnnouncementsScreen />)

    expect(screen.getAllByTestId('announcementTimeWindow')).toHaveLength(1)
    expect(
      screen.getByText(/^展示时间：\d{4}年\d{1,2}月\d{1,2}日/),
    ).toBeTruthy()
  })

  it('shows a loader while the first request is pending', () => {
    setQuery({isLoading: true})
    render(<AnnouncementsScreen />)

    expect(screen.getByTestId('announcementsLoader')).toBeTruthy()
    expect(screen.getByLabelText('正在加载公告')).toBeTruthy()
    expect(screen.queryByTestId('announcementsError')).toBeNull()
  })

  it('shows an empty state when there are no announcements', () => {
    setQuery({data: []})
    render(<AnnouncementsScreen />)

    expect(screen.getByTestId('announcementsEmpty')).toBeTruthy()
    expect(screen.getByText('当前没有公告')).toBeTruthy()
    expect(screen.getByText('有新公告发布后会显示在这里。')).toBeTruthy()
    expect(screen.queryByText('公告加载失败')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a retryable failure without technical details', () => {
    setQuery({
      isError: true,
      error: new Error('socket hang up at https://internal.example'),
    })
    render(<AnnouncementsScreen />)

    expect(screen.getByTestId('announcementsError')).toBeTruthy()
    expect(screen.getByText('公告加载失败')).toBeTruthy()
    expect(screen.getByText('请检查网络连接后重试。')).toBeTruthy()
    expect(screen.queryByText(/socket hang up/)).toBeNull()
    expect(screen.queryByText(/internal\.example/)).toBeNull()

    fireEvent.press(screen.getByRole('button', {name: '重试'}))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('keeps announcements readable when a background refresh fails', () => {
    setQuery({
      data: [announcement({title: '已有公告', body: '已有公告正文'})],
      isError: true,
    })
    render(<AnnouncementsScreen />)

    expect(screen.getByText('已有公告')).toBeTruthy()
    expect(screen.getByText('已有公告正文')).toBeTruthy()
    expect(screen.getByText('公告可能不是最新内容，请稍后重试。')).toBeTruthy()

    fireEvent.press(screen.getByRole('button', {name: '重试'}))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('does not offer write, dismiss, or mark-as-read controls', () => {
    setQuery({data: [announcement()]})
    render(<AnnouncementsScreen />)

    expect(screen.queryByText('忽略')).toBeNull()
    expect(screen.queryByText('关闭')).toBeNull()
    expect(screen.queryByText('标记已读')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
