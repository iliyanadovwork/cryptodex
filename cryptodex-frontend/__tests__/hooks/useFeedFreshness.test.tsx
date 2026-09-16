/**
 * useFeedFreshness — "have we heard from this stream recently?"
 *
 * This drives the NOT LIVE label on the page header, the chart and the trade
 * log. Getting it wrong in one direction shouts "dead feed" at a user whose
 * feed is fine; in the other it lets a frozen mark price keep passing itself
 * off as the market.
 */

import { act, renderHook } from '@testing-library/react'
import { useFeedFreshness } from '@/hooks/useFeedFreshness'

const THRESHOLD_MS = 90000

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

const advance = async (ms: number, step = 1000) => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(step)
    })
  }
}

describe('useFeedFreshness', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    jest.useRealTimers()
    setVisibility('visible')
  })

  it('starts fresh', () => {
    const heardAt = Date.now()
    const { result } = renderHook(() =>
      useFeedFreshness({ lastUpdate: heardAt, thresholdMs: THRESHOLD_MS })
    )
    expect(result.current).toBe(false)
  })

  it('tolerates silence shorter than the threshold', async () => {
    const heardAt = Date.now()
    const { result } = renderHook(() =>
      useFeedFreshness({ lastUpdate: heardAt, thresholdMs: THRESHOLD_MS })
    )

    await advance(THRESHOLD_MS - 5000)

    expect(result.current).toBe(false)
  })

  it('goes stale once the stream has been silent past the threshold', async () => {
    const heardAt = Date.now()
    const { result } = renderHook(() =>
      useFeedFreshness({ lastUpdate: heardAt, thresholdMs: THRESHOLD_MS })
    )

    await advance(THRESHOLD_MS + 5000)

    expect(result.current).toBe(true)
  })

  it('comes back the moment a message arrives', async () => {
    const { result, rerender } = renderHook(
      ({ lastUpdate }: any) => useFeedFreshness({ lastUpdate, thresholdMs: THRESHOLD_MS }),
      { initialProps: { lastUpdate: Date.now() } }
    )

    await advance(THRESHOLD_MS + 5000)
    expect(result.current).toBe(true)

    rerender({ lastUpdate: Date.now() })
    expect(result.current).toBe(false)
  })

  it('does not judge a hidden tab', async () => {
    const heardAt = Date.now()
    const { result } = renderHook(() =>
      useFeedFreshness({ lastUpdate: heardAt, thresholdMs: THRESHOLD_MS })
    )
    setVisibility('hidden')

    // Timers are throttled and sockets may be suspended while hidden; silence
    // there is not evidence the feed died.
    await advance(THRESHOLD_MS * 3)

    expect(result.current).toBe(false)
  })

  it('gives a fresh window after returning from a hidden tab', async () => {
    const heardAt = Date.now()
    const { result } = renderHook(() =>
      useFeedFreshness({ lastUpdate: heardAt, thresholdMs: THRESHOLD_MS })
    )
    setVisibility('hidden')
    await advance(THRESHOLD_MS * 3)

    setVisibility('visible')
    // Straight back does not flash a warning...
    await advance(2000)
    expect(result.current).toBe(false)

    // ...but continued silence while watching does.
    await advance(THRESHOLD_MS)
    expect(result.current).toBe(true)
  })

  it('is never stale for a stream we do not subscribe to', async () => {
    const { result } = renderHook(() =>
      useFeedFreshness({ lastUpdate: null, thresholdMs: THRESHOLD_MS, isEnabled: false })
    )

    await advance(THRESHOLD_MS * 3)

    expect(result.current).toBe(false)
  })

  it('treats "never heard anything" as a fresh window, then goes stale', async () => {
    const { result } = renderHook(() =>
      useFeedFreshness({ lastUpdate: null, thresholdMs: THRESHOLD_MS })
    )

    expect(result.current).toBe(false)
    await advance(THRESHOLD_MS + 5000)
    expect(result.current).toBe(true)
  })
})
