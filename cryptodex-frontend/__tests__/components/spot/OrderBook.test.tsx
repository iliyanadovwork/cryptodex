/**
 * Spot OrderBook — the ladder gate.
 *
 * The fault this protects against is specific and was live in production: the
 * backend purged the ladder, kept publishing an empty book with
 * `healthy: false`, and the UI drew a blank staircase with no explanation while
 * the Buy/Sell ticket stayed fully enabled. A blank book with no explanation is
 * the same lie as a stale one, just quieter.
 */

import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SocketContext from '@/components/Context/SocketContext'
import OrderBook from '@/components/spot/OrderBook'
import spotReducer, { setTradePair, setOpenOrders } from '@/store/trade/dataSlice'
import { DEFAULT_BOOK_HEALTH } from '@/lib/orderBookHealth'

jest.mock('@/store', () => {
  const actualReactRedux = jest.requireActual('react-redux')
  return {
    useSelector: actualReactRedux.useSelector,
    useDispatch: actualReactRedux.useDispatch,
  }
})

const mockGetOrderBook = jest.fn()
jest.mock('@/services/Spot/SpotService', () => ({
  getOrderBook: (...args: any[]) => mockGetOrderBook(...args),
}))

const PAIR_A = '695bf1017573eeb15a749c9d'
const PAIR_B = '695bf1017573eeb15a749c9f'

const tradePair = {
  _id: PAIR_A,
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD',
  firstFloatDigit: 6,
  secondFloatDigit: 2,
  botstatus: 'binance',
}

/** A minimal socket that records handlers so a test can push a payload. */
const makeSocket = () => {
  const handlers: Record<string, Function[]> = {}
  // The MANAGER. socket.io-client v4 emits `reconnect` here, not on the Socket
  // (the Socket reserves only connect / connect_error / disconnect /
  // disconnecting), so anything listening for a reconnect must reach it through
  // `socket.io`. The double carried no `io`, which is why a component correctly
  // listening on the manager saw `undefined`.
  const managerHandlers: Record<string, Function[]> = {}
  const io = {
    handlers: managerHandlers,
    on: (event: string, fn: Function) => {
      managerHandlers[event] = [...(managerHandlers[event] || []), fn]
    },
    off: (event: string, fn?: Function) => {
      managerHandlers[event] = fn
        ? (managerHandlers[event] || []).filter((h) => h !== fn)
        : []
    },
  }
  return {
    handlers,
    io,
    on: (event: string, fn: Function) => {
      handlers[event] = [...(handlers[event] || []), fn]
    },
    off: (event: string, fn?: Function) => {
      handlers[event] = fn ? (handlers[event] || []).filter((h) => h !== fn) : []
    },
    emit: jest.fn(),
    /** Deliver a MANAGER event - `reconnect` - exactly as socket.io would. */
    pushManager: async (event: string, payload?: any) => {
      await act(async () => {
        await Promise.all((managerHandlers[event] || []).map((h) => h(payload)))
      })
    },
    /** Deliver an event exactly as the server would. */
    push: async (event: string, payload: any) => {
      await act(async () => {
        await Promise.all((handlers[event] || []).map((h) => h(payload)))
      })
    },
  }
}

const healthyBook = {
  pairId: PAIR_A,
  healthy: true,
  healthReason: null,
  ladderPresent: true,
  buyOrder: [{ _id: 49990, quantity: 1, notional: 49990 }],
  sellOrder: [{ _id: 50010, quantity: 1, notional: 50010 }],
}

const deadBook = {
  pairId: PAIR_A,
  healthy: false,
  healthReason: 'no_admin_liquidity',
  ladderPresent: false,
  buyOrder: [],
  sellOrder: [],
}

/** The REAL spot reducer, so a published verdict reads back exactly as the
 *  order tickets read it. */
const makeStore = () =>
  configureStore({
    reducer: {
      spot: spotReducer,
      wallet: (state = { priceConversion: [] }) => state,
    },
    preloadedState: {
      spot: {
        ...spotReducer(undefined, { type: '@@INIT' }),
        tradePair,
        marketData: { markPrice: 50000 },
        openOrders: [],
      },
    } as any,
  })

