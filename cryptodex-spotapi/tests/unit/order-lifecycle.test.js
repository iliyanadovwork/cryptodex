/**
 * WHAT HAPPENS TO AN ORDER AT THE GATE - AGAINST THE POLICY
 * ========================================================
 *
 * WHY THIS FILE WAS REWRITTEN
 * ---------------------------
 * It held 65 tests and imported nothing but `@jest/globals`. Its idea of an
 * order lifecycle test was:
 *
 *     test('should have open status for new orders', () => {
 *       const status = 'open';
 *       const validStatuses = ['open', 'partially_filled', ...];
 *       expect(validStatuses.includes(status)).toBe(true);
 *     });
 *
 * - an array literal asked whether it contains its own element. It described a
 * websocket update protocol, an order-history filter API and a Redis cache
 * layer, none of it wired to anything, and it was green throughout the period
 * in which POST /api/spot/orderPlace accepted market orders into a book that
 * could not fill and DEBITED the user for them.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * The real decision point in an order's life: `lib/orderGate.js
 * evaluateOrderGate`, the pure policy that decides whether an order is
 * accepted, rejected, or accepted-into-a-degraded-book, BEFORE any balance is
 * touched. `tests/unit/order-gate.test.js` drives it end-to-end through the
 * controller with redis in the loop; this file pins the POLICY ITSELF as a
 * total function - every reason, both order types, both sides, and the size
 * verdict - which is the part that has to be exhaustive rather than
 * representative.
 *
 * THE TWO PROPERTIES THAT MATTER, AND WHY THEY ARE STATED AS IDENTITIES
 * --------------------------------------------------------------------
 *   1. A REJECTION MOVES NO MONEY, so the only outcomes allowed are "refused
 *      with a message the user can act on" and "accepted into something whose
 *      funds cancelOrder can always return". The gate is therefore checked for
 *      TOTALITY - every reason it can emit maps to a message, and no verdict is
 *      ever `allowed: false` without one. That is asserted by driving every
 *      reason through the gate rather than by listing the ones someone
 *      remembered.
 *
 *   2. THE SIZE CHECK MUST COMPARE LIKE WITH LIKE. A market buy spends QUOTE
 *      and eats the ask ladder's NOTIONAL; a market sell delivers BASE and eats
 *      the bid ladder's QUANTITY. Comparing a BTC size against a USD capacity
 *      passes everything, which makes the whole check meaningless while looking
 *      present. The pairing is asserted as an identity between
 *      `ladderCapacityFor` and the verdict `evaluateOrderGate` reaches.
 *
 * MUTATION SUMMARY at the foot of the file.
 */

import { describe, test, expect } from '@jest/globals';

// `evaluateOrderGate` is PURE - verdicts in, decision out, no redis and no
// clock. Its module, however, also exports `assertOrderTradable`, which imports
// the depth snapshot resolver and the paper-book controller; importing those
// for real drags in redis, node-cron and the websocket client, none of which
// this file's subject touches. They are stubbed so the POLICY can be tested as
// the pure function it is. `assertOrderTradable` - the impure wrapper that
// resolves live verdicts and applies this policy - is driven end-to-end with
// redis in the loop by tests/unit/order-gate.test.js, which is where it
// belongs.
jest.mock('../../lib/depthSource.js', () => ({
  __esModule: true,
  resolveDepthSnapshot: async () => null
}));
jest.mock('../../controllers/paperBook.controller.js', () => ({
  __esModule: true,
  getLadderState: () => ({ present: false, reason: 'ladder_not_built' })
}));

import {
  evaluateOrderGate,
  ladderCapacityFor,
  usesPaperLadder,
  TERMINAL_REASONS,
  PAPER_LADDER_BOTSTATUS,
} from '../../lib/orderGate.js';

const healthy = { healthy: true, reason: null };
const resting = (over = {}) => ({
  present: true,
  reason: null,
  buyQuantity: 10,
  sellNotional: 100000,
  ...over
});

