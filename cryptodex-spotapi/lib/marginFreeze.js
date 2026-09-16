/**
 * THE PER-USER MARGIN FREEZE - THE SPOT SERVICE'S HALF
 * ====================================================
 *
 * One redis key, `margin_freeze_<userId>` (this service's prefix is applied by
 * controllers/redis.controller.js, so `cryptodex_margin_freeze_<userId>`). While
 * it exists, THIS SERVICE WILL NOT CREATE A NEW SPOT RESERVATION for that user:
 * the key is checked with an `EXISTS` inside the single Lua step that takes
 * every reservation spot takes (`RESERVE_LUA` and the value-flight variant in
 * controllers/redis.controller.js).
 *
 * IT IS LOAD BEARING, AND IT IS LOAD BEARING FOR SPOT ALONE.
 * ----------------------------------------------------------
 * What it covers is the half that has always been about THIS service: the
 * faucet-reset race on the SPOT ledger. Deleting this freeze would reopen that
 * race.
 *
 * WHY THE RESET NEEDS IT
 * ----------------------
 * `resetFaucet` writes ABSOLUTE balances - it SETS the spot ledger to
 * FAUCET_AMOUNT and zeroes the other counters. A spot order placement racing
 * that write reserves against a balance the reset is about to overwrite, and
 * the account ends up holding the fresh grant AND an order funded out of the
 * old one. MEASURED on this stack: an account taken from 10,000 to 48,039.52
 * in four consecutive wins.
 *
 * WHAT THE FREEZE BUYS THAT A BETTER READ CANNOT
 * ----------------------------------------------
 * Reading the balance instead is only ever a snapshot: the reset can read a
 * number and a reservation can land a microsecond later, before the reset's own
 * writes. Only mutual exclusion removes that, and it has to exclude the
 * RESERVATION - one redis command, held under no lock by design - rather than
 * the request around it.
 *
 * So the order is: take the freeze, THEN read. After the freeze is visible no
 * reservation can be created, and any reservation that exists was created
 * before it. Redis serialises the two, and both orderings are safe:
 *
 *   reserve lands first -> the order is resting, the reset's own gate sees it
 *                          (it reads the resting books) and refuses
 *   freeze lands first  -> the reservation is refused with FROZEN and nothing
 *                          moved, because the freeze check and the increment
 *                          are ONE command
 *
 * FAILURE IS CLOSED HERE. `claimOnce` answers false when redis cannot be
 * reached, and the reset then refuses rather than running unprotected.
 */

/**
 * Long enough to cover a reset (which is a few dozen redis writes and two mongo
 * updates), short enough that a holder that dies cannot keep refusing the
 * user's orders for meaningfully longer than the reset itself would have. The
 * reset releases it in a `finally`; this is only the backstop.
 */
export const MARGIN_FREEZE_TTL_MS = 15000;

/** The one key name. It must be identical in every service that uses it. */
export const marginFreezeKey = (userId) => `margin_freeze_${userId?.toString()}`;

export default { MARGIN_FREEZE_TTL_MS, marginFreezeKey };
