import {createElement, type PropsWithChildren} from 'react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook, waitFor} from '@testing-library/react-native'

import {
  announcementsQueryKey,
  PublicAnnouncementsError,
  useAnnouncementsQuery,
} from '../announcements'

let mockAdminApiUrl: string | undefined

jest.mock('#/env', () => ({
  get ADMIN_API_URL() {
    return mockAdminApiUrl
  },
}))

const BASE_URL = 'http://127.0.0.1:2587'
const ENDPOINT = `${BASE_URL}/xrpc/com.selfcommand.admin.announcement.public?placement=app&limit=5`

const validAnnouncement = {
  title: '服务维护通知',
  body: '系统将于今晚进行维护。',
  level: 'info',
  placement: 'app',
  startsAt: '2026-10-31T00:00:00.000Z',
  endsAt: '2026-11-01T00:00:00.000Z',
}

const originalFetch = global.fetch
let fetchMock: jest.MockedFunction<typeof fetch>

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {queries: {gcTime: Infinity, retry: false}},
  })
  const wrapper = ({children}: PropsWithChildren) =>
    createElement(QueryClientProvider, {client: queryClient}, children)
  return {queryClient, wrapper}
}

beforeEach(() => {
  mockAdminApiUrl = BASE_URL
  fetchMock = jest.fn()
  global.fetch = fetchMock
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('useAnnouncementsQuery', () => {
  it('does not request announcements when no admin API URL is configured', async () => {
    mockAdminApiUrl = undefined
    const {wrapper} = createWrapper()

    const {result} = renderHook(() => useAnnouncementsQuery(), {wrapper})
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.isPending).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests and parses announcements anonymously', async () => {
    fetchMock.mockResolvedValue(
      Response.json({announcements: [validAnnouncement], ignored: true}),
    )
    const {wrapper} = createWrapper()

    const {result} = renderHook(() => useAnnouncementsQuery(), {wrapper})

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, {
      method: 'GET',
      credentials: 'omit',
      headers: {Accept: 'application/json'},
      signal: expect.any(AbortSignal),
    })
    expect(result.current.data).toEqual([validAnnouncement])
  })

  it('drops invalid records and keeps valid ones in service order', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        announcements: [
          {...validAnnouncement, title: undefined},
          {...validAnnouncement, body: 42},
          {...validAnnouncement, title: '   '},
          {...validAnnouncement, level: 'notice'},
          {...validAnnouncement, placement: 'ozone'},
          {...validAnnouncement, startsAt: 123},
          {
            title: '第二条公告',
            body: '正文',
            level: 'warning',
            placement: 'app',
          },
          {
            title: '第三条公告',
            body: '正文',
            level: 'critical',
            placement: 'app',
            unknownField: true,
          },
        ],
      }),
    )
    const {wrapper} = createWrapper()

    const {result} = renderHook(() => useAnnouncementsQuery(), {wrapper})

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual([
      {
        title: '第二条公告',
        body: '正文',
        level: 'warning',
        placement: 'app',
      },
      {
        title: '第三条公告',
        body: '正文',
        level: 'critical',
        placement: 'app',
      },
    ])
  })

  it('does not retry a 404 response', async () => {
    fetchMock.mockResolvedValue(new Response(null, {status: 404}))
    const {wrapper} = createWrapper()

    const {result} = renderHook(() => useAnnouncementsQuery(), {wrapper})

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeInstanceOf(PublicAnnouncementsError)
    expect((result.current.error as PublicAnnouncementsError).status).toBe(404)
  })

  it('does not retry a 429 response', async () => {
    fetchMock.mockResolvedValue(new Response(null, {status: 429}))
    const {wrapper} = createWrapper()

    const {result} = renderHook(() => useAnnouncementsQuery(), {wrapper})

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeInstanceOf(PublicAnnouncementsError)
    expect((result.current.error as PublicAnnouncementsError).status).toBe(429)
  })

  it('retries a 5xx response at most twice', async () => {
    fetchMock.mockResolvedValue(new Response(null, {status: 502}))
    const {wrapper} = createWrapper()

    const {result} = renderHook(() => useAnnouncementsQuery(), {wrapper})

    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: 10_000,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.current.error).toBeInstanceOf(PublicAnnouncementsError)
    expect((result.current.error as PublicAnnouncementsError).status).toBe(502)
  })

  it('aborts the request when the query is cancelled', async () => {
    let requestSignal: AbortSignal | undefined
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined
          requestSignal?.addEventListener('abort', () => {
            const error = new Error('Aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )
    const {queryClient, wrapper} = createWrapper()

    const {result} = renderHook(() => useAnnouncementsQuery(), {wrapper})
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      await queryClient.cancelQueries({queryKey: announcementsQueryKey})
    })

    expect(requestSignal).toBeInstanceOf(AbortSignal)
    expect(requestSignal?.aborted).toBe(true)
    expect(result.current.isError).toBe(false)
  })
})
