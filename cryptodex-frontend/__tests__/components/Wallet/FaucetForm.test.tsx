/**
 * FaucetForm Component Tests (CRITICAL)
 *
 * CRITICAL TESTS - These tests verify the paper-trading demo faucet
 * Tests cover claim flow, cooldown errors, login gating and navigation
 * Run frequently and never modify without thorough review
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { useRouter } from 'next/router'

// Import hooks from react-redux, not from @/store
import { useSelector, useDispatch } from 'react-redux'

// Mock @/store to provide hooks without loading actual Redux code
jest.mock('@/store', () => ({
  useSelector,
  useDispatch,
  default: jest.fn(),
}))

// Mocks
jest.mock('next/router', () => ({
  useRouter: jest.fn(),
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('@/services/Wallet/WalletService', () => ({
  faucetClaim: jest.fn(),
  // The page asks the server whether this account is inside its 24h cooldown
  // before it decides whether the Claim button may be pressed. Every test in
  // this file is about a claimable account, so the default answer says so; the
  // cooldown behaviour itself is covered in FaucetCooldown.test.tsx.
  faucetStatus: jest.fn(),
}))

jest.mock('@/store/Wallet/dataSlice', () => ({
  getAssetData: jest.fn(),
  refreshWalletBalances: jest.fn(),
}))

jest.mock('@/lib/toastAlert', () => ({
  toastAlert: jest.fn(),
}))

jest.mock('@/components/Wallet/DepositHistory', () => {
  return function DepositHistory(props: any) {
    return (
      <div
        data-testid="deposit-history"
        data-refresh-key={String(props?.refreshKey ?? '')}
        data-receipts={String(props?.receipts?.length ?? 'none')}
      >
        Deposit History Component
      </div>
    )
  }
})

import FaucetForm from '@/components/Wallet/FaucetForm'
import { faucetClaim, faucetStatus } from '@/services/Wallet/WalletService'
import { getAssetData, refreshWalletBalances } from '@/store/Wallet/dataSlice'
import { toastAlert } from '@/lib/toastAlert'
import {
  FAUCET_FULL_GRANT,
  FAUCET_SPOT_GRANT,
  creditPhrase,
  saveReceipt,
} from '@/lib/faucetReceipt'

// The button and the promise are built from the same constants the component
// uses, so this test asserts that the WHOLE advertised grant is named - not a
// string that could drift into naming part of it.
const SPOT_PHRASE = creditPhrase(FAUCET_SPOT_GRANT)
const FULL_PHRASE = creditPhrase(FAUCET_FULL_GRANT)
const CLAIM_BUTTON_LABEL = `Claim ${FULL_PHRASE}`

const mockRouter = {
  push: jest.fn(),
  pathname: '/faucet',
  query: {},
}

const defaultAssets = [
  {
    _id: 'usd001',
    coin: 'USD',
    spotBal: '10000',
    spotInOrder: '0',
    currencyId: 'cur001',
  },
  {
    _id: 'btc123',
    coin: 'BTC',
    spotBal: '1.5',
    spotInOrder: '0.5',
    currencyId: 'cur002',
  },
]

const createMockStore = ({
  user = { _id: 'user123' } as any,
  assets = defaultAssets as any[],
} = {}) =>
  configureStore({
    reducer: {
      wallet: () => ({
        assets,
        currency: [],
        loading: false,
      }),
      auth: () => ({
        user,
      }),
    },
  })

const renderWithProviders = (
  component: React.ReactElement,
  storeOptions: { user?: any; assets?: any[] } = {}
) => {
  const store = createMockStore(storeOptions)
  return render(<Provider store={store}>{component}</Provider>)
}

// resetMocks is enabled in jest.config.js, so implementations set in the
// module factories above are wiped before every test — re-apply them here.
const setupMocks = () => {
  jest.clearAllMocks()
  // Receipts are persisted per user, so one test's claim must not be visible
  // to the next.
  window.localStorage.clear()
  ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  ;(getAssetData as jest.Mock).mockReturnValue({ type: 'wallet/getAssetData/test' })
  ;(refreshWalletBalances as jest.Mock).mockReturnValue({
    type: 'wallet/refreshWalletBalances/test',
  })
  ;(faucetClaim as jest.Mock).mockResolvedValue({ data: { success: true } })
  ;(faucetStatus as jest.Mock).mockResolvedValue({
    data: { success: true, canClaim: true, retryAfter: 0, cooldownSeconds: 86400 },
  })
}

const getClaimButton = () =>
  screen.getByText(CLAIM_BUTTON_LABEL).closest('button') as HTMLButtonElement

describe('FaucetForm - Component Rendering (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('should render the Claim Demo Funds page header', async () => {
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      expect(screen.getByText('Claim Demo Funds')).toBeInTheDocument()
    })
  })

  test('should render the paper trading disclaimer', async () => {
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      expect(screen.getByText('Paper Trading')).toBeInTheDocument()
      expect(
        screen.getByText(/This is a paper trading platform/i)
      ).toBeInTheDocument()
      expect(screen.getByText(/no real money is involved/i)).toBeInTheDocument()
    })
  })

  test('should display the USD spot balance', async () => {
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      expect(screen.getByText(/10000\.0000/)).toBeInTheDocument()
    })
  })

  test('should render the claim button for a logged-in user', async () => {
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      expect(screen.getByText(CLAIM_BUTTON_LABEL)).toBeInTheDocument()
    })
  })

  test('should render the About Demo Funds sidebar', async () => {
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      expect(screen.getByText('About Demo Funds')).toBeInTheDocument()
      expect(screen.getByText(/claim once every 24 hours/i)).toBeInTheDocument()
    })
  })

  test('should render demo credit history section', async () => {
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      // By ROLE, not by text: the sidebar copy now also says "demo credit
      // history", because the table below it is a real, server-side record
      // again and the page is allowed to point at it. The heading is the
      // section; the sentence is a reference to it.
      expect(
        screen.getByRole('heading', { name: /Demo credit history/i })
      ).toBeInTheDocument()
      expect(screen.getByTestId('deposit-history')).toBeInTheDocument()
    })
  })

  test('the sidebar tells the user where the full record lives', async () => {
    // The page used to promise a receipt only. The rows are on the server (one
    // DepositEvent per credited leg, written by the claim) and readable from
    // any device, and for a while they were unreachable because the route that
    // read them had been deleted - so the table under this promise was
    // permanently empty. Both halves of the sentence have to stay true.
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      const panel = screen.getByText('About Demo Funds')
        .parentElement as HTMLElement
      expect(panel.textContent).toMatch(/demo credit history below/i)
      expect(panel.textContent).toMatch(/every device/i)
    })
  })

  test('should fetch assets on mount', async () => {
    renderWithProviders(<FaucetForm />)

    await waitFor(() => {
      expect(getAssetData).toHaveBeenCalledTimes(1)
    })
  })
})

describe('FaucetForm - Claim Flow (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('should call faucetClaim and show success toast when claim succeeds', async () => {
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => {
      expect(faucetClaim).toHaveBeenCalledTimes(1)
      expect(toastAlert).toHaveBeenCalledWith(
        'success',
        `${SPOT_PHRASE} credited to your spot wallet`,
        'faucet'
      )
    })
  })

  test('should show the server success message when provided', async () => {
    ;(faucetClaim as jest.Mock).mockResolvedValue({
      data: { success: true, message: 'Demo funds credited' },
    })
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => {
      expect(toastAlert).toHaveBeenCalledWith(
        'success',
        'Demo funds credited',
        'faucet'
      )
    })
  })

  test('should refresh EVERY wallet slice after a successful claim', async () => {
    renderWithProviders(<FaucetForm />)

    // The mount read is the plain asset read and stays that way: reading is not
    // a mutation and must not make every mounted trade page re-read.
    expect(getAssetData).toHaveBeenCalledTimes(1)
    expect(refreshWalletBalances).not.toHaveBeenCalled()

    fireEvent.click(getClaimButton())

    // A claim moves a balance outside any matching engine, so it goes through
    // the one call that re-reads the asset rows AND raises the "balances moved"
    // signal - not the plain read.
    await waitFor(() => {
      expect(refreshWalletBalances).toHaveBeenCalledTimes(1)
    })
    // and it did NOT quietly go back to the asset-rows-only refresh
    expect(getAssetData).toHaveBeenCalledTimes(1)
  })

  test('should show error toast when the claim response is unsuccessful', async () => {
    ;(faucetClaim as jest.Mock).mockResolvedValue({
      data: { success: false, message: 'Faucet temporarily unavailable' },
    })
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => {
      expect(toastAlert).toHaveBeenCalledWith(
        'error',
        'Faucet temporarily unavailable',
        'faucet'
      )
    })
  })

  test('should show the 24-hour cooldown error from the server', async () => {
    ;(faucetClaim as jest.Mock).mockRejectedValue({
      response: {
        data: { error: 'You can only claim demo funds once every 24 hours' },
      },
    })
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => {
      expect(toastAlert).toHaveBeenCalledWith(
        'error',
        'You can only claim demo funds once every 24 hours',
        'faucet'
      )
    })
  })

  test('should show the default cooldown message when the request fails without a payload', async () => {
    ;(faucetClaim as jest.Mock).mockRejectedValue(new Error('Network Error'))
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => {
      expect(toastAlert).toHaveBeenCalledWith(
        'error',
        'Claim failed. You can claim demo funds once every 24 hours.',
        'faucet'
      )
    })
  })

  test('should disable the claim button while a claim is in flight', async () => {
    let resolveClaim: (value: any) => void = () => {}
    ;(faucetClaim as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClaim = resolve
        })
    )
    renderWithProviders(<FaucetForm />)

    const claimButton = getClaimButton()
    fireEvent.click(claimButton)

    await waitFor(() => {
      expect(claimButton).toBeDisabled()
    })

    await act(async () => {
      resolveClaim({ data: { success: true } })
    })

    await waitFor(() => {
      expect(claimButton).not.toBeDisabled()
    })
  })

  test('should re-fetch assets when the refresh button is clicked', async () => {
    const { container } = renderWithProviders(<FaucetForm />)

    // Once on mount
    expect(getAssetData).toHaveBeenCalledTimes(1)

    const refreshButton = container
      .querySelector('.fa-refresh')
      ?.closest('button') as HTMLButtonElement
    expect(refreshButton).toBeTruthy()
    fireEvent.click(refreshButton)

    await waitFor(() => {
      expect(getAssetData).toHaveBeenCalledTimes(2)
    })
  })
})

describe('FaucetForm - Login Gate (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('should show login prompt when user is not logged in', async () => {
    renderWithProviders(<FaucetForm />, { user: null })

    await waitFor(() => {
      expect(screen.getByText('Please Log In')).toBeInTheDocument()
      expect(
        screen.getByText(/You need to be logged in to claim demo funds/i)
      ).toBeInTheDocument()
    })
  })

  test('should not render the claim button when logged out', async () => {
    renderWithProviders(<FaucetForm />, { user: null })

    await waitFor(() => {
      expect(screen.getByText('Please Log In')).toBeInTheDocument()
    })
    expect(screen.queryByText(CLAIM_BUTTON_LABEL)).not.toBeInTheDocument()
  })

  test('should navigate to login page from the Go to Login button', async () => {
    renderWithProviders(<FaucetForm />, { user: null })

    fireEvent.click(screen.getByText('Go to Login'))

    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/login')
    })
  })
})

describe('FaucetForm - Navigation (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('should navigate to the reset (withdraw) page from Reset Account', async () => {
    renderWithProviders(<FaucetForm />)

    fireEvent.click(screen.getByText('Reset Account'))

    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/reset')
    })
  })
})

describe('FaucetForm - Empty State (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('should show a zero balance when the user has no USD asset', async () => {
    renderWithProviders(<FaucetForm />, { assets: [] })

    // One faucet coin is shown, so one balance reads 0.0000.
    await waitFor(() => {
      expect(screen.getAllByText(/0\.0000/).length).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('FaucetForm - Cooldown feedback (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('should render the remaining cooldown from retryAfter and keep it on the page', async () => {
    ;(faucetClaim as jest.Mock).mockRejectedValue({
      response: {
        data: {
          success: false,
          message: 'Faucet already claimed, please try again later',
          retryAfter: 65308,
        },
      },
    })
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => {
      expect(toastAlert).toHaveBeenCalledWith(
        'error',
        'Faucet already claimed, please try again later (try again in 18h 9m)',
        'faucet'
      )
    })

    // The toast disappears; the inline notice has to survive it.
    expect(
      screen.getByText(
        /Faucet already claimed, please try again later \(try again in 18h 9m\)/
      )
    ).toBeInTheDocument()
  })

  test('should omit the countdown when the server sends no retryAfter', async () => {
    ;(faucetClaim as jest.Mock).mockRejectedValue({
      response: { data: { message: 'Faucet already claimed' } },
    })
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => {
      expect(toastAlert).toHaveBeenCalledWith(
        'error',
        'Faucet already claimed',
        'faucet'
      )
    })
  })
})

describe('FaucetForm - the grant is stated before the click (CRITICAL)', () => {
  beforeEach(setupMocks)

  test('the button names the whole advertised grant', async () => {
    renderWithProviders(<FaucetForm />)

    const label = getClaimButton().textContent || ''
    expect(label).toContain(FULL_PHRASE)
  })

  test('the standing promise names the wallet the claim credits', async () => {
    const { container } = renderWithProviders(<FaucetForm />)
    const text = container.textContent || ''

    expect(text).toContain(FULL_PHRASE)
    expect(text).toMatch(/spot wallet/i)
  })

  test('the About Demo Funds panel states the same grant', async () => {
    renderWithProviders(<FaucetForm />)

    const panel = screen.getByText('About Demo Funds').parentElement as HTMLElement
    expect(panel.textContent).toContain(FULL_PHRASE)
  })

  /**
   * THE PROMISE MUST NOT NAME A WALLET THE VENUE NO LONGER HAS.
   * Promising collateral in a wallet no product can spend from is the original
   * "the copy does not match the behaviour" defect wearing the opposite sign.
   */
  test('the page promises nothing about a derivative wallet', async () => {
    const { container } = renderWithProviders(<FaucetForm />)
    const text = (container.textContent || '').toLowerCase()

    expect(text).not.toContain('inverse')
    expect(text).not.toContain('futures')
  })
})

