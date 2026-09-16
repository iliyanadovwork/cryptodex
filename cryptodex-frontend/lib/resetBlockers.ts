/**
 * WHAT IS ACTUALLY BLOCKING THE RESET
 * ===================================
 *
 * SCOPE: the only thing that can block a reset on this venue is a resting spot
 * order. This module is deliberately NOT narrowed to that, because it reads
 * whatever the server sends rather than deciding in advance what a blocker can
 * be. If the server declines for something this build has no name for, the user
 * is told in the server's own words instead of being left pressing a button
 * that appears to do nothing.
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * The reset refusal is a 409 from spotapi carrying a prose `message` plus two
 * structured arrays, `positions` and `orders`. The page printed the prose and
 * nothing else, and the prose leads with the verb "Close":
 *
 *     "Close your 1 open order first, which would otherwise be left with
 *      nothing behind it (...)"
 *
 * A resting limit order is not closed, it is CANCELLED, and it is cancelled
 * from a different panel than the one that closes a position. The page's own
 * "About Reset" copy then explained the refusal purely in position terms, so a
 * user whose only blocker was a resting order was sent looking for a position
 * they did not have.
 *
 * THE RULE
 * --------
 * The instruction is derived from the STRUCTURED arrays, which say
 * unambiguously which of the two kinds of thing is in the way, rather than from
 * the sentence. Positions get "close", orders get "cancel", each is named with
 * its product and pair, and when both are present both are listed — because
 * clearing one of them still leaves the reset refused, and being told that
 * twice, one trip at a time, is its own small betrayal.
 *
 * When the server sends no arrays (the `unavailable` case, where it could not
 * reach the database at all) there is nothing to name, and its own sentence is
 * shown unchanged. Inventing a blocker would be worse than quoting one.
 */

export type BlockerKind = "position" | "order";

export interface ResetBlockerGroup {
  kind: BlockerKind;
  /** "Cancel your 2 resting orders" / "Close your 1 open position" */
  instruction: string;
  /** "Spot BTCUSD" — one per blocker, de-duplicated, named by the server. */
  items: string[];
}

export interface ResetRefusalView {
  /** The sentence to lead with. */
  headline: string;
  /** One group per kind of blocker, in the order the user should act. */
  groups: ResetBlockerGroup[];
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

/**
 * "Spot BTCUSD" for one blocker: the server's own product label and pair name.
 *
 * A row missing both fields contributes nothing rather than an empty bullet.
 */
const label = (item: any): string =>
  `${item?.productLabel || ""} ${item?.pairName || ""}`.trim();

const labelsOf = (items: any): string[] => {
  if (!Array.isArray(items)) return [];
  const seen: string[] = [];
  for (const item of items) {
    const text = label(item);
    if (text && !seen.includes(text)) seen.push(text);
  }
  return seen;
};

const countOf = (items: any): number =>
  Array.isArray(items) ? items.length : 0;

/**
 * Turn a reset refusal payload into an instruction that names the real blocker.
 *
 * `serverMessage` is the fallback, used verbatim when the payload names nothing
 * — never appended to a derived instruction, because the server's sentence says
 * "close" for orders too and repeating it would put the wrong verb back on the
 * page underneath the right one.
 */
export function describeResetRefusal(
  data: any,
  serverMessage: string
): ResetRefusalView {
  const positions = countOf(data?.positions);
  const orders = countOf(data?.orders);

  if (positions === 0 && orders === 0) {
    return { headline: serverMessage, groups: [] };
  }

  const groups: ResetBlockerGroup[] = [];

  // Orders first: cancelling a resting order is the cheaper action, and a user
  // who has both should not close a position only to find they are still stuck.
  if (orders > 0) {
    groups.push({
      kind: "order",
      instruction: `Cancel your ${orders} resting ${plural(
        orders,
        "order",
        "orders"
      )}`,
      items: labelsOf(data?.orders),
    });
  }
  if (positions > 0) {
    groups.push({
      kind: "position",
      instruction: `Close your ${positions} open ${plural(
        positions,
        "position",
        "positions"
      )}`,
      items: labelsOf(data?.positions),
    });
  }

  const what: string[] = [];
  if (orders > 0) {
    what.push(
      `${orders} resting ${plural(orders, "order", "orders")} still ${plural(
        orders,
        "holds",
        "hold"
      )} a reservation`
    );
  }
  if (positions > 0) {
    what.push(
      `${positions} open ${plural(
        positions,
        "position",
        "positions"
      )} still ${plural(positions, "stands", "stand")} on margin`
    );
  }

  return {
    headline:
      `The reset was not run: ${what.join(" and ")}. ` +
      "A reset writes fixed balances, so anything still outstanding would be " +
      "paid back on top of them rather than returned to where it came from.",
    groups,
  };
}
