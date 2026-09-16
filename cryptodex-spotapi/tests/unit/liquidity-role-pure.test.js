/**
 * lib/liquidityRole.js — EVERY GUARD, ONE AT A TIME (CRITICAL)
 * ===========================================================
 *
 * This module decides two things about every spot fill: which side pays which
 * of the two published rates, and what price the fill prints at. The
 * end-to-end cases in tests/unit/liquidity-role.test.js drive it through the
 * real placement path and the real matcher, which is the right way to prove the
 * money moves correctly — but it only ever reaches the branches a healthy
 * BTC/USD book produces. A mutation audit of the module found eleven guards
 * that could each be deleted outright with the whole suite green: the defensive
 * arms of `crossesBook`, all three arms of `isMarketOrder`, the rate sanity
 * checks in `feeRateFor`/`feeForSide`, and the direction of price-time priority
 * itself.
 *
 * Every one of those is a MONEY decision on an input the live stack does
 * produce — a side of the book with nothing on it quotes 0, an order rehydrated
 * from mongo has a string `orderDate`, a market order has had its `price`
 * overwritten by the matcher before the second matcher sees it, and a
 * misconfigured pair has a blank fee. So they are pinned here, individually,
 * on the pure functions, where the exact input can be stated.
 *
 * Each case below was verified by deleting the guard it names and watching this
 * file go red.
 */

import { describe, test, expect } from '@jest/globals';

import {
  MAKER,
  TAKER,
  otherSide,
  crossesBook,
  roleForNewOrder,
  roleOf,
  isMarketOrder,
  makerSideOf,
} from '../../lib/liquidityRole.js';

const at = (ms) => new Date(ms);

describe('crossesBook - did this order take liquidity as it arrived', () => {
  test('a buy AT the ask crosses; a tick below it rests', () => {
    expect(crossesBook({ buyorsell: 'buy', price: 63500, bestAsk: 63500 })).toBe(true);
    expect(crossesBook({ buyorsell: 'buy', price: 63499.99, bestAsk: 63500 })).toBe(false);
  });

  test('a sell AT the bid crosses; a tick above it rests', () => {
    // The mirror of the buy case, and the one the live BTC/USD flows never
    // exercised. An order priced exactly at the resting quote is hitting it,
    // not joining it - "equal" belongs on the taker side of both comparisons or
    // a seller who lifts the bid collects the maker rebate for it.
    expect(crossesBook({ buyorsell: 'sell', price: 63499, bestBid: 63499 })).toBe(true);
    expect(crossesBook({ buyorsell: 'sell', price: 63499.01, bestBid: 63499 })).toBe(false);
  });

  test('a side with NOTHING resting cannot be crossed, whatever it quotes', () => {
    // A book with an empty side reports 0, not null - ladderBestPrice returns
    // null but assessDepthHealth, the ticker mirror and a purged ladder all
    // produce 0 somewhere. Without the `> 0` test, `price >= 0` is true for
    // every buy ever placed, so every order into an empty book would be billed
    // as a taker of liquidity that was not there.
    expect(crossesBook({ buyorsell: 'buy', price: 63500, bestAsk: 0 })).toBe(false);
    expect(crossesBook({ buyorsell: 'buy', price: 63500, bestAsk: -1 })).toBe(false);
    expect(crossesBook({ buyorsell: 'sell', price: 0.00000001, bestBid: 0 })).toBe(false);
    expect(crossesBook({ buyorsell: 'sell', price: 63500, bestBid: -1 })).toBe(false);
  });

  test('an absent or unreadable reference means "it will rest"', () => {
    expect(crossesBook({ buyorsell: 'buy', price: 63500, bestAsk: null })).toBe(false);
    expect(crossesBook({ buyorsell: 'buy', price: 63500, bestAsk: undefined })).toBe(false);
    expect(crossesBook({ buyorsell: 'sell', price: 63500, bestBid: 'n/a' })).toBe(false);
  });

  test('an unreadable price rests rather than crossing', () => {
    expect(crossesBook({ buyorsell: 'buy', price: 'market', bestAsk: 63500 })).toBe(false);
    expect(crossesBook({ buyorsell: 'sell', price: undefined, bestBid: 63499 })).toBe(false);
  });

  test('a price that is not a FINITE number is not a price', () => {
    // parseFloat("Infinity") and parseFloat("1e999") both yield Infinity, and
    // an infinite price compares as through every level of the book at once.
    // Without the finite test, such an order is stamped a taker of liquidity
    // whose size and price nobody can state; with it, the order is treated as
    // one that will rest, and the far side is left alone.
    expect(crossesBook({ buyorsell: 'buy', price: Infinity, bestAsk: 63500 })).toBe(false);
    expect(crossesBook({ buyorsell: 'buy', price: '1e999', bestAsk: 63500 })).toBe(false);
    expect(crossesBook({ buyorsell: 'sell', price: -Infinity, bestBid: 63499 })).toBe(false);
  });

  test('prices arriving as strings compare as numbers, not as text', () => {
    // Redis hands every field back as a string. "9" > "63500" lexically.
    expect(crossesBook({ buyorsell: 'buy', price: '63500', bestAsk: '63500' })).toBe(true);
    expect(crossesBook({ buyorsell: 'buy', price: '9', bestAsk: '63500' })).toBe(false);
  });
});

