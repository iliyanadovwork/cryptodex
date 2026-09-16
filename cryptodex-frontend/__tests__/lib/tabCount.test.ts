/**
 * Tab-count badge wiring (the open-order and position tab badges)
 *
 * Each trading page renders its tables twice - desktop layout and mobile
 * layout - and each layout owns its own count badge, reached imperatively:
 *
 *   HomePage.tsx (desktop)  <OrderCount ref={countRef2} />
 *                           <OpenOrder countRef={countRef} countRef2={countRef2} />
 *   HomePage.tsx (mobile)   <OrderCount ref={countRef} />
 *                           <OpenOrder countRef={countRef} />          <- no countRef2
 *
 * One product's OpenOrder and PositionHistory panels only ever wrote countRef,
 * so their DESKTOP "Open Orders(n)" tab sat at 0 forever even though the API
 * reported count 1 and the table below it listed the resting order. The others
 * wrote both refs by hand, one statement each, inside a try/catch - so on the
 * mobile layout the second statement threw on `undefined.current` and only the
 * statement ORDER kept the first badge working.
 *
 * publishTabCount is what both cases now go through.
 */
import { publishTabCount } from '../../lib/tabCount';

const badge = () => ({ current: { show: jest.fn() } });

describe('publishTabCount', () => {
  it('updates BOTH badges when a layout passes both refs (desktop)', () => {
    const countRef = badge();
    const countRef2 = badge();

    publishTabCount(3, countRef, countRef2);

    expect(countRef.current.show).toHaveBeenCalledWith(3);
    expect(countRef2.current.show).toHaveBeenCalledWith(3);
  });

  it('is the desktop-tab regression: countRef2 must receive the count', () => {
    // The old code called countRef.current.show(count) only.
    const countRef = badge();
    const countRef2 = badge();

    publishTabCount(1, countRef, countRef2);

    expect(countRef2.current.show).toHaveBeenCalledTimes(1);
    expect(countRef2.current.show).toHaveBeenCalledWith(1);
  });

  it('still updates the ref that IS present when a layout passes one (mobile)', () => {
    const countRef = badge();

    expect(() => publishTabCount(2, countRef, undefined)).not.toThrow();
    expect(countRef.current.show).toHaveBeenCalledWith(2);
  });

  it('does not throw when a ref is not attached yet (first fetch beats mount)', () => {
    const countRef = { current: null };
    const countRef2 = badge();

    expect(() => publishTabCount(5, countRef, countRef2)).not.toThrow();
    expect(countRef2.current.show).toHaveBeenCalledWith(5);
  });

  it('skips a ref whose component exposes no show handle, and keeps going', () => {
    const noHandle = { current: {} };
    const countRef2 = badge();

    expect(() => publishTabCount(7, noHandle, countRef2)).not.toThrow();
    expect(countRef2.current.show).toHaveBeenCalledWith(7);
  });

  it('publishes zero - clearing a badge after the last order fills', () => {
    const countRef = badge();
    const countRef2 = badge();

    publishTabCount(0, countRef, countRef2);

    expect(countRef.current.show).toHaveBeenCalledWith(0);
    expect(countRef2.current.show).toHaveBeenCalledWith(0);
  });

  it('is a no-op with no refs at all', () => {
    expect(() => publishTabCount(1)).not.toThrow();
  });
});
