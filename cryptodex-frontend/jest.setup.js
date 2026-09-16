/**
 * Jest Setup File
 *
 * Runs before each test file
 * Configures global test utilities and mocks
 */

import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'
import React from 'react'
const actualReactRedux = jest.requireActual('react-redux')

// Configure testing-library
configure({ testIdAttribute: 'data-testid' })

// Mock Redux Store - create default state
const defaultState = {
  auth: {
    session: { signedIn: false },
    user: {
      email: '',
      userId: '',
      twoFAStatus: false,
      emailStatus: 'verified',
    },
    token: null,
  },
  // `mode` is the SITE setting block (userapi user/setting), not a trading
  // mode: `showSpot` is the only field anything on this venue reads, from the
  // spot order tabs. A fixture that offers state the product cannot have lets a
  // test pass on a shape production never produces, so it holds only that.
  UserSetting: {
    data: { mode: { showSpot: true }, theme: 'dark' },
  },
  Wallet: {
    btcBalance: 1,
    assets: [],
  },
  trade: {
    currentPair: null,
    pairs: [],
  },
  // The mock store holds only branches a real reducer produces.
}

const mockDispatch = jest.fn()

// Make state accessible for tests to customize
global.mockReduxState = defaultState

// Mock react-redux - keep Provider and useSelector real, only mock useDispatch for convenience
// Tests that need Redux state should use <Provider> with their own mock store
jest.mock('react-redux', () => ({
  ...jest.requireActual('react-redux'),
  // Note: We don't mock useSelector anymore - tests should use Provider
  useDispatch: () => mockDispatch,
}))

// Mock Next.js router
jest.mock('next/router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    pathname: '/',
    query: {},
    asPath: '/',
  }),
}))

// Mock API Services - must be before they are imported
jest.mock('@/services/User/ApiService', () => ({
  default: {
    fetchData: jest.fn(() => Promise.resolve({})),
  },
}))

jest.mock('@/services/User/BaseService', () => {
  const mockInstance = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  }
  return { default: mockInstance }
})

// Mock store to prevent BaseService import issues
// Use actualReactRedux from line 11 for typed hooks
jest.mock('@/store', () => ({
  dispatch: jest.fn(),
  getState: jest.fn(() => ({})),
  useSelector: actualReactRedux.useSelector,
  useDispatch: actualReactRedux.useDispatch,
  default: jest.fn(),
}))

jest.mock('@/store/index', () => ({
  dispatch: jest.fn(),
  getState: jest.fn(() => ({})),
  useSelector: actualReactRedux.useSelector,
  useDispatch: actualReactRedux.useDispatch,
  default: jest.fn(),
}))

// Mock Redux slices
jest.mock('@/store/auth/userSlice', () => ({
  getUserDetails: jest.fn(() => ({ type: 'USER_DETAILS_SUCCESS' })),
}))

jest.mock('@/store/Wallet/dataSlice', () => ({
  getAssetData: jest.fn(() => ({ type: 'GET_ASSET_DATA' })),
  getPriceConversion: jest.fn(() => ({ type: 'GET_PRICE_CONVERSION' })),
  // The signal every wallet-mutating screen raises. See store/Wallet/dataSlice.
  walletBalancesChanged: jest.fn(() => ({ type: 'WALLET_BALANCES_CHANGED' })),
  refreshWalletBalances: jest.fn(() => ({ type: 'REFRESH_WALLET_BALANCES' })),
}))

jest.mock('@/config', () => ({
  USER_API: 'http://localhost:3000',
}))

jest.mock('@/lib/deepParseJson', () => jest.fn((json) => {
  try { return JSON.parse(json) }
  catch { return json }
}))

jest.mock('react-cookie', () => ({
  Cookies: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
  })),
}))

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
  })),
  get: jest.fn(() => Promise.resolve({ data: {} })),
  post: jest.fn(() => Promise.resolve({ data: {} })),
}))

jest.mock('@/services/User/UserServices', () => ({
  apiEmailOTPRequest: jest.fn(async () => {
    // Return a promise that resolves with success
    return Promise.resolve({
      data: { status: true, message: 'OTP sent successfully.' },
    })
  }),
  // `apiEmailOTPVerify` was mocked here too. Both it and its route
  // (user/verifyOtp) are gone, and nothing ever called it: change password
  // posts its code straight to user/changePassword, which verifies it itself.
  // A mock of a module export that no longer exists passes silently and hides
  // the fact that nothing imports it.
  apiGetUserProfile: jest.fn(() => Promise.resolve({
    data: { status: true, result: {} },
  })),
}))

