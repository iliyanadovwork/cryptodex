# Cryptodex, a spot-only paper-trading exchange

Cryptodex is a working cryptocurrency exchange in which **no money is real**. It
quotes live Binance prices, matches orders through a real matching engine, and
settles them against real balances, and every one of those balances is a number
in a database. No order leaves the machine, no blockchain is touched, nobody can
deposit or withdraw anything. You register, you are given 1,000 virtual USD and
1,000 virtual USD, and you trade.

It is a single-author university project. It has been cut down and corrected
until what is left is the part that can be honestly operated and honestly
described.

One market, quoting USD: **BTCUSD**.

---

## The idea worth reading first: where the fills come from

A paper exchange has an obvious problem. You put in a buy order, who sells to
you? A simulator usually answers by faking the whole thing: it takes the last
price off an API and pretends you filled at it. That teaches you nothing about
an order book, and it cannot be wrong in any interesting way.

Cryptodex answers it differently, and this is the design:

1. **Live depth in.** `spotapi/lib/binanceWebSocket.js` holds an open websocket
   to Binance's public L2 depth stream for each pair. Real bids, real asks, real
   sizes, updating continuously.

2. **Depth becomes a resting book.** `spotapi/controllers/paperBook.controller.js`
   mirrors that depth into **real limit orders owned by a house account**
   (`adminbot@bot.com`), written into the very same Redis hashes that hold user
   orders, `buyOpenOrders_<pairId>`, `sellOpenOrders_<pairId>`, and flagged
   `isPaper: true`. Twelve price levels a side, grouped so each clears a minimum
   notional.

3. **The ordinary matcher does the rest.** The engine that matches user orders
   against each other has no special case for paper orders. A market buy walks
   the ask ladder and consumes it level by level; a limit order rests until the
   book comes to it; partial fills are partial fills; the balance debits and
   credits are the same code path either way.

So the liquidity is synthetic but the **market microstructure is not**. A large
market order gets a worse average price than a small one because it eats through
levels. An order placed away from the touch waits. When the depth feed dies, the
ladder is torn down and the venue refuses market orders instead of inventing a
price.

The ladder is rebuilt synchronously at the top of every matcher tick (a 2-second
cron), so the liquidity being matched against is under a millisecond old by
construction. Two consequences are worth knowing before you read the code:

- **The house account is a single point of failure.** It lives in Redis at
  `cryptodex_admin_liquidity`, field `liquidation`. If it is missing, no ladder is
  built and every user order rests forever. `ops/reset-and-seed.mjs` creates it;
  nothing in the product does.
- **The book is briefly empty every two seconds**, in the millisecond between
  deleting the old ladder and writing the new one. The display can absorb that;
  the order path deliberately does not re-read Redis for that reason.
  (`SYSTEM_GUIDE.md` §4 and §6.)

---

## Architecture

Four processes, one Mongo, one Redis. Nothing else runs.

```
                    ┌──────────────────────────┐
   browser  ───────▶│  Frontend  (Next.js)     │  :3000
                    └───┬───────────┬──────────┘
                        │ HTTP      │ socket.io
        ┌───────────────▼──┐   ┌────▼──────────────┐   ┌──────────────────┐
        │  User API        │   │  Spot API         │   │  Wallet API      │
        │  :2567  gRPC 6001│   │  :2568  gRPC 6003 │   │  :3002 gRPC 6002 │
        │  accounts, auth, │   │  matcher, book,   │   │  balances, the   │
        │  e-mail, profile │   │  charts, faucet   │   │  ledger of record│
        └────────┬─────────┘   └─────┬──────┬──────┘   └────────┬─────────┘
                 │  gRPC             │      │  gRPC             │
                 └───────────────────┴──────┴───────────────────┘
                                     │
                         ┌───────────┴───────────┐          ┌──────────────┐
                         │ MongoDB :27017        │          │ Binance      │
                         │ cryptodex_user          │          │ public L2    │
                         │ cryptodex_spot          │◀─────────│ depth (ws)   │
                         │ cryptodex_wallet        │          └──────────────┘
                         └───────────────────────┘
                         ┌───────────────────────┐
                         │ Redis :6379           │  order books, balances,
                         │ prefix cryptodex_       │  pair cache, house account
                         └───────────────────────┘
```

