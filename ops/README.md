# Ops notes

Operational tooling for the Cryptodex stack. Application code lives in the
per-service directories and is **not** touched by anything in here.

## Log rotation

### The problem

Service logs were written with `nohup npm start > /tmp/<svc>.log` and nothing
ever rotated them. Measured growth on a steady-state stack:

| service       | growth      | dominant content                          |
|---------------|-------------|-------------------------------------------|
| spot-api      | ~9.0 MB/hr  | `[Socket] Emitting orderBook` (~85%)      |
| others        | <0.1 MB/hr  | —                                         |

That was ~220 MB/day from spot-api alone, unbounded. Observed size before the
fix: `spot-api.log` 106 MB.

> Rotation covers the four services `start-all.sh` launches: spot-api, user-api,
> wallet-api and the frontend.

### The fix: `ops/logcap.pl`

`start-all.sh` now pipes each service through `ops/logcap.pl`:

```
npm start 2>&1 | ops/logcap.pl --rotate-on-start /tmp/spot-api.log 25165824 2
```

`logcap.pl` appends stdin to the log, and when it exceeds the cap it rotates
`<log>` -> `<log>.1` -> `<log>.2`, deleting anything past the last generation.
Disk use is bounded at `LOG_MAX_BYTES * (LOG_KEEP + 1)` per service — with the
defaults, **72 MiB per service**, ~8 hours of retained spot-api history.

Tuning (environment variables read by `start-all.sh`):

| var                    | default            | meaning                          |
|------------------------|--------------------|----------------------------------|
| `LOG_MAX_BYTES`        | `25165824` (24 MiB)| rotate when the log exceeds this |
| `LOG_KEEP`             | `2`                | rotated generations to retain    |
| `CRYPTODEX_LOG_ROTATE`   | `1`                | set `0` for plain redirects      |

```bash
LOG_MAX_BYTES=$((64*1024*1024)) LOG_KEEP=4 ./start-all.sh   # keep more history
CRYPTODEX_LOG_ROTATE=0 ./start-all.sh                          # old behaviour
```

### Why a pipe and not `truncate`/`mv`

`> /tmp/x.log` opens the file **without** `O_APPEND`, so the node process keeps
its own file offset. Neither of the obvious shell fixes works:

- `: > /tmp/x.log` (truncate in place) does not reset the writer's offset. The
  file becomes sparse and immediately reports its old huge size again.
- `mv x.log x.log.1` leaves the writer attached to the old inode, so the new
  log stays empty forever.

Having a sink process on the other end of a pipe own the file is the only way
to rotate correctly without editing service code. Verified: `lsof /tmp/spot-api.log`
shows only `perl` holding the write fd; the node process holds zero fds on it.

`logcap.pl` exits on EOF, so it never outlives the service it logs for.

### Pre-existing logs

Logs from before the fix were archived to `/tmp/cryptodex-log-archive/` and
gzipped (149 MB -> 5.6 MB). They are not needed by anything and can be deleted.

## Fixes to `start-all.sh` / `stop-all.sh`

1. **`kill_port` killed the user's browser.** Both scripts used
   `lsof -ti:$PORT | xargs kill -9`. A bare `lsof -ti:PORT` matches *client*
   sockets connected to that port as well as the listener — at the time this was
   found, four Google Chrome helper processes with tabs open on the exchange were
   in that list and would have been `kill -9`'d. Both scripts now filter on
   `-sTCP:LISTEN`.

2. **`stop-all.sh` never cleaned up nodemon.** Its `pkill -f` patterns matched
   no directory that existed on disk, so the nodemon supervisors survived every
   `stop-all.sh`. Patterns now match the real directory names (frontend, user,
   spot, wallet) and are anchored to `node|npm|sh` so they cannot match an
   editor or an unrelated shell.

3. **Redis could silently boot empty.** Redis persists to `dump.rdb` relative to
   its *working directory*, and the user's dataset lives at the repo root.
   `start-all.sh` started Redis without `cd`-ing anywhere, so running the script
   from another directory would boot an empty Redis and look like total data
   loss. It now `cd`s to `$PROJECT_DIR`, passes `--dir` explicitly, and asserts
   `redis-cli config get dir` matches after startup.

