/**
 * spot.bookHealth reducer — one slot, two writers.
 *
 * The spot page mounts TWO OrderBook instances (the desktop layout and the
 * mobile layout are both in the tree; CSS decides which is visible). Both
 * subscribe, both receive the same payloads, and both publish into this single
 * slot — but they do not reach the first payload of a new pair at the same
 * moment. The reducer has to make that harmless.
 */

import reducer, { setBookHealth, setTickerStale } from '@/store/trade/dataSlice'
import { DEFAULT_BOOK_HEALTH, pendingBookHealth } from '@/lib/orderBookHealth'

const PAIR_A = '695bf1017573eeb15a749c9d'
const PAIR_B = '695bf1017573eeb15a749c9f'

const stateWith = (bookHealth: any) => ({ bookHealth } as any)

const observedHealthy = { ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A }
const observedDead = {
  healthy: false,
  reason: 'no_admin_liquidity',
  ladderPresent: false,
  pairId: PAIR_A,
  pending: false,
}

describe('setBookHealth', () => {
  it('stores a verdict', () => {
    const next = reducer(stateWith(DEFAULT_BOOK_HEALTH), setBookHealth(observedDead))
    expect(next.bookHealth).toEqual(observedDead)
  })

  it('keeps the same object when the verdict has not changed', () => {
    // The book republishes about once a second from two components. Handing out
    // a new object each time would re-render both order tickets for nothing.
    const state = stateWith(observedDead)
    const next = reducer(state, setBookHealth({ ...observedDead }))
    expect(next.bookHealth).toBe(state.bookHealth)
  })

  it('fills in defaults for a partial payload', () => {
    const next = reducer(stateWith(DEFAULT_BOOK_HEALTH), setBookHealth({ pairId: PAIR_A } as any))
    expect(next.bookHealth).toEqual({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
  })

  describe('the desktop/mobile race', () => {
    it('does not let a re-mounting instance wipe an observed verdict', () => {
      // One instance has seen the real payload; the other has just mounted and
      // knows nothing. "I have not heard yet" must not overwrite "it is dead".
      const state = stateWith(observedDead)

      const next = reducer(state, setBookHealth(pendingBookHealth(PAIR_A)))

      expect(next.bookHealth).toEqual(observedDead)
    })

    it('does not let it wipe an observed healthy verdict either', () => {
      const state = stateWith(observedHealthy)

      const next = reducer(state, setBookHealth(pendingBookHealth(PAIR_A)))

      // Otherwise the two instances would flip the ticket between "loading" and
      // "ready" for as long as they disagreed.
      expect(next.bookHealth).toEqual(observedHealthy)
    })

    it('still accepts pending for a DIFFERENT pair — that is a real pair switch', () => {
      const state = stateWith(observedDead)

      const next = reducer(state, setBookHealth(pendingBookHealth(PAIR_B)))

      expect(next.bookHealth.pairId).toBe(PAIR_B)
      expect(next.bookHealth.pending).toBe(true)
      // PAIR_A's fault must not follow us to PAIR_B.
      expect(next.bookHealth.healthy).toBe(true)
    })

    it('always accepts a real verdict, whichever instance sends it', () => {
      let state: any = stateWith(pendingBookHealth(PAIR_A))

      state = reducer(state, setBookHealth(observedDead))
      expect(state.bookHealth).toEqual(observedDead)

      // ...and recovery still gets through, from either instance.
      state = reducer(state, setBookHealth(observedHealthy))
      expect(state.bookHealth).toEqual(observedHealthy)
    })
  })
})

describe('setTickerStale', () => {
  it('flips the flag', () => {
    const next = reducer({ tickerStale: false } as any, setTickerStale(true))
    expect(next.tickerStale).toBe(true)
  })

  it('ignores a repeat of the value it already holds', () => {
    // Two MarketPrice instances publish this every second.
    const state: any = { tickerStale: true }
    const next = reducer(state, setTickerStale(true))
    expect(next).toBe(state)
  })
})