| Service | Port | Directory | Owns |
|---|---|---|---|
| Frontend | 3000 | `cryptodex-frontend` | the trading client |
| User API | 2567 (gRPC 6001) | `cryptodex-userapi` | registration, login, sessions, e-mail |
| Spot API | 2568 (gRPC 6003) | `cryptodex-spotapi` | orders, matching, the paper ladder, market data, the faucet |
| Wallet API | 3002 (gRPC 6002) | `cryptodex-walletapi` | balances, wallets, the demo grant |

**Redis is the ledger of record for live trading.** Balances are mirrored into
Mongo, and a mirror failure is logged loudly but never fails the trade. All
balance mutation goes through one helper per service so the copies cannot drift
(`spotapi/controllers/paperLedger.js`). Do not hand-roll balance writes.

Each service has its own README with the detail. `SYSTEM_GUIDE.md` is the
operator's guide; read §1, §2 and §9 of it and you can run the venue.

---

## Running it

### Prerequisites

- **macOS or Linux.** `start-all.sh` uses `lsof` and `brew services`; on Linux
  start Mongo and Redis yourself first and it will use them.
- **Node 18.12+.** Developed and run on Node 24.
- **MongoDB 6/7** and **Redis 6/7**, both on their default ports.
- Nothing else. No Docker, no message broker, no cloud account, no API key.

### From a fresh clone

```bash
git clone <this repo> cryptodex && cd cryptodex

# 1. Environment files.
#
#    No .env file is in git. Each one has a `.example` beside it with the keys,
#    the comments and the loopback defaults intact and the credential values
#    blanked.
#
#    Copy the ones you need. Each service reads a DIFFERENT file depending on
#    which npm script you run:
#
#      npm start      -> local.env     (this is what start-all.sh uses)
#      npm run dev    -> dev.env
#      npm run prod   -> prod.env
#      npm run start:prod -> no file at all; pure process environment
#
#    For the documented workflow below you only need local.env:
for d in cryptodex-userapi \
         cryptodex-spotapi \
         cryptodex-walletapi; do
  cp "$d/local.env.example" "$d/local.env"
done

#    The FRONTEND needs BOTH of its files, for different reasons:
cd cryptodex-frontend
cp .env.local.example .env.local   # what Next actually reads (config/index.js)
cp local.env.example  local.env    # must merely EXIST: `npm run dev` is
                                   # `env-cmd -f local.env next dev`, and
                                   # env-cmd fails before Next starts if the
                                   # file is missing. Every key inside it is
                                   # spelled with a double underscore and
                                   # reaches nothing. Read the .env.local.example
                                   # header, it explains this trap in full.
cd ..

# 2. Secrets: for local development, nothing to set. The three backend
#    local.env.example files carry the SAME SECRET_KEY, which is what signs the
#    session JWT that all three verify. If you want your own, change it in all
#    three together, a mismatch logs you out of one service and not the others.
#
#    For a real deployment, fill in the blanked values: see
#    railway-api.env.example, which labels every variable REQUIRED / ADVISED /
#    OPTIONAL / DEAD.

# 3. Dependencies (a few minutes; the frontend is the slow one).
for d in cryptodex-* system-smoke-test; do
  (cd $d && npm install)
done

# 4. Build the venue: currencies, the pair, and the house liquidity
#    account without which nothing fills.
node ops/reset-and-seed.mjs

# 5. Start everything.
./start-all.sh

# 6. Prove it works.
cd system-smoke-test && npm test
```

`start-all.sh` starts Mongo and Redis if they are not up, waits for each to
actually answer rather than sleeping, launches the four services through a
rotating log sink, waits for each port to listen, and finishes by asserting that
the pair cache hydrated. `./stop-all.sh` stops the four services and leaves the
datastores running.

Logs: `/tmp/{user,spot,wallet}-api.log` and `/tmp/frontend.log`.

### Then

Open <http://localhost:3000>, register (the activation link is printed in
`/tmp/user-api.log`; no mail is sent in development), log in, and trade. A new
account arrives with 1,000 USD. `/faucet` tops it up once a day;
`/reset` puts it back to the starting balances.

### If something is wrong

