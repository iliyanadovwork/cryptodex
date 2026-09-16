/**
 * Spot LIMIT ticket — the order-placement gate.
 *
 * The whole point of the health layer is this file: while the published verdict
 * says nothing can fill, the ticket must not hand an order to the API. These
 * tests exercise it end to end through the rendered ticket — the button state,
 * the explanation, and above all whether apiOrderPlace is reached.
 */

import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import LimitOrder from '@/components/spot/LimitOrder'
import { DEFAULT_BOOK_HEALTH, pendingBookHealth } from '@/lib/orderBookHealth'
import { PENDING_VERDICT_GRACE_MS } from '@/hooks/useSpotBookHealth'

jest.mock('@/store', () => {
  const actualReactRedux = jest.requireActual('react-redux')
  return {
    useSelector: actualReactRedux.useSelector,
    useDispatch: actualReactRedux.useDispatch,
  }
})

const mockOrderPlace = jest.fn()
jest.mock('@/services/Spot/SpotService', () => ({
  apiOrderPlace: (...args: any[]) => mockOrderPlace(...args),
}))

jest.mock('@/lib/cryptoJS', () => ({
  encryptObject: jest.fn(() => 'encrypted-token'),
}))

const mockToastAlert = jest.fn()
jest.mock('@/lib/toastAlert', () => ({
  toastAlert: (...args: any[]) => mockToastAlert(...args),
}))

const PAIR_A = '695bf1017573eeb15a749c9d'
const PAIR_B = '695bf1017573eeb15a749c9f'

const tradePair = {
  _id: PAIR_A,
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD',
  firstFloatDigit: 6,
  secondFloatDigit: 2,
  markPrice: 50000,
  botstatus: 'binance',
}

const spotState = (bookHealth: any, pair: any = tradePair) => ({
  tradePair: pair,
  marketData: { markPrice: 50000 },
  orderBookPrice: {},
  firstCurrency: { spotBal: 5 },
  secondCurrency: { spotBal: 100000 },
  bookHealth,
})

const renderTicket = (bookHealth: any, pair: any = tradePair) => {
  const store = configureStore({
    reducer: {
      spot: (state = spotState(bookHealth, pair)) => state,
      auth: (state = { session: { signedIn: true } }) => state,
      wallet: (state = { priceConversion: [] }) => state,
    },
  })
  return render(
    <Provider store={store}>
      <LimitOrder activeTab="buy" />
    </Provider>
  )
}

const buyButton = () => screen.getByRole('button', { name: /^Buy$/i })

const fillTicket = () => {
  const price = document.querySelector('input[name="price"]') as HTMLInputElement
  fireEvent.change(price, { target: { name: 'price', value: '50000' } })
  const amount = document.querySelector('input[name="quantity"]') as HTMLInputElement
  fireEvent.change(amount, { target: { name: 'quantity', value: '0.01' } })
}

/**
 * Invoke the ticket's OWN submit handler — the exact function the component
 * hands to the Buy button — instead of clicking the button.
 *
 * THIS IS THE POINT OF THE FILE. The gate has two layers: the button is
 * disabled, and handleSubmit refuses again on its own. React will not dispatch a
 * mouse event to an element whose props say `disabled` (shouldPreventMouseEvent
 * in react-dom's event system), and jsdom suppresses it too — so a click on the
 * paused button never reaches handleSubmit, and asserting "apiOrderPlace was not
 * called" after such a click is true whatever handleSubmit does. That assertion
 * passed with the second layer deleted, which is how this file used to be
 * written and why the gate could have been removed unnoticed.
 *
 * Reaching in for the handler is the only way to exercise the second layer at
 * all. The first layer has its own tests: the button really is disabled, and a
 * real click on it places nothing.
 */
const submitViaTicketHandler = async () => {
  const button = buyButton()
  const propsKey = Object.keys(button).find((k) => k.startsWith('__reactProps$'))
  if (!propsKey) throw new Error('could not find the React props on the Buy button')
  const { onClick } = (button as any)[propsKey]
  await act(async () => {
    await onClick({ preventDefault() {} })
  })
}