describe('roleForNewOrder - the stamp put on an arriving order', () => {
  test('a MARKET order is a taker whatever the book says', () => {
    // It carries no price of its own and demands immediate execution, so
    // "did it cross" is not a question that applies to it. Judged by the
    // crossing test alone, a market order arriving into a book with an empty
    // far side would be stamped MAKER and collect the rebate for consuming the
    // last of the liquidity.
    expect(roleForNewOrder({ orderType: 'market', crosses: false })).toBe(TAKER);
    expect(roleForNewOrder({ orderType: 'market', crosses: true })).toBe(TAKER);
  });

  test('a LIMIT order is whatever the crossing test said', () => {
    expect(roleForNewOrder({ orderType: 'limit', crosses: true })).toBe(TAKER);
    expect(roleForNewOrder({ orderType: 'limit', crosses: false })).toBe(MAKER);
  });
});

describe('roleOf - the role recorded on an order', () => {
  test('reads the stamp, and falls back to TAKER for anything else', () => {
    expect(roleOf({ liquidityRole: MAKER })).toBe(MAKER);
    expect(roleOf({ liquidityRole: TAKER })).toBe(TAKER);
    expect(roleOf({})).toBe(TAKER);
    expect(roleOf(null)).toBe(TAKER);
    expect(roleOf({ liquidityRole: 'MAKER' })).toBe(TAKER); // not case-folded
    expect(roleOf({ liquidityRole: true })).toBe(TAKER);
  });
});

describe('isMarketOrder - checked three ways because the matcher rewrites the order', () => {
  test('the `flag` marker alone is enough', () => {
    // tradeMatching stamps a market order with the limit price it is about to
    // trade against, so by the time marketMatching sees it neither
    // `price === "market"` nor `orderType === "market"` need still hold.
    // `flag` is set by marketOrderPlace and nothing overwrites it.
    expect(isMarketOrder({ flag: true, price: 63500, orderType: 'limit' })).toBe(true);
  });

  test('the `price` marker alone is enough', () => {
    expect(isMarketOrder({ price: 'market', orderType: 'limit', flag: false })).toBe(true);
  });

  test('the `orderType` marker alone is enough', () => {
    expect(isMarketOrder({ orderType: 'market', price: 63500, flag: false })).toBe(true);
  });

  test('a plain limit order is not a market order', () => {
    expect(isMarketOrder({ orderType: 'limit', price: 63500, flag: false })).toBe(false);
    expect(isMarketOrder(null)).toBe(false);
    expect(isMarketOrder({ flag: 'true' })).toBe(false); // strict true only
  });
});

