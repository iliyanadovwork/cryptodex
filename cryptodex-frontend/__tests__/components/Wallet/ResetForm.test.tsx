/**
 * ResetForm (Reset Demo Account) Component Tests (CRITICAL)
 *
 * This page used to tell the user THREE TIMES that a wallet would be "zeroed"
 * and then re-seed it, and its About panel documented the old unsafe reset that
 * orphaned margin under an open position. These tests pin the copy to what the
 * server actually does, and pin the two outcomes — the receipt and the refusal —
 * to the page rather than to a toast that is gone in seconds.
 *
 * The venue is spot-only now, so the copy promises the spot wallet and nothing
 * else. The FIXTURES below deliberately do not follow: the reset payload reports
 * credits to a wallet this build does not advertise ('lending'), and the refusal
 * names products it has never heard of ('Alpha', 'Beta'). Those names are
 * invented on purpose — nothing on this venue is called any of them, which is
 * exactly what makes them the right fixture. The page's job is to report what
 * the server said, and the only way an unannounced credit or an unexpected
 * refusal reaches the user is if it does.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { useRouter } from 'next/router'

import { useSelector, useDispatch } from 'react-redux'

jest.mock('@/store', () => ({
  useSelector,
  useDispatch,
  default: jest.fn(),
}))

jest.mock('next/router', () => ({
  useRouter: jest.fn(),
}))

jest.mock('@/services/Wallet/WalletService', () => ({
  faucetReset: jest.fn(),
}))

jest.mock('@/store/Wallet/dataSlice', () => ({
  getAssetData: jest.fn(),
  refreshWalletBalances: jest.fn(),
}))

jest.mock('@/lib/toastAlert', () => ({
  toastAlert: jest.fn(),
}))

import ResetForm from '@/components/Wallet/ResetForm'
import { faucetReset } from '@/services/Wallet/WalletService'
import { getAssetData, refreshWalletBalances } from '@/store/Wallet/dataSlice'
import { toastAlert } from '@/lib/toastAlert'
import {
  FAUCET_SPOT_GRANT,
  creditPhrase,
} from '@/lib/faucetReceipt'

const SPOT_PHRASE = creditPhrase(FAUCET_SPOT_GRANT)

const mockRouter = { push: jest.fn(), pathname: '/reset', query: {} }

const defaultAssets = [
  { _id: 'usdc001', coin: 'USDC', spotBal: '9699.79', currencyId: 'cur001' },
  { _id: 'usd001', coin: 'USD', spotBal: '9230', currencyId: 'cur002' },
]

const createMockStore = ({ user = { _id: 'user123' } as any, assets = defaultAssets as any[] } = {}) =>
  configureStore({
    reducer: {
      wallet: () => ({ assets, currency: [], loading: false }),
      auth: () => ({ user }),
    },
  })

const renderWithProviders = (options: { user?: any; assets?: any[] } = {}) =>
  render(
    <Provider store={createMockStore(options)}>
      <ResetForm />
    </Provider>
  )

const successPayload = {
  success: true,
  credited: [
    { coin: 'USDC', amount: 10000, wallet: 'spot', balance: 10000 },
    { coin: 'USD', amount: 10000, wallet: 'spot', balance: 10000 },
    { coin: 'BTC', amount: 0.05, wallet: 'lending', balance: 0.05 },
    { coin: 'ETH', amount: 1, wallet: 'lending', balance: 1 },
    { coin: 'SOL', amount: 50, wallet: 'lending', balance: 50 },
  ],
  cleared: {
    wallets: ['lending'],
    cancelledSpotOrders: 2,
    zeroedCoins: ['BTC'],
    clearedCoins: ['BTC', 'USDC', 'USD'],
  },
  message: 'Reset to 1,000 USDC + 1,000 USD to your spot wallet',
}

const setupMocks = () => {
  jest.clearAllMocks()
  window.localStorage.clear()
  ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  ;(getAssetData as jest.Mock).mockReturnValue({ type: 'wallet/getAssetData/test' })
  ;(refreshWalletBalances as jest.Mock).mockReturnValue({
    type: 'wallet/refreshWalletBalances/test',
  })
  ;(faucetReset as jest.Mock).mockResolvedValue({ data: successPayload })
}

const confirmReset = async () => {
  fireEvent.click(screen.getByText('Reset Demo Account', { selector: 'label' }))
  await waitFor(() => expect(screen.getByText('Confirm Reset')).toBeInTheDocument())
  fireEvent.click(screen.getByText('Confirm Reset'))
}

describe('ResetForm - Copy honesty (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('promises nothing about a wallet the venue no longer has', () => {
    const { container } = renderWithProviders()
    const text = (container.textContent || '').toLowerCase()

    // The old copy said an inverse wallet would be "zeroed" while the reset
    // re-seeded it. There is no inverse wallet to make either claim about.
    expect(text).not.toContain('inverse')
    expect(text).not.toContain('futures')
  })

  test('states the spot balance the reset restores', () => {
    const { container } = renderWithProviders()
    expect(container.textContent).toContain(SPOT_PHRASE)
  })

  test('the confirm step names what it restores', async () => {
    const { container } = renderWithProviders()
    fireEvent.click(screen.getByText('Reset Demo Account', { selector: 'label' }))

    await waitFor(() => expect(screen.getByText('Confirm Reset')).toBeInTheDocument())
    const text = container.textContent || ''
    expect(text).toContain(`set your spot wallet to ${SPOT_PHRASE}`)
    expect(text).toMatch(/set every other coin balance\s*to 0/i)
  })

  test('the About panel documents the refusal, not the old margin-orphaning behaviour', () => {
    const { container } = renderWithProviders()
    const text = container.textContent || ''

    // The removed claim: positions are left open while their balances vanish.
    expect(text).not.toMatch(/Open derivative positions are not closed/i)
    // The pre-run promise must name the precondition the server now enforces.
    expect(text).toMatch(/Cancel your resting spot orders first/i)
    expect(text).toMatch(/Reset is refused while any spot order is still resting/i)
    // AND the spot half, which is the one that was an unlimited mint: the page
    // used to promise twice that "all of your open spot orders are cancelled",
    // while the server cancelled only what mongo could already see.
    expect(text).not.toMatch(/all of your open spot orders are cancelled/i)
    expect(text).toMatch(/any spot order is still resting/i)
  })

  test('the About panel names the ACTION the blocker needs', () => {
    // A resting order is CANCELLED, from Open Orders. The copy used to justify
    // the refusal purely in terms of "a live position", which sent a user whose
    // only blocker was a resting order hunting for a position they did not
    // have. There are no positions on this venue at all now, so naming one
    // would be the same wrong turn with nothing behind it.
    const { container } = renderWithProviders()
    const text = container.textContent || ''

    expect(text).toMatch(/Cancel it from Open Orders/i)
    expect(text).not.toMatch(/close any open positions/i)
  })
})

describe('ResetForm - Reset outcome survives the toast (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('renders every wallet the API said it credited, advertised or not', async () => {
    renderWithProviders()
    await confirmReset()

    // `lending` is not a wallet this build promises anything about. A credit
    // the server made and the page does not print is exactly the defect this
    // receipt exists to prevent, so it must still appear - named by
    // walletLabel's fallback rather than dropped.
    const receipt = await screen.findByTestId('reset-receipt')
    expect(receipt.textContent).toContain('Spot wallet')
    expect(receipt.textContent).toContain('10,000 USDC + 10,000 USD')
    expect(receipt.textContent).toContain('Lending wallet')
    expect(receipt.textContent).toContain('0.05 BTC + 1 ETH + 50 SOL')
  })

  test('states what was cleared alongside what was restored', async () => {
    renderWithProviders()
    await confirmReset()

    const receipt = await screen.findByTestId('reset-receipt')
    expect(receipt.textContent).toContain('2 open spot orders cancelled')
    expect(receipt.textContent).toContain('BTC set to 0')
  })

  test('says so plainly when nothing was resting', async () => {
    ;(faucetReset as jest.Mock).mockResolvedValue({
      data: { ...successPayload, cleared: { ...successPayload.cleared, cancelledSpotOrders: 0 } },
    })
    renderWithProviders()
    await confirmReset()

    const receipt = await screen.findByTestId('reset-receipt')
    // A reset can only run on an account with nothing resting, so this is the
    // only branch a current server can produce.
    expect(receipt.textContent).toContain('no spot orders were resting')
  })

  test('a single cancelled order is not pluralised', async () => {
    ;(faucetReset as jest.Mock).mockResolvedValue({
      data: { ...successPayload, cleared: { ...successPayload.cleared, cancelledSpotOrders: 1 } },
    })
    renderWithProviders()
    await confirmReset()

    const receipt = await screen.findByTestId('reset-receipt')
    expect(receipt.textContent).toContain('1 open spot order cancelled')
    expect(receipt.textContent).not.toContain('1 open spot orders cancelled')
  })

  test('the receipt is restored on a later page load', async () => {
    const first = renderWithProviders()
    await confirmReset()
    await screen.findByTestId('reset-receipt')

    first.unmount()
    const second = renderWithProviders()
    await waitFor(() =>
      expect(second.getByTestId('reset-receipt').textContent).toContain(
        'Lending wallet'
      )
    )
  })

  test('shows no receipt when the API reported no credits', async () => {
    ;(faucetReset as jest.Mock).mockResolvedValue({ data: { success: true } })
    renderWithProviders()
    await confirmReset()

    await waitFor(() => expect(toastAlert).toHaveBeenCalled())
    expect(screen.queryByTestId('reset-receipt')).not.toBeInTheDocument()
  })

  test('refreshes EVERY wallet slice after a successful reset', async () => {
    renderWithProviders()
    // Mount is a plain read.
    expect(getAssetData).toHaveBeenCalledTimes(1)
    expect(refreshWalletBalances).not.toHaveBeenCalled()
    await confirmReset()
    // A reset rewrites balances outside any matching engine, so it goes
    // through the one call that re-reads the asset rows AND raises the
    // "balances moved" signal - not the plain read.
    await waitFor(() => expect(refreshWalletBalances).toHaveBeenCalledTimes(1))
    expect(getAssetData).toHaveBeenCalledTimes(1)
  })
})

describe('ResetForm - Refusal survives the toast (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('keeps the open-exposure refusal on the page with the blocking pairs', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue({
      response: {
        status: 409,
        data: {
          success: false,
          code: 'OPEN_EXPOSURE',
          message: 'Close your 1 open position first.',
          positions: [{ productLabel: 'Alpha', pairName: 'BTCUSDT' }],
          orders: [{ productLabel: 'Beta', pairName: 'ETHUSD' }],
        },
      },
    })
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    expect(refusal.textContent).toContain('Alpha BTCUSDT')
    expect(refusal.textContent).toContain('Beta ETHUSD')
  })

  // THE BLOCKER IS NAMED BY KIND, WITH ITS OWN VERB.
  // The server's own sentence leads with "Close" whichever kind is in the way,
  // so a user whose only blocker was a resting limit order was told to close a
  // position. The page derives the instruction from the structured arrays.
  test('tells the user to CANCEL when the only blocker is a resting order', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue({
      response: {
        data: {
          message:
            'Close your 1 open order first. A reset writes fixed balances, ' +
            'which would leave those orders with nothing behind them ' +
            '(Beta ETHUSD).',
          positions: [],
          orders: [{ productLabel: 'Beta', pairName: 'ETHUSD' }],
        },
      },
    })
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    const text = refusal.textContent || ''
    expect(text).toContain('Cancel your 1 resting order')
    expect(text).toContain('Beta ETHUSD')
    // The word that sent the user to the wrong panel, and the thing they do
    // not have, are both absent.
    expect(text.toLowerCase()).not.toContain('close')
    expect(text.toLowerCase()).not.toContain('position')
    expect(screen.getByTestId('reset-blocker-order')).toBeTruthy()
    expect(screen.queryByTestId('reset-blocker-position')).toBeNull()
  })

  test('tells the user to CLOSE when the only blocker is a position', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue({
      response: {
        data: {
          message: 'Close your 1 open position first.',
          positions: [{ productLabel: 'Alpha', pairName: 'BTCUSDT' }],
          orders: [],
        },
      },
    })
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    const text = refusal.textContent || ''
    expect(text).toContain('Close your 1 open position')
    expect(text.toLowerCase()).not.toContain('cancel')
    expect(screen.queryByTestId('reset-blocker-order')).toBeNull()
  })

  test('names both kinds when both are in the way, orders first', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue({
      response: {
        data: {
          message: 'Close your 1 open position and 1 open order first.',
          positions: [{ productLabel: 'Alpha', pairName: 'BTCUSDT' }],
          orders: [{ productLabel: 'Beta', pairName: 'ETHUSD' }],
        },
      },
    })
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    const text = refusal.textContent || ''
    expect(text).toContain('Cancel your 1 resting order')
    expect(text).toContain('Close your 1 open position')
    expect(text.indexOf('Cancel your')).toBeLessThan(text.indexOf('Close your'))
  })

  test('lists a blocking pair only once within its own group', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue({
      response: {
        data: {
          message: 'Close your 2 open orders first.',
          positions: [],
          orders: [
            { productLabel: 'Alpha', pairName: 'BTCUSDT' },
            { productLabel: 'Alpha', pairName: 'BTCUSDT' },
          ],
        },
      },
    })
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    const items = Array.from(refusal.querySelectorAll('li')).map((li) => li.textContent)
    expect(items).toEqual(['Alpha BTCUSDT'])
    // One bullet, but the count still admits there are two orders.
    expect(refusal.textContent).toContain('Cancel your 2 resting orders')
  })

  test('lists every blocking pair, including ones the server sentence omitted', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue({
      response: {
        data: {
          message: 'Close your 2 open positions first (Alpha BTCUSDT).',
          positions: [
            { productLabel: 'Alpha', pairName: 'BTCUSDT' },
            { productLabel: 'Beta', pairName: 'ETHUSD' },
          ],
        },
      },
    })
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    const items = Array.from(refusal.querySelectorAll('li')).map((li) => li.textContent)
    expect(items).toEqual(['Alpha BTCUSDT', 'Beta ETHUSD'])
  })

  test('shows the refusal for a non-throwing unsuccessful response too', async () => {
    ;(faucetReset as jest.Mock).mockResolvedValue({
      data: { success: false, message: 'Faucet currency not found' },
    })
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    expect(refusal.textContent).toContain('Faucet currency not found')
  })

  test('falls back to a stated failure when the server sends no message', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue(new Error('Network Error'))
    renderWithProviders()
    await confirmReset()

    const refusal = await screen.findByTestId('reset-refusal')
    expect(refusal.textContent).toContain('Reset failed')
  })

  test('the refusal clears when the user starts another reset', async () => {
    ;(faucetReset as jest.Mock).mockRejectedValue({
      response: { data: { message: 'Close your 1 open position first.' } },
    })
    renderWithProviders()
    await confirmReset()
    await screen.findByTestId('reset-refusal')

    fireEvent.click(screen.getByText('Reset Demo Account', { selector: 'label' }))
    await waitFor(() =>
      expect(screen.queryByTestId('reset-refusal')).not.toBeInTheDocument()
    )
  })
})

describe('ResetForm - Navigation (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('navigates to the claim page', async () => {
    renderWithProviders()
    fireEvent.click(screen.getByText('Claim Funds'))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/faucet'))
  })
})
