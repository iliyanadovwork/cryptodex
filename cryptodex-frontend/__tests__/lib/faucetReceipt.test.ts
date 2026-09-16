/**
 * Faucet receipt tests (CRITICAL)
 *
 * The receipt is the only thing standing between the claim/reset pages and the
 * copy they used to print — copy that named one half of a claim and left the
 * rest out entirely. These tests pin the two properties that matter: the page
 * describes EVERY wallet the API reported, and it describes NOTHING the API did
 * not report.
 *
 * Those two properties matter MORE now, not less. The venue is spot-only and
 * the advertised grant below names the spot wallet alone, so if the server is
 * still crediting something else the only thing that will say so is the receipt
 * read out of the response.
 */

import {
  FAUCET_FULL_GRANT,
  FAUCET_SPOT_GRANT,
  FaucetReceipt,
  creditPhrase,
  formatCreditAmount,
  groupCreditsByWallet,
  loadReceipts,
  readCredits,
  saveReceipt,
  walletLabel,
} from '@/lib/faucetReceipt'

beforeEach(() => {
  window.localStorage.clear()
})

describe('advertised grant', () => {
  test('the spot grant is the one faucet coin', () => {
    expect(FAUCET_SPOT_GRANT.map((c) => c.coin)).toEqual(['USD'])
    expect(FAUCET_SPOT_GRANT.every((c) => c.amount === 1000)).toBe(true)
    expect(FAUCET_SPOT_GRANT.every((c) => c.wallet === 'spot')).toBe(true)
  })

  test('the advertised grant promises the spot wallet and nothing else', () => {
    // Spot is the only wallet a product on this venue can spend from. Promising
    // a credit to a wallet the user cannot use would be the original defect
    // wearing the opposite sign.
    expect(FAUCET_FULL_GRANT.every((c) => c.wallet === 'spot')).toBe(true)
    expect(FAUCET_FULL_GRANT.map((c) => c.coin)).toEqual(['USD'])
    expect(FAUCET_FULL_GRANT[0].coin).toBe('USD')
  })
})

describe('formatCreditAmount', () => {
  test('separates thousands', () => {
    expect(formatCreditAmount(10000)).toBe('10,000')
  })

  test('keeps fractional collateral amounts', () => {
    expect(formatCreditAmount(0.05)).toBe('0.05')
  })

  test('drops trailing zeros', () => {
    expect(formatCreditAmount('50.00000000')).toBe('50')
  })

  test('accepts numeric strings', () => {
    expect(formatCreditAmount('1234.5')).toBe('1,234.5')
  })

  test('returns empty for a non-numeric value rather than printing NaN', () => {
    expect(formatCreditAmount('not-a-number')).toBe('')
    expect(formatCreditAmount(undefined)).toBe('')
  })
})

describe('creditPhrase', () => {
  test('joins a wallet worth of credits', () => {
    expect(creditPhrase(FAUCET_SPOT_GRANT)).toBe('1,000 USD')
    expect(
      creditPhrase([
        { coin: 'BTC', amount: 0.05, wallet: 'spot' },
        { coin: 'ETH', amount: 1, wallet: 'spot' },
        { coin: 'SOL', amount: 50, wallet: 'spot' },
      ])
    ).toBe('0.05 BTC + 1 ETH + 50 SOL')
  })

  test('is empty for no credits', () => {
    expect(creditPhrase([])).toBe('')
  })
})

describe('walletLabel', () => {
  test('names the wallet the faucet credits', () => {
    expect(walletLabel('spot')).toBe('Spot wallet')
  })

  /**
   * THIS IS THE LOAD-BEARING ONE NOW.
   *
   * The label map holds one entry, so any wallet the server reports that this
   * build has not heard of goes through this path. A credit that is dropped
   * because its wallet has no label is a credit the user is never told about —
   * which is the defect this whole module exists to prevent, arriving from the
   * other direction.
   */
  test('names an unknown wallet rather than dropping it', () => {
    expect(walletLabel('p2p')).toBe('P2p wallet')
    expect(walletLabel('lending')).toBe('Lending wallet')
    expect(walletLabel('savings')).toBe('Savings wallet')
  })

  test('falls back when the API reports no wallet', () => {
    expect(walletLabel(undefined)).toBe('Wallet')
    expect(walletLabel('')).toBe('Wallet')
  })
})

describe('readCredits', () => {
  const payload = {
    credited: [
      { coin: 'USDC', amount: 10000, wallet: 'spot', balance: 10000 },
      { coin: 'BTC', amount: 0.05, wallet: 'lending', balance: 0.05 },
    ],
  }

  test('reads every credit the API reported, both wallets', () => {
    const credits = readCredits(payload)
    expect(credits).toHaveLength(2)
    expect(credits.map((c) => c.wallet)).toEqual(['spot', 'lending'])
    expect(credits[1]).toEqual({
      coin: 'BTC',
      amount: 0.05,
      wallet: 'lending',
      balance: 0.05,
    })
  })

  test('invents nothing when the response omits credited', () => {
    expect(readCredits({ success: true })).toEqual([])
    expect(readCredits(undefined)).toEqual([])
    expect(readCredits({ credited: 'nope' })).toEqual([])
  })

  test('drops malformed entries instead of printing blanks', () => {
    expect(
      readCredits({ credited: [null, { coin: 'USDC' }, { wallet: 'spot' }] })
    ).toEqual([])
  })
})