4. **MongoDB fallback pointed at a non-existent path.** The fallback used
   `--dbpath $PROJECT_DIR/mongodb-data/`; the real directories are
   `mongodb-data-27017` / `mongodb-data-27000`. (Normal operation uses
   `brew services`, dbPath `/opt/homebrew/var/mongodb`, so this only bit on the
   fallback path.)

5. **Boot ordering race.** APIs were launched immediately after a `sleep 2` for
   Mongo and `sleep 1` for Redis, then the frontend after a blind `sleep 8`.
   The services connect to Mongo and hydrate Redis caches at startup, so a slow
   datastore meant a silently half-initialised stack. `start-all.sh` now blocks
   on a real `mongosh ping` and `redis-cli ping` (aborting rather than booting a
   broken stack) and polls each port for readiness instead of sleeping.

6. **The frontend was started with the wrong command.** The refactor's shared
   launcher defaults to `npm start`, but the frontend's `start` script is
   `next start` (serves a production build, no HMR). It is explicitly launched
   with `npm run dev`.

`start-all.sh` also now prints the boot time and asserts pair-cache hydration at
the end of startup: `cryptodex_spotPairdata >= 1` (the venue lists one market,
BTC/USD).

## Reset and seed: `ops/reset-and-seed.mjs`

A one-command bring-up. Rebuilds a spot-only paper-trading venue from an empty
Mongo and an empty Redis, in Mongo **and** Redis, idempotently.

```bash
node ops/reset-and-seed.mjs --help
node ops/reset-and-seed.mjs                              # seed / repair, never destroys
node ops/reset-and-seed.mjs --verify                     # read-only audit, exit 1 on gaps
node ops/reset-and-seed.mjs --reset --confirm cryptodex    # wipe, then rebuild
```

### Why it exists

The reset itself was the easy half. Nothing could rebuild the venue afterwards,
and one missing Redis field would have bricked it silently.

**`admin_liquidity/liquidation` is the single point of failure.**
`spotapi/controllers/paperBook.controller.js` reads
`hget("admin_liquidity","liquidation")` before it builds a ladder. If the field
is absent it logs `orders cannot fill`, calls `dropLadder(pairId,
"no_admin_liquidity")` and returns — the book is empty and **every user order
rests forever**. That entry was created by hand in January and has survived only
because Redis has never been flushed. Nothing in the product recreates it:

- `userapi/controllers/user.controller.js` at line 1588 contains an IIFE
  that reloads it from Mongo on boot — written `(async function () { … });`
  **with no trailing `()`**. It is defined and never invoked, so it has never
  run. That is a latent bug, reported not fixed.
- `botUser()` in `userapi/controllers/auth.controller.js` *does*
  `hset("admin_liquidity","liquidation", …)` — but **nothing calls it any
  more**. Its only HTTP route, `POST /api/admin/add-bot-user`, was deleted along
  with the rest of that router; `grep -rn botUser routes/` returns nothing. It is
  still exported over gRPC (`userapi/grpc/server.js:81`), but nothing in the tree
  dials that method, so it is not an alternative bring-up path.

So `reset-and-seed.mjs` is the only thing in the tree that can put that field
back.

### What it produces

| Target | Contents |
|---|---|
| `<p>_wallet.currency` | BTC, **USD** (2) |
| `<p>_wallet.priceconversion` | 2 rows — every ordered pair of the 2 |
| `<p>_wallet.wallet` | wallet for the liquidity bot (2 assets - BTC, USD - zero balances) |
| `<p>_spot.spotpair` | BTC/USD, `botstatus: binance` |
| `<p>_spot.sequenceId` | `orderHistory` order-code counter |
| `<p>_user.user` | the liquidity bot `adminbot@bot.com`, role `admin_bot` |
| `<p>_user.usersetting` | defaults for the bot |
| `<p>_user.sitesetting` | the single row every frontend page fetches |
| `<p>_user.emailtemplate` | the 5 templates, incl. `activate_register_user` |
| Redis `admin_liquidity` | **`liquidation` — without this nothing fills** |
| Redis `spotPairdata` | warm start; `spotapi` rebuilds it on boot |
| Redis `currecny` | warm start; `walletapi` rebuilds it at module load |
| Redis `priceCnv` | 2 conversions at 0; the walletapi cron prices them |

