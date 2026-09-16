# Spot API

The matching engine, the market data, and the paper liquidity that makes both
of them mean something. HTTP on **2568**, gRPC on **6003**. Start the whole
stack with `../start-all.sh`; the project README at the repository root explains
the venue as a whole.

## The part worth understanding: where fills come from

This venue has one market — BTCUSD — and, most of the time,
one real trader. Nobody is on the other side of your order. So:

1. `lib/binanceWebSocket.js` streams **live Binance L2 depth** into memory.
2. `controllers/paperBook.controller.js` mirrors that depth as **resting limit
   orders owned by a house account** (`adminbot@bot.com`), written into the same
   `buyOpenOrders_<pairId>` / `sellOpenOrders_<pairId>` Redis hashes as real user
   orders and flagged `isPaper: true`. Twelve price levels a side.
3. The **ordinary matcher** then runs, with no special case for paper orders. A
   market buy walks the real ask ladder; a limit order fills when the book
   reaches it.

So the prices are real and the mechanism is real; only the counterparty is
synthetic. The ladder is rewritten synchronously at the top of every matcher
tick (2s cron), which is also how the health endpoint knows the matcher is
still turning.

**The house account lives in Redis at `cryptodex_admin_liquidity`, field
`liquidation`. Delete it and nothing fills, on any pair.** Nothing in the
product recreates it; `ops/reset-and-seed.mjs` does.

## Order placement

Order bodies are AES-encrypted into a single `token` field. `lib/cryptoJS.js`
has the helper; the key is in `config/index.js` (`cryptoSecretKey`), in the
repository, not a secret — it is obfuscation, not protection.

`POST /api/spot/orderPlace` is gated before any balance moves: market orders
need a fully fillable book of sufficient size, limit orders are refused only for
terminal pair-level faults, and cancel is never gated. The reasoning is in
`SYSTEM_GUIDE.md` §6.

## Health — this one is a liquidity check, not a ping

    GET http://localhost:2568/api/spot/health      # also aliased at /api/health

Unauthenticated. It walks the live resting book exactly as a market order would
and reports whether a probe **would fill right now**, writing nothing. `200` and
`verdict: "ok"` when it would; `503` and a verdict naming the subsystem
(`stale_depth`, `ladder_stale`, `no_admin_liquidity`, `insufficient_liquidity`,
`matcher_stalled`, …) when it would not. It exists because spot once stopped
filling for five and a half hours while every process stayed up and every test
stayed green.

## Configuration

`local.env` — copy it from `local.env.example`. The Binance depth feed uses the
**public** websocket; the `BINANCE_API_KEY` entries are dead and can stay blank.

## Tests

    npm test        # jest, ~1043 tests

Foreground, one suite at a time (`--runInBand --ci`).
