/**
 * ORDER BOOK HEALTH — translation layer tests.
 *
 * This module decides whether the UI is allowed to present a book as tradeable
 * and what it says to the user when it is not. Everything here protects one of
 * two properties:
 *
 *   1. It never over-blocks. A payload from the old ungated path (no `healthy`
 *      field at all) must keep trading enabled — blocking those pairs would be
 *      a regression, and it is the single most dangerous change anyone could
 *      make to this file by "tightening" it.
 *   2. It never lies or leaks. Every state a person can land in produces real
 *      English — never a blank panel, never a raw enum like `ladder_orphaned`.
 */

import {
  AWAITING_BOOK_COPY,
  BookHealth,
  BookHealthReason,
  DEFAULT_BOOK_HEALTH,
  describeBookHealth,
  healthForPair,
  pendingBookHealth,
  readBookHealth,
  sameHealth,
} from '@/lib/orderBookHealth'

/** Every reason the backend can publish, plus the one the client derives. */
const ALL_REASONS: BookHealthReason[] = [
  'no_depth',
  'stale_depth',
  'empty_side',
  'crossed_book',
  'price_deviation',
  'pair_ineligible',
  'no_admin_liquidity',
  'ladder_not_built',
  'ladder_stale',
  'ladder_orphaned',
  'error',
  'no_pair',
  'connection_lost',
]

const unhealthy = (reason: any, pairId = 'PAIR_A'): BookHealth => ({
  healthy: false,
  reason,
  ladderPresent: false,
  pairId,
  pending: false,
})

describe('readBookHealth — what counts as a verdict', () => {
  it('treats a payload with no `healthy` field as healthy (bot-pair fail-open)', () => {
    // The ungated publisher still exists for non-binance pairs. Its payloads
    // have ladders and no health fields; gating them would break those pairs.
    const health = readBookHealth({
      pairId: 'PAIR_A',
      buyOrder: [{ _id: 100, quantity: 1 }],
      sellOrder: [{ _id: 101, quantity: 1 }],
    })

    expect(health.healthy).toBe(true)
    expect(health.reason).toBeNull()
    expect(health.pending).toBe(false)
  })

  it('treats an empty object and a null payload as healthy, not broken', () => {
    expect(readBookHealth({}).healthy).toBe(true)
    expect(readBookHealth(null).healthy).toBe(true)
    expect(readBookHealth(undefined).healthy).toBe(true)
  })

  it('reacts to an explicit false and nothing else', () => {
    expect(readBookHealth({ healthy: false }).healthy).toBe(false)
    // Anything truthy, or simply absent, stays enabled.
    expect(readBookHealth({ healthy: true }).healthy).toBe(true)
    expect(readBookHealth({ healthy: 'no' }).healthy).toBe(true)
    expect(readBookHealth({ healthy: 0 }).healthy).toBe(true)
  })

  it('keeps the machine-readable reason off an unhealthy payload', () => {
    const health = readBookHealth({
      healthy: false,
      healthReason: 'no_admin_liquidity',
      ladderPresent: false,
      pairId: 'PAIR_A',
    })

    expect(health).toEqual({
      healthy: false,
      reason: 'no_admin_liquidity',
      ladderPresent: false,
      pairId: 'PAIR_A',
      pending: false,
    })
  })

  it('falls back to `error` when an unhealthy payload gives no usable reason', () => {
    expect(readBookHealth({ healthy: false }).reason).toBe('error')
    expect(readBookHealth({ healthy: false, healthReason: '' }).reason).toBe('error')
    expect(readBookHealth({ healthy: false, healthReason: null }).reason).toBe('error')
    expect(readBookHealth({ healthy: false, healthReason: 42 }).reason).toBe('error')
  })

  it('never reports a healthy payload as having a reason', () => {
    // A stray reason on a healthy payload must not surface as a fault.
    expect(readBookHealth({ healthy: true, healthReason: 'stale_depth' }).reason).toBeNull()
  })

  it('coerces pairId to a string and defaults ladderPresent to true', () => {
    const health = readBookHealth({ pairId: 12345 })
    expect(health.pairId).toBe('12345')
    expect(health.ladderPresent).toBe(true)
    expect(readBookHealth({ ladderPresent: false }).ladderPresent).toBe(false)
  })

  it('marks a payload as observed, never pending — a payload IS the observation', () => {
    expect(readBookHealth({ pairId: 'PAIR_A' }).pending).toBe(false)
    expect(readBookHealth({ healthy: false, pairId: 'PAIR_A' }).pending).toBe(false)
  })
})