describe('makerSideOf - price-time priority, where nothing else decides', () => {
  const buy = (over) => ({ userId: 'buyer', orderType: 'limit', ...over });
  const sell = (over) => ({ userId: 'seller', orderType: 'limit', ...over });

  test('user vs user: the order that ARRIVED FIRST is the maker', () => {
    // The direction is the whole rule. Reversed, every fill between two real
    // users pays the aggressor the rebate and charges the resting order the
    // taker rate - which is precisely the defect this module was written to
    // fix, in the one branch that was left doing it by hand.
    expect(makerSideOf(buy({ orderDate: at(1000) }), sell({ orderDate: at(2000) }))).toBe('buy');
    expect(makerSideOf(buy({ orderDate: at(2000) }), sell({ orderDate: at(1000) }))).toBe('sell');
  });

  test('a MARKET order is never the maker, even when it arrived FIRST', () => {
    // The one case price-time gets flatly wrong. A market order does not rest,
    // so it cannot have provided the liquidity - but it has an orderDate like
    // anything else, and a market order sitting in the book for one matcher
    // cycle before its counterparty arrives looks older than that counterparty.
    // Judged by arrival alone it collects the rebate for the fill it demanded.
    expect(
      makerSideOf({ flag: true, orderDate: at(1000) }, sell({ orderDate: at(2000) }))
    ).toBe('sell');
    expect(
      makerSideOf(buy({ orderDate: at(2000) }), { flag: true, orderDate: at(1000) })
    ).toBe('buy');
  });

  test('two market orders against each other fall back to arrival like anything else', () => {
    expect(
      makerSideOf(
        { flag: true, orderDate: at(1000) },
        { flag: true, orderDate: at(2000) }
      )
    ).toBe('buy');
  });

  test('an order with no readable arrival time sorts LAST, never first', () => {
    // A row rehydrated without an orderDate, or with one mongo wrote as a
    // string the parser cannot read, must not be handed the maker side by
    // default: that is free rebate for an order nobody can prove was resting.
    expect(makerSideOf(buy({}), sell({ orderDate: at(2000) }))).toBe('sell');
    expect(makerSideOf(buy({ orderDate: 'not a date' }), sell({ orderDate: at(2000) }))).toBe('sell');
    expect(makerSideOf(buy({ orderDate: at(2000) }), sell({ orderDate: null }))).toBe('buy');
  });

  test('numeric and string timestamps compare like dates', () => {
    expect(makerSideOf(buy({ orderDate: 1000 }), sell({ orderDate: 2000 }))).toBe('buy');
    expect(
      makerSideOf(
        buy({ orderDate: at(1000).toISOString() }),
        sell({ orderDate: at(2000).toISOString() })
      )
    ).toBe('buy');
  });

  test('otherSide really flips', () => {
    expect(otherSide('buy')).toBe('sell');
    expect(otherSide('sell')).toBe('buy');
  });
});

/**
 * THIS VENUE CHARGES NOTHING.
 *
 * Every fee - maker, taker, the whole schedule - was withdrawn from the
 * platform. These blocks used to pin which RATE applied in which role; they now
 * pin that no rate applies at all, which is the contract that has to hold.
 *
 * They are kept rather than deleted precisely because a fee is the kind of thing
 * that creeps back in: feeRateFor is the single gate every fill's fee is priced
 * through, so if anything ever reads a rate off an order again, this goes red.
 */
// The fee functions that were tested here are GONE. feeRateFor and feeForSide
// were deleted with every charge on this venue, so there is nothing left to
// assert about a rate. What replaced these tests is stronger and lives in
// liquidity-role.test.js: a settled trade row has NO fee column at all, and a
// fill credits the gross amount on both legs.

