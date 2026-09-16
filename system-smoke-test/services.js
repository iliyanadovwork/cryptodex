/**
 * THE ONE PORT TABLE.
 * ===================
 *
 * Every script in this directory used to carry its OWN copy of the service
 * layout, and the copies had drifted apart and away from reality - pinning the
 * live ports to the wrong names, so the checker reported services as DOWN while
 * they were serving traffic and told the operator to start a stack that was
 * already up. Four independent copies is why: fixing one never fixed the others.
 *
 * The table lives here now and every script imports it, so the next port change
 * is one edit and cannot leave a stale copy behind. THE TABLE IS THE INVENTORY:
 * a service that leaves the stack comes off it in the same change, or the
 * checker starts contradicting reality in the direction an operator acts on.
 *
 * The live layout is now four processes and nothing else:
 *
 *   Frontend (Next)  3000
 *   User API         2567   (gRPC 6001)
 *   Spot API         2568   (gRPC 6003)
 *   Wallet API       3002   (gRPC 6002)
 *
 * `probe` is how a script asks "is the right service healthy on this port":
 *   kind 'health'   - a real health endpoint whose JSON verdict is the answer:
 *                       userapi    GET /api/health
 *                       spotapi    GET /api/spot/health
 *                       walletapi  GET /api/health
 *                     Three of the four. Whatever the service says about
 *                     itself is what gets reported, including "degraded".
 *   kind 'liveness' - no health route exists (only the Next frontend now), so
 *                     we GET a route that ONLY this service mounts. That is
 *                     weaker than health, and it is labelled as such wherever
 *                     it is reported - but unlike "did the socket accept", it
 *                     still proves the identity of the process on the port.
 */

export const SERVICES = [
  {
    name: 'Frontend',
    key: 'frontend',
    port: 3000,
    dir: 'cryptodex-frontend',
    probe: { kind: 'liveness', path: '/' },
  },
  {
    name: 'User API',
    key: 'userAPI',
    port: 2567,
    dir: 'cryptodex-userapi',
    probe: { kind: 'health', path: '/api/health', service: 'userapi' },
  },
  {
    name: 'Spot API',
    key: 'spotAPI',
    port: 2568,
    dir: 'cryptodex-spotapi',
    probe: { kind: 'health', path: '/api/spot/health', service: 'spotapi' },
  },
  {
    name: 'Wallet API',
    key: 'walletAPI',
    port: 3002,
    dir: 'cryptodex-walletapi',
    // WAS A LIVENESS PROBE OF /api/currency/getCurrency, WHICH COULD NOT SEE
    // THE FAILURE THAT MATTERS HERE. walletapi's main surface is not HTTP:
    // spotapi and userapi read and move every balance over its gRPC server on
    // 6002, and it refuses every value-moving route with 503 when it cannot
    // read the stand-down state. An express process whose gRPC socket never
    // bound serves getCurrency perfectly while the venue gets 14 UNAVAILABLE.
    // /api/health carries `grpc.bound` and `standDownGuard.ready`, so it is
    // asked directly - and check-services.js no longer needs its HEALTH_ROUTES
    // bridge to say so.
    probe: { kind: 'health', path: '/api/health', service: 'walletapi' },
  },
];

/** `{ userAPI: 'http://localhost:2567', ... }` for the axios-based smoke test. */
export const BASE_URLS = Object.fromEntries(
  SERVICES.map((s) => [s.key, `http://localhost:${s.port}`])
);

export const PORTS = SERVICES.map((s) => s.port);