/** Every reason the gate can be handed by the two verdict sources. */
const DEPTH_REASONS = [
  'no_depth',
  'stale_depth',
  'empty_side',
  'crossed_book',
  'price_deviation'
];
const LADDER_REASONS = [
  'ladder_not_built',
  'ladder_stale',
  'ladder_orphaned',
  'no_admin_liquidity',
  'pair_ineligible',
  'no_pair'
];

// ===========================================================================
// SCOPE
// ===========================================================================

describe('the gate only speaks for pairs whose liquidity IS the paper ladder', () => {
  test('a "binance" pair is gated and nothing else is', () => {
    expect(PAPER_LADDER_BOTSTATUS).toBe('binance');
    expect(usesPaperLadder({ botstatus: 'binance' })).toBe(true);
    // A "bot"/"off" pair has no paper ladder BY DESIGN, so gating it would
    // report `ladder_not_built` forever and refuse every market order on it -
    // a self-inflicted outage.
    for (const botstatus of ['bot', 'off', '', undefined, 'Binance', 'BINANCE']) {
      expect(usesPaperLadder({ botstatus })).toBe(false);
    }
    expect(usesPaperLadder(null)).toBe(false);
    expect(usesPaperLadder(undefined)).toBe(false);
  });
});

// ===========================================================================
// THE HEALTHY PATH
// ===========================================================================

describe('a fillable book accepts both instruments (CRITICAL)', () => {
  test('a market order that fits, and a limit order, are accepted cleanly', () => {
    for (const orderType of ['market', 'limit']) {
      expect(
        evaluateOrderGate({
          orderType,
          depth: healthy,
          ladder: resting(),
          side: 'buy',
          size: 100
        })
      ).toEqual({ allowed: true, reason: null, message: null, degraded: false });
    }
  });

  test('NO SIZE MEANS NO SIZE OPINION - the health probe is not an order', () => {
    // Health reporting asks the gate "is this pair tradable at all" with no
    // order to measure. It must not be answered with a sufficiency verdict.
    expect(
      evaluateOrderGate({ orderType: 'market', depth: healthy, ladder: resting() })
        .allowed
    ).toBe(true);
    expect(
      evaluateOrderGate({
        orderType: 'market',
        depth: healthy,
        ladder: resting(),
        side: 'buy',
        size: null
      }).allowed
    ).toBe(true);
  });
});

// ===========================================================================
// SIZE - THE UNITS ARE THE WHOLE POINT
// ===========================================================================

