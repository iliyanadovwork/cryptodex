/**
 * The market-scoped "NOT LIVE" badge.
 *
 * Spot already stopped lying when its feed died. The other markets this venue
 * once listed did not: their headers went on painting a frozen Mark Price,
 * Index Price and 24H change/high/low/volume/turnover as the current market,
 * and their Recent Trades panels went on presenting a list that had stopped
 * growing as "the latest trades".
 *
 * The badge is one component with a `market` prop. These tests pin the part
 * that matters: EACH MARKET IS JUDGED ON ITS OWN FEED. A dead feed on one
 * market must not make another market's header apologise.
 *
 * Spot is the only market this venue lists, so `alpha` and `beta` below are
 * stand-in slice names. The component reads `state[market].tickerStale` for
 * whatever string it is handed, so the scoping is what is under test, never the
 * identity of any particular second market.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import FeedStaleBadge from '@/components/FeedStaleBadge'
import SpotFeedStaleBadge from '@/components/spot/FeedStaleBadge'

jest.mock('@/store', () => {
  const actualReactRedux = jest.requireActual('react-redux')
  return {
    useSelector: actualReactRedux.useSelector,
    useDispatch: actualReactRedux.useDispatch,
  }
})

const renderWith = (state: any, element: React.ReactElement) => {
  const store = configureStore({
    reducer: {
      spot: (s = state.spot ?? {}) => s,
      alpha: (s = state.alpha ?? {}) => s,
      beta: (s = state.beta ?? {}) => s,
    },
  })
  return render(<Provider store={store}>{element}</Provider>)
}

describe('FeedStaleBadge — per-market scoping', () => {
  it.each(['spot', 'alpha', 'beta'] as const)(
    'labels %s when its own tick has gone silent',
    (market) => {
      renderWith({ [market]: { tickerStale: true } }, <FeedStaleBadge market={market} />)
      const badge = screen.getByTestId('feed-stale-badge')
      expect(badge).toHaveTextContent(/not live/i)
      expect(badge).toHaveAttribute('role', 'status')
      expect(badge.getAttribute('title')).toMatch(/not updating/i)
    }
  )

  it.each(['spot', 'alpha', 'beta'] as const)(
    'stays away while %s is live',
    (market) => {
      renderWith({ [market]: { tickerStale: false } }, <FeedStaleBadge market={market} />)
      expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
    }
  )

  it('a dead alpha feed does not make the spot header apologise', () => {
    renderWith(
      { alpha: { tickerStale: true }, spot: { tickerStale: false } },
      <FeedStaleBadge market="spot" />
    )
    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })

  it('a dead spot feed does not make the beta header apologise', () => {
    renderWith(
      { spot: { tickerStale: true }, beta: { tickerStale: false } },
      <FeedStaleBadge market="beta" />
    )
    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })

  it('ignores the order book verdict entirely', () => {
    // A purged ladder gates orders; it does not make the last traded price or
    // the 24H stats false. The book blanking while the header ticks is correct.
    renderWith(
      {
        alpha: {
          tickerStale: false,
          bookHealth: { healthy: false, reason: 'no_admin_liquidity' },
        },
      },
      <FeedStaleBadge market="alpha" />
    )
    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })

  it('survives a slice that has never set the flag', () => {
    renderWith({}, <FeedStaleBadge market="alpha" />)
    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })

  it('defaults to spot when no market is named', () => {
    renderWith({ spot: { tickerStale: true } }, <FeedStaleBadge />)
    expect(screen.getByTestId('feed-stale-badge')).toBeInTheDocument()
  })
})

describe('the spot binding still reads the spot slice', () => {
  it('shows when spot is stale', () => {
    renderWith({ spot: { tickerStale: true } }, <SpotFeedStaleBadge />)
    expect(screen.getByTestId('feed-stale-badge')).toBeInTheDocument()
  })

  it('does not show for another market being stale', () => {
    renderWith(
      { spot: { tickerStale: false }, beta: { tickerStale: true } },
      <SpotFeedStaleBadge />
    )
    expect(screen.queryByTestId('feed-stale-badge')).toBeNull()
  })
})
