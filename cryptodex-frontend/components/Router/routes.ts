/**
 * WHICH ROUTES THE EDGE MIDDLEWARE GUARDS.
 * ========================================
 *
 * These lists are consumed by `middleware.ts`, which compares them against
 * `request.nextUrl.pathname` - the RESOLVED path the browser asked for
 * (`/deposit`, `/reset-password/9f2c…`), never Next's file-system route
 * pattern. Two entries here were written in the pattern spelling:
 *
 *     '/deposit/[id]'          '/withdraw/[id]'          '/reset-password/[token]'
 *
 * and a literal `[id]` never appears in a pathname, so those three matched
 * NOTHING. Worse, the two `[…]` protected entries were the only mention of the
 * deposit and withdraw screens at all: `pages/deposit.tsx` and
 * `pages/withdraw.tsx` are flat routes, `/deposit` and `/withdraw`, and they
 * were reachable signed out - rendering the whole wallet UI around a wallet the
 * API answers 401 for. Empty balances, dead buttons, no explanation.
 *
 * `matchesRoute` in middleware.ts now matches an entry exactly OR as a leading
 * PATH SEGMENT (`/deposit` covers `/deposit/anything`), so an entry is written
 * once as the real URL and keeps covering the route if it later grows a
 * parameter.
 */

/**
 * Pages that only make sense to a signed-OUT visitor; a signed-in one is sent
 * to the home page.
 *
 * `/reset-password` covers `/reset-password/<token>` by segment, which is the
 * only form that route is ever requested in - the old `'/reset-password/[token]'`
 * could not match it.
 */
export const authRoutes: string[] = [
    // "/login",
    "/register",
    "/forget",
    "/reset-password"
]

/**
 * Pages that require a session. A signed-out request is bounced to /login
 * before the page is ever rendered, rather than rendering it around a series of
 * 401s.
 */
export const protectedRoutes: string[] = [
    // Account deactivation. Every request it makes carries the session
    // (user/deactive-req and user/deactive-confirm are both behind
    // passportAuth and act only on `req.user.id`), so signed out the form can
    // do nothing at all.
    '/deactive',
    // The demo faucet. `/deposit` used to be listed here and is not a page any
    // more - next.config.js redirects it to /faucet - so the entry guarded
    // nothing while the page it moved to was open to anyone.
    '/faucet',
    // The user's own trade and demo-credit history. Every panel on it is a
    // per-account read.
    '/history',
    // The demo-account reset. Same story as /faucet: the old '/withdraw' entry
    // outlived the page, which is now /reset.
    '/reset',
    // P2P routes removed - no P2P pages exist on this paper-trading build
    '/security',
    // '/support-ticket' guarded a page that no longer exists - the support
    // desk went with user/support and user/getSupportCategory. Guarding a
    // route with no page just bounces a 404 through /login first.
    '/wallet',
]

/**
 * WHY /deposit AND /withdraw ARE NO LONGER IN THAT LIST.
 *
 * They were the last two entries naming a page this app does not have. Both
 * were renamed during the paper conversion - /deposit became /faucet and
 * /withdraw became /reset, because neither ever moved money and the old names
 * said they did - and next.config.js redirects the old URLs. What was left
 * behind was the guard: the list still protected the two dead paths and named
 * neither of the live ones, so a signed-out visitor could open /faucet, /reset
 * or /history and watch the whole screen render around a series of 401s before
 * anything client-side noticed. That is the exact defect the `[id]` spellings
 * caused, one rename later.
 */

/**
 * Does `pathname` name one of `routes`?
 *
 * Exactly, or as a leading PATH SEGMENT: `/deposit` matches `/deposit` and
 * `/deposit/9f2c…`, and does NOT match `/deposits`. The middleware used to ask
 * `routes.includes(pathname)` - a whole-string equality against entries written
 * as Next's file-system patterns - which is how three of them came to guard
 * nothing.
 *
 * `/wallet/` is covered by the SEGMENT arm rather than by normalising the
 * trailing slash away: `"/wallet/".startsWith("/wallet/")` is already true. A
 * normalisation step here would be a line no input can change the answer of.
 */
export const matchesRoute = (routes: string[], pathname: string): boolean => {
    // A pathname that is not a string is not a route. Without this, `undefined`
    // reaches `.startsWith` and throws INSIDE the middleware - and a middleware
    // that throws lets the request through, which fails open on exactly the
    // pages this list exists to close.
    if (typeof pathname !== "string") return false
    return routes.some(
        (route) => pathname === route || pathname.startsWith(`${route}/`)
    )
}
