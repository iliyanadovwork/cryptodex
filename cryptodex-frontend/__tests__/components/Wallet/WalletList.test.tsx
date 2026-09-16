/**
 * WalletList Component Tests (CRITICAL)
 *
 * CRITICAL TESTS - These tests verify wallet list functionality
 * Tests cover wallet display, tab switching, search, and filtering
 * Run frequently and never modify without thorough review
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

import WalletList from '@/components/Wallet/WalletList'

// Mocks
jest.mock('next/router', () => ({
  useRouter: jest.fn(),
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />,
}))

jest.mock('@/services/Wallet/WalletService', () => ({
  apiGetUserDeposit: jest.fn(() => Promise.resolve()),
}))

const mockRouter = {
  push: jest.fn(),
  pathname: '/wallet',
  query: {},
}

const mockDispatch = jest.fn()

const createMockStore = () =>
  configureStore({
    reducer: {
      wallet: () => ({
        assets: [
          {
            _id: 'btc123',
            coin: 'BTC',
            spotBal: '1.5',
            spotInOrder: '0.5',
            spotLockedBal: '0',
            currencyId: 'cur001',
          },
          {
            _id: 'eth456',
            coin: 'ETH',
            spotBal: '10.0',
            spotInOrder: '2.0',
            spotLockedBal: '0',
            currencyId: 'cur002',
          },
          {
            _id: 'usdt789',
            coin: 'USDT',
            spotBal: '1000.0',
            spotInOrder: '0',
            spotLockedBal: '0',
            currencyId: 'cur003',
          },
        ],
        currency: [
          {
            _id: 'cur001',
            coin: 'BTC',
            type: 'crypto',
            status: 'active',
            image: '/images/btc.png',
            minimumDeposit: '0.001',
            contractDecimal: 8,
            decimals: 8,
          },
          {
            _id: 'cur002',
            coin: 'ETH',
            type: 'crypto',
            status: 'active',
            image: '/images/eth.png',
            minimumDeposit: '0.01',
            contractDecimal: 18,
            decimals: 18,
          },
          {
            _id: 'cur003',
            coin: 'USDT',
            type: 'token',
            status: 'active',
            image: '/images/usdt.png',
            minimumDeposit: '10',
            decimals: 6,
            tokenAddressArray: [],
          },
        ],
        priceConversion: [
          { baseSymbol: 'BTC', convertSymbol: 'USDT', convertPrice: '45000' },
          { baseSymbol: 'ETH', convertSymbol: 'USDT', convertPrice: '3000' },
          { baseSymbol: 'USDT', convertSymbol: 'BTC', convertPrice: '0.00002' },
        ],
        loading: false,
      }),
      spot: () => ({
        pairList: [
          { _id: 'pair1', firstCurrencySymbol: 'BTC', secondCurrencySymbol: 'USDT' },
          { _id: 'pair2', firstCurrencySymbol: 'ETH', secondCurrencySymbol: 'USDT' },
        ],
      }),
    },
  })

const renderWithProviders = (component: React.ReactElement) => {
  const store = createMockStore()
  return render(
    <Provider store={store}>
      {component}
    </Provider>
  )
}

describe('WalletList - Component Rendering (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  })

  test('should render wallet list component', () => {
    renderWithProviders(<WalletList />)
    expect(screen.getByText(/Total Assets Value/i)).toBeInTheDocument()
  })

  test('should render action buttons', () => {
    renderWithProviders(<WalletList />)
    expect(screen.getByText(/Claim Demo Funds/i)).toBeInTheDocument()
    expect(screen.getByText(/Reset Demo Account/i)).toBeInTheDocument()
  })

  test('offers no Transfer button, because there is nowhere to transfer to', () => {
    // One wallet. Both dropdowns of the old modal would have held one entry,
    // and every destination it could name is a wallet the venue no longer has.
    renderWithProviders(<WalletList />)
    expect(screen.queryByText(/Transfer/i)).not.toBeInTheDocument()
  })

  test('names the one wallet it shows', () => {
    renderWithProviders(<WalletList />)
    expect(screen.getByTestId('wallet-section-spot')).toHaveTextContent(
      /Spot wallet/i
    )
  })

  test('offers no derivative wallet to switch to', () => {
    renderWithProviders(<WalletList />)
    expect(screen.queryByText(/Future wallet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Inverse wallet/i)).not.toBeInTheDocument()
  })
})

/*
 * A "Search and Filter" describe covered a search box and an "above zero"
 * checkbox. Both were built for a wallet of dozens of coins; this venue lists
 * two, so the search could only narrow the table to one row and the checkbox
 * could only hide BTC-when-empty - the row, and the Trade button, you need in
 * order to buy any. Both controls are gone, and the guard below replaces them.
 */
