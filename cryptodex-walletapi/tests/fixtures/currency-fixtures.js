/**
 * Currency Fixtures
 *
 * Sample currency data for testing
 */

export const SUPPORTED_CURRENCIES = [
  {
    _id: 'BTC_ID',
    symbol: 'BTC',
    type: 'crypto',
    status: 'active',
    image: '/images/currencies/btc.png',
    depositStatus: true,
    withdrawStatus: true,
    transferStatus: true,
    network: 'BTC',
    contractAddress: null,
    decimals: 8,
    minDeposit: '0.0001',
    maxWithdraw: '100',
    withdrawFee: '0.0005',
    minWithdraw: '0.001',
    priceInUSD: 45000
  },
  {
    _id: 'ETH_ID',
    symbol: 'ETH',
    type: 'crypto',
    status: 'active',
    image: '/images/currencies/eth.png',
    depositStatus: true,
    withdrawStatus: true,
    transferStatus: true,
    network: 'ERC20',
    contractAddress: null,
    decimals: 18,
    minDeposit: '0.001',
    maxWithdraw: '1000',
    withdrawFee: '0.005',
    minWithdraw: '0.01',
    priceInUSD: 2500
  },
  {
    _id: 'USDT_ID',
    symbol: 'USDT',
    type: 'token',
    status: 'active',
    image: '/images/currencies/usdt.png',
    depositStatus: true,
    withdrawStatus: true,
    transferStatus: true,
    network: 'ERC20',
    contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
    minDeposit: '1',
    maxWithdraw: '100000',
    withdrawFee: '5',
    minWithdraw: '10',
    priceInUSD: 1
  },
  {
    _id: 'BNB_ID',
    symbol: 'BNB',
    type: 'crypto',
    status: 'active',
    image: '/images/currencies/bnb.png',
    depositStatus: true,
    withdrawStatus: true,
    transferStatus: true,
    network: 'BSC',
    contractAddress: null,
    decimals: 18,
    minDeposit: '0.001',
    maxWithdraw: '10000',
    withdrawFee: '0.01',
    minWithdraw: '0.01',
    priceInUSD: 300
  },
  {
    _id: 'SOL_ID',
    symbol: 'SOL',
    type: 'crypto',
    status: 'active',
    image: '/images/currencies/sol.png',
    depositStatus: true,
    withdrawStatus: true,
    transferStatus: true,
    network: 'SOL',
    contractAddress: null,
    decimals: 9,
    minDeposit: '0.01',
    maxWithdraw: '10000',
    withdrawFee: '0.01',
    minWithdraw: '0.1',
    priceInUSD: 100
  }
];

export const INACTIVE_CURRENCIES = [
  {
    _id: 'DOGE_INACTIVE_ID',
    symbol: 'DOGE',
    type: 'crypto',
    status: 'inactive',
    image: '/images/currencies/doge.png',
    depositStatus: false,
    withdrawStatus: false,
    transferStatus: false,
    network: 'DOGE',
    contractAddress: null,
    decimals: 8,
    minDeposit: '1',
    maxWithdraw: '1000000',
    withdrawFee: '1',
    minWithdraw: '10',
    priceInUSD: 0.1
  }
];