describe('groupCreditsByWallet', () => {
  test('groups by wallet in first-seen order, keeping every coin', () => {
    // Built from a response the server COULD send rather than from the
    // advertised grant: what this has to handle is whatever arrives, including
    // a wallet this build does not advertise.
    const groups = groupCreditsByWallet([
      ...FAUCET_FULL_GRANT,
      { coin: 'BTC', amount: 0.05, wallet: 'lending' },
      { coin: 'ETH', amount: 1, wallet: 'lending' },
      { coin: 'SOL', amount: 50, wallet: 'lending' },
    ])
    expect(groups.map((g) => g.wallet)).toEqual(['spot', 'lending'])
    expect(groups[0].label).toBe('Spot wallet')
    expect(groups[1].label).toBe('Lending wallet')
    expect(groups[1].credits.map((c) => c.coin)).toEqual(['BTC', 'ETH', 'SOL'])
  })

  test('keeps a wallet that appears again later in the list', () => {
    const groups = groupCreditsByWallet([
      { coin: 'USDC', amount: 1, wallet: 'spot' },
      { coin: 'BTC', amount: 1, wallet: 'lending' },
      { coin: 'USD', amount: 1, wallet: 'spot' },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].credits.map((c) => c.coin)).toEqual(['USDC', 'USD'])
  })

  test('is empty for no credits', () => {
    expect(groupCreditsByWallet([])).toEqual([])
  })

  test('drops entries with no wallet instead of rendering a headless group', () => {
    const groups = groupCreditsByWallet([
      { coin: 'USDC', amount: 1, wallet: 'spot' },
      { coin: 'MYSTERY', amount: 1 } as any,
      null as any,
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].wallet).toBe('spot')
    expect(groups[0].credits.map((c) => c.coin)).toEqual(['USDC'])
  })

  test('an unwalleted entry never sneaks into a real wallet group', () => {
    const groups = groupCreditsByWallet([
      { coin: 'MYSTERY', amount: 1, wallet: '' } as any,
      { coin: 'BTC', amount: 0.05, wallet: 'lending' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].credits.map((c) => c.coin)).toEqual(['BTC'])
  })
})

describe('receipt storage', () => {
  const receipt: FaucetReceipt = {
    at: 1000,
    kind: 'claim',
    signature: 'faucet-1-user-USDC',
    credited: FAUCET_FULL_GRANT,
  }

  test('a saved receipt is readable back for that user', () => {
    saveReceipt('user1', receipt)
    expect(loadReceipts('user1')).toHaveLength(1)
    expect(loadReceipts('user1')[0].signature).toBe('faucet-1-user-USDC')
  })

  test('receipts are per user', () => {
    saveReceipt('user1', receipt)
    expect(loadReceipts('user2')).toEqual([])
  })

  test('nothing is stored without a user', () => {
    expect(saveReceipt(undefined, receipt)).toEqual([])
    expect(loadReceipts(undefined)).toEqual([])
  })

  test('the newest receipt is first', () => {
    saveReceipt('user1', { ...receipt, at: 1000, signature: 'old' })
    saveReceipt('user1', { ...receipt, at: 5000, signature: 'new' })
    expect(loadReceipts('user1').map((r) => r.signature)).toEqual(['new', 'old'])
  })

  test('an out-of-order save still sorts newest first', () => {
    saveReceipt('user1', { ...receipt, at: 5000, signature: 'new' })
    saveReceipt('user1', { ...receipt, at: 1000, signature: 'old' })
    expect(loadReceipts('user1')[0].signature).toBe('new')
  })

  test('the stored list is capped so it cannot grow without bound', () => {
    for (let i = 0; i < 25; i++) {
      saveReceipt('user1', { ...receipt, at: i, signature: `sig-${i}` })
    }
    const stored = loadReceipts('user1')
    expect(stored).toHaveLength(20)
    expect(stored[0].signature).toBe('sig-24')
  })

  test('corrupt storage reads as empty rather than throwing', () => {
    window.localStorage.setItem('cryptodex_faucet_receipts', '{not json')
    expect(loadReceipts('user1')).toEqual([])
  })

  test('a non-object payload in storage reads as empty', () => {
    window.localStorage.setItem('cryptodex_faucet_receipts', '[1,2,3]')
    expect(loadReceipts('user1')).toEqual([])
  })

  test('a null payload in storage reads as empty rather than throwing', () => {
    window.localStorage.setItem('cryptodex_faucet_receipts', 'null')
    expect(loadReceipts('user1')).toEqual([])
  })

  test('an empty user id reads as empty even if storage holds an empty key', () => {
    window.localStorage.setItem(
      'cryptodex_faucet_receipts',
      JSON.stringify({ '': [receipt] })
    )
    expect(loadReceipts('')).toEqual([])
    expect(loadReceipts(undefined)).toEqual([])
  })

  test('a non-array user entry reads as empty', () => {
    window.localStorage.setItem(
      'cryptodex_faucet_receipts',
      JSON.stringify({ user1: 'nope' })
    )
    expect(loadReceipts('user1')).toEqual([])
  })
})