describe('WalletList - the controls a two-coin wallet does not need', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  })

  test('offers no search box', () => {
    renderWithProviders(<WalletList />)
    expect(screen.queryByPlaceholderText(/Search coins/i)).not.toBeInTheDocument()
  })

  test('offers no zero-balance filter, so BTC and its Trade button always show', () => {
    renderWithProviders(<WalletList />)
    expect(screen.queryByLabelText(/Assets above 0/i)).not.toBeInTheDocument()
    // The point of removing it: the row it could hide stays visible.
    expect(screen.getByTestId('spot-row-BTC')).toBeInTheDocument()
  })
})

describe('WalletList - Navigation (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  })

  test('should navigate to deposit page on Claim Demo Funds button click', async () => {
    renderWithProviders(<WalletList />)

    // Get the deposit button - use role or find the clickable element
    const depositButtons = screen.getAllByText(/Claim Demo Funds/i)
    // Find the first button element from the text matches
    const depositButton = depositButtons.find(el => el.closest('button')) || depositButtons[0]
    if (depositButton) {
      fireEvent.click(depositButton)
    }

    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/faucet')
    })
  })

  test('should navigate to withdraw page on Reset Demo Account button click', async () => {
    renderWithProviders(<WalletList />)

    // Get the withdraw button - use role or find the clickable element
    const withdrawButtons = screen.getAllByText(/Reset Demo Account/i)
    // Find the first button element from the text matches
    const withdrawButton = withdrawButtons.find(el => el.closest('button')) || withdrawButtons[0]
    if (withdrawButton) {
      fireEvent.click(withdrawButton)
    }

    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/reset')
    })
  })
})

describe('WalletList - Asset Display (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  })

  test('should display wallet table headers', () => {
    renderWithProviders(<WalletList />)

    expect(screen.getByText(/Coin/i)).toBeInTheDocument()
    expect(screen.getByText(/Available/i)).toBeInTheDocument()
    expect(screen.getByText(/In Orders/i)).toBeInTheDocument()
    expect(screen.getByText(/Value \(USD\)/i)).toBeInTheDocument()
  })

  test('carries no column that only restates the ones beside it', () => {
    renderWithProviders(<WalletList />)

    // Sub Total was Available + In Orders with both printed next to it, and
    // Locked was a term nothing on this venue can make non-zero. The quantity
    // Sub Total named still exists - Estimated Value is priced from it - but it
    // no longer takes a column to say what the reader can already add up.
    expect(screen.queryByText(/Sub Total/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Locked/i)).not.toBeInTheDocument()
  })

  test('offers no per-row Trade button, because there is one market to trade', () => {
    renderWithProviders(<WalletList />)

    // Every row's button resolved to the same destination - this venue lists
    // one market - and the navbar already links it as "Spot".
    expect(screen.queryByText(/^Trade$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Action/i)).not.toBeInTheDocument()
  })
})

describe('WalletList - Empty State (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  })

  test('should show no records message when wallet is empty', () => {
    // Create a store with empty assets array to test empty state
    const emptyStore = configureStore({
      reducer: {
        wallet: () => ({
          assets: [],
          currency: [],
          priceConversion: [],
          loading: false,
        }),
        spot: () => ({
          pairList: [],
        }),
      },
    })

    render(
      <Provider store={emptyStore}>
        <WalletList />
      </Provider>
    )

    expect(screen.getByText(/No Records Found/i)).toBeInTheDocument()
  })
})

describe('WalletList - Balance Calculations (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
  })

  test('should display total assets in BTC and USDT', () => {
    renderWithProviders(<WalletList />)

    // Should display BTC and USDT (there may be multiple elements, so use getAllByText)
    const btcElements = screen.getAllByText(/BTC/i)
    expect(btcElements.length).toBeGreaterThan(0)

    const usdtElements = screen.getAllByText(/USDT/i)
    expect(usdtElements.length).toBeGreaterThan(0)
  })
})