describe('FaucetForm - Claim receipt survives the toast (CRITICAL)', () => {
  beforeEach(setupMocks)

  const creditedPayload = {
    success: true,
    signature: 'faucet-1700000000000-user123-USD',
    credited: [
            { coin: 'USD', amount: 10000, wallet: 'spot', balance: 10000 },
      { coin: 'BTC', amount: 0.05, wallet: 'lending', balance: 0.05 },
      { coin: 'ETH', amount: 1, wallet: 'lending', balance: 1 },
      { coin: 'SOL', amount: 50, wallet: 'lending', balance: 50 },
    ],
  }

  test('renders every wallet the API said it credited', async () => {
    ;(faucetClaim as jest.Mock).mockResolvedValue({ data: creditedPayload })
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    // The payload deliberately reports a wallet this build does not advertise.
    // A credit the server made and the page does not show is the defect this
    // receipt exists to prevent, so the unknown wallet must still be printed -
    // named by `walletLabel`'s fallback rather than dropped.
    const receipt = await screen.findByTestId('claim-receipt')
    expect(receipt.textContent).toContain('Spot wallet')
    expect(receipt.textContent).toContain('10,000 USD')
    expect(receipt.textContent).toContain('Lending wallet')
    expect(receipt.textContent).toContain('0.05 BTC + 1 ETH + 50 SOL')
  })

  test('shows no receipt when the API reported no credits', async () => {
    ;(faucetClaim as jest.Mock).mockResolvedValue({ data: { success: true } })
    renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())

    await waitFor(() => expect(toastAlert).toHaveBeenCalled())
    expect(screen.queryByTestId('claim-receipt')).not.toBeInTheDocument()
  })

  test('tells the demo credit history to REFETCH after a claim, rather than handing it receipts', async () => {
    // The history is the server's, not this browser's. Every leg of the claim
    // is a server row now, so the page's only job is to say "there is new
    // history" — passing receipts down would put a device-local reconstruction
    // back into a table that is supposed to be readable from anywhere.
    ;(faucetClaim as jest.Mock).mockResolvedValue({ data: creditedPayload })
    renderWithProviders(<FaucetForm />)

    const history = () => screen.getByTestId('deposit-history')
    expect(history()).toHaveAttribute('data-refresh-key', '0')
    expect(history()).toHaveAttribute('data-receipts', 'none')

    fireEvent.click(getClaimButton())

    await waitFor(() => expect(history()).toHaveAttribute('data-refresh-key', '1'))
    // ...and still nothing local was handed to it.
    expect(history()).toHaveAttribute('data-receipts', 'none')
  })

  test('the receipt is restored on a later page load', async () => {
    ;(faucetClaim as jest.Mock).mockResolvedValue({ data: creditedPayload })
    const first = renderWithProviders(<FaucetForm />)

    fireEvent.click(getClaimButton())
    await screen.findByTestId('claim-receipt')

    first.unmount()
    renderWithProviders(<FaucetForm />)

    await waitFor(() =>
      expect(screen.getByTestId('claim-receipt').textContent).toContain('Lending wallet')
    )
  })

  test('a reset receipt is NOT shown under "Last claim credited"', async () => {
    // loadReceipts returns claims and resets together. Seed only a RESET; the
    // "Last claim credited" panel keys off the newest CLAIM, of which there is
    // none, so it must not render the reset's credits as though they were claimed.
    saveReceipt('user123', {
      at: Date.now(),
      kind: 'reset',
      signature: 'reset-sig',
      headline: 'Balances reset',
      credited: [{ coin: 'USD', amount: '1000', wallet: 'spot' }],
    })

    renderWithProviders(<FaucetForm />)

    await waitFor(() => expect(getClaimButton()).toBeInTheDocument())
    expect(screen.queryByTestId('claim-receipt')).not.toBeInTheDocument()
  })

  test('shows the last CLAIM even when a newer reset receipt exists', async () => {
    // A claim, then a later reset. The faucet page must still show the claim's
    // credit under "Last claim credited", not the more recent reset.
    saveReceipt('user123', {
      at: 1000,
      kind: 'claim',
      signature: 'claim-sig',
      headline: 'Claimed',
      credited: [{ coin: 'USD', amount: '10000', wallet: 'spot' }],
    })
    saveReceipt('user123', {
      at: 2000,
      kind: 'reset',
      signature: 'reset-sig',
      headline: 'Reset',
      credited: [{ coin: 'USD', amount: '1000', wallet: 'spot' }],
    })

    renderWithProviders(<FaucetForm />)

    const receipt = await screen.findByTestId('claim-receipt')
    expect(receipt.textContent).toContain('10,000 USD')
    expect(receipt.textContent).not.toContain('1,000 USD')
  })
})