Ordinary user wallets are deliberately **not** seeded — `walletapi/controllers/
createAsset.js` builds them at registration, including the demo USD grant
(1,000).

**Four things this table used to list are no longer seeded**, because the
surfaces that read them were deleted: `admin` (a privileged login with nothing
left to log into), `supportcategory` (the support-ticket subject dropdown),
`faq`/`faqcategory` (`pages/faq.tsx` is gone) and `cms` (the frontend never read
it — and `/terms` and `/privacy-policy` are themselves deleted, redirecting to
`/`, so nothing is left that a CMS row could feed). A seed
that rebuilds a deleted surface is how a scope reduction quietly un-does itself.
`--verify` does not look for any of them either, so a venue without them is a
correct venue, not an incomplete one.

The `--admin-email`, `--admin-name` and `--admin-password` flags went with the
`admin` document. They had survived its removal and did nothing: the parser
accepted them, and no account was ever created. They are now rejected as
unknown options, which is the honest answer.

### The currency collection is singular, and the plural one is residue

`cryptodex_wallet.currency` — the collection both `walletapi/models/currency.js`
and `spotapi/models/currency.js` bind to by **explicit** third argument — holds
the five rows. The same is true of `cryptodex_spot.spotpair`: **singular**.

Older checkouts also carried `cryptodex_wallet.currencies`,
`cryptodex_spot.currencies` and `cryptodex_spot.spotpairs` — pluralised twins that
**nothing in the product reads**, left behind by scripts that let Mongoose
pluralise a model name. They were inert, and they were exactly the sort of thing
that sends someone debugging in the wrong direction. The databases have since
been rebuilt and none of the three is present today (`db.getCollectionNames()`
in `cryptodex_wallet` and `cryptodex_spot` will show you). If you ever see a plural
twin reappear, a script bound a model without its explicit collection name.

Two currencies is the floor, not a preference. `USD` is the quote of the pair and
spot `orderPlace` reads the buy-side balance at `walletbalance_spot
<userId>_<pair.secondCurrencyId>` — no USD row, nobody can buy. `BTC` is the only
base. A third, `USDC`, was the paper-trading spec currency and was seeded and
minted alongside USD; it had no market of its own on a venue that lists BTC/USD
alone, so it could not be traded, converted or spent, and it is deleted —
currency, balances, its four `priceconversion` directions, and the flat `assets`
collection that existed only to hold it.

### Do NOT run `userapi/scripts/seed-pairs.js` on this venue

It `deleteMany({})`s currencies and spot pairs and replaces them with 20 coins
and 22 **USDT**-quoted pairs. This venue quotes in USD. Running it destroys the
venue and takes every `walletbalance_spot <userId>_<currencyId>` key with it,
because the currency `_id`s all change. `reset-and-seed.mjs` supersedes it, and
also supersedes `walletapi/createSpotPairs.js` (USDT pairs) and
`userapi/scripts/seed-email-templates.js` (hardcodes the live database URI, so
it cannot be pointed anywhere else). `createSuperAdmin.js` is no longer in the
tree either.

### The `_id`s are pinned, on purpose

Currency ids, pair ids and the bot's user id are the values the live venue
already uses. Redis keys are built from them — `buy_depth_binance_<pairId>`,
`buyOpenOrders_<pairId>`, `walletbalance_spot <userId>_<currencyId>` — so
minting fresh ids would strand every one of them under a dead id. Pinning makes
the reset reproducible: run it twice, on two machines, and you get the same
venue.

### Safety

- The only destructive path is `--reset`, and it is opt-in twice: `--reset`
  **and** `--confirm <db-prefix>` typed out. A mismatch aborts with exit 2.
- `--verify` never writes, so it is safe to point at production.
- Everything is parameterised (`--db-prefix`, `--redis-prefix`, `--redis-db`),
  which is how it was rehearsed end to end against scratch databases without
  touching live data:

  ```bash
  node ops/reset-and-seed.mjs --reset --confirm resettest \
       --db-prefix resettest --redis-prefix resettest_ --redis-db 9
  ```

### After running it

Start the stack. `spotapi` loads the pairs into Redis on boot
(`controllers/loadPairs.js`) and opens the Binance depth feed; the paper ladder
is built from that depth, so the first fills need the feed to be up. Then
register a user — registration seeds its own wallet.
