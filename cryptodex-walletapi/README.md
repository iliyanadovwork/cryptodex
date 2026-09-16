# Wallet API

The balance ledger. HTTP on **3002**, gRPC on **6002**. Start the whole stack
with `../start-all.sh`; the project README at the repository root explains the
venue as a whole.

## What it owns

- **Wallet creation at registration.** `controllers/createAsset.js` builds a new
  user's assets and seeds the demo grant: **1,000 USDC and 1,000 USD**
  (`DEMO_SEED_COINS` / `DEMO_SEED_AMOUNT`). That is the only money a paper
  account starts with.
- **The balance surface** the frontend reads — `/api/wallet/getAssetsDetails`
  and friends — and the currency list.
- **The gRPC server on 6002**, which is how userapi and spotapi read and move
  balances. This is its main interface; HTTP is the smaller half.

## No custody

Nothing here touches a blockchain. There is no deposit address, no withdrawal,
no hot wallet, no Fireblocks integration — all of it was removed when the venue
became paper-only. The `FIREBLOCK_*` and `TRX_WALLET_ID` entries still present
in the env files are dead; leave them blank.

## Health

    GET http://localhost:3002/api/health

Unauthenticated. Beyond Mongo and Redis it reports two things a port check
cannot see and that matter more than either:

- `grpc.bound` — an express process whose **gRPC socket never bound** serves
  every HTTP route perfectly while the rest of the venue gets `14 UNAVAILABLE`.
- `standDownGuard.ready` — the guard fails closed, so when it cannot read its
  state the service refuses every value-moving route with 503 while the port
  stays wide open and reads keep answering 200.

## Configuration

`local.env` — copy it from `local.env.example`. `SECRET_KEY` must match the
other services.

Known wart, left as the owner's call: the checked-in `local.env` has a missing
newline that glues `ENV=development` to the assignment after it, so `ENV` picks
up the whole rest of the line and the following key is never set. Both are dead
values, which is why nothing broke.

## Tests

    npm test        # jest, ~621 tests

Foreground, one suite at a time (`--runInBand --ci`).
