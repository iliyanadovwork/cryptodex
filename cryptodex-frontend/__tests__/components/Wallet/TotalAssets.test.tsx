/**
 * "Total Assets Value" on the wallet page has to be a total.
 *
 * It was the value of whichever tab was selected. Switching between two of the
 * wallets this venue used to have made the headline figure change even though
 * the user owned exactly the same money — and an internal transfer between
 * them, which moves nothing in or out of the account, made it fall. Watching
 * that number, a user would reasonably conclude the venue had destroyed their
 * funds.
 *
 * These tests render the real WalletList. There are no wallet tabs left to
 * click: the venue is spot-only, so the page shows one wallet and the tab strip
 * is a heading. What survives, and is asserted below, is the pair of properties
 * that fixed the original fault and still bind:
 *
 *   - the headline counts everything it claims to, and does not move when money
 *     moves BETWEEN things it counts (spot available -> resting order);
 *   - anything the headline counts is printed underneath it, so a reader with a
 *     calculator can check it. With one wallet left that check is the spot
 *     table itself; a one-line "Spot balance:" breakdown would restate the
 *     headline word for word and is not printed.
 *
 * The fixture keeps a few balance columns that no bucket names. A live payload
 * can no longer carry them — walletapi's wallet schema does not declare them
 * and getWallet answers from an explicit projection — so they are here to give
 * the headline something it must ignore, which is a claim worth rendering
 * rather than assuming.
 */

import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { useRouter } from 'next/router'
import { useSelector, useDispatch } from 'react-redux'

jest.mock('@/store', () => ({ useSelector, useDispatch, default: jest.fn() }))

import WalletList from '@/components/Wallet/WalletList'

jest.mock('next/router', () => ({ useRouter: jest.fn() }))
jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />,
}))
jest.mock('@/services/Wallet/WalletService', () => ({
  apiGetUserDeposit: jest.fn(() => Promise.resolve()),
}))

/**
 * One coin, USD. Priced 1:1 in USD so the arithmetic in the assertions is the
 * arithmetic a user would do in their head.
 */
const makeStore = (usd: any, currency: any = {}) =>
  configureStore({
    reducer: {
      wallet: () => ({
        assets: [
          {
            _id: 'usd1',
            coin: 'USD',
            currencyId: 'cur-usd',
            spotBal: '0',
            spotInOrder: '0',
            spotLockedBal: '0',
            derivativeBal: '0',
            derivativeBalLocked: '0',
            inverseBal: '0',
            inverseLockBal: '0',
            affiliateBal: '0',
            tokenAddressArray: [],
            ...usd,
          },
        ],
        currency: [
          {
            _id: 'usd1',
            coin: 'USD',
            type: 'crypto',
            status: 'active',
            image: '/images/usd.png',
            decimals: 2,
            contractDecimal: 2,
            ...currency,
          },
        ],
        priceConversion: [
          { baseSymbol: 'USD', convertSymbol: 'USD', convertPrice: '1' },
          { baseSymbol: 'USD', convertSymbol: 'BTC', convertPrice: '0.0000156' },
        ],
        loading: false,
      }),
      spot: () => ({ pairList: [] }),
    },
  })

const renderWallet = (usd: any, currency: any = {}) =>
  render(
    <Provider store={makeStore(usd, currency)}>
      <WalletList />
    </Provider>
  )

/** The USD figure out of "10000.00 USD ≈ 0.15600000 BTC". */
const headlineUsd = () => {
  const text = screen.getByTestId('total-assets-value').textContent || ''
  const match = text.match(/([\d.]+)\s*USD/)
  return match ? parseFloat(match[1]) : NaN
}

/**
 * Every "Estimated Value" printed in the spot table, added up.
 *
 * With one wallet the checkable-by-the-reader property moved from a per-wallet
 * breakdown (which would restate the headline) to the table: the headline is
 * the sum of the rows printed beneath it.
 */
const printedRowsTotal = () => {
  const cells = screen.getAllByTestId('spot-estimated')
  return cells.reduce(
    (sum, el) => sum + (parseFloat(el.textContent || '0') || 0),
    0
  )
}

beforeEach(() => {
  ;(useRouter as jest.Mock).mockReturnValue({ push: jest.fn(), pathname: '/wallet', query: {} })
})

describe('Total Assets Value', () => {
  const stranded = { spotBal: '5000', derivativeBal: '3000', inverseBal: '2000' }

  it('counts the wallet the user can actually spend from', () => {
    renderWallet(stranded)
    expect(headlineUsd()).toBeCloseTo(5000, 2)
  })

  it('does not count a derivative balance no product can reach', () => {
    // No bucket names these fields, so nothing sums them. Adding them to
    // "Total Assets Value" would tell the user they have 10,000 to trade with
    // when they have 5,000.
    renderWallet(stranded)
    expect(headlineUsd()).not.toBeCloseTo(10000, 2)
  })

  it('is unchanged when spot money moves into a resting order', () => {
    const { unmount } = renderWallet({ spotBal: '10000', spotInOrder: '0' })
    const before = headlineUsd()
    unmount()

    renderWallet({ spotBal: '2500', spotInOrder: '7500' })
    expect(headlineUsd()).toBeCloseTo(before, 2)
  })

  it('DOES change when money genuinely arrives', () => {
    // The guard must not be vacuous.
    const { unmount } = renderWallet({ spotBal: '10000' })
    const before = headlineUsd()
    unmount()

    renderWallet({ spotBal: '15000' })
    expect(headlineUsd() - before).toBeCloseTo(5000, 2)
  })

  it('no longer claims a scope the venue does not have', () => {
    // "(all wallets)" answered "is this figure the open tab or everything?".
    // There are no tabs, so it would now raise that question instead.
    renderWallet(stranded)
    const label = screen.getByTestId('total-assets-label')
    expect(label).toHaveTextContent(/Total Assets Value/i)
    expect(label).not.toHaveTextContent(/all wallets/i)
  })
})

