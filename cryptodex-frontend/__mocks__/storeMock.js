/**
 * Mock Redux Store Slices
 *
 * Provides mock implementations of Redux slices for testing
 */

// Mock user actions
export const setUser = jest.fn()
export const updateUser = jest.fn()
export const clearUser = jest.fn()

// Mock session actions
export const onSignInSuccess = jest.fn()
export const onSignOut = jest.fn()
export const setSessionToken = jest.fn()

// Mock user setting actions
export const setUserSetting = jest.fn()
export const updateUserSetting = jest.fn()
export const getMode = jest.fn()

// Mock wallet actions
export const setWalletBalance = jest.fn()
export const updateWalletAssets = jest.fn()
export const getWalletDetails = jest.fn()

// Mock trade actions
export const setCurrentPair = jest.fn()
export const updatePairs = jest.fn()

// Default exports for slices
export default {
  userSlice: {
    setUser,
    updateUser,
    clearUser,
  },
  sessionSlice: {
    onSignInSuccess,
    onSignOut,
    setSessionToken,
  },
  dataSlice: {
    setUserSetting,
    updateUserSetting,
    getMode,
  },
  walletSlice: {
    setWalletBalance,
    updateWalletAssets,
    getWalletDetails,
  },
}