/** Let any promise chain inside handleSubmit run to completion. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('LimitOrder — book health gate', () => {
  beforeEach(() => {
    mockOrderPlace.mockResolvedValue({ data: { status: true, message: 'Order placed' } })
  })

  describe('when the published verdict says the book cannot fill', () => {
    const dead = {
      healthy: false,
      reason: 'no_admin_liquidity',
      ladderPresent: false,
      pairId: PAIR_A,
      pending: false,
    }

    it('disables the Buy button', () => {
      renderTicket(dead)
      expect(buyButton()).toBeDisabled()
    })

    it('explains why, in English, above the button', () => {
      renderTicket(dead)
      const note = screen.getByTestId('ticket-paused-note')

      expect(note).toHaveTextContent(/Trading paused/i)
      expect(note).toHaveTextContent(/no liquidity available/i)
      // Never the raw enum from the backend.
      expect(note.textContent).not.toContain('no_admin_liquidity')
      // And it promises recovery rather than looking like a dead end.
      expect(note).toHaveTextContent(/re-enables on its own/i)
    })

    it('places nothing on a real click — and the identical click DOES place it when healthy', async () => {
      // The control and the assertion live in one test on purpose: "the API was
      // not called" means nothing unless the very same sequence of events,
      // differing in nothing but the verdict, does call it.
      const paused = renderTicket(dead)
      fillTicket()
      // The mechanism, stated: the button a user can reach is inert.
      expect(buyButton()).toBeDisabled()
      fireEvent.click(buyButton())
      await flush()

      expect(mockOrderPlace).not.toHaveBeenCalled()

      paused.unmount()

      renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
      fillTicket()
      fireEvent.click(buyButton())

      await waitFor(() => expect(mockOrderPlace).toHaveBeenCalledTimes(1))
    })

    it('refuses inside the submit handler as well, and says why', async () => {
      // The second layer, on its own: if something ever reaches handleSubmit
      // while the book cannot fill — a verdict landing between paint and click,
      // a scripted submit — it still must not become an order.
      const paused = renderTicket(dead)
      fillTicket()
      await submitViaTicketHandler()

      expect(mockOrderPlace).not.toHaveBeenCalled()
      // ...and the refusal is explained rather than silent.
      expect(mockToastAlert).toHaveBeenCalledWith(
        'error',
        expect.stringMatching(/no liquidity available/i),
        'orderPlace'
      )

      paused.unmount()

      // The control: the same handler, same fields, healthy verdict — this is
      // what proves the assertion above is about the guard and not about the
      // handler being unreachable.
      renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
      fillTicket()
      await submitViaTicketHandler()

      await waitFor(() => expect(mockOrderPlace).toHaveBeenCalledTimes(1))
    })
  })

  describe('when the verdict is healthy for this pair', () => {
    const alive = { ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A }

    it('enables the ticket and shows no warning', () => {
      renderTicket(alive)

      expect(buyButton()).not.toBeDisabled()
      expect(screen.queryByTestId('ticket-paused-note')).toBeNull()
    })

    it('places the order', async () => {
      renderTicket(alive)
      fillTicket()

      fireEvent.click(buyButton())

      await waitFor(() => expect(mockOrderPlace).toHaveBeenCalledTimes(1))
    })
  })

  describe('when no verdict for this pair has arrived yet', () => {
    it('holds the ticket closed rather than assuming the book is fine', () => {
      // Exactly the state right after a pair switch: the store still holds the
      // previous pair's verdict, which says nothing about this one.
      renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_B })

      expect(buyButton()).toBeDisabled()
      expect(screen.getByTestId('ticket-paused-note')).toHaveTextContent(/Loading the order book/i)
    })

    it('refuses to place an order during that window, through both layers', async () => {
      renderTicket(pendingBookHealth(PAIR_A))
      fillTicket()

      // Layer one: the button a user can actually reach.
      fireEvent.click(buyButton())
      await flush()
      expect(mockOrderPlace).not.toHaveBeenCalled()

      // Layer two: the handler itself, reached directly.
      await submitViaTicketHandler()
      expect(mockOrderPlace).not.toHaveBeenCalled()
      expect(mockToastAlert).toHaveBeenCalledWith(
        'error',
        expect.stringMatching(/loading the order book/i),
        'orderPlace'
      )
    })

    it('lets that same handler place the order once the wait is over', async () => {
      // The control for the test above: nothing about this ticket is inert.
      jest.useFakeTimers()
      try {
        renderTicket(pendingBookHealth(PAIR_A))
        fillTicket()

        await act(async () => {
          jest.advanceTimersByTime(PENDING_VERDICT_GRACE_MS + 100)
        })
        await submitViaTicketHandler()

        expect(mockOrderPlace).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })

    it('opens by itself if the payload never comes, so an ungated pair still trades', async () => {
      jest.useFakeTimers()
      try {
        renderTicket(pendingBookHealth(PAIR_A))
        expect(buyButton()).toBeDisabled()

        await act(async () => {
          jest.advanceTimersByTime(PENDING_VERDICT_GRACE_MS + 100)
        })

        expect(buyButton()).not.toBeDisabled()
        expect(screen.queryByTestId('ticket-paused-note')).toBeNull()
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