jest.mock('@/services/spot/SpotService', () => ({
  getPairData: jest.fn(() => Promise.resolve({})),
}))

// Mock history service
jest.mock('@/services/history.service', () => ({
  apiGetMySpotHistory: jest.fn(() => Promise.resolve({
    data: {
      result: {
        data: [],
        count: 0,
      },
    },
  })),
}))

// Mock next.config.js imports
jest.mock('@/utils/cookie', () => ({
  setCookie: jest.fn(),
  getCookie: jest.fn(),
  removeCookie: jest.fn(),
}))

jest.mock('@/lib/toastAlert', () => ({
  toastAlert: jest.fn(),
}))

// Mock Pagination component
jest.mock('@/lib/pagination', () => ({
  __esModule: true,
  default: function Pagination({ currentPage, totalCount, pageSize, onPageChange }) {
    const totalPages = Math.ceil(totalCount / pageSize)
    return React.createElement('div', { 'data-testid': 'pagination' },
      React.createElement('button', { onClick: () => onPageChange(1), disabled: currentPage === 1 }, 'First'),
      React.createElement('button', { onClick: () => onPageChange(currentPage - 1), disabled: currentPage === 1 }, 'Prev'),
      React.createElement('span', null, `Page ${currentPage} of ${totalPages}`),
      React.createElement('button', { onClick: () => onPageChange(currentPage + 1), disabled: currentPage === totalPages }, 'Next'),
      React.createElement('button', { onClick: () => onPageChange(totalPages), disabled: currentPage === totalPages }, 'Last')
    )
  },
}))

// Mock usePagination hook
jest.mock('@/lib/usePagination', () => ({
  DOTS: '...',
  usePagination: jest.fn(() => [1, 2, 3]),
}))

// Mock other utility libraries
jest.mock('@/lib/roundOf', () => ({
  truncateDecimals: (num, decimals) => (typeof num === 'number' ? num.toFixed(decimals || 2) : '0.00'),
  toFixed: (num, decimals) => (typeof num === 'number' ? num.toFixed(decimals || 2) : '0.00'),
  toFixedDown: (num, decimals) => (typeof num === 'number' ? num.toFixed(decimals || 2) : '0.00'),
}))

jest.mock('@/lib/dateTimeHelper', () => ({
  dateTimeFormat: (date) => '2024-01-01 10:00',
}))

/**
 * THIS MOCK REPLACES THE WHOLE MODULE, SO EVERY EXPORT IT OMITS BECOMES
 * `undefined` - AND CALLING ONE THROWS.
 *
 * It listed only `capitalize`. lib/stringCase.js also exports `emailFormat`,
 * `firstLetterCase` and `cnvtBoolean`, and `emailFormat` is called at render
 * time by components/security/ChangePassword.tsx. Any test that mounts that
 * dialog died on "(0 , _stringCase.emailFormat) is not a function" - a failure
 * of the harness, not of the component, which is the kind that gets a real
 * component written off as untestable. Filled in with the real behaviours.
 */
jest.mock('@/lib/stringCase', () => ({
  capitalize: (str) => str,
  firstLetterCase: (value) => (value ? String(value).charAt(0).toUpperCase() : ''),
  emailFormat: (email) => (email ? String(email) : ''),
  cnvtBoolean: (value) => value === true || value === 'true',
}))

/**
 * `isEmpty` IS NOT MOCKED, AND MUST NOT BE.
 *
 * It used to be — twice, at two different points in this file, with a stub that
 * only understood null/undefined/"" and answered FALSE for `{}`. The real
 * implementation (lib/isEmpty.js) counts an object with no keys as empty, and
 * every form in this app decides whether it may submit by asking exactly that:
 *
 *     let checkErrors = validation(data)
 *     if (!isEmpty(checkErrors)) return   // <- bail out, show the errors
 *
 * With the stub, `{}` — the no-errors-found result — was reported as NOT empty,
 * so under Jest every form bailed out of every submit no matter how valid the
 * input. No test could assert "a valid form calls the API", because on this
 * harness no valid form ever did. That is why the Register suite's submission
 * test could only assert the button still existed afterwards, and why a totally
 * dead Register button sailed through a green suite.
 *
 * A stub that disagrees with the module it replaces does not simplify a test,
 * it blinds it. The real function is pure, synchronous and dependency-free;
 * there is nothing here to mock.
 */

