/**
 * useOrderBookResync — the staleness watchdog behind `connection_lost`.
 *
 * The backend republishes the book at least once a second even when the depth
 * feed is dead, so silence means we have lost the publisher, not that the
 * market went quiet. OrderBook.tsx turns `isStale` straight into the
 * `connection_lost` verdict that blanks the ladder and disables the ticket —
 * so a false positive here disables trading on a working exchange, and a false
 * negative leaves a frozen ladder on screen looking live.
 */

import { act, renderHook } from '@testing-library/react'
import { useOrderBookResync } from '@/hooks/useOrderBookResync'

const mockGetOrderBook = jest.fn()

jest.mock('@/services/Spot/SpotService', () => ({
  getOrderBook: (...args: any[]) => mockGetOrderBook(...args),
}))

const PAIR = '695bf1017573eeb15a749c9d'
const THRESHOLD = 3
/** The hook only calls it stale after threshold * STALE_UI_MULTIPLIER (3). */
const STALE_AFTER_MS = THRESHOLD * 3 * 1000

/** Drive jsdom's visibility state, which the watchdog reads directly. */
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/**
 * Advance in small steps, flushing microtasks between them. The watchdog fires
 * REST retries whose promises must settle between ticks, exactly as they do in
 * a real browser; advancing in one jump would run every tick before any
 * response landed.
 */
const advance = async (ms: number, step = 500) => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(step)
    })
  }
}

const renderResync = (over: any = {}) =>
  renderHook(() =>
    useOrderBookResync({
      pairId: PAIR,
      botstatus: 'binance',
      isEnabled: true,
      staleThreshold: THRESHOLD,
      ...over,
    })
  )

describe('useOrderBookResync staleness', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setVisibility('visible')
    // A dead publisher means the REST retry fails too — that is the situation
    // staleness is meant to describe.
    mockGetOrderBook.mockRejectedValue(new Error('backend down'))
  })

  afterEach(() => {
    jest.useRealTimers()
    setVisibility('visible')
  })

  it('starts fresh', () => {
    const { result } = renderResync()
    expect(result.current.isStale).toBe(false)
  })

  it('does not cry stale over a single missed publish', async () => {
    const { result } = renderResync()

    // Past the 3s resync trigger but well short of the UI threshold.
    await advance(4000)

    expect(result.current.isStale).toBe(false)
  })

  it('reports stale once the publisher has been silent long enough', async () => {
    const { result } = renderResync()

    await advance(STALE_AFTER_MS + 1000)

    expect(result.current.isStale).toBe(true)
  })

  it('stays quiet while the tab is hidden, however long the silence', async () => {
    const { result } = renderResync()
    setVisibility('hidden')

    // A backgrounded tab has throttled timers and may have its socket
    // suspended, so silence there is not evidence of anything.
    await advance(STALE_AFTER_MS * 4)

    expect(result.current.isStale).toBe(false)
  })

  it('reports stale after returning to a visible tab if the feed is still dead', async () => {
    const { result } = renderResync()
    setVisibility('hidden')
    await advance(STALE_AFTER_MS * 2)
    expect(result.current.isStale).toBe(false)

    setVisibility('visible')
    await advance(2000)

    expect(result.current.isStale).toBe(true)
  })

  it('clears the moment a payload arrives', async () => {
    const { result } = renderResync()
    await advance(STALE_AFTER_MS + 1000)
    expect(result.current.isStale).toBe(true)

    act(() => {
      result.current.markUpdate()
    })

    expect(result.current.isStale).toBe(false)
  })

  it('never reports stale for a pair we do not subscribe to', async () => {
    const { result } = renderResync({ isEnabled: false })

    await advance(STALE_AFTER_MS * 3)

    expect(result.current.isStale).toBe(false)
  })

  it('keeps trying the REST snapshot while stale', async () => {
    renderResync()

    await advance(STALE_AFTER_MS + 2000)

    expect(mockGetOrderBook).toHaveBeenCalledWith(PAIR)
    expect(mockGetOrderBook.mock.calls.length).toBeGreaterThan(1)
  })

  it('a successful resync counts as hearing from the book', async () => {
    mockGetOrderBook.mockResolvedValue({ status: 'success', result: { pairId: PAIR } })
    const onResyncComplete = jest.fn()
    const { result } = renderResync({ onResyncComplete })

    await advance(STALE_AFTER_MS + 1000)

    // REST is still answering, so the book is not stale even though the socket
    // has gone quiet — the ladder on screen is genuinely current.
    expect(onResyncComplete).toHaveBeenCalled()
    expect(result.current.isStale).toBe(false)
  })
})
