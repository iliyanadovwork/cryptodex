# Frontend

The trading client: Next.js (pages router), TypeScript, Redux, socket.io, and
TradingView's Advanced Charts. Serves on **3000**. Start the whole stack with
`../start-all.sh`; the project README at the repository root explains the venue
as a whole.

## Running it

    cp local.env.example local.env          # required: npm run dev reads it
    cp .env.local.example .env.local        # this is the file that configures it
    npm install
    npm run dev                             # http://localhost:3000

**Two env files, one of which does nothing.** `npm run dev` is
`env-cmd -f local.env next dev`, so `local.env` must exist or the command exits
before Next starts. But every key in it is spelled with a double underscore
(`NEXT_PUBLIC__USER_API`) while `config/index.js` reads single underscores
(`NEXT_PUBLIC_USER_API`). The file that reaches the application is `.env.local`,
which Next loads by itself. `config/index.js` carries correct localhost
fallbacks, so the app works without `.env.local` — copy it anyway; relying on
fallbacks is how a page once ended up pointed at a port nothing binds and
rendered blank forever with no error.

## The pages that matter

| Route | What it is |
|---|---|
| `/spot/[pair]` | the trading screen: chart, order book, tape, order form, open orders |
| `/wallet` | balances |
| `/faucet` | claim demo funds (this was `/deposit`, which is why that path redirects) |
| `/reset` | reset the demo account (this was `/withdraw`) |
| `/history` | order and trade history |
| `/login`, `/register`, `/security` | account |

`/2fa`, `/kyc` and `/log-session` are **307 redirects**, not pages. Those paths
were in the navigation for the life of the product, so they land on the nearest
surviving screen (`/security`) rather than 404.

## Charts

`public/charting_library/` and `public/static/charting_library/` are the
TradingView Advanced Charts distribution and are committed. The `advanced-charts/`
directory at the repository root is a leftover git link to a separate checkout
of the same library; the application does not read it.

## Tests

    npm test          # jest + testing-library, ~914 tests
    npm run test:e2e  # playwright (chromium is in this package's node_modules)

Foreground, one suite at a time (`--runInBand --ci`).
