/**
 * Publish a row count to the tab-header badges that display it.
 *
 * The trading pages render their order and
 * position tables TWICE - once for the desktop layout and once for the mobile
 * one - and each layout has its own `<OrderCount>` / `<OrderPosition>` badge
 * component holding the number, reached through an imperative ref:
 *
 *   desktop:  <OrderCount ref={countRef2} />   ... <OpenOrder countRef={countRef} countRef2={countRef2} />
 *   mobile:   <OrderCount ref={countRef}  />   ... <OpenOrder countRef={countRef} />
 *
 * The tables were each written to poke exactly ONE of the two refs, and which
 * one differed per page, so on every page one of the two layouts had a badge
 * that never moved off (0) while its table showed rows:
 *
 *   one product's panels -> only countRef  -> DESKTOP stuck at 0
 *   Spot   OpenOrder                    -> only countRef2 -> MOBILE  stuck at 0
 *   another's            -> only countRef2 -> MOBILE  stuck at 0
 *
 * The miss was silent because the write sat inside a try/catch: on the layout
 * whose ref was not passed, `countRef2.current` threw a TypeError that was
 * swallowed, so the badge simply never updated.
 *
 * Passing every ref through here fixes both directions at once and stays safe
 * when a layout deliberately passes only one: a ref that is absent, not yet
 * attached, or attached to a component with no `show` handle is skipped rather
 * than throwing.
 */
export const publishTabCount = (count: number, ...refs: any[]) => {
  for (const ref of refs) {
    // ref may be undefined (layout passed only one), ref.current may be null
    // (badge not mounted yet on first fetch), and show() only exists once
    // useImperativeHandle has run.
    if (typeof ref?.current?.show === "function") {
      ref.current.show(count);
    }
  }
};

export default publishTabCount;
