# Making the ledger the source of truth

**Status:** implemented. Every write to a spendable balance goes through the
ledger; `tests/unit/ledger-coverage.test.js` fails the build if one stops.
**Problem:** Redis holds the live balances and nothing can rebuild them. A crash
between RDB snapshots loses up to an hour of writes, and there is no record from
which the correct balance could be recovered.

---

## What is wrong today

A balance lives in Redis and is moved by `HINCRBYFLOAT`, usually inside a Lua
script so the check and the debit cannot interleave. Separately, most of those
call sites also write a **passbook** row to MongoDB recording
`beforeBalance / afterBalance / amount / type / category`.

That passbook is *almost* an event log. Three things stop it being one.

### 1. It is incomplete

Six functions move a balance and write no row at all:

| Function | File |
|---|---|
| `claimFaucet` | `controllers/faucet.controller.js` |
| `adjustSpotBalance` | `controllers/paperLedger.js` |
| `releaseInOrder` | `controllers/spot.controller.js` |
| `sweepResidualInOrder` | `controllers/spot.controller.js` |
| `settlementCredit` | `controllers/spot.controller.js` |
| `assetUpdate` | `controllers/spot.controller.js` |

Some are helpers whose callers log, but "the caller usually logs" is not a
property you can rebuild a balance from.

### 2. The row is not written atomically with the move

The balance moves in Redis. The row is written to MongoDB, afterwards, in a
separate call — and in several places without awaiting it. Anything that ends
the request in between (a throw, a restart, a swallowed error) leaves a balance
that moved and no record that it did.

**A log with holes cannot be a source of truth**, because you cannot tell a hole
from a balance that was always that value.

### 3. It records a derived number, not an event

`afterBalance` is what the balance *became*, computed by the writer. If two
writers disagree, the log inherits the disagreement rather than settling it.

---

## The design

**The ledger entry is written by the same Lua script that moves the balance.**

Redis executes a script atomically, so appending to a stream inside that script
makes the entry and the movement one indivisible operation. There is no window
in which one exists without the other.

```
                    ┌──────────────────────────────────────┐
   order  ───────►  │  ONE Lua script, atomic:             │
                    │    1. check the balance covers it    │
                    │    2. HINCRBYFLOAT the balance       │
                    │    3. XADD the ledger entry          │
                    └──────────────────────────────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                              ▼
          balance (a projection)          ledger stream (the truth)
          rebuildable from the log        append-only, ordered, durable
                                                   │
                                                   ▼
                                          flushed to MongoDB
                                          for query and archive
```

### Why a Redis stream rather than a list

`XADD` gives a monotonic id per entry, so the log is **ordered and addressable**.
A rebuild can say "replay from id X", and the flusher can record how far it has
copied without needing a separate cursor.

### What each store is for, afterwards

| Store | Role |
|---|---|
| Redis stream `ledger_<userId>_<currencyId>` | **the source of truth.** Append-only. Never rewritten. |
| Redis hash `walletbalance_spot` | a **projection** of the stream. Fast to read, rebuildable, disposable. |
| MongoDB `passbook` | an **archive** of the stream, for querying and reporting. Not on the hot path. |

The balance stops being the truth and becomes a cache of the truth — which is
the arrangement that was inverted before.

### Durability

`appendonly yes` with `appendfsync everysec`. The stream is then durable to
within one second, and the balance does not need to be durable at all because it
can be recomputed.

---

## What this buys

1. **A lost Redis balance is recoverable.** Replay the stream.
2. **A balance can be audited.** `balance == replay(ledger)` is checkable, and a
   reconciler can assert it continuously.
3. **The hot path does not get slower.** The `XADD` happens inside a script that
   was already running; there is no extra round trip and no database write.
4. **The passbook stops being load-bearing.** It becomes a read model, so a
   failed Mongo write is an archiving problem rather than a lost record.

## What it does not buy

- **It is not multi-node consensus.** One Redis, one AOF. A real exchange
  replicates the log. This makes the log exist and be durable; it does not make
  it distributed.
- **It does not fix float arithmetic.** Balances are still IEEE-754 doubles
  moved by `HINCRBYFLOAT`. The ledger records the same numbers.

---

## Stages

- [x] **1. Atomic ledger write.** A Lua script that moves a balance and appends
      the entry in one step, plus a helper every mutation site calls.
- [x] **2. Close the gaps.** All 20 direct writes routed, across
      `spot.controller.js` and `binance.controller.js`.
      Two helpers, because a bare `hincbyfloat` and a checked reservation are
      not the same operation: `moveBalanceLogged` (refuses rather than
      overdrawing) and `moveBalanceSigned` (unconditional signed apply, the
      faithful drop-in). The budget table is now empty and the ratchet holds it
      there.
- [x] **3. Rebuild.** `replayBalance` starts from the oldest surviving entry's
      `before`, not from zero, so a pre-ledger opening balance or a MAXLEN-trimmed
      stream does not replay short. `rebuildBalance` **refuses by default** while
      coverage is incomplete: a stream holding a credit whose debit was never
      logged would otherwise restore an account too high, which is minting done
      by the recovery mechanism. `replayBalance(userId, currencyId)` derives a balance from
      the stream.
- [x] **4. Reconcile.** Advisory while coverage is partial. A source-scanning
      ratchet fails if any file gains a direct write, or keeps a budget it no
      longer needs. A check that the live balance equals the replay, with a
      test that breaks if a mutation path skips the ledger.
- [x] **6. Durability, reported AND configured.** `ops/redis.conf` turns
      `appendonly` on for local development, because `CONFIG SET` does not
      survive a restart and a restart is the event this is for. Start with
      `redis-server ops/redis.conf`. On a managed redis this is an addon
      setting; the service reports the answer either way rather than assuming
      it. Redis is provisioned externally, so
      `appendonly` is an operator setting this service cannot change. It can
      refuse to pretend: `ledgerDurability()` reads the running config, the boot
      path warns once if AOF is off, and `/api/health` carries the answer.
      REPORTED, NEVER GATED - a deploy that went red over a setting it cannot
      change would block every release without fixing anything.
- [ ] **5. Flush to Mongo.** Copy stream entries to the passbook collection in
      the background, tracking the last-copied id. NOT DONE, and not on the
      critical path: the stream is already the durable record, and the passbook
      still receives its rows the way it always did. This would make the passbook
      a projection OF the stream rather than a parallel write.

---

## What is true now

- Every spendable-balance write appends its entry in the same atomic step.
- A balance can be destroyed and recomputed exactly. Verified end to end.
- `reconcile` is an assertion rather than advice, because there is no longer a
  sanctioned way to move a balance without logging it.
- The replay starts from the oldest surviving entry's `before`, so a pre-ledger
  opening balance or a trimmed stream does not replay short.
- Redis persistence is outside this service's control, so it is reported rather
  than assumed: `ledgerDurability()`, a boot warning, and a `ledger` block on
  `/api/health`. `ops/redis.conf` sets it for local development.
- `maxmemory-policy noeviction` matters more than it looks: a ledger that
  evicts entries under memory pressure is not a ledger. Refusing writes is the
  correct failure.
