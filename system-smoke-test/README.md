# Cryptodex — system smoke test tooling

## What this directory is

Four operator scripts and one unit-test file that answer "is the venue up, and is
it well". They all read **one** service table, `services.js`; nothing here keeps
its own copy of the ports.

| Script | Command | What it does |
|---|---|---|
| `check-services.js` | `npm run test:services` | Asks every service its own health endpoint. Exits non-zero if any is down or degraded. |
| `diagnose.js` | `node diagnose.js` | Per-route detail: which routes answer on which port. |
| `smoke-test.js` | `npm test` | Drives the user journey over HTTP: register → login → wallet → spot trading → market data. |
| `start-services.js` / `stop-services.js` | `npm run start:services` / `stop:services` | Start/stop by the table. |
| `check-services.test.js` | `npm run test:unit` (`node --test`) | Guards the health parser and the table itself. No test framework — `node --test` ships with node. |

## The service layout

Four processes, and that is the whole venue:

| Service | HTTP | gRPC | Probe |
|---|---|---|---|
| Frontend (Next) | 3000 | — | liveness `GET /` — no health route exists to ask |
| User API | 2567 | 6001 | health `GET /api/health` |
| Spot API | 2568 | 6003 | health `GET /api/spot/health` |
| Wallet API | 3002 | 6002 | health `GET /api/health` |

Mongo is on 27017 and redis on 6379 (keys are prefixed `cryptodex_`).

## What this file used to say, and why that mattered

This README was a dated status report ("January 2, 2026") that listed User API on
3001, Spot API on 3002 and Wallet API on 3003 — every port wrong — together with
a table of test results from that one run, and step-by-step instructions to
start three services that have since been **deleted from the repository**.
Anyone following it would have been told the stack was 25% healthy and sent to
`cd` into directories that no longer exist.

The scripts had the same fault and it has been fixed in the same way: the three
deleted services are gone from the repository, so they are off the table. While
they were still on it, `check-services.js` printed

```
✗ Deleted service (port 3005) - connect ECONNREFUSED 127.0.0.1:3005
✗ Deleted service (port 3006) - connect ECONNREFUSED 127.0.0.1:3006
✗ Deleted service (port 3008) - connect ECONNREFUSED 127.0.0.1:3008
3/7 services running
```

and exited 1 against a completely healthy venue. A checker that cries wolf is
worse than no checker, because the operator learns to ignore it.

**So this file no longer records the result of any particular run.** Run the
tooling; it will tell you the truth about the stack in front of you. The one
thing worth writing down is the layout, and there is a test
(`guard: the ports have not drifted back`, `guard: no deleted service is left on
the table`) that fails if the table and this description come apart.

## Reading the output

- **health vs liveness** — a health probe reads the service's own JSON verdict;
  a liveness probe only proves that a route *this* service mounts answers on
  that port. Liveness is used for the frontend alone, and every line that
  rests on it says "liveness only".
- **`status` is the state, `verdict` is the reason.** A service reporting
  `status: "healthy", verdict: "…"` is up; the verdict is printed as the
  explanation, never used as the state word.
- **degraded is not stopped.** A service that answers 503 with a reason is
  listed separately from one that is not listening, because the remedy is
  different.
