# 04 — Flow: registration, wallet provisioning, activation, login (evidence)

Companion to [`04-flow-registration.mmd`](04-flow-registration.mmd). How an account comes into
existence, gets its virtual money, and gets a session.

---

## Hops in order

| # | Hop | Source `file:line` |
|---|---|---|
| 1 | `/register` renders `EmailForm` — the phone/SMS variant is commented out | [pages/register.tsx:6](../../cryptodex-frontend/pages/register.tsx#L6), [Register/Form.tsx:20](../../cryptodex-frontend/components/Register/Form.tsx#L20) |
| 1 | `apiSignUp` → `POST auth/register` on `${USER_API}/api` | [AuthService.js:13](../../cryptodex-frontend/services/User/AuthService.js#L13), [User/BaseService.js:19](../../cryptodex-frontend/services/User/BaseService.js#L19) |
| 2 | Gateway prefix `/api/auth` → userapi | [routes.mjs:66](../../deploy/routes.mjs#L66) |
| 3 | `registerValidate` — email regex, password regex, **two conflicting length checks** | [user.validation.js:34](../../cryptodex-userapi/validation/user.validation.js#L34) |
| 4 | `createNewUser` | [auth.controller.js:155](../../cryptodex-userapi/controllers/auth.controller.js#L154) |
| 5 | Email lowercased, `User.findOne({email})` | [auth.controller.js:181](../../cryptodex-userapi/controllers/auth.controller.js#L180) |
| 6–8 | Duplicate handling — see [The 24-hour reuse window](#the-24-hour-reuse-window) | [auth.controller.js:192](../../cryptodex-userapi/controllers/auth.controller.js#L191) |
| 9–10 | `password` **virtual** → `makeSalt()` + pbkdf2 | [User.js:372](../../cryptodex-userapi/models/User.js#L382), [:414](../../cryptodex-userapi/models/User.js#L424) |
| 11 | `newUser.save()`; `userId` and `refferalCode` both from `IncCntObjId(_id)` | [auth.controller.js:217-226](../../cryptodex-userapi/controllers/auth.controller.js#L216-L225) |
| 12 | `defaultUserSetting` — **not awaited, errors swallowed** | [auth.controller.js:626](../../cryptodex-userapi/controllers/auth.controller.js#L407) |
| 13–14 | `newAsset(...)` over gRPC — **not awaited** | [auth.controller.js:253](../../cryptodex-userapi/controllers/auth.controller.js#L252) |
| 15 | walletapi's handler **does not await `emptyAsset`** either | [walletapi/grpc/server.js:57](../../cryptodex-walletapi/grpc/server.js#L57) |
| 16–17 | Wallet created with `_id = user._id`; demo assets pushed | [createAsset.js:46](../../cryptodex-walletapi/controllers/createAsset.js#L46), [:143](../../cryptodex-walletapi/controllers/createAsset.js#L143) |
| 18–19 | `hset walletbalance_spot <userId>_<currencyId> 1000`, then `updateUserWallet` **HSETNX** hydration | [createAsset.js:170](../../cryptodex-walletapi/controllers/createAsset.js#L170), [wallet.js:123](../../cryptodex-walletapi/controllers/wallet.js#L123) |
| 20–21 | `mailTemplateLang("activate_register_user")` — **not awaited** | [auth.controller.js:267](../../cryptodex-userapi/controllers/auth.controller.js#L266) |
| 21 | Link is `${config.FRONT_URL}/verification/register?auth=${encryptToken}` | [auth.controller.js:247](../../cryptodex-userapi/controllers/auth.controller.js#L246) |
| 22–23 | `POST /api/auth/confirm-mail` → `confirmMail` matches `mailToken` | [auth.route.js:35](../../cryptodex-userapi/routes/auth.route.js#L35) |
| 25–26 | `userLogin` → `authenticate()` re-derives pbkdf2, **plain `===` compare** | [User.js:393](../../cryptodex-userapi/models/User.js#L403) |
| 27–28 | OTP branch, or the `TEST_MODE` bypass | [auth.controller.js:933](../../cryptodex-userapi/controllers/auth.controller.js#L714) |
| 29–30 | JWT signed; Redis `userToken` row written with `tokenId` | [passport.js:22](../../cryptodex-spotapi/config/passport.js#L22) |

## The 24-hour reuse window

A non-obvious piece of product logic ([auth.controller.js:192-214](../../cryptodex-userapi/controllers/auth.controller.js#L191-L213)):

- Existing **verified** account → `400 Email already exists`.
- Existing **unverified** account **older than 24 h** (`HOURS_BEFORE_DELETE`) → the stale user *and*
  its `UserSetting` are deleted, and registration proceeds.
- Existing **unverified** account **younger than 24 h** → `400 "An unverified account exists. Please
  wait N hour(s)"`.

This stops an abandoned unverified signup from permanently squatting an address, without letting an
attacker delete someone's pending registration on demand.

## Wallet provisioning is fire-and-forget on both sides

This is the flow's most significant structural property, and it is **doubly** unawaited:

1. userapi calls `newAsset(...)` **without `await`** ([auth.controller.js:253](../../cryptodex-userapi/controllers/auth.controller.js#L252)).
2. walletapi's handler is `newAsset: (_, callback) => { emptyAsset(_.request); callback(null, {status:true}); }`
   — it returns `status: true` **before the wallet exists** and regardless of success
   ([walletapi/grpc/server.js:57](../../cryptodex-walletapi/grpc/server.js#L57)).

So registration returns 200 with **no guarantee a wallet was created**. There is no retry, no
reconciliation job, and no compensating action. In practice the user's first balance read would find
nothing — though `updateUserWallet` hydration on first touch during order placement provides a partial
safety net ([spot.controller.js:1784](../../cryptodex-spotapi/controllers/spot.controller.js#L1784)).

The gRPC stub also **drops the `botUser: false` field** the caller passes — it is not part of the proto
message ([userapi/grpc/walletService.js:26](../../cryptodex-userapi/grpc/walletService.js#L26)).

## Credentials

**PBKDF2, not bcrypt** — despite `bcrypt` and `bcryptjs` both being dependencies. `encryptPassword` is
`crypto.pbkdf2Sync(password, Buffer(salt,'base64'), 100000, 128, "sha512")` with a 16-byte random salt
([User.js:414](../../cryptodex-userapi/models/User.js#L424)). `lib/bcrypt.js` exists but is imported by nothing on this path
([lib/bcrypt.js:4](../../cryptodex-userapi/lib/bcrypt.js#L4)).

Login compares with a plain `===` string comparison — **not timing-safe** ([User.js:393](../../cryptodex-userapi/models/User.js#L403)).

The activation token is `CryptoJS.AES.encrypt(user._id, config.cryptoSecretKey)` with `+ / =`
URL-safed; `cryptoSecretKey` is a hardcoded constant with **no env override**
([lib/cryptoJS.js:58](../../cryptodex-userapi/lib/cryptoJS.js#L58), [config/index.js:51](../../cryptodex-userapi/config/index.js#L51)).

## Session semantics

**Sessions are revoked through Redis, not JWT expiry.** The login writes a `userToken` row carrying a
`tokenId`; every authenticated request in **all three services** re-reads that row and rejects on a
missing row, `userLocked != "false"`, or a `tokenId` mismatch ([passport.js:22](../../cryptodex-spotapi/config/passport.js#L22)).

Therefore **a re-login immediately invalidates the previous token** — one live session per account.
The same mechanism drives the socket's `ROOMREJECTED` `session_revoked`.

The browser then stores the token in **four** places (localStorage `authToken`, `userToken` cookie,
`loggedin` marker cookie, redux-persist blob) ([EmailForm.tsx:179](../../cryptodex-frontend/components/Login/EmailForm.tsx#L179)).

---

## Unverified

1. Whether `RESEND_API_KEY` is set in production. If empty, `sendEmail` refuses before the request and
   **registration completes with no activation email and no user-visible error**
   ([emailGateway.js:36-43](../../cryptodex-userapi/lib/emailGateway.js#L36-L43)).
2. Whether the activation token is single-use or time-bounded — `mailToken` is compared but expiry was
   not traced.
3. The `cleanupUnactivatedAccounts` cron cadence.
4. Whether any deployed environment sets `TEST_MODE=true`.

## Open questions

1. **Should registration await wallet creation?** Today a gRPC failure is invisible to the user and
   leaves an account with no wallet, with no reconciliation path.
2. **Two conflicting password length rules** — the regex demands `{6,18}` and a separate check demands
   8–18 ([user.validation.js:34](../../cryptodex-userapi/validation/user.validation.js#L34)). The stricter wins, but the regex is misleading.
3. **`TEST_MODE` skips OTP with no production veto**, unlike `test-verify` which has one
   ([auth.controller.js:933](../../cryptodex-userapi/controllers/auth.controller.js#L714) vs [:1729](../../cryptodex-userapi/controllers/auth.controller.js#L1510)).
4. **`user.email` has `required: true` commented out** ([User.js:94-98](../../cryptodex-userapi/models/User.js#L94-L98)) — the unique index still
   applies, so at most one document can have no email.
5. **Password comparison is not timing-safe** ([User.js:393](../../cryptodex-userapi/models/User.js#L403)); there is also no login rate
   limiting anywhere.
6. **`defaultUserSetting` is unawaited and swallows errors** ([auth.controller.js:626](../../cryptodex-userapi/controllers/auth.controller.js#L407)) — an
   account can exist without settings.
