import { useEffect, useRef, useState } from "react";

interface UseFeedFreshnessOptions {
  /** Timestamp (ms) of the last message from the stream, or null if none yet. */
  lastUpdate: number | null;
  /** Silence longer than this means the stream is gone, not quiet. */
  thresholdMs: number;
  /** Streams we do not subscribe to can never be stale. */
  isEnabled?: boolean;
  /** How often to re-evaluate. */
  checkIntervalMs?: number;
}

/**
 * "Have we heard from this stream recently?" — the one honest question behind
 * every 'is this number live' badge in the UI.
 *
 * Two rules make it trustworthy:
 *
 *   1. Only VISIBLE time counts. A backgrounded tab has its timers throttled and
 *      its sockets may be suspended entirely, so silence there proves nothing.
 *      Returning from a background tab starts a fresh window rather than
 *      immediately shouting that the feed is dead.
 *   2. The threshold must be several times the stream's own heartbeat, so a
 *      single missed publish never flashes a warning at the user.
 */
export function useFeedFreshness({
  lastUpdate,
  thresholdMs,
  isEnabled = true,
  checkIntervalMs = 1000,
}: UseFeedFreshnessOptions): boolean {
  const [isStale, setIsStale] = useState(false);
  // When the tab last became visible. Time spent hidden is not evidence.
  const visibleSinceRef = useRef<number>(Date.now());

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        visibleSinceRef.current = Date.now();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    if (!isEnabled) {
      setIsStale(false);
      return;
    }

    const check = () => {
      // Judge only while the user can actually see the numbers.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const heardAt = Math.max(lastUpdate || 0, visibleSinceRef.current);
      setIsStale(Date.now() - heardAt > thresholdMs);
    };

    check();
    const timer = setInterval(check, checkIntervalMs);
    return () => clearInterval(timer);
  }, [isEnabled, lastUpdate, thresholdMs, checkIntervalMs]);

  return isStale;
}

export default useFeedFreshness;