const renderBook = (props: any = {}) => {
  const socket = makeSocket()
  const store = makeStore()
  const view = render(
    <Provider store={store}>
      <SocketContext.Provider value={{ spotSocket: socket } as any}>
        <OrderBook {...props} />
      </SocketContext.Provider>
    </Provider>
  )
  return { socket, store, view }
}

/**
 * The spot page as it really is: BOTH layouts mounted, sharing one socket and
 * one store. Only the desktop instance owns the shared verdict.
 */
const renderBothLayouts = () => {
  const socket = makeSocket()
  const store = makeStore()
  const view = render(
    <Provider store={store}>
      <SocketContext.Provider value={{ spotSocket: socket } as any}>
        <div data-testid="desktop-layout">
          <OrderBook publishHealth />
        </div>
        <div data-testid="mobile-layout">
          <OrderBook publishHealth={false} />
        </div>
      </SocketContext.Provider>
    </Provider>
  )
  return { socket, store, view }
}

/** Advance fake timers in small steps, letting promises settle between ticks. */
const advance = async (ms: number, step = 500) => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(step)
    })
  }
}

describe('OrderBook health gating', () => {
  beforeEach(() => {
    // The mount snapshot resolves to nothing by default; tests push payloads.
    mockGetOrderBook.mockResolvedValue({ status: 'failed', result: null })
  })

  it('says it is loading before any payload arrives, instead of an empty ladder', async () => {
    renderBook()

    const status = await screen.findByTestId('orderbook-status')
    expect(status).toHaveTextContent(/Loading the order book/i)
    expect(status.getAttribute('data-health-reason')).toBe('awaiting_book')
  })

  it('draws the ladder for a healthy payload', async () => {
    const { socket } = renderBook()

    await socket.push('orderBook', healthyBook)

    expect(screen.queryByTestId('orderbook-status')).toBeNull()
    expect(screen.getByText("PRICE")).toBeInTheDocument()
  })

  it('replaces the ladder with an explanation when nothing can fill', async () => {
    const { socket } = renderBook()
    await socket.push('orderBook', healthyBook)
    expect(screen.queryByTestId('orderbook-status')).toBeNull()

    await socket.push('orderBook', deadBook)

    const status = screen.getByTestId('orderbook-status')
    expect(status).toHaveTextContent(/No liquidity available right now/i)
    // The reason is exposed for tests/telemetry but never rendered raw.
    expect(status.getAttribute('data-health-reason')).toBe('no_admin_liquidity')
    expect(status.textContent).not.toContain('no_admin_liquidity')
    // The ladder itself is gone, not merely emptied of rows.
    expect(screen.queryByText("PRICE")).toBeNull()
  })

  it('publishes the verdict so the order ticket can refuse the order', async () => {
    const { socket, store } = renderBook()

    await socket.push('orderBook', deadBook)

    await waitFor(() => {
      const published = (store.getState() as any).spot.bookHealth
      expect(published.healthy).toBe(false)
      expect(published.reason).toBe('no_admin_liquidity')
      expect(published.pairId).toBe(PAIR_A)
    })
  })

  it('publishes a pending verdict before it has heard anything', async () => {
    const { store } = renderBook()

    await waitFor(() => {
      const published = (store.getState() as any).spot.bookHealth
      // Not "healthy" — "we have not heard yet", which the ticket treats as a
      // reason to wait rather than a green light.
      expect(published.pending).toBe(true)
      expect(published.pairId).toBe(PAIR_A)
    })
  })

  it('recovers on its own when a healthy payload comes back', async () => {
    const { socket } = renderBook()
    await socket.push('orderBook', deadBook)
    expect(screen.getByTestId('orderbook-status')).toBeInTheDocument()

    await socket.push('orderBook', healthyBook)

    expect(screen.queryByTestId('orderbook-status')).toBeNull()
  })

  it('ignores a payload belonging to another pair', async () => {
    const { socket } = renderBook()
    await socket.push('orderBook', healthyBook)

    await socket.push('orderBook', { ...deadBook, pairId: 'SOME_OTHER_PAIR' })

    // Another pair's fault must not blank this book.
    expect(screen.queryByTestId('orderbook-status')).toBeNull()
  })

  /**
   * THE ~1s AFTER A PAIR SWITCH.
   *
   * The previous pair's verdict says nothing about the new pair, and there is no
   * verdict for the new one yet. The old code kept the stale verdict — which was
   * usually "healthy" — so for about a second the ladder of the pair you just
   * left was on screen under the new pair's name, with a fully enabled ticket
   * behind it.
   */
  describe('switching pairs', () => {
    it('goes back to "we have not heard yet" instead of carrying the old verdict', async () => {
      const { socket, store } = renderBook()
      await socket.push('orderBook', healthyBook)
      // Settled: a real, healthy verdict for PAIR_A, ladder on screen.
      expect(screen.queryByTestId('orderbook-status')).toBeNull()
      expect((store.getState() as any).spot.bookHealth).toMatchObject({
        healthy: true,
        pending: false,
        pairId: PAIR_A,
      })

      await act(async () => {
        store.dispatch(setTradePair({ ...tradePair, _id: PAIR_B }))
      })

      // PAIR_A's ladder is not PAIR_B's book, and PAIR_A's clean bill of health
      // is not PAIR_B's either.
      const status = screen.getByTestId('orderbook-status')
      expect(status.getAttribute('data-health-reason')).toBe('awaiting_book')
      expect(status).toHaveTextContent(/Loading the order book/i)

      const published = (store.getState() as any).spot.bookHealth
      expect(published.pairId).toBe(PAIR_B)
      expect(published.pending).toBe(true)
      // Unknown must not read as healthy to anything downstream: the ticket
      // treats a settled `healthy: true` as a green light.
      expect(published).not.toEqual({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_B })
    })

    it('settles as soon as the new pair reports, without waiting anything out', async () => {
      const { socket, store } = renderBook()
      await socket.push('orderBook', healthyBook)
      await act(async () => {
        store.dispatch(setTradePair({ ...tradePair, _id: PAIR_B }))
      })
      expect(screen.getByTestId('orderbook-status')).toBeInTheDocument()

      await socket.push('orderBook', { ...healthyBook, pairId: PAIR_B })

      expect(screen.queryByTestId('orderbook-status')).toBeNull()
      expect((store.getState() as any).spot.bookHealth).toMatchObject({
        healthy: true,
        pending: false,
        pairId: PAIR_B,
      })
    })

    it('carries a fault across no more than it carries a clean bill of health', async () => {
      const { socket, store } = renderBook()
      await socket.push('orderBook', deadBook)
      expect((store.getState() as any).spot.bookHealth.healthy).toBe(false)

      await act(async () => {
        store.dispatch(setTradePair({ ...tradePair, _id: PAIR_B }))
      })

      const published = (store.getState() as any).spot.bookHealth
      expect(published.pairId).toBe(PAIR_B)
      expect(published.pending).toBe(true)
      expect(published.reason).toBeNull()
    })
  })

  /**
   * THE SHARED SLOT, TWO WRITERS.
   *
   * Desktop and mobile are both mounted (CSS hides one) and each keeps its own
   * copy of the verdict: own socket handler, own REST snapshot, own watchdog. So
   * they can disagree for a moment — and with both writing `spot.bookHealth` it
   * was last-writer-wins, where the winner could be the instance that knew less.
   */
  describe('the desktop/mobile pair of instances', () => {
    it('does not let the other instance publish at all', async () => {
      const { socket, store } = renderBook({ publishHealth: false })

      await socket.push('orderBook', deadBook)

      // It renders the fault for itself...
      expect(screen.getByTestId('orderbook-status')).toHaveTextContent(
        /No liquidity available/i
      )
      // ...but the shared verdict is not its business.
      expect((store.getState() as any).spot.bookHealth).toEqual(DEFAULT_BOOK_HEALTH)
    })

    it('does not let a late snapshot at one instance undo what the other just heard', async () => {
      // The exact race: each instance fetches its own REST snapshot on mount.
      // The mobile one's response is slow, so it lands AFTER the socket has told
      // both of them the book is dead — and it is a picture of an older,
      // healthier moment. Published, it would re-enable the ticket over a live
      // "nothing can fill".
      let resolveLateSnapshot: (v: any) => void = () => {}
      const lateSnapshot = new Promise((resolve) => {
        resolveLateSnapshot = resolve
      })
      mockGetOrderBook
        .mockResolvedValueOnce({ status: 'failed', result: null }) // desktop
        .mockReturnValueOnce(lateSnapshot) // mobile, still in flight

      const { socket, store } = renderBothLayouts()

      await socket.push('orderBook', deadBook)
      expect((store.getState() as any).spot.bookHealth).toMatchObject({
        healthy: false,
        reason: 'no_admin_liquidity',
      })

      await act(async () => {
        resolveLateSnapshot({ status: 'success', result: healthyBook })
        await Promise.resolve()
      })

      // The two instances now genuinely disagree on screen — one shows the
      // fault, the other the stale ladder. That is the situation this is about.
      expect(screen.getAllByTestId('orderbook-status')).toHaveLength(1)
      // And the tickets still see the live verdict, not the stale snapshot.
      expect((store.getState() as any).spot.bookHealth).toMatchObject({
        healthy: false,
        reason: 'no_admin_liquidity',
        pairId: PAIR_A,
      })
    })
  })

  /**
   * A feed that has simply stopped is no more tradeable than one the backend has
   * declared dead — the payload that would say so never arrives.
   */
  it('treats a silent feed as unusable rather than leaving a frozen ladder looking live', async () => {
    jest.useFakeTimers()
    try {
      const { socket, store } = renderBook()
      await socket.push('orderBook', healthyBook)
      expect(screen.queryByTestId('orderbook-status')).toBeNull()

      // Nothing more arrives. The book republishes ~1s, so this is many misses.
      await advance(11000)

      const status = screen.getByTestId('orderbook-status')
      expect(status.getAttribute('data-health-reason')).toBe('connection_lost')
      expect(status).toHaveTextContent(/Reconnecting/i)
      expect(screen.queryByText("PRICE")).toBeNull()
      expect((store.getState() as any).spot.bookHealth).toMatchObject({
        healthy: false,
        reason: 'connection_lost',
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('comes back the moment the feed does', async () => {
    jest.useFakeTimers()
    try {
      const { socket, store } = renderBook()
      await socket.push('orderBook', healthyBook)
      await advance(11000)
      expect(screen.getByTestId('orderbook-status')).toBeInTheDocument()

      await socket.push('orderBook', healthyBook)

      expect(screen.queryByTestId('orderbook-status')).toBeNull()
      expect((store.getState() as any).spot.bookHealth.healthy).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('falls open for an ungated payload that carries no health fields', async () => {
    const { socket } = renderBook()

    await socket.push('orderBook', {
      pairId: PAIR_A,
      buyOrder: [{ _id: 49990, quantity: 1, notional: 49990 }],
      sellOrder: [{ _id: 50010, quantity: 1, notional: 50010 }],
    })

    // Non-binance "bot" pairs still publish down the old ungated path.
    expect(screen.queryByTestId('orderbook-status')).toBeNull()
  })
})

/**
 * REPAINT THROTTLE
 * ================
 * The venue publishes off Binance's `@depth@100ms` stream, so up to ~10 payloads
 * a second arrive per pair and every one of them used to repaint the ladder -
 * too fast to read. Repaints are now coalesced to one per
 * BOOK_REPAINT_INTERVAL_MS (500ms).
 *
 * Coalescing is only safe because each payload is a COMPLETE book: the component
 * REPLACES the ladder rather than merging deltas, so dropping an intermediate
 * frame loses nothing. These pin that, and pin the two things that must NEVER be
 * made to wait for the window.
 */
describe('repaint throttle', () => {
  // The ask sits 200 clear of the bid so no frame's ask can collide with another
  // frame's bid: the book opens grouped at 10, and a +20 spread put frame one's
  // ask on exactly frame three's bid price.
  const bookAt = (bid: number) => ({
    ...healthyBook,
    buyOrder: [{ _id: bid, quantity: 1, notional: bid }],
    sellOrder: [{ _id: bid + 200, quantity: 1, notional: bid + 200 }],
  })

  it('coalesces a burst into one repaint and draws the NEWEST tick', async () => {
    jest.useFakeTimers()
    try {
      const { socket } = renderBook()

      // Leading edge: the first tick after a quiet spell draws at once, so the
      // book is never blank waiting out a window.
      await socket.push('orderBook', bookAt(49970))
      expect(screen.getByText('49970')).toBeInTheDocument()

      // A FULL STEP apart. The book opens grouped at 10, so 49990/49991/49992
      // would all floor into the same bucket and the assertions could not tell
      // the frames apart. (advance() below uses 1100ms because
      // BOOK_REPAINT_INTERVAL_MS is 750 - see OrderBook.tsx.)
      await socket.push('orderBook', bookAt(49980))
      await socket.push('orderBook', bookAt(49990))
      expect(screen.getByText('49970')).toBeInTheDocument()
      expect(screen.queryByText('49990')).toBeNull()

      // Trailing edge: when the window closes the newest held tick is drawn -
      // and the intermediate one never is, because by then it is stale.
      await advance(1100)
      expect(screen.getByText('49990')).toBeInTheDocument()
      expect(screen.queryByText('49980')).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it('never makes a health transition wait for the window', async () => {
    jest.useFakeTimers()
    try {
      const { socket } = renderBook()
      await socket.push('orderBook', bookAt(49990))

      // Immediately after a draw - deep inside the window - a book that has gone
      // dead must blank NOW. Health is a safety verdict, not a price tick.
      await socket.push('orderBook', deadBook)
      expect(screen.getByTestId('orderbook-status')).toBeInTheDocument()

      // ...and the recovery is just as immediate.
      await socket.push('orderBook', bookAt(49990))
      expect(screen.queryByTestId('orderbook-status')).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it('marks liveness on EVERY tick, not only on the drawn ones', async () => {
    jest.useFakeTimers()
    try {
      const { socket } = renderBook()

      // Ticks keep arriving every 100ms for well past the 3s staleness
      // threshold. If the liveness mark were throttled along with the repaint,
      // the watchdog would declare a perfectly live feed dead.
      for (let i = 0; i < 40; i++) {
        // eslint-disable-next-line no-await-in-loop
        await socket.push('orderBook', bookAt(49990))
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          jest.advanceTimersByTime(100)
        })
      }

      expect(screen.queryByTestId('orderbook-status')).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })
})

/**
 * A QUEUED FRAME MUST SURVIVE AN UNRELATED RE-RENDER.
 *
 * `mergeOrder` depends on the user's `openOrders`, so placing or cancelling an
 * order changes handleOrderBookData's identity - and with it every callback
 * built on top of it. When the socket effect was allowed to churn on that, its
 * cleanup cancelled the pending repaint timer and the queued frame was DROPPED:
 * the ladder sat on the older frame indefinitely, which is precisely the stale
 * frame the trailing edge exists to prevent. The derivations are now reached
 * through latest-refs, so the effect only re-runs on a real pair change.
 */
describe('repaint throttle survives unrelated churn', () => {
  // The ask sits 200 clear of the bid so no frame's ask can collide with another
  // frame's bid: the book opens grouped at 10, and a +20 spread put frame one's
  // ask on exactly frame three's bid price.
  const bookAt = (bid: number) => ({
    ...healthyBook,
    buyOrder: [{ _id: bid, quantity: 1, notional: bid }],
    sellOrder: [{ _id: bid + 200, quantity: 1, notional: bid + 200 }],
  })

  it('still draws a queued frame after the user\'s open orders change', async () => {
    jest.useFakeTimers()
    try {
      const { socket, store } = renderBook()

      await socket.push('orderBook', bookAt(49970))
      expect(screen.getByText('49970')).toBeInTheDocument()

      // A full grouping step apart - see the note in the throttle suite.
      await socket.push('orderBook', bookAt(49990))
      expect(screen.queryByText('49990')).toBeNull()

      // The user places/cancels an order: a new openOrders array lands in the
      // store while that frame is still queued.
      await act(async () => {
        store.dispatch(setOpenOrders([]))
      })

      // The queued frame must still be drawn when the window closes.
      await advance(1100)
      expect(screen.getByText('49990')).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not re-fetch a REST snapshot on every open-order change', async () => {
    jest.useFakeTimers()
    try {
      const { store } = renderBook()
      const before = mockGetOrderBook.mock.calls.length

      await act(async () => { store.dispatch(setOpenOrders([])) })
      await act(async () => { store.dispatch(setOpenOrders([])) })
      await act(async () => { store.dispatch(setOpenOrders([])) })

      // Each of those used to re-run the subscription effect and pull a fresh
      // snapshot; the book has not changed pair, so none is owed.
      expect(mockGetOrderBook.mock.calls.length).toBe(before)
    } finally {
      jest.useRealTimers()
    }
  })

  /**
   * REGRESSION: the reconnect resync must listen on the MANAGER.
   *
   * `reconnect` is emitted by socket.io-client's Manager, and the Socket's
   * RESERVED_EVENTS are only connect / connect_error / disconnect /
   * disconnecting. This component was registering `socket.on("reconnect", ...)`,
   * which can never fire - and it registers no "connect" listener either, so the
   * book had NO resync path at all: after a dropped connection it kept rendering
   * whatever was last pushed until the next delta happened to arrive.
   *
   * Asserting on the manager is the point of the test. If anyone moves this
   * listener back onto the socket, `pushManager` will find no handler and the
   * snapshot count will not move.
   */
  it('re-pulls a REST snapshot when the socket manager reports a reconnect', async () => {
    const { socket } = renderBook()

    // Give the book a pair to be on, so the resync has something to ask for.
    await socket.push('orderBook', healthyBook)
    const before = mockGetOrderBook.mock.calls.length

    await socket.pushManager('reconnect', 1)

    expect(mockGetOrderBook.mock.calls.length).toBeGreaterThan(before)
  })
})

/**
 * SERVER-GROUPED LADDERS + THE UNIT SELECTOR
 * ==========================================
 * Grouping the 20 published levels client-side collapsed them into one or two
 * rows at coarse steps (the top 20 BTC levels span ~$2.67, i.e. ONE bucket at a
 * $10 step). The publisher now aggregates over the whole cached book and sends a
 * ready-made ladder per step; the client renders it directly and only falls back
 * to local grouping for a payload that has none.
 */
describe('server-grouped ladders', () => {
  const grouped10 = {
    pairId: PAIR_A,
    healthy: true,
    healthReason: null,
    ladderPresent: true,
    // The RAW 20-level book: tightly packed, one $10 bucket's worth.
    buyOrder: [{ _id: 49999, quantity: 1, notional: 49999 }],
    sellOrder: [{ _id: 50001, quantity: 1, notional: 50001 }],
    // ...and the ladder the server aggregated from the FULL book.
    grouped: {
      '10': {
        buyOrder: [
          { _id: 49990, quantity: 2, notional: 99980 },
          { _id: 49980, quantity: 3, notional: 149940 },
        ],
        sellOrder: [
          { _id: 50010, quantity: 4, notional: 200040 },
          { _id: 50020, quantity: 5, notional: 250100 },
        ],
      },
    },
  }

  const selectStep = (value: string) => {
    const select = screen.getByTestId('orderbook-grouping') as HTMLSelectElement
    fireEvent.change(select, { target: { value } })
  }

  it('opens on the COARSEST step the venue publishes, not the tick', async () => {
    const { socket } = renderBook()
    await socket.push('orderBook', {
      ...grouped10,
      grouped: {
        '0.5': { buyOrder: [], sellOrder: [] },
        '10': grouped10.grouped['10'],
      },
    })
    const select = screen.getByTestId('orderbook-grouping') as HTMLSelectElement
    // Ungrouped is the tick, and a BTC ladder at 0.01 is eight rows spanning a
    // couple of dollars - the coarse step is the one that shows where the
    // liquidity is.
    expect(select.value).toBe('10')
  })

  it('falls back to a pair\'s own coarsest step when it does not offer the default', async () => {
    // A finer-quoting market publishes [0.01, 0.05, 0.1, 0.5] and has no 10 at
    // all; the select must not sit on a value with no matching option.
    const { socket } = renderBook()
    await socket.push('orderBook', {
      ...grouped10,
      grouped: {
        '0.05': { buyOrder: [], sellOrder: [] },
        '0.5': { buyOrder: [], sellOrder: [] },
      },
    })
    const select = screen.getByTestId('orderbook-grouping') as HTMLSelectElement
    expect(select.value).toBe('0.5')
    expect(Array.from(select.options).map((o) => o.value)).toContain('0.5')
  })

  it('OPENS on the server ladder, not the sparse raw book', async () => {
    const { socket } = renderBook()
    await socket.push('orderBook', grouped10)

    // The book opens at the coarsest step the venue publishes, so the
    // aggregated levels are what a trader sees first - rows the raw 20-level
    // book could never fill. The raw 49999 is NOT on screen.
    expect(screen.getByText('49990')).toBeInTheDocument()
    expect(screen.getByText('49980')).toBeInTheDocument()
    expect(screen.getByText('50020')).toBeInTheDocument()
    expect(screen.queryByText('49999')).toBeNull()

    // ...and the tick is one click away, which is when the raw book appears.
    selectStep('0')
    await socket.push('orderBook', grouped10)
    expect(screen.getByText('49999')).toBeInTheDocument()
  })

  it('labels the ungrouped step with the venue tick, never a bare "0"', async () => {
    const { socket } = renderBook()
    await socket.push('orderBook', grouped10)

    const select = screen.getByTestId('orderbook-grouping') as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => o.textContent)
    // "0" is the internal "do not group" value; the pair quotes to 2dp, so what
    // that step actually means to a reader is a 0.01 tick.
    expect(labels).toEqual(['0.01', '10'])
    expect(labels).not.toContain('0')
    // ...and the VALUE is untouched, so the grouping logic still sees 0.
    expect(select.options[0].value).toBe('0')
  })

  it('offers exactly the steps the server published', async () => {
    const { socket } = renderBook()
    await socket.push('orderBook', grouped10)

    const select = screen.getByTestId('orderbook-grouping') as HTMLSelectElement
    const offered = Array.from(select.options).map((o) => o.value)
    // 0 (ungrouped) plus the one step this payload carried - no invented steps.
    expect(offered).toEqual(['0', '10'])
  })

  it('still groups locally when the payload carries no ladder (older server)', async () => {
    const { socket } = renderBook()
    const noGrouped = { ...grouped10, grouped: undefined }
    await socket.push('orderBook', noGrouped)

    selectStep('10')
    await socket.push('orderBook', noGrouped)

    // 49999 floors into the 49990 bucket, 50001 ceils into 50010.
    expect(screen.getByText('49990')).toBeInTheDocument()
    expect(screen.getByText('50010')).toBeInTheDocument()
  })

  it('switches Size/Total between the base coin and its quote value', async () => {
    const { socket } = renderBook()
    // Quantities deliberately unlike the notionals (and unlike the prices), so
    // the assertions cannot pass on the PRICE column by accident.
    // No `grouped` block: this test is about the SIZE/TOTAL cells, not about
    // grouping, so let the component group these two levels itself - a single
    // level per side keeps its own quantity and notional through bucketing.
    await socket.push('orderBook', {
      ...grouped10,
      grouped: undefined,
      buyOrder: [{ _id: 49999, quantity: 2, notional: 99998 }],
      sellOrder: [{ _id: 50001, quantity: 3, notional: 150003 }],
    })

    /** Match a number however the formatter groups its thousands. */
    const num = (n: number) => (content: string) =>
      content.replace(/,/g, '') === String(n)

    // Base by default: the coin quantity is shown, its value is not.
    expect(screen.getAllByText(num(2)).length).toBeGreaterThan(0)
    expect(screen.queryByText(num(99998))).toBeNull()

    fireEvent.click(screen.getByTestId('orderbook-unit-toggle'))

    // Quote: the value is shown for both sides.
    expect(screen.getAllByText(num(99998)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(num(150003)).length).toBeGreaterThan(0)
  })
})

/**
 * SIZE-CHANGE FLASH
 * =================
 * A live book marks activity by briefly brightening the row whose size moved.
 * Two things make it correct rather than decorative:
 *  - it fires on a CHANGE, so the first paint of a pair does not flash the whole
 *    book just for arriving;
 *  - the class ALTERNATES (ob_flash_a / ob_flash_b), because the rows are keyed
 *    by position and persist across repaints - re-applying one class name would
 *    never re-trigger the animation.
 */
describe('size-change flash', () => {
  const bookWith = (bidQty: number, askQty: number) => ({
    pairId: PAIR_A,
    healthy: true,
    healthReason: null,
    ladderPresent: true,
    buyOrder: [{ _id: 49990, quantity: bidQty, notional: 49990 * bidQty }],
    sellOrder: [{ _id: 50010, quantity: askQty, notional: 50010 * askQty }],
  })

  const rowClassesFor = (price: string) => {
    const cell = screen.getByText(price)
    const row = cell.closest('div[class*="ob_row"]') as HTMLElement
    return row?.className || ''
  }

  it('does not flash the book merely for arriving', async () => {
    jest.useFakeTimers()
    try {
      const { socket } = renderBook()
      await socket.push('orderBook', bookWith(1, 1))
      expect(rowClassesFor('49990')).not.toMatch(/ob_flash/)
      expect(rowClassesFor('50010')).not.toMatch(/ob_flash/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('flashes only the side whose size actually moved', async () => {
    jest.useFakeTimers()
    try {
      const { socket } = renderBook()
      await socket.push('orderBook', bookWith(1, 1))
      await advance(1100)

      // Bid size moves, ask size does not.
      await socket.push('orderBook', bookWith(2, 1))
      expect(rowClassesFor('49990')).toMatch(/ob_flash/)
      expect(rowClassesFor('50010')).not.toMatch(/ob_flash/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('flashes the bid green and the ask red, not one neutral colour', async () => {
    jest.useFakeTimers()
    try {
      const { socket } = renderBook()
      await socket.push('orderBook', bookWith(1, 1))
      await advance(1100)

      // Both sides move at once.
      await socket.push('orderBook', bookWith(2, 2))

      expect(rowClassesFor('49990')).toMatch(/ob_flash_bid/)
      expect(rowClassesFor('50010')).toMatch(/ob_flash_ask/)
      // ...and never each other's colour.
      expect(rowClassesFor('49990')).not.toMatch(/ob_flash_ask/)
      expect(rowClassesFor('50010')).not.toMatch(/ob_flash_bid/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('alternates the class so a repeatedly changing row keeps re-triggering', async () => {
    jest.useFakeTimers()
    try {
      const { socket } = renderBook()
      await socket.push('orderBook', bookWith(1, 1))
      await advance(1100)

      await socket.push('orderBook', bookWith(2, 1))
      const first = rowClassesFor('49990')
      await advance(1100)

      await socket.push('orderBook', bookWith(3, 1))
      const second = rowClassesFor('49990')

      expect(first).toMatch(/ob_flash/)
      expect(second).toMatch(/ob_flash/)
      // Same class twice would be a no-op to the CSS engine - the row would
      // flash once and then sit still while its size kept moving.
      expect(first).not.toEqual(second)
    } finally {
      jest.useRealTimers()
    }
  })
})
