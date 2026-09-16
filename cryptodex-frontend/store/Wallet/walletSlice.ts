/**
 * Mock walletSlice for testing
 * This file provides mock actions that components may import
 */

export const setWalletBalance = jest.fn()
export const updateWalletAssets = jest.fn()
export const getWalletDetails = jest.fn()
export const setUserSetting = jest.fn()
export default { setWalletBalance, updateWalletAssets, getWalletDetails, setUserSetting }
