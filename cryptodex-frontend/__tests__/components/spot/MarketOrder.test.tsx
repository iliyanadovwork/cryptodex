/**
 * Spot MARKET ticket — the order-placement gate.
 *
 * A market order is the sharpest case: it exists only to be filled immediately
 * against the other side of the book. If the ladder is gone, the read-only
 * "Index Price" field is also quoting a figure the order could never get.
 */

import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import MarketOrder from '@/components/spot/MarketOrder'
import { DEFAULT_BOOK_HEALTH } from '@/lib/orderBookHealth'

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

const tradePair = {
  _id: PAIR_A,
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD',
  firstFloatDigit: 6,
  secondFloatDigit: 2,
  markPrice: 50000,
  botstatus: 'binance',
}

const renderTicket = (bookHealth: any) => {
  const store = configureStore({
    reducer: {
      spot: (
        state = {
          tradePair,
          marketData: { markPrice: 50000, _id: PAIR_A },
          orderBookPrice: {},
          firstCurrency: { spotBal: 5 },
          secondCurrency: { spotBal: 100000 },
          bookHealth,
        }
      ) => state,
      auth: (state = { session: { signedIn: true } }) => state,
      wallet: (state = { priceConversion: [] }) => state,
    },
  })
  return render(
    <Provider store={store}>
      <MarketOrder activeTab="buy" />
    </Provider>
  )
}

const buyButton = () => screen.getByRole('button', { name: /^Buy$/i })
const priceField = () => document.querySelector('input[name="market"]') as HTMLInputElement

const fillTicket = () => {
  const value = document.querySelector('input[name="orderValue"]') as HTMLInputElement
  fireEvent.change(value, { target: { name: 'orderValue', value: '100' } })
}

/**
 * Invoke the ticket's own submit handler — the exact function wired to the Buy
 * button — instead of clicking it.
 *
 * React refuses to dispatch mouse events to an element whose props say
 * `disabled`, and jsdom suppresses them too, so a click on the paused button
 * never reaches handleSubmit. Asserting "apiOrderPlace was not called" after
 * such a click therefore passes with the guard inside handleSubmit deleted —
 * which is how this file used to be written. This reaches the second layer for
 * real; the disabled button has its own tests.
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

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

const dead = {
  healthy: false,
  reason: 'ladder_orphaned',
  ladderPresent: false,
  pairId: PAIR_A,
  pending: false,
}

describe('MarketOrder — book health gate', () => {
  beforeEach(() => {
    mockOrderPlace.mockResolvedValue({ data: { status: true, message: 'Order placed' } })
  })

  it('disables the ticket and explains why when nothing can fill', () => {
    renderTicket(dead)

    expect(buyButton()).toBeDisabled()
    expect(screen.getByTestId('ticket-paused-note')).toHaveTextContent(/no liquidity available/i)
    expect(screen.getByTestId('ticket-paused-note').textContent).not.toContain('ladder_orphaned')
  })

  it('stops quoting a price the order could not get', () => {
    renderTicket(dead)
    // With no book there is nothing to reference, so the field shows a dash
    // rather than a live-looking number.
    expect(priceField().value).toBe('—')
  })

  it('estimates what the order buys, because the ticket computed nothing before', () => {
    // The limit ticket turns your inputs into a Total. This one turned them
    // into nothing: you typed a figure and the form never said what it buys.
    renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
    const valueField = document.querySelector(
      'input[name="orderValue"]'
    ) as HTMLInputElement
    fireEvent.change(valueField, { target: { name: 'orderValue', value: '100' } })
    const est = screen.getByTestId('market-estimate-buy').textContent || ''
    // Priced off markPrice, so it must be an approximation and say so - the
    // fill is re-derived against the ladder.
    expect(est).toMatch(/≈/)
    expect(est).toMatch(/BTC/)
  })

  it('offers a share of the balance without arithmetic', () => {
    renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
    const pct = screen.getAllByRole('button', { name: /^(25|50|75|100)%$/ })
    expect(pct).toHaveLength(4)

    // CLICK one. Counting the buttons passed while the handler threw
    // "setBuyFormValue is not defined" - the component's setter is spelled
    // setBuyFormvalue - and only a real click catches that.
    fireEvent.click(pct[3]) // 100%
    const valueField = document.querySelector(
      'input[name="orderValue"]'
    ) as HTMLInputElement
    expect(parseFloat(valueField.value)).toBeGreaterThan(0)
  })

  it('says Market in the price slot rather than showing a number', () => {
    // The slot showed markPrice - a 30-second reference the order does not
    // price from - and a number in a price field on an order ticket reads as a
    // quote. A market order has no price until it fills, so it says so. The
    // reference figure is still in the header, labelled and updated identically.
    renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
    expect(priceField().value).toBe('Market')
    expect(priceField().value).not.toMatch(/[0-9]/)
  })


  it('places nothing on a real click — and the identical click DOES place it when healthy', async () => {
    // Same events, same fields, same click: the only difference between the two
    // halves is the verdict. Without the healthy half, "not called" proves
    // nothing at all.
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
    const paused = renderTicket(dead)
    fillTicket()
    await submitViaTicketHandler()

    expect(mockOrderPlace).not.toHaveBeenCalled()
    expect(mockToastAlert).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/no liquidity available/i),
      'orderPlace'
    )

    paused.unmount()

    // Control: the same handler, healthy verdict — so the assertion above is
    // about the guard, not about an unreachable handler.
    renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
    fillTicket()
    await submitViaTicketHandler()

    await waitFor(() => expect(mockOrderPlace).toHaveBeenCalledTimes(1))
  })

  it('quotes a price again once the book is healthy', () => {
    renderTicket({ ...DEFAULT_BOOK_HEALTH, pairId: PAIR_A })
    expect(priceField().value).not.toBe('—')
  })
})
