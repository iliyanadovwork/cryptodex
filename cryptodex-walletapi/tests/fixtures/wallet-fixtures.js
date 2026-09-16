/**
 * Wallet Fixtures
 *
 * Sample wallet data for testing
 */

export const TEST_WALLETS = {
  btcWallet: {
    _id: 'WALLET_BTC_1',
    userId: 'USER_1',
    currencyId: 'BTC_ID',
    currencySymbol: 'BTC',
    balance: '1.5',
    frozenBalance: '0.1',
    depositAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfEb',
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  ethWallet: {
    _id: 'WALLET_ETH_1',
    userId: 'USER_1',
    currencyId: 'ETH_ID',
    currencySymbol: 'ETH',
    balance: '10.5',
    frozenBalance: '2',
    depositAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  usdtWallet: {
    _id: 'WALLET_USDT_1',
    userId: 'USER_1',
    currencyId: 'USDT_ID',
    currencySymbol: 'USDT',
    balance: '5000',
    frozenBalance: '1000',
    depositAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  emptyWallet: {
    _id: 'WALLET_EMPTY_1',
    userId: 'USER_2',
    currencyId: 'BTC_ID',
    currencySymbol: 'BTC',
    balance: '0',
    frozenBalance: '0',
    depositAddress: null,
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  frozenWallet: {
    _id: 'WALLET_FROZEN_1',
    userId: 'USER_4',
    currencyId: 'ETH_ID',
    currencySymbol: 'ETH',
    balance: '0',
    frozenBalance: '100',
    depositAddress: '0x1234567890123456789012345678901234567890',
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  }
};

export const TEST_TRANSACTIONS = {
  completedDeposit: {
    _id: 'TX_DEPOSIT_1',
    userId: 'USER_1',
    type: 'deposit',
    currencySymbol: 'BTC',
    amount: '0.5',
    status: 'completed',
    txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    fromAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfEb',
    toAddress: 'WALLET_BTC_1',
    confirmations: 6,
    requiredConfirmations: 6,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  pendingWithdraw: {
    _id: 'TX_WITHDRAW_1',
    userId: 'USER_1',
    type: 'withdraw',
    currencySymbol: 'ETH',
    amount: '1.5',
    status: 'pending',
    txHash: null,
    fromAddress: 'WALLET_ETH_1',
    toAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    confirmations: 0,
    requiredConfirmations: 12,
    fee: '0.01',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  completedWithdraw: {
    _id: 'TX_WITHDRAW_2',
    userId: 'USER_1',
    type: 'withdraw',
    currencySymbol: 'USDT',
    amount: '500',
    status: 'completed',
    txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    fromAddress: 'WALLET_USDT_1',
    toAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    confirmations: 12,
    requiredConfirmations: 12,
    fee: '5',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  failedTransaction: {
    _id: 'TX_FAILED_1',
    userId: 'USER_2',
    type: 'deposit',
    currencySymbol: 'BTC',
    amount: '0.01',
    status: 'failed',
    txHash: '0xfailed1234567890failed1234567890failed1234567890failed1234567890',
    fromAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfEb',
    toAddress: 'WALLET_EMPTY_1',
    confirmations: 0,
    requiredConfirmations: 6,
    errorMessage: 'Transaction confirmation timeout',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  }
};

export const TEST_DEPOSIT_EVENTS = {
  pendingDeposit: {
    _id: 'DEP_EVENT_1',
    userId: 'USER_1',
    currencySymbol: 'BTC',
    amount: '0.25',
    address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfEb',
    txHash: '0xabc123',
    confirmations: 0,
    status: 'pending',
    createdAt: new Date()
  },
  confirmingDeposit: {
    _id: 'DEP_EVENT_2',
    userId: 'USER_1',
    currencySymbol: 'ETH',
    amount: '2.0',
    address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    txHash: '0xdef456',
    confirmations: 5,
    status: 'confirming',
    createdAt: new Date()
  },
  confirmedDeposit: {
    _id: 'DEP_EVENT_3',
    userId: 'USER_1',
    currencySymbol: 'USDT',
    amount: '1000',
    address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    txHash: '0xghi789',
    confirmations: 12,
    status: 'confirmed',
    createdAt: new Date()
  }
};