jest.mock('classnames', () => (...args) => {
  return args.flat().filter(Boolean).join(' ')
})

// Mock react-select
jest.mock('react-select', () => ({
  __esModule: true,
  default: function Select({ options, onChange, value, ...props }) {
    return React.createElement('select', {
      ...props,
      value: value?.value || value,
      onChange: (e) => onChange(options?.find((o) => o.value === e.target.value) || e.target.value),
    }, options?.map((opt) =>
      React.createElement('option', { key: opt.value, value: opt.value }, opt.label)
    ))
  },
}))

jest.mock('@/lib/validation', () => ({
  removeByObj: jest.fn((obj, key) => {
    const newObj = { ...obj }
    delete newObj[key]
    return newObj
  }),
}))

jest.mock('browser-detect', () => ({
  __esModule: true,
  default: () => ({
    name: 'Chrome',
    mobile: false,
    os: 'Windows 10',
  }),
}))

jest.mock('react-google-recaptcha-v3', () => ({
  useGoogleReCaptcha: () => ({
    executeRecaptcha: jest.fn(() => Promise.resolve('mock-token')),
  }),
}))

// Mock next-themes
jest.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark_theme', setTheme: jest.fn() }),
  ThemeProvider: ({ children }) => children,
}))

// Mock Next.js navigation
jest.mock('next/navigation', () => ({
  useRouter() {
    return {
      push: jest.fn(),
      replace: jest.fn(),
      prefetch: jest.fn(),
      back: jest.fn(),
      pathname: '/',
      query: {},
      asPath: '/',
    }
  },
  usePathname() {
    return '/'
  },
  useSearchParams() {
    return new URLSearchParams()
  },
}))

// Mock Redux store slices - these need to be mocked in individual test files
// due to Jest's module resolution timing issues

// Mock react-bootstrap components - must be after React is available
// These are namespace components - Form.Label, Form.Control, InputGroup.Text
// IMPORTANT: Mock must be defined inline in factory to avoid scope issues
// NOTE: Modal is NOT mocked here - tests that need Modal should mock it locally

jest.mock('react-bootstrap', () => {
  const React = require('react')

  const MockFormControl = function({ children, ...props }) { return React.createElement('input', props) }
  const MockFormLabel = function({ children, ...props }) { return React.createElement('label', props, children) }
  const MockInputGroupText = function({ children, ...props }) { return React.createElement('span', props, children) }

  const MockForm = Object.assign(
    function({ children, ...props }) { return React.createElement('form', props, children) },
    {
      Group: function({ children, ...props }) { return React.createElement('div', props, children) },
      Label: MockFormLabel,
      Control: MockFormControl,
      Check: function({ children, ...props }) { return React.createElement('input', { type: 'checkbox', ...props }) },
      FormControl: MockFormControl,
      FormLabel: MockFormLabel,
    }
  )

  const MockInputGroup = Object.assign(
    function({ children, ...props }) { return React.createElement('div', props, children) },
    {
      Text: MockInputGroupText,
      InputGroupText: MockInputGroupText,
    }
  )

  const MockDropdown = Object.assign(
    function({ children, ...props }) { return React.createElement('div', props, children) },
    {
      Toggle: function({ children, ...props }) { return React.createElement('button', props, children) },
      Menu: function({ children, ...props }) { return React.createElement('div', props, children) },
      Item: function({ children, ...props }) { return React.createElement('div', props, children) },
    }
  )

  const MockTable = function({ children, ...props }) { return React.createElement('table', props, children) }

  const MockContainer = function({ children, ...props }) { return React.createElement('div', props, children) }
  const MockRow = function({ children, ...props }) { return React.createElement('div', props, children) }
  const MockCol = function({ children, ...props }) { return React.createElement('div', props, children) }

  const MockTabs = function({ children, ...props }) { return React.createElement('div', props, children) }
  const MockTab = function({ children, ...props }) { return React.createElement('div', props, children) }

  const MockNavbar = function({ children, ...props }) { return React.createElement('nav', props, children) }
  const MockNav = function({ children, ...props }) { return React.createElement('div', props, children) }
  const MockCard = function({ children, ...props }) { return React.createElement('div', props, children) }
  const MockProgressBar = function({ children, ...props }) { return React.createElement('div', props, children) }
  const MockSpinner = function({ children, ...props }) { return React.createElement('div', { ...props, 'data-testid': 'spinner' }, children) }
  const MockButton = function({ children, ...props }) { return React.createElement('button', props, children) }

  return {
    __esModule: true,
    default: {
      Form: MockForm,
      InputGroup: MockInputGroup,
      Dropdown: MockDropdown,
      Table: MockTable,
      Container: MockContainer,
      Row: MockRow,
      Col: MockCol,
      Tabs: MockTabs,
      Tab: MockTab,
      Navbar: MockNavbar,
      Nav: MockNav,
      Card: MockCard,
      ProgressBar: MockProgressBar,
      Spinner: MockSpinner,
      Button: MockButton,
    },
    Form: MockForm,
    InputGroup: MockInputGroup,
    Dropdown: MockDropdown,
    Table: MockTable,
    Container: MockContainer,
    Row: MockRow,
    Col: MockCol,
    Tabs: MockTabs,
    Tab: MockTab,
    Navbar: MockNavbar,
    Nav: MockNav,
    Card: MockCard,
    ProgressBar: MockProgressBar,
    Spinner: MockSpinner,
    Button: MockButton,
  }
})

