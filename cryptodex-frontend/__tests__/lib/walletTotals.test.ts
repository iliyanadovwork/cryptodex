/**
 * lib/walletTotals — "Total Assets Value" has to be a total.
 *
 * The wallet page printed that label over the balance of whichever tab was
 * selected. Moving your own money between two of the wallets this venue used to
 * have — an internal transfer that changes nothing about what you own — made
 * the headline number fall, and clicking between tabs made it jump. These tests pinned the property that
 * fixes it: THE TOTAL IS INVARIANT UNDER A MOVE BETWEEN COUNTED BUCKETS.
 *
 * The venue is spot-only now, so the transfer that caused the original defect
 * cannot be performed. The property is still the right one to pin, and it is
 * still what a resting spot order exercises: `spotBal -> spotInOrder` moves
 * money between two fields the headline counts, and the headline must not
 * flinch. It is asserted below in exactly the terms that survive.
 *
 * AND THE OTHER HALF, which now carries the weight: the buckets that are NOT
 * counted. WALLET_BUCKETS is the whole list of what is summed, and a field that
 * is not named there contributes nothing however large it is.
 *
 * Nothing can reach this module with such a field today — walletapi's wallet
 * schema no longer declares one and getWallet answers from an explicit
 * projection, so a live payload cannot carry it. The extra fields on the
 * fixtures below are what gives that property something to bite on. They stand
 * for any balance a payload might carry in a pot no product on this venue can
 * spend from: counting one would tell the user they have money to trade with
 * that they do not.
 */

import {
  bucketBalance,
  totalBalance,
  valueInQuote,
  walletTotals,
  WALLET_BUCKETS,
  DEMO_DOLLAR_COINS,
  isDemoDollar,
  quoteRate,
} from '@/lib/walletTotals'

/**
 * THE DEMO DOLLARS.
 *
 * A fresh account holding 1,000 USDC + 1,000 USD and nothing else printed
 * "2000.90 USD", because USDC was valued from an outside market's USDC/USD rate
 * (USDC has since been removed entirely; the peg below is what survived it)
 * - for a coin that appears in none of this venue's three markets and cannot be
 * sold here at any price. The peg is one list, applied in one place, so the row
 * and the headline cannot value the same coin differently.
 */
describe('the coins this venue issues as dollars', () => {
  it('is USD, and nothing else', () => {
    expect([...DEMO_DOLLAR_COINS]).toEqual(['USD'])
  })

  it('recognises them whatever case they arrive in', () => {
    expect(isDemoDollar('usd')).toBe(true)
    expect(isDemoDollar(' USD ')).toBe(true)
    expect(isDemoDollar('BTC')).toBe(false)
    expect(isDemoDollar(undefined)).toBe(false)
  })

  it('prices them at exactly one, whatever the feed says', () => {
    expect(quoteRate('USD', '1.00092')).toBe(1)
    expect(quoteRate('USD', undefined)).toBe(1)
  })

  it('leaves every tradable coin on the feed rate', () => {
    expect(quoteRate('BTC', '63432.27')).toBe('63432.27')
    // Including the "no rate published" case, which valueInQuote answers 1:1 -
    // that is a fallback, not a peg, and the two must stay distinguishable.
    expect(quoteRate('DOGE', undefined)).toBe(undefined)
  })
})

const asset = (over: any = {}) => ({
  coin: 'USD',
  spotBal: '0',
  spotInOrder: '0',
  spotLockedBal: '0',
  // Not on any payload this venue can produce any more; present so the
  // "counted by nothing" property below has something to bite on. See above.
  derivativeBal: '0',
  derivativeBalLocked: '0',
  inverseBal: '0',
  inverseLockBal: '0',
  affiliateBal: '0',
  ...over,
})

describe('bucketBalance', () => {
  it('adds every disjoint field of a wallet', () => {
    const a = asset({ spotBal: '100', spotInOrder: '25', spotLockedBal: '5' })
    expect(bucketBalance(a, 'spot')).toBe(130)
  })

  it('treats missing and unparseable fields as zero, never NaN', () => {
    // One NaN would poison an entire portfolio total.
    expect(bucketBalance({ coin: 'BTC' }, 'spot')).toBe(0)
    expect(bucketBalance(asset({ spotBal: 'oops' }), 'spot')).toBe(0)
    expect(bucketBalance(null, 'spot')).toBe(0)
  })

  it('answers zero for a bucket that is not declared', () => {
    // "future" and "inverse" were buckets; they are not any more. Asking for
    // one must answer 0, not throw and not resurrect the field.
    expect(bucketBalance(asset({ derivativeBal: '999' }), 'future' as any)).toBe(0)
    expect(bucketBalance(asset({ inverseBal: '999' }), 'inverse' as any)).toBe(0)
    expect(bucketBalance(asset({ affiliateBal: '999' }), 'affiliate' as any)).toBe(0)
  })
})

