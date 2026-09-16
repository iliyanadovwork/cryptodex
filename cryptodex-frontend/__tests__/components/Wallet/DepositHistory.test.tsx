/**
 * DepositHistory Component Tests (CRITICAL)
 *
 * A faucet claim once credited two wallets. The server recorded only one half,
 * and this table filled the gap by joining a receipt kept in THIS browser's
 * localStorage onto the server rows — so the other half was visible only on the
 * device that claimed it, and vanished with the storage.
 *
 * Every leg is a server row now, each carrying the wallet it landed in. These
 * tests pin the consequence: the table renders what the API returned, and it
 * renders NOTHING the API did not return.
 *
 * The fixture is three single-wallet claims, which is all the server can now
 * produce: both faucet paths pass 'spot' as a literal and the schema defaults
 * to it. That is why the table carries no Wallet column at all — a column that
 * can only ever print one value names nothing — and it is what the first test
 * below asserts.
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'

jest.mock('@/services/Wallet/WalletService', () => ({
  getDemoCreditHistory: jest.fn(),
}))

jest.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark_theme' }),
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />,
}))

jest.mock('../../../lib/pagination', () => ({
  __esModule: true,
  default: () => <div data-testid="pagination" />,
}))

import DepositHistory from '@/components/Wallet/DepositHistory'
import { getDemoCreditHistory } from '@/services/Wallet/WalletService'

const AT = '2026-08-03T23:27:00.000Z'

/**
 * Three claims, as spotapi's faucet history returns them: newest first.
 *
 * This was ONE claim of five legs across two wallets in several coins. Every
 * part of that is now impossible: those extra coins are deleted, and both
 * faucet paths call `creditLine(coin, FAUCET_AMOUNT, 'spot', ...)` with the
 * wallet as a literal, so a credit can only land in spot. The faucet grants one
 * coin - so a claim is one row, and several rows means several claims, which is
 * what a 24h faucet produces over a few days.
 */
const claimRows = [
  { createdAt: '2026-08-05T23:27:00.000Z', coin: 'USD', wallet: 'spot', amount: '3000', txid: 'faucet-3-u-spot-USD', status: 'credited' },
  { createdAt: '2026-08-04T23:27:00.000Z', coin: 'USD', wallet: 'spot', amount: '2000', txid: 'faucet-2-u-spot-USD', status: 'credited' },
  { createdAt: AT, coin: 'USD', wallet: 'spot', amount: '1000', txid: 'faucet-1-u-spot-USD', status: 'credited' },
]

const respond = (data: any[], count = data.length) =>
  ({ data: { success: true, result: { count, data } } })

const rowText = () =>
  Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.textContent || '')

beforeEach(() => {
  jest.clearAllMocks()
  ;(getDemoCreditHistory as jest.Mock).mockResolvedValue(respond(claimRows))
})

describe('DepositHistory - every leg comes from the server (CRITICAL)', () => {
  test('names no wallet, because a credit can only land in one', async () => {
    render(<DepositHistory />)

    await waitFor(() => expect(rowText()).toHaveLength(3))
    // A Wallet column named where each row landed, and guarded against the
    // server recording one this build did not advertise. Both faucet paths
    // pass 'spot' as a literal and the schema defaults to it, so there is no
    // second wallet for a row to land in.
    expect(screen.queryByText(/^Wallet$/)).toBeNull()
    expect(screen.queryByText('Spot wallet')).toBeNull()
  })

  test('keeps the server order rather than regrouping the rows', async () => {
    render(<DepositHistory />)

    await waitFor(() => expect(rowText()).toHaveLength(3))
    const rows = rowText()
    // Newest first, as the server sent them: the ordering decision belongs to
    // the query that pages the results, not to this component.
    // The date cell runs through a formatter this suite stubs to a constant,
    // so the rows are told apart by amount instead.
    expect(rows[0]).toContain('3000')
    expect(rows[1]).toContain('2000')
    expect(rows[2]).toContain('1000')
  })

  test('needs no local receipt: a device that did not make the claim sees every row', async () => {
    // Nothing in localStorage, nothing passed in — this is the second browser.
    window.localStorage.clear()
    render(<DepositHistory />)

    await waitFor(() => expect(rowText()).toHaveLength(3))
    expect(rowText().join(' ')).toContain('1000')
  })

  test('renders exactly the rows the server sent, inventing none', async () => {
    ;(getDemoCreditHistory as jest.Mock).mockResolvedValue(
      respond(claimRows.slice(0, 2))
    )
    render(<DepositHistory />)

    await waitFor(() => expect(rowText()).toHaveLength(2))
  })

  test('calls the faucet credits demo credits, not deposits', async () => {
    render(<DepositHistory />)

    await waitFor(() => expect(rowText()).toHaveLength(3))
    // This was a Type column printing the literal 'Demo credit' on every row.
    // The naming still matters - these are not chain deposits - but the
    // surfaces around the table say it once instead of once per row.
    expect(screen.queryByText('Deposit')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Type$/)).toBeNull()
  })

  test('refetches when the claim page reports a new claim', async () => {
    const { rerender } = render(<DepositHistory refreshKey={0} />)
    await waitFor(() => expect(getDemoCreditHistory).toHaveBeenCalledTimes(1))

    rerender(<DepositHistory refreshKey={1} />)
    await waitFor(() => expect(getDemoCreditHistory).toHaveBeenCalledTimes(2))
  })

  test('the empty state says which kind of empty it is', async () => {
    // "No Records Found" over a wallet holding 2,000 reads as a table that
    // failed to load, and for as long as the route behind this component was
    // deleted that is precisely what it was. A never-claimed account is a
    // different thing from a broken request, and the copy has to distinguish
    // them: the starting balance is seeded by walletapi when the wallet is
    // created, and is not a claim.
    ;(getDemoCreditHistory as jest.Mock).mockResolvedValue(respond([], 0))
    render(<DepositHistory />)

    await waitFor(() =>
      expect(screen.getByText('No claims yet')).toBeInTheDocument()
    )
    expect(screen.getByText(/seeded when it was created/i)).toBeInTheDocument()
    expect(screen.queryByText('No Records Found')).toBeNull()
  })

  test('survives a failing history request', async () => {
    ;(getDemoCreditHistory as jest.Mock).mockRejectedValue(new Error('boom'))
    render(<DepositHistory />)

    await waitFor(() =>
      expect(screen.getByText('No claims yet')).toBeInTheDocument()
    )
  })
})
