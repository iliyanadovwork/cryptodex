/**
 * FeedStaleBadge — the "NOT LIVE" label for ticker-derived numbers.
 *
 * It exists because only the order book used to stop lying: when the feed died,
 * the page header kept painting a frozen Mark Price, 24H change/high/low/volume,
 * the chart and Recent Trades as if they were current.
 *
 * It is driven by the TICKER's own silence, never by the order book's verdict.
 * That distinction is the whole design: a purged ladder means orders cannot
 * fill, but the last traded price and the 24H stats keep arriving and remain
 * true, so the book blanking itself while the header keeps ticking is correct.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import FeedStaleBadge from '@/components/spot/FeedStaleBadge'

jest.mock('@/store', () => {
  const actualReactRedux = jest.requireActual('react-redux')
  return {
    useSelector: actualReactRedux.useSelector,
    useDispatch: actualReactRedux.useDispatch,
  }
})

const renderBadge = (spotState: any) => {
  const store = configureStore({ reducer: { spot: (state = spotState) => state } })
  return render(
    <Provider store={store}>
      <FeedStaleBadge />
    </Provider>
  )
}

describe('FeedStaleBadge', () => {
  it('renders nothing while the feed is live', () => {
    renderBadge({ tickerStale: false })
    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })

  it('labels the numbers when the venue tick has gone silent', () => {
    renderBadge({ tickerStale: true })

    const badge = screen.getByTestId('feed-stale-badge')
    expect(badge).toHaveTextContent(/not live/i)
    // Announced, so a screen reader user is not the last to know.
    expect(badge).toHaveAttribute('role', 'status')
    expect(badge.getAttribute('title')).toMatch(/not updating/i)
  })

  it('does not react to the order book verdict', () => {
    // An unhealthy book with a live ticker: the ladder is gated, the header is
    // not, and this badge must stay away.
    renderBadge({
      tickerStale: false,
      bookHealth: { healthy: false, reason: 'no_admin_liquidity', pairId: 'PAIR_A' },
    })

    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })

  it('survives a store that has never set the flag', () => {
    renderBadge({})
    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })
})
