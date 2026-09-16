# User API

Accounts, sessions and e-mail for the Cryptodex paper-trading venue. HTTP on
**2567**, gRPC on **6001**. Start the whole stack with `../start-all.sh`; the
project README at the repository root explains the venue as a whole.

## What it owns

- **Registration and activation.** `POST /api/auth/register` creates the
  account; `POST /api/auth/test-verify` activates it without e-mail when
  `TEST_MODE=true`. Registration calls walletapi over gRPC, which is what
  creates the wallet and the demo grant.
- **Login and sessions.** `POST /api/auth/login` returns a JWT that **already
  carries the `Bearer ` prefix** — pass `Authorization: <token>` verbatim, do
  not prepend it again. The token embeds a `tokenId` and only the newest one is
  accepted, so logging in again invalidates the previous session.
- **Password reset, change password, profile, notification preferences.**
- **The site settings row** every frontend page fetches on load.
- **E-mail.** `lib/mailDelivery.js` in front of Resend. In development it is in
  log-only mode: nothing is sent and the activation link is printed to the
  service log.

## What it does NOT own

Balances and orders. It holds no money. Wallets live in walletapi, orders and
fills in spotapi.

## Health

    GET http://localhost:2567/api/health

Unauthenticated. `200` with `{"status":"ok","service":"userapi",...}` when Mongo
and Redis are connected, `503` otherwise. The payload also reports the mail
provider and whether delivery is log-only.

## Configuration

`local.env` — copy it from `local.env.example` and read the comments there.
`SECRET_KEY` must be byte-identical across userapi, spotapi, walletapi and the
frontend, because it signs the session JWT that all four verify.

## Tests

    npm test        # jest, ~527 tests

Run one suite at a time and in the foreground (`--runInBand --ci`) — parallel
jest workers against this repo have a history of being left behind as zombies.