// Note: Individual react-bootstrap subpath mocks removed to avoid conflicts with main mock
// The main react-bootstrap mock above handles all components

// Mock Next.js Image component
jest.mock('next/image', () => ({
  __esModule: true,
  default: (props) => {
    // eslint-disable-next-line @next/next/no-img-element
    return React.createElement('img', props)
  },
}))

// Mock Next.js Link component
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...props }) => (
    React.createElement('a', { href: href, ...props }, children)
  ),
}))

// Mock Next.js dynamic import - return the component directly instead of lazy loading
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: (...args) => {
    // Get the component loader function
    const loader = args[0]
    // In test environment, just return the component directly
    // If it's a function (dynamic import), we need to handle it
    if (typeof loader === 'function') {
      // For dynamic imports like () => import('@/lib/pagination')
      // We return a mock component that renders the mocked version
      const dynamicMod = loader()
      if (dynamicMod && typeof dynamicMod.then === 'function') {
        // It's a promise, return a placeholder that will be replaced
        return function DynamicPlaceholder(props) {
          return React.createElement('div', { 'data-testid': 'dynamic-component', ...props }, props?.children || 'Loading...')
        }
      }
      return dynamicMod
    }
    return function DynamicPlaceholder(props) {
      return React.createElement('div', { 'data-testid': 'dynamic-component', ...props }, props?.children || 'Loading...')
    }
  },
}))

// Mock next-cookies
jest.mock('next-cookies', () => ({
  __esModule: true,
  default: () => ({
    token: 'mock-token',
    userId: 'mock-user-id',
  }),
}))

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}
global.localStorage = localStorageMock

// Mock sessionStorage
const sessionStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}
global.sessionStorage = sessionStorageMock

// BROWSER-ONLY STUBS.
//
// This setup file is applied to EVERY test file, including ones that declare
// `@jest-environment node` in order to test server-render behaviour - and there
// is no `window` or `navigator` there. Referencing them unconditionally made
// such a file fail to run at all ("ReferenceError: window is not defined",
// pointing at this line rather than at the test), which is exactly the class of
// code that then goes untested: SSR guards can only be exercised without a DOM.
if (typeof window !== 'undefined') {
  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  })
}

// Mock navigator.clipboard
if (typeof navigator !== 'undefined') {
  Object.assign(navigator, {
    clipboard: {
      writeText: jest.fn(() => Promise.resolve()),
      readText: jest.fn(() => Promise.resolve('')),
    },
  })
}

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return []
  }
  unobserve() {}
}

// Suppress console errors in tests (optional - remove when debugging)
const originalError = console.error
beforeAll(() => {
  console.error = (...args) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('Warning: ReactDOM.render')
    ) {
      return
    }
    originalError.call(console, ...args)
  }
})

afterAll(() => {
  console.error = originalError
})