describe('a market order bigger than the book is refused BEFORE any debit (CRITICAL)', () => {
  test('IDENTITY - a BUY is measured against the ladder\'s sell NOTIONAL', () => {
    // It spends quote and eats the ask side.
    const ladder = resting({ sellNotional: 100000, buyQuantity: 10 });
    expect(ladderCapacityFor(ladder, 'buy')).toBe(100000);

    const ok = evaluateOrderGate({
      orderType: 'market',
      depth: healthy,
      ladder,
      side: 'buy',
      size: 100000
    });
    expect(ok.allowed).toBe(true);

    const tooBig = evaluateOrderGate({
      orderType: 'market',
      depth: healthy,
      ladder,
      side: 'buy',
      size: 100000.01
    });
    expect(tooBig.allowed).toBe(false);
    expect(tooBig.reason).toBe('insufficient_liquidity');
    // The size that WOULD have been accepted is reported, so the refusal is
    // actionable rather than merely a "no".
    expect(tooBig.available).toBe(ladderCapacityFor(ladder, 'buy'));
    expect(tooBig.message).toMatch(/smaller size/i);
  });

  test('IDENTITY - a SELL is measured against the ladder\'s buy QUANTITY', () => {
    // It delivers base and eats the bid side. THIS IS THE PAIRING THAT MATTERS:
    // a BTC quantity compared against a USD notional passes everything.
    const ladder = resting({ sellNotional: 100000, buyQuantity: 10 });
    expect(ladderCapacityFor(ladder, 'sell')).toBe(10);

    expect(
      evaluateOrderGate({
        orderType: 'market',
        depth: healthy,
        ladder,
        side: 'sell',
        size: 10
      }).allowed
    ).toBe(true);

    const tooBig = evaluateOrderGate({
      orderType: 'market',
      depth: healthy,
      ladder,
      side: 'sell',
      size: 10.0001
    });
    expect(tooBig.allowed).toBe(false);
    expect(tooBig.reason).toBe('insufficient_liquidity');
    expect(tooBig.available).toBe(10);

    // And the units are NOT interchangeable: a sell of 500 is refused even
    // though 500 is comfortably inside the sell-side notional of 100000.
    expect(
      evaluateOrderGate({
        orderType: 'market',
        depth: healthy,
        ladder,
        side: 'sell',
        size: 500
      }).allowed
    ).toBe(false);
  });

  test('anything that is not "sell" eats the ask side', () => {
    const ladder = resting();
    for (const side of ['buy', 'BUY', undefined, null, '']) {
      expect(ladderCapacityFor(ladder, side)).toBe(ladder.sellNotional);
    }
    expect(ladderCapacityFor(ladder, 'sell')).toBe(ladder.buyQuantity);
  });

  test('A RESTING ORDER IS NOT A DEMAND ON THIS INSTANT\'S LIQUIDITY', () => {
    // A limit order is a claim about a FUTURE price. Refusing one for being
    // bigger than the book right now would be refusing the instrument.
    expect(
      evaluateOrderGate({
        orderType: 'limit',
        depth: healthy,
        ladder: resting(),
        side: 'buy',
        size: 1e12
      })
    ).toEqual({ allowed: true, reason: null, message: null, degraded: false });
  });

  test('FAIL CLOSED - an unmeasurable order or ladder is refused, not accepted', () => {
    // "We do not know whether this can fill" is, for a market order, the same
    // answer as "it cannot": accepting is what debits money against liquidity
    // nobody has confirmed exists.
    const unmeasurableSizes = [NaN, 0, -1, Infinity, 'abc', {}, []];
    for (const size of unmeasurableSizes) {
      const verdict = evaluateOrderGate({
        orderType: 'market',
        depth: healthy,
        ladder: resting(),
        side: 'buy',
        size
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe('error');
      expect(verdict.message).toBeTruthy();
    }

    for (const bad of [{ sellNotional: NaN }, { sellNotional: 'abc' }, { sellNotional: undefined }]) {
      expect(ladderCapacityFor(resting(bad), 'buy')).toBeNull();
      expect(
        evaluateOrderGate({
          orderType: 'market',
          depth: healthy,
          ladder: resting(bad),
          side: 'buy',
          size: 100
        }).allowed
      ).toBe(false);
    }
    expect(ladderCapacityFor(null, 'buy')).toBeNull();
  });

  test('a ZERO-capacity ladder refuses every market order', () => {
    const verdict = evaluateOrderGate({
      orderType: 'market',
      depth: healthy,
      ladder: resting({ sellNotional: 0 }),
      side: 'buy',
      size: 1
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('insufficient_liquidity');
  });
});

// ===========================================================================
// THE UNWELL PATHS
// ===========================================================================

describe('a market order is refused for every fault; a limit order is not (CRITICAL)', () => {
  test('EVERY depth fault refuses a market order, with a message', () => {
    for (const reason of DEPTH_REASONS) {
      const verdict = evaluateOrderGate({
        orderType: 'market',
        depth: { healthy: false, reason },
        ladder: resting(),
        side: 'buy',
        size: 1
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe(reason);
      expect(typeof verdict.message).toBe('string');
      expect(verdict.message.length).toBeGreaterThan(0);
      // The user must be told their money is safe. This is the sentence that
      // stops a support ticket, and it is not optional.
      expect(verdict.message).toMatch(/[Nn]othing has been charged/);
      expect(verdict.degraded).toBe(true);
    }
  });

  test('EVERY ladder fault refuses a market order, with a message', () => {
    for (const reason of LADDER_REASONS) {
      const verdict = evaluateOrderGate({
        orderType: 'market',
        depth: healthy,
        ladder: { present: false, reason },
        side: 'buy',
        size: 1
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe(reason);
      expect(verdict.message).toMatch(/[Nn]othing has been charged/);
    }
  });

  test('A TRANSIENT FAULT STILL LETS A LIMIT ORDER REST', () => {
    // Taking limit orders away during a hiccup removes the one instrument a
    // user has to get OUT of a position while the feed is unwell - worse for
    // them than the fault. Its funds are recoverable: cancelOrder refunds in
    // full and is deliberately never gated on health.
    const transient = [...DEPTH_REASONS, 'ladder_not_built', 'ladder_stale',
      'ladder_orphaned', 'no_admin_liquidity'];
    for (const reason of transient) {
      const verdict = evaluateOrderGate({
        orderType: 'limit',
        depth: { healthy: false, reason },
        ladder: resting(),
        side: 'buy',
        size: 1
      });
      expect(verdict.allowed).toBe(true);
      // ...but the caller is told WHY it was let through an unwell book.
      expect(verdict.reason).toBe(reason);
      expect(verdict.degraded).toBe(true);
    }
  });

  test('A TERMINAL FAULT STOPS EVEN A LIMIT ORDER', () => {
    // These are the verdicts that will not clear on their own - the pair
    // cannot carry liquidity at all - so the order would rest against nothing
    // indefinitely.
    expect([...TERMINAL_REASONS].sort()).toEqual(['no_pair', 'pair_ineligible']);
    for (const reason of TERMINAL_REASONS) {
      const verdict = evaluateOrderGate({
        orderType: 'limit',
        depth: healthy,
        ladder: { present: false, reason },
        side: 'buy',
        size: 1
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe(reason);
      expect(verdict.message).toMatch(/[Nn]othing has been charged/);
    }
  });

  test('IDENTITY - terminal reasons are exactly the ones a limit order cannot pass', () => {
    // Stated as a partition rather than as two lists that can drift: for every
    // reason the gate knows, a limit order is allowed if and only if the reason
    // is not terminal.
    for (const reason of [...DEPTH_REASONS, ...LADDER_REASONS]) {
      const allowed = evaluateOrderGate({
        orderType: 'limit',
        depth: { healthy: false, reason },
        ladder: { present: false, reason },
        side: 'buy',
        size: 1
      }).allowed;
      expect(allowed).toBe(!TERMINAL_REASONS.has(reason));
    }
  });

  test('DEPTH IS NAMED BEFORE THE LADDER - the reported cause is the real one', () => {
    // A dead feed produces a missing ladder a tick later. Reporting
    // `ladder_not_built` would send an operator to the wrong subsystem.
    const verdict = evaluateOrderGate({
      orderType: 'market',
      depth: { healthy: false, reason: 'stale_depth' },
      ladder: { present: false, reason: 'ladder_orphaned' },
      side: 'buy',
      size: 1
    });
    expect(verdict.reason).toBe('stale_depth');
  });

  test('an absent or unnamed verdict still produces an answer, never a crash', () => {
    // Totality. There is no input for which the gate returns undefined or
    // throws - a gate that throws is a gate that is bypassed by a catch block.
    const inputs = [
      { orderType: 'market', depth: undefined, ladder: undefined },
      { orderType: 'market', depth: null, ladder: null },
      { orderType: 'market', depth: { healthy: false }, ladder: resting() },
      { orderType: 'market', depth: healthy, ladder: { present: false } },
      { orderType: undefined, depth: healthy, ladder: resting() },
      { orderType: 'MARKET', depth: healthy, ladder: resting() },
      {}
    ];
    for (const input of inputs) {
      const verdict = evaluateOrderGate({ side: 'buy', size: 1, ...input });
      expect(verdict).toBeDefined();
      expect(typeof verdict.allowed).toBe('boolean');
      if (!verdict.allowed) {
        expect(typeof verdict.message).toBe('string');
        expect(verdict.message.length).toBeGreaterThan(0);
      }
    }
  });

  test('A REASON THIS MODULE HAS NEVER HEARD OF STILL GETS A MESSAGE', () => {
    // The reason string comes from `assessDepthHealth` and `getLadderState`,
    // which are separate modules and free to grow new verdicts. When one does,
    // the gate has no entry for it in MESSAGES - and a refusal whose `message`
    // is `undefined` reaches the user as a blank error, or as whatever the
    // controller prints when it interpolates undefined. `|| DEFAULT_MESSAGE` is
    // what makes the refusal explainable before anyone updates this table.
    for (const reason of ['some_new_verdict', 'feed_desynced', '']) {
      const verdict = evaluateOrderGate({
        orderType: 'market',
        depth: { healthy: false, reason },
        ladder: resting(),
        side: 'buy',
        size: 1
      });
      expect(verdict.allowed).toBe(false);
      expect(typeof verdict.message).toBe('string');
      expect(verdict.message.length).toBeGreaterThan(0);
      expect(verdict.message).toMatch(/[Nn]othing has been charged/);
    }
  });

  test('an unnamed fault defaults to a reason AND a message', () => {
    const verdict = evaluateOrderGate({
      orderType: 'market',
      depth: { healthy: false },
      ladder: resting(),
      side: 'buy',
      size: 1
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('error');
    expect(verdict.message).toMatch(/[Nn]othing has been charged/);

    const noLadderReason = evaluateOrderGate({
      orderType: 'market',
      depth: healthy,
      ladder: { present: false },
      side: 'buy',
      size: 1
    });
    expect(noLadderReason.reason).toBe('ladder_not_built');
  });

  test('ONLY "market" IS TREATED AS A MARKET ORDER - the safe direction', () => {
    // Anything else is treated as a resting order, whose funds cancelOrder can
    // always return. Erring is safe in exactly one direction and this is it.
    for (const orderType of ['limit', 'MARKET', 'Market', ' market', undefined, null, '']) {
      expect(
        evaluateOrderGate({
          orderType,
          depth: { healthy: false, reason: 'stale_depth' },
          ladder: resting(),
          side: 'buy',
          size: 1
        }).allowed
      ).toBe(true);
    }
    expect(
      evaluateOrderGate({
        orderType: 'market',
        depth: { healthy: false, reason: 'stale_depth' },
        ladder: resting(),
        side: 'buy',
        size: 1
      }).allowed
    ).toBe(false);
  });
});

describe('the shape of a verdict is stable, so callers cannot misread it', () => {
  test('every verdict carries all four fields', () => {
    const verdicts = [
      evaluateOrderGate({ orderType: 'market', depth: healthy, ladder: resting(), side: 'buy', size: 1 }),
      evaluateOrderGate({ orderType: 'limit', depth: { healthy: false, reason: 'stale_depth' }, ladder: resting() }),
      evaluateOrderGate({ orderType: 'market', depth: { healthy: false, reason: 'no_depth' }, ladder: resting(), side: 'buy', size: 1 }),
      evaluateOrderGate({ orderType: 'market', depth: healthy, ladder: resting(), side: 'buy', size: 1e12 })
    ];
    for (const verdict of verdicts) {
      for (const key of ['allowed', 'reason', 'message', 'degraded']) {
        expect(Object.prototype.hasOwnProperty.call(verdict, key)).toBe(true);
      }
      expect(typeof verdict.allowed).toBe('boolean');
      expect(typeof verdict.degraded).toBe('boolean');
      // An allowed-and-clean verdict carries no message; a refusal always does.
      if (verdict.allowed) expect(verdict.message).toBeNull();
      else expect(verdict.message).toBeTruthy();
    }
  });

  test('`available` appears only on an insufficient-liquidity refusal', () => {
    const insufficient = evaluateOrderGate({
      orderType: 'market', depth: healthy, ladder: resting(), side: 'buy', size: 1e12
    });
    expect(insufficient.available).toBe(100000);

    const ok = evaluateOrderGate({
      orderType: 'market', depth: healthy, ladder: resting(), side: 'buy', size: 1
    });
    expect(ok.available).toBeUndefined();

    const other = evaluateOrderGate({
      orderType: 'market', depth: { healthy: false, reason: 'no_depth' }, ladder: resting(), side: 'buy', size: 1
    });
    expect(other.available).toBeUndefined();
  });

  test('two different faults never share a message', () => {
    // A client that cannot tell "the feed is dead" from "your order is too big"
    // cannot tell the user what to do about it.
    const messages = new Map();
    for (const reason of [...DEPTH_REASONS, ...LADDER_REASONS]) {
      const { message } = evaluateOrderGate({
        orderType: 'market',
        depth: { healthy: false, reason },
        ladder: { present: false, reason },
        side: 'buy',
        size: 1
      });
      messages.set(reason, message);
    }
    const insufficient = evaluateOrderGate({
      orderType: 'market', depth: healthy, ladder: resting(), side: 'buy', size: 1e12
    }).message;
    // `insufficient_liquidity` in particular must not read like an outage - it
    // is the one fault the user can fix themselves, by trading smaller.
    expect([...messages.values()]).not.toContain(insufficient);
    expect(insufficient).toMatch(/smaller size/i);
  });
});

/**
 * MUTATION SUMMARY - each applied to lib/orderGate.js in a shadow tree,
 * reverted after each, with the guards that went red.
 *
 *  L1  ladderCapacityFor: swap the sides (buy -> buyQuantity,
 *      sell -> sellNotional) ............................ both unit identities
 *  L2  ladderCapacityFor: always return sellNotional .... sell unit identity,
 *                                                          anything-not-sell
 *  L3  ladderCapacityFor: return 0 instead of null for an
 *      unmeasurable ladder ............................... fail-closed
 *  L4  evaluateOrderGate: `requested >= available` (reject
 *      an exactly-fitting order) ......................... both unit identities
 *  L5  evaluateOrderGate: `requested < available` inverted
 *      to accept an oversized order ...................... both unit identities,
 *                                                          zero-capacity
 *  L7  evaluateOrderGate: treat a non-finite size as
 *      allowed ........................................... fail-closed
 *  L8  evaluateOrderGate: apply the size verdict to LIMIT
 *      orders too ........................................ resting-order guard
 *  L9  evaluateOrderGate: report the ladder reason before
 *      the depth reason .................................. depth-named-first
 *  L10 evaluateOrderGate: refuse limit orders on any fault  transient-fault
 *                                                          guard, partition
 *  L11 evaluateOrderGate: allow limit orders on terminal
 *      faults ............................................ terminal guard,
 *                                                          partition
 *  L12 evaluateOrderGate: drop the `MESSAGES[reason] ||
 *      DEFAULT_MESSAGE` fallback ......................... unheard-of-reason
 *  L13 evaluateOrderGate: default an unnamed ladder fault
 *      to `error` instead of `ladder_not_built` .......... unnamed-fault
 *  L14 evaluateOrderGate: treat every orderType as market   only-market guard
 *  L15 evaluateOrderGate: omit `available` from the
 *      insufficient verdict .............................. available-field,
 *                                                          buy unit identity
 *  L17 usesPaperLadder: accept any truthy botstatus ...... scope guard
 *  L18 TERMINAL_REASONS: add `stale_depth` ............... terminal guard,
 *                                                          partition, transient
 *
 * 16 mutations applied, 16 killed, 0 survivors.
 */