/**
 * THE HEADLINE MUST EQUAL THE FIGURES PRINTED UNDER IT.
 *
 * The reported fault: "TOTAL ASSETS VALUE (ALL WALLETS)" did not equal the sum
 * of the wallet balances printed directly beneath it. It could not, because
 * only ONE of them was printed - the tab currently open - while the headline
 * counted all of them.
 *
 * This venue now has ONE wallet, so the per-wallet breakdown is gone: a single
 * "Spot balance:" line would restate the headline word for word. What a reader
 * with a calculator checks instead is the spot table, whose Estimated Value
 * column is priced from the same buckets the headline sums.
 */
describe('the figures under it', () => {
  it('prints no per-wallet breakdown, because there is one wallet', () => {
    renderWallet({ spotBal: '5000' })
    expect(screen.queryByTestId('wallet-breakdown')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wallet-balance-spot')).not.toBeInTheDocument()
    expect(headlineUsd()).toBeCloseTo(5000, 2)
  })

  it('never captions anything "Affiliate" - that wallet does not exist', () => {
    renderWallet({ spotBal: '5000', affiliateBal: '250' })
    expect(screen.queryByTestId('wallet-balance-affiliate')).not.toBeInTheDocument()
    expect(screen.queryByText(/affiliate/i)).not.toBeInTheDocument()
  })

  it('does not count an affiliate balance no product can credit or spend', () => {
    // The programme was removed: there are no plans, no commission rates and no
    // rewards, so nothing can put money into `affiliateBal` and nothing can take
    // it out. Counting it would tell the user they have 5,250 to trade with when
    // they have 5,000 - the same lie the stranded derivative balances would be.
    renderWallet({ spotBal: '5000', affiliateBal: '250' })
    expect(headlineUsd()).toBeCloseTo(5000, 2)
  })

  it('equals the rows printed beneath it', () => {
    renderWallet({ spotBal: '5000' })
    expect(printedRowsTotal()).toBeCloseTo(headlineUsd(), 2)
  })

  it('equals them TO THE CENT when the values do not round cleanly', () => {
    // Observed live: figures truncated independently summed to a cent less than
    // the separately truncated headline, so the page contradicted itself one
    // decimal place below the complaint that was filed.
    renderWallet({ spotBal: '18005.664' })
    expect(printedRowsTotal().toFixed(2)).toBe(headlineUsd().toFixed(2))
  })

  it('still adds up when spot funds are split across available / in-order / locked', () => {
    // The case behind the row-level bug: money resting in an order is still the
    // user's, and the headline counts it, so the printed row must too.
    renderWallet({
      spotBal: '4000',
      spotInOrder: '600',
      spotLockedBal: '400',
    })
    expect(headlineUsd()).toBeCloseTo(5000, 2)
    expect(printedRowsTotal()).toBeCloseTo(headlineUsd(), 2)
  })
})

/**
 * THE SPOT ROW MUST NOT CONTRADICT ITSELF.
 *
 * Reported: "SUB TOTAL 9000.00 but ESTIMATED VALUE(USD) 8400.00 for a 1:1
 * asset". Sub Total counted spotBal + spotInOrder while Estimated Value was
 * priced off spotBal alone.
 */
describe('the spot table row', () => {
  const cell = (coin: string, testid: string) =>
    parseFloat(
      within(screen.getByTestId(`spot-row-${coin}`))
        .getByTestId(testid)
        .textContent || 'NaN'
    )

  it('prices the WHOLE holding, not just the spendable part', () => {
    // The bug this pins: money resting in an order is still yours, and the
    // headline counts it, so the row must value it too. A row with 8400 free
    // and 600 in an order once printed an estimate of 8400.
    //
    // The Sub Total column that used to state this quantity is gone - it was
    // Available + In Orders with both printed beside it - so the property is
    // now held directly between the two columns that remain.
    renderWallet({ spotBal: '8400', spotInOrder: '600', spotLockedBal: '0' })
    const held = cell('USD', 'spot-available') + cell('USD', 'spot-in-order')
    expect(held).toBeCloseTo(9000, 2)
    // Priced 1:1, so the estimate must equal what is held, not what is free.
    expect(cell('USD', 'spot-estimated')).toBeCloseTo(9000, 2)
    expect(cell('USD', 'spot-estimated')).not.toBeCloseTo(
      cell('USD', 'spot-available'),
      2
    )
  })

  it('prints Estimated Value in dollars, not in the row coin\'s precision', () => {
    // Estimated Value used to share the size columns' formatter, so it
    // inherited the ROW COIN's decimals: an 8-decimal coin printed its dollar
    // value as 100.00000000. Every row of that column is the same currency, so
    // it takes that currency's 2dp no matter what the coin's precision is.
    renderWallet({ spotBal: '100', spotInOrder: '0' }, { decimals: 8, contractDecimal: 8 })
    const row = within(screen.getByTestId('spot-row-USD'))
    expect(row.getByTestId('spot-estimated').textContent).toMatch(/^\d+\.\d{2}$/)
    // ...while the size columns still use the coin's own precision.
    expect(row.getByTestId('spot-available').textContent).toMatch(/^\d+\.\d{8}$/)
  })

  it('applies a conversion rate that is not 1:1', () => {
    // Guards against a "fix" that simply copies Sub Total into Estimated Value.
    renderWallet({ spotBal: '100', spotInOrder: '0', coin: 'USD' })
    expect(cell('USD', 'spot-estimated')).toBeCloseTo(100, 2)
  })
})