describe('describeBookHealth — every state produces English', () => {
  it.each(ALL_REASONS)('maps %s to complete, human copy', (reason) => {
    const copy = describeBookHealth(unhealthy(reason))

    expect(copy.title.length).toBeGreaterThan(0)
    expect(copy.detail.length).toBeGreaterThan(0)
    expect(copy.short.length).toBeGreaterThan(0)
    expect(typeof copy.transient).toBe('boolean')

    // The raw enum must never reach a person, in any of the three slots.
    expect(copy.title).not.toContain(reason)
    expect(copy.detail).not.toContain(reason)
    expect(copy.short).not.toContain(reason)
    expect(`${copy.title}${copy.detail}${copy.short}`).not.toMatch(/_/)
  })

  it.each(ALL_REASONS)('gives %s a `short` that reads inside the paused sentence', (reason) => {
    // The ticket renders "Trading paused — {short}. This re-enables on its own."
    const { short } = describeBookHealth(unhealthy(reason))
    expect(short).toBe(short.toLowerCase())
    expect(short.endsWith('.')).toBe(false)
  })

  it('degrades a reason it has never seen to the generic copy', () => {
    // A reason the backend adds tomorrow must not render blank or leak the enum.
    const copy = describeBookHealth(unhealthy('a_brand_new_backend_reason'))
    const generic = describeBookHealth(unhealthy('error'))

    expect(copy).toEqual(generic)
    expect(copy.title).not.toContain('a_brand_new_backend_reason')
    expect(copy.title.length).toBeGreaterThan(0)
  })

  it('degrades junk (numbers, objects, empty string) to the generic copy', () => {
    const generic = describeBookHealth(unhealthy('error'))
    expect(describeBookHealth(unhealthy(123 as any))).toEqual(generic)
    expect(describeBookHealth(unhealthy({} as any))).toEqual(generic)
    expect(describeBookHealth(unhealthy(''))).toEqual(generic)
  })

  it('never returns empty copy for null, undefined or a reasonless verdict', () => {
    for (const input of [null, undefined, unhealthy(null)]) {
      const copy = describeBookHealth(input as any)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.detail.length).toBeGreaterThan(0)
    }
  })

  it('describes "not heard yet" as loading, not as a fault', () => {
    const copy = describeBookHealth(pendingBookHealth('PAIR_A'))
    expect(copy).toEqual(AWAITING_BOOK_COPY)
    expect(copy.transient).toBe(true)
    // It must not read like something is broken.
    expect(copy.title.toLowerCase()).not.toContain('unavailable')
  })

  it('prefers the real fault over the loading copy when both could apply', () => {
    // A verdict that is somehow both pending and unhealthy is a fault first.
    const copy = describeBookHealth({ ...unhealthy('no_admin_liquidity'), pending: true })
    expect(copy).toEqual(describeBookHealth(unhealthy('no_admin_liquidity')))
  })
})

describe('healthForPair — a verdict only speaks for its own pair', () => {
  it('returns the verdict when it belongs to the pair on screen', () => {
    const verdict = unhealthy('ladder_stale', 'PAIR_A')
    expect(healthForPair(verdict, 'PAIR_A')).toBe(verdict)
  })

  it('ignores a verdict belonging to a different pair', () => {
    const other = unhealthy('no_admin_liquidity', 'PAIR_B')
    const result = healthForPair(other, 'PAIR_A')

    // Not "PAIR_A is broken" — we simply have not heard about PAIR_A.
    expect(result.healthy).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.pending).toBe(true)
    expect(result.pairId).toBe('PAIR_A')
  })

  it('reports pending — not healthy — when no verdict has arrived for this pair', () => {
    // This is the window the reviewer found: right after a pair switch there is
    // no verdict yet, and "no verdict" must not read as "all clear".
    expect(healthForPair(null, 'PAIR_A').pending).toBe(true)
    expect(healthForPair(undefined, 'PAIR_A').pending).toBe(true)
    expect(healthForPair(DEFAULT_BOOK_HEALTH, 'PAIR_A').pending).toBe(true)
  })

  it('compares ids as strings so an ObjectId-shaped value still matches', () => {
    const verdict = unhealthy('crossed_book', '695bf1017573eeb15a749c9d')
    expect(healthForPair(verdict, '695bf1017573eeb15a749c9d' as any).pending).toBeFalsy()
  })

  it('has nothing to gate when there is no pair on screen', () => {
    expect(healthForPair(unhealthy('no_depth'), '')).toEqual(DEFAULT_BOOK_HEALTH)
    expect(healthForPair(unhealthy('no_depth'), null)).toEqual(DEFAULT_BOOK_HEALTH)
  })
})

describe('sameHealth — the no-op filter that keeps 1s republishes cheap', () => {
  it('is true for identical verdicts', () => {
    expect(sameHealth(unhealthy('no_depth'), unhealthy('no_depth'))).toBe(true)
  })

  it('is false when any field differs', () => {
    const base = unhealthy('no_depth')
    expect(sameHealth(base, { ...base, healthy: true })).toBe(false)
    expect(sameHealth(base, { ...base, reason: 'stale_depth' })).toBe(false)
    expect(sameHealth(base, { ...base, ladderPresent: true })).toBe(false)
    expect(sameHealth(base, { ...base, pairId: 'PAIR_B' })).toBe(false)
  })

  it('distinguishes "not heard yet" from a settled healthy verdict', () => {
    // Without this, a pending placeholder would be filtered out as a no-op and
    // the ticket would never learn it should wait.
    const settled = { ...DEFAULT_BOOK_HEALTH, pairId: 'PAIR_A' }
    expect(sameHealth(settled, pendingBookHealth('PAIR_A'))).toBe(false)
  })
})