describe('the wallets a spot-only venue counts', () => {
  it('counts spot, and nothing else', () => {
    expect(Object.keys(WALLET_BUCKETS).sort()).toEqual(['spot'])
  })

  it('does not count an affiliate balance no product can credit or spend', () => {
    // The affiliate programme is gone: no plans, no commission rates, no
    // rewards, so nothing writes this field and nothing can withdraw from it.
    const stranded = asset({ spotBal: '100', affiliateBal: '9000' })
    expect(totalBalance(stranded)).toBe(100)
    expect(bucketBalance(stranded, 'affiliate' as any)).toBe(0)
  })

  it('does not count a derivative balance the user cannot reach', () => {
    // The engines are gone; no product can spend this or transfer it out.
    // Putting it in "Total Assets Value" would tell the user they have money
    // to trade with that they do not.
    const stranded = asset({ spotBal: '100', derivativeBal: '5000', inverseBal: '2000' })
    expect(totalBalance(stranded)).toBe(100)
  })

  it('does not count locked margin fields either', () => {
    const a = asset({ derivativeBalLocked: '150', inverseLockBal: '90' })
    expect(totalBalance(a)).toBe(0)
  })
})

describe('totalBalance — invariance under a move between counted buckets', () => {
  it('is unchanged when spot funds become resting orders', () => {
    const before = asset({ spotBal: '500', spotInOrder: '0' })
    const after = asset({ spotBal: '120', spotInOrder: '380' })
    expect(totalBalance(before)).toBe(500)
    expect(totalBalance(after)).toBe(500)
  })

  it('is unchanged when spot funds are locked by the venue', () => {
    const before = asset({ spotBal: '1000', spotLockedBal: '0' })
    const after = asset({ spotBal: '250', spotLockedBal: '750' })
    expect(totalBalance(before)).toBe(totalBalance(after))
  })

  it('DOES change when money genuinely arrives', () => {
    // The guard must not be vacuous: a real deposit has to move the number.
    const before = asset({ spotBal: '1000' })
    const after = asset({ spotBal: '1500' })
    expect(totalBalance(after) - totalBalance(before)).toBe(500)
  })

  it('counts every declared bucket', () => {
    // If a new wallet is added to WALLET_BUCKETS but forgotten in the sum, the
    // total silently starts under-reporting. Fund each bucket with a distinct
    // amount and check every one lands.
    const buckets = Object.keys(WALLET_BUCKETS) as (keyof typeof WALLET_BUCKETS)[]
    const funded: any = { coin: 'USD' }
    buckets.forEach((bucket, i) => {
      funded[WALLET_BUCKETS[bucket][0]] = String(10 ** (i + 1))
    })
    const expected = buckets.reduce((sum, _b, i) => sum + 10 ** (i + 1), 0)
    expect(totalBalance(funded)).toBe(expected)
  })
})

describe('valueInQuote', () => {
  it('applies the conversion rate', () => {
    expect(valueInQuote(2, '64000')).toBe(128000)
  })

  it('falls back to 1:1 rather than to zero when there is no rate', () => {
    // Pricing an unknown coin at nothing understates holdings; and for the
    // quote coin itself (USD priced in USD) 1:1 is exactly right.
    expect(valueInQuote(500, undefined)).toBe(500)
    expect(valueInQuote(500, '0')).toBe(500)
    expect(valueInQuote(500, 'nope')).toBe(500)
  })
})

describe('walletTotals', () => {
  const assets = [
    asset({ coin: 'USD', spotBal: '5000', spotInOrder: '3000' }),
    asset({ coin: 'BTC', spotBal: '0.5' }),
  ]
  const priceOf = (coin: string) => (coin === 'BTC' ? '60000' : '1')

  it('values every wallet and sums them', () => {
    const { total, byBucket } = walletTotals(assets, priceOf)
    expect(byBucket.spot).toBe(5000 + 3000 + 30000)
    expect(total).toBe(5000 + 3000 + 30000)
  })

  it('total equals the sum of its parts', () => {
    const { total, byBucket } = walletTotals(assets, priceOf)
    const summed = Object.values(byBucket).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(summed, 8)
  })

  it('the total does not move when spot money moves into a resting order', () => {
    const beforeTotal = walletTotals(assets, priceOf).total
    const moved = [
      asset({ coin: 'USD', spotBal: '1000', spotInOrder: '7000' }),
      asset({ coin: 'BTC', spotBal: '0.5' }),
    ]
    expect(walletTotals(moved, priceOf).total).toBe(beforeTotal)
  })

  it('ignores stranded balances however large they are', () => {
    const withStranded = [
      asset({ coin: 'USD', spotBal: '5000', spotInOrder: '3000', affiliateBal: '2000', derivativeBal: '999999' }),
      asset({ coin: 'BTC', spotBal: '0.5', inverseBal: '10' }),
    ]
    expect(walletTotals(withStranded, priceOf).total).toBe(
      walletTotals(assets, priceOf).total
    )
  })

  it('survives a missing or malformed asset list', () => {
    expect(walletTotals(undefined as any, priceOf).total).toBe(0)
    expect(walletTotals([null, undefined] as any, priceOf).total).toBe(0)
  })
})

/**
 * There is no WALLET_BUCKET_LABELS block any more. The map captioned a
 * per-wallet breakdown under the /wallet headline ("Spot balance: …",
 * "Affiliate balance: …"); with one bucket left that breakdown would restate
 * the headline word for word, so the page stopped rendering it and the export
 * went with it.
 */
