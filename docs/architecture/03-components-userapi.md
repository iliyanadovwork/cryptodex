# 03 — Components: userapi (evidence)

Companion to [`03-components-userapi.mmd`](03-components-userapi.mmd). The identity service: registration,
activation, login, password reset, profile, notifications, and the site-branding read.

---

## Entry points

| Element | What it is | Source `file:line` | Notes |
|---|---|---|---|
| `routes/auth.route.js` | register, login, forgotPassword, resetPassword, confirm-mail, resend-otp/mail, test-verify | [auth.route.js:19](../../cryptodex-userapi/routes/auth.route.js#L19) | **all unauthenticated** |
| `routes/user.route.js` | profile, settings, changePassword, notifications, emailChange, deactivation | [user.route.js:63](../../cryptodex-userapi/routes/user.route.js#L63) | guard applied **per endpoint** |
| `routes/language.route.js` | `GET /api/language` | [language.route.js:9](../../cryptodex-userapi/routes/language.route.js#L9) | unauthenticated |
| `routes/health.route.js` | `GET /api/health` | [health.route.js:14](../../cryptodex-userapi/routes/health.route.js#L14) | **the only router not also mounted under `/app`** |
| `grpc/server.js` | 3 services / 12 methods | [grpc/server.js:53-117](../../cryptodex-userapi/grpc/server.js#L53-L117) | started *inside* the listen callback |
| `config/socketIO.js` | a second socket.io server | [socketIO.js:10](../../cryptodex-userapi/config/socketIO.js#L10) | **no client anywhere connects to it** |
| `cleanupUnactivatedAccounts` | cron, started after listen | [server.js:74](../../cryptodex-userapi/server.js#L74) | |

All four routers are `express()` sub-apps, not `express.Router()` ([auth.route.js:10](../../cryptodex-userapi/routes/auth.route.js#L10)).

## Guards

| Guard | What it does | Source |
|---|---|---|
| `lib/responseGuard.js` | 60s per-request timer → forces `500` if nothing replied. Registered **before** body parsing so it covers parse failures | [responseGuard.js:20](../../cryptodex-userapi/lib/responseGuard.js#L20), [server.js:32](../../cryptodex-userapi/server.js#L32) |
| `config/passport.js` | single `usersAuth` JWT strategy; re-reads the Redis session row | [passport.js:22](../../cryptodex-userapi/config/passport.js#L22) |
| `validation/` | per-route validators, applied before the controller | [auth.route.js:19](../../cryptodex-userapi/routes/auth.route.js#L19) |

**`responseGuard` is unusual and worth an interview mention.** It does not abort the underlying work —
it just guarantees the client gets *an* answer. It exists because handlers were found that could
return without ever calling `res.*`; `ops/response-sweep.cjs` is the static sweep for that same defect
class ([response-sweep.cjs:2](../../ops/response-sweep.cjs#L2)).

### Auth gaps worth noting

- **`PATCH /api/user/emailChange` has no `passportAuth`** — it authenticates by the emailed token
  alone ([user.route.js:108](../../cryptodex-userapi/routes/user.route.js#L108)). Deliberate for a click-through link, but it means the endpoint is
  reachable unauthenticated.
- **`GET /api/user/siteSetting` is public** — the branding read the frontend makes before login
  ([user.route.js:119](../../cryptodex-userapi/routes/user.route.js#L119)).
- **No rate limiting** anywhere: no limiter is registered and no rate-limit package is declared
  ([server.js:77](../../cryptodex-userapi/server.js#L77)). `/login`, `/register` and `/forgotPassword` are unthrottled.
- **No 404 handler and no error middleware** in all 77 lines of `server.js` ([server.js:77](../../cryptodex-userapi/server.js#L77)).
- **CORS is `origin: '*'`** ([server.js:26](../../cryptodex-userapi/server.js#L26)).

## Domain

| Element | Responsibility | Source |
|---|---|---|
| `auth.controller.js` (1563 lines) | register, activate, login + email login code, reset, resend, the test backdoor, gRPC reads | [auth.controller.js:155](../../cryptodex-userapi/controllers/auth.controller.js#L154) |
| `user.controller.js` (~1700 lines) | profile, settings, email change, OTP, **deactivation fan-out to walletapi + spotapi** | [user.controller.js:65](../../cryptodex-userapi/controllers/user.controller.js#L65) |
| `notification.controller.js` | creates notifications, pushes unread counts over socket.io | [notification.controller.js:14](../../cryptodex-userapi/controllers/notification.controller.js#L14) |
| `emailTemplate.controller.js` | renders a stored `EmailTemplate` with `##TOKEN##` substitution | [emailTemplate.controller.js:51](../../cryptodex-userapi/controllers/emailTemplate.controller.js#L51) |
| `siteSetting.controller.js` | two reads only — HTTP public + gRPC | [siteSetting.controller.js:45](../../cryptodex-userapi/controllers/siteSetting.controller.js#L45) |
| `adminProfit.controller.js` | writes one fee row per trade — **called only over gRPC by spotapi** | [adminProfit.controller.js:16](../../cryptodex-userapi/controllers/adminProfit.controller.js#L16) |

**Account deactivation is the one genuine cross-service saga** in this service: `user.controller.js`
calls walletapi `deactivateWallet` *and* spotapi `cancelOrderForDeactiveAcc` over gRPC
([user.controller.js:1487](../../cryptodex-userapi/controllers/user.controller.js#L1487)) *(verified)*. There is no compensating transaction — see
[Open questions](#open-questions).

## Mail

Two modules, deliberately split into **policy** and **transport**:

| Element | Responsibility | Source |
|---|---|---|
| `lib/mailDelivery.js` | `mailDeliveryMode()` — **`production` is a hard veto that forces real delivery**; log-only requires an explicit opt-in | [mailDelivery.js:75](../../cryptodex-userapi/lib/mailDelivery.js#L75) |
| `lib/emailGateway.js` | raw `fetch` POST to `https://api.resend.com/emails`. **No retry, deliberately** | [emailGateway.js:45](../../cryptodex-userapi/lib/emailGateway.js#L45) |

An empty `RESEND_API_KEY` makes `sendEmail` refuse *before* the request and return
`{delivered:false, error:'not_configured'}` — registration then completes with **no activation email
and no user-visible error** ([emailGateway.js:36-43](../../cryptodex-userapi/lib/emailGateway.js#L36-L43)).

## Data access

| Element | What | Source |
|---|---|---|
| `controllers/redis.controller.js` | single client at module scope; node-redis v3 promisified; every key prefixed | [redis.controller.js:6](../../cryptodex-userapi/controllers/redis.controller.js#L6) |
| Redis `userToken` hash | **the live session row** — `tokenId`, `userLocked` | [passport.js:22](../../cryptodex-userapi/config/passport.js#L22) |
| `models/` | `User`, `UserSetting`, `EmailTemplate`, `SiteSetting`, `Language`, `Notification` | see [05-data](05-data.md) |

**Session revocation is Redis-backed, not JWT-expiry-backed.** Every authenticated request in *all
three* services re-reads `userToken` and compares `tokenId`, so a re-login invalidates the previous
token immediately ([passport.js:22](../../cryptodex-userapi/config/passport.js#L22)). This is the mechanism behind `ROOMREJECTED`
`session_revoked` on the socket too.

> Password hashing has **two** mechanisms: `lib/bcrypt.js` exists, but the main login password uses
> the `User` model's own **pbkdf2** virtual ([lib/bcrypt.js:4](../../cryptodex-userapi/lib/bcrypt.js#L4)). `ops/reset-and-seed.mjs`
> reproduces the pbkdf2 shape byte for byte to satisfy the pre-save hook ([reset-and-seed.mjs:223](../../ops/reset-and-seed.mjs#L223)).

## Dead surface

`sentVerifLink`, `assetPassword` and `updateCryptodexFee` are fully implemented and routed nowhere
([user.controller.js:862](../../cryptodex-userapi/controllers/user.controller.js#L862)). Referral capture is disabled — `couponCode.generate()` is
commented out and an inbound `refferalCode` is ignored
([auth.controller.js:168](../../cryptodex-userapi/controllers/auth.controller.js#L167)).

`createNewUserApp` / `userLoginApp` (wallet-address auth, role `app-user`) used to sit here as the
largest dead surface in the service. Both are now **deleted**, along with the `app-user` role itself:
it was minted only by those two controllers, so no live session could ever carry it, and all three
services' JWT and socket gates now accept `user` alone. `role` on the `User` document is a plain
default of `"user"` and is never read to build a token.

The **second socket.io server** emits `unreadnotification`, `passwordVerify` and `registerVerify` into
a void — the frontend opens exactly one socket, and it points at spotapi
([socketConnectivity.js:36](../../cryptodex-frontend/config/socketConnectivity.js#L36)).

---

## Unverified

1. Whether `RESEND_API_KEY` is populated in production — decides whether registration emails actually
   send ([emailGateway.js:36](../../cryptodex-userapi/lib/emailGateway.js#L36)).
2. Whether `TEST_MODE` leaks into any deployed environment. The `test-verify` backdoor has a hard
   `NODE_ENV==='production'` veto, but the **OTP bypass at [auth.controller.js:933](../../cryptodex-userapi/controllers/auth.controller.js#L714) does not**
   — it checks only `TEST_MODE`.
3. The exact cadence of `cleanupUnactivatedAccounts` — confirmed started, its schedule not read.

## Open questions

1. **Account deactivation has no compensating action.** If `deactivateWallet` succeeds and
   `cancelOrderForDeactiveAcc` fails (5s deadline, no retry), the wallet is frozen while orders stay
   resting ([user.controller.js:1487](../../cryptodex-userapi/controllers/user.controller.js#L1487)). Acceptable, or should it be ordered/retried?
2. **`PATCH /emailChange` is unauthenticated by design** ([user.route.js:108](../../cryptodex-userapi/routes/user.route.js#L108)) — is the emailed
   token single-use and time-bounded?
3. **No throttling on `/login`, `/register`, `/forgotPassword`.** The venue has no captcha either
   (every server-side call site is commented out). Intended for a demo venue?
4. **The `TEST_MODE` OTP bypass lacks the production veto** that `test-verify` has. Worth making
   symmetric?
5. **`AdminProfit` rows are still written per trade** even though fees are hard-zero and nothing in the
   product reads them back ([adminProfit.controller.js:16](../../cryptodex-userapi/controllers/adminProfit.controller.js#L16)). Keep warm, or retire?
