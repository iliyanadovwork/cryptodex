/**
 * useSpotBookHealth — the gate every spot order ticket reads.
 *
 * If this hook says "fine" when it should say "wait", a user can submit an
 * order into a book that cannot fill it. If it says "wait" forever, a perfectly
 * healthy pair becomes untradeable. Both failures are tested here.
 */

import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { useSpotBookHealth, PENDING_VERDICT_GRACE_MS } from '@/hooks/useSpotBookHealth'
import { DEFAULT_BOOK_HEALTH } from '@/lib/orderBookHealth'

jest.mock('@/store', () => {
  const actualReactRedux = jest.requireActual('react-redux')
  return {
    useSelector: actualReactRedux.useSelector,
    useDispatch: actualReactRedux.useDispatch,
  }
})

const PAIR_A = '695bf1017573eeb15a749c9d'
const PAIR_B = '695bf1017573eeb15a749c9f'

const wrapperFor = (spotState: any) => {
  const store = configureStore({
    reducer: { spot: (state = spotState) => state },
  })
  return ({ children }: any) => <Provider store={store}>{children}</Provider>
}

const renderWith = (spotState: any) =>
  renderHook(() => useSpotBookHealth(), { wrapper: wrapperFor(spotState) })

const verdict = (over: any = {}) => ({ ...DEFAULT_BOOK_HEALTH, ...over })

describe('useSpotBookHealth', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('lets trading through on a healthy verdict for the pair on screen', () => {
    const { result } = renderWith({
      tradePair: { _id: PAIR_A },
      bookHealth: verdict({ pairId: PAIR_A }),
    })

    expect(result.current.tradingPaused).toBe(false)
    expect(result.current.awaitingVerdict).toBe(false)
  })

  it('pauses trading on an explicit unhealthy verdict for that pair', () => {
    const { result } = renderWith({
      tradePair: { _id: PAIR_A },
      bookHealth: verdict({
        healthy: false,
        reason: 'no_admin_liquidity',
        ladderPresent: false,
        pairId: PAIR_A,
      }),
    })

    expect(result.current.tradingPaused).toBe(true)
    expect(result.current.copy.title).toBe('No liquidity available right now')
    expect(result.current.note).toContain('Trading paused')
    expect(result.current.note).toContain('no liquidity available')
    // Never the raw enum.
    expect(result.current.note).not.toContain('no_admin_liquidity')
  })

  it('never leaves an unhealthy verdict enabled, however long it lasts', () => {
    const { result } = renderWith({
      tradePair: { _id: PAIR_A },
      bookHealth: verdict({ healthy: false, reason: 'ladder_stale', pairId: PAIR_A }),
    })

    act(() => {
      jest.advanceTimersByTime(PENDING_VERDICT_GRACE_MS * 10)
    })

    // The grace window is only for "we have not heard" — not for a real fault.
    expect(result.current.tradingPaused).toBe(true)
  })

  it('ignores a verdict that belongs to a different pair', () => {
    const { result } = renderWith({
      tradePair: { _id: PAIR_A },
      bookHealth: verdict({
        healthy: false,
        reason: 'no_admin_liquidity',
        pairId: PAIR_B,
      }),
    })

    // PAIR_B being broken says nothing about PAIR_A...
    expect(result.current.health.reason).toBeNull()
    expect(result.current.health.pairId).toBe(PAIR_A)
    // ...but it is not evidence PAIR_A is fine either, so we hold briefly.
    expect(result.current.awaitingVerdict).toBe(true)
    expect(result.current.tradingPaused).toBe(true)
  })

  describe('the window after a pair switch, before any verdict arrives', () => {
    it('holds the ticket closed instead of assuming all is well', () => {
      const { result } = renderWith({
        tradePair: { _id: PAIR_A },
        bookHealth: DEFAULT_BOOK_HEALTH, // pairId "" — nothing known about PAIR_A
      })

      expect(result.current.awaitingVerdict).toBe(true)
      expect(result.current.tradingPaused).toBe(true)
      expect(result.current.note).toContain('Loading the order book')
      // It reads as loading, not as a fault.
      expect(result.current.note).not.toContain('Trading paused')
    })

    it('opens on its own after the grace window, so an ungated pair is never stuck', () => {
      const { result } = renderWith({
        tradePair: { _id: PAIR_A },
        bookHealth: DEFAULT_BOOK_HEALTH,
      })

      expect(result.current.tradingPaused).toBe(true)

      act(() => {
        jest.advanceTimersByTime(PENDING_VERDICT_GRACE_MS + 50)
      })

      // No payload ever came. That is a legitimate ungated pair, not a fault.
      expect(result.current.tradingPaused).toBe(false)
      expect(result.current.awaitingVerdict).toBe(false)
    })

    it('still holds just before the grace window expires', () => {
      const { result } = renderWith({
        tradePair: { _id: PAIR_A },
        bookHealth: DEFAULT_BOOK_HEALTH,
      })

      act(() => {
        jest.advanceTimersByTime(PENDING_VERDICT_GRACE_MS - 100)
      })

      expect(result.current.tradingPaused).toBe(true)
    })

    it('opens immediately when the verdict lands, without waiting out the window', () => {
      const store = configureStore({
        reducer: {
          spot: (
            state: any = { tradePair: { _id: PAIR_A }, bookHealth: DEFAULT_BOOK_HEALTH },
            action: any
          ) => (action.type === 'set' ? { ...state, bookHealth: action.payload } : state),
        },
      })
      const wrapper = ({ children }: any) => <Provider store={store}>{children}</Provider>
      const { result } = renderHook(() => useSpotBookHealth(), { wrapper })

      expect(result.current.tradingPaused).toBe(true)

      act(() => {
        store.dispatch({ type: 'set', payload: verdict({ pairId: PAIR_A }) })
      })

      expect(result.current.tradingPaused).toBe(false)
    })

    it('re-arms the wait when the pair changes again', () => {
      const store = configureStore({
        reducer: {
          spot: (
            state: any = { tradePair: { _id: PAIR_A }, bookHealth: verdict({ pairId: PAIR_A }) },
            action: any
          ) => (action.type === 'pair' ? { ...state, tradePair: { _id: action.payload } } : state),
        },
      })
      const wrapper = ({ children }: any) => <Provider store={store}>{children}</Provider>
      const { result } = renderHook(() => useSpotBookHealth(), { wrapper })

      expect(result.current.tradingPaused).toBe(false)

      // Switch to a pair the stored verdict says nothing about.
      act(() => {
        store.dispatch({ type: 'pair', payload: PAIR_B })
      })

      expect(result.current.awaitingVerdict).toBe(true)
      expect(result.current.tradingPaused).toBe(true)

      act(() => {
        jest.advanceTimersByTime(PENDING_VERDICT_GRACE_MS + 50)
      })
      expect(result.current.tradingPaused).toBe(false)
    })
  })

  it('does not gate when there is no pair on screen yet', () => {
    const { result } = renderWith({ tradePair: {}, bookHealth: DEFAULT_BOOK_HEALTH })
    // Nothing to trade and nothing to explain; other guards cover this case.
    expect(result.current.tradingPaused).toBe(false)
  })

  it('survives a store with no bookHealth at all', () => {
    const { result } = renderWith({ tradePair: { _id: PAIR_A } })
    expect(result.current.health.pending).toBe(true)
    expect(result.current.copy.title.length).toBeGreaterThan(0)
  })
})