```bash
cd system-smoke-test
node check-services.js     # asks each service's own health endpoint
npm test                   # registers an account and exercises the venue
curl -s localhost:2568/api/spot/health | python3 -m json.tool
```

The last one is the interesting one: spotapi's health check is not a ping. It
walks the live resting book exactly as a market order would and reports whether
an order **could fill right now**, then throws the result away without writing
anything. When it says `503`, the `verdict` field names the subsystem that
failed, `stale_depth`, `ladder_stale`, `no_admin_liquidity`,
`insufficient_liquidity`, `matcher_stalled`. It exists because spot once stopped
filling for five and a half hours while every process stayed up, the UI kept
rendering a book, and every test kept passing.

### Known rough edges in a first install

- **`npm install` in userapi can fail on `bcrypt`.** It is a native module and
  npm first tries to download a prebuilt binary; if that download is interrupted
  it falls back to compiling, which needs a working Xcode command-line
  toolchain and Python. **Re-running `npm install` fixed it here.**
- **`package-lock.json` is gitignored**, so every clone re-resolves semver
  ranges and two clones are not guaranteed to be identical. That is a real
  reproducibility weakness; it is called out rather than hidden.
- **`advanced-charts/` clones as an empty directory.** It is a git link to a
  separate checkout with no `.gitmodules` to resolve it. Nothing needs it, the
  TradingView library the app actually loads is committed under the frontend's
  `public/`.

---

## Configuration and secrets

Configuration lives in per-service `local.env` files. None of them is committed.
Each service ships `local.env.example`, `dev.env.example` and `prod.env.example`
with every port, URL and database name filled in and every credential blank; on a
paper venue almost no credential is needed, and the templates say which are dead
outright. `SYSTEM_GUIDE.md` §10 states the same thing.

`cryptoSecretKey`, the AES key that order payloads are encrypted with between
browser and server, now comes from `CRYPTO_SECRET_KEY` like every other
credential. Be clear about what it is worth: the browser must hold it to encrypt at all, so it is
obfuscation rather than protection, and anything that depends on it being
secret is already broken. It is configuration because secrets do not belong in
source, not because this one guards very much.

---

## Tests

| Suite | Where | Count |
|---|---|---|
| Spot API | `cryptodex-spotapi` | 1076 |
| Frontend | `cryptodex-frontend` | 996 |
| Wallet API | `cryptodex-walletapi` | 605 |
| User API | `cryptodex-userapi` | 549 |
| System smoke test | `system-smoke-test` | 17 checks against a running stack |

`npm test` in each. Run jest in the foreground, one suite at a time
(`--runInBand --ci`), parallel workers against this repo have a habit of
outliving the run.

The smoke test is the useful one for a reader: it registers a brand-new account
through the real endpoints, verifies it, logs in, reads its balances back out of
a *different* service with the token the first one minted, and exercises the
pair list, order book, tape, market price and chart against a pair id it
resolved from the venue rather than one it assumed. On a healthy stack it is
17/17 and exits 0.

---

## Repository map

Every tracked entry at the repository root, with nothing omitted:

```
README.md                    this file
SYSTEM_GUIDE.md              the operator's guide, how it works, how to verify it
package.json                 root manifest: name, version and the four convenience
                             scripts. Declares NO dependencies, each service
                             installs its own. (It previously declared three, @solana/web3.js, ethereumjs-wallet, ethers, that
                             nothing in the repository imported.)
.gitignore                   excludes *.env, package-lock.json and all key material
ops/                         reset-and-seed, log rotation, one-off analysis tools
system-smoke-test/           the end-to-end check described above
start-all.sh / stop-all.sh   the stack
advanced-charts/             a git link with no .gitmodules; clones empty and
                             nothing needs it (see "Known rough edges")
cryptodex-*/
                             the four services, one directory each, see the
                             table under "Architecture" above
```

## What this venue deliberately does not have

Custody of any kind, no deposits, no withdrawals, no addresses, no hot wallet.
KYC, two-factor authentication, the login IP blocklist, the anti-phishing code,
the P2P market, support tickets, the CMS. Each was removed rather than left
half-wired, and `SYSTEM_GUIDE.md` §12 says what went and why.

What is left is a spot exchange that fills orders against live market depth with
money that does not exist, and can be read end to end.
