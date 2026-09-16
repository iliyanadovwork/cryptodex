/**
 * MarketTable — the home page "Popular Cryptocurrencies" teaser.
 *
 * It rendered ZERO rows. The row source was
 *
 *     pList.filter(item => item.secondCurrencySymbol === 'USDT')
 *
 * and this venue has no USDT: every spot pair quotes in USD (BTCUSD, ETHUSD,
 * SOLUSD). So the filter matched nothing, the table body was empty, and the
 * column header still advertised "Market Price (USDT)" — a quote asset the
 * platform does not offer.
 *
 * These tests use the REAL pair shape the spot API returns (verified against
 * GET :2568/api/spot/tradePair) so a regression to a quote-specific filter
 * fails here.
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { useRouter } from 'next/router'
import MarketTable, { rankPairs } from '@/components/Market/MarketTable'
import { apigetPairList } from '@/services/Spot/SpotService'

jest.mock('next/router', () => ({ useRouter: jest.fn() }))

jest.mock('@/components/Context/SocketContext', () => ({
  __esModule: true,
  default: React.createContext({
    spotSocket: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
  }),
}))

jest.mock('@/services/Spot/SpotService', () => ({
  apigetPairList: jest.fn(),
}))

// The exact rows the running venue serves, quote asset and all.
const LIVE_PAIRS = [
  {
    _id: 'btc',
    firstCurrencySymbol: 'BTC',
    secondCurrencySymbol: 'USD',
    markPrice: 64202.01,
    last: 64202.01,
    change: -0.01,
    secondVolume: 365801.79,
    status: 'active',
  },
  {
    _id: 'sol',
    firstCurrencySymbol: 'SOL',
    secondCurrencySymbol: 'USD',
    markPrice: 74.12,
    last: 74.12,
    change: -0.01,
    secondVolume: 295132.44,
    status: 'active',
  },
  {
    _id: 'eth',
    firstCurrencySymbol: 'ETH',
    secondCurrencySymbol: 'USD',
    markPrice: 1873.14,
    last: 1873.14,
    change: 0,
    secondVolume: 45012.9,
    status: 'active',
  },
]

describe('rankPairs', () => {
  it('lists the venue\'s USD pairs instead of dropping them', () => {
    // The regression that emptied the table: anything quote-specific here
    // returns [] for this venue.
    expect(rankPairs(LIVE_PAIRS).map((p: any) => p._id)).toEqual([
      'btc',
      'sol',
      'eth',
    ])
  })

  it('orders by turnover, busiest first', () => {
    const shuffled = [LIVE_PAIRS[2], LIVE_PAIRS[0], LIVE_PAIRS[1]]
    expect(rankPairs(shuffled).map((p: any) => p.secondVolume)).toEqual([
      365801.79, 295132.44, 45012.9,
    ])
  })

  it('sorts string volumes numerically, not lexically', () => {
    const asStrings = [
      { _id: 'a', secondVolume: '9' },
      { _id: 'b', secondVolume: '100' },
    ]
    expect(rankPairs(asStrings).map((p: any) => p._id)).toEqual(['b', 'a'])
  })

  it('drops delisted pairs but keeps ones that never stated a status', () => {
    const mixed = [
      { _id: 'dead', secondVolume: 999, status: 'deactive' },
      { _id: 'silent', secondVolume: 5 },
    ]
    expect(rankPairs(mixed).map((p: any) => p._id)).toEqual(['silent'])
  })

  it('does not mutate the caller\'s array', () => {
    const input = [...LIVE_PAIRS]
    const order = input.map((p) => p._id)
    rankPairs(input)
    expect(input.map((p) => p._id)).toEqual(order)
  })

  it('survives a failed request', () => {
    expect(rankPairs(undefined)).toEqual([])
    expect(rankPairs(null)).toEqual([])
    expect(rankPairs({} as any)).toEqual([])
  })
})

describe('MarketTable rendering', () => {
  beforeEach(() => {
    ;(useRouter as jest.Mock).mockReturnValue({ push: jest.fn(), query: {} })
    ;(apigetPairList as jest.Mock).mockResolvedValue({
      data: { result: LIVE_PAIRS },
    })
  })

  it('renders a row per listed pair', async () => {
    render(<MarketTable />)
    await waitFor(() =>
      expect(screen.getAllByTestId('popular-pair-row')).toHaveLength(3)
    )
  })

  it('shows the pairs the venue actually offers', async () => {
    render(<MarketTable />)
    await waitFor(() => screen.getAllByTestId('popular-pair-row'))
    expect(screen.getByText('BTC')).toBeInTheDocument()
    expect(screen.getAllByText('/USD').length).toBe(3)
  })

  it('does not advertise a quote asset the platform lacks', async () => {
    render(<MarketTable />)
    await waitFor(() => screen.getAllByTestId('popular-pair-row'))
    const headers = screen
      .getAllByRole('columnheader')
      .map((th) => th.textContent)
    expect(headers).toContain('Market Price')
    headers.forEach((h) => expect(h).not.toMatch(/USDT/i))
  })

  it('prints each row\'s own quote symbol next to its price', async () => {
    render(<MarketTable />)
    const rows = await waitFor(() => screen.getAllByTestId('popular-pair-row'))
    const cells = rows[0].querySelectorAll('td')
    // Name | Last | Change | Market Price | Action
    expect(cells[3].textContent).toContain('USD')
    expect(cells[3].textContent).not.toContain('$')
  })

  it('caps the teaser at five rows', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      _id: `p${i}`,
      firstCurrencySymbol: `C${i}`,
      secondCurrencySymbol: 'USD',
      markPrice: 1,
      last: 1,
      change: 0,
      secondVolume: 100 - i,
      status: 'active',
    }))
    ;(apigetPairList as jest.Mock).mockResolvedValue({ data: { result: many } })
    render(<MarketTable />)
    await waitFor(() =>
      expect(screen.getAllByTestId('popular-pair-row')).toHaveLength(5)
    )
  })
})
