import { useEffect, useRef, useState, useCallback } from "react";
import { getOrderBook } from "@/services/Spot/SpotService";

interface UseOrderBookResyncOptions {
  pairId: string;
  botstatus?: string;
  isEnabled?: boolean;
  onResyncComplete?: (data: any) => void;
  staleThreshold?: number; // seconds before considering data stale
}

/**
 * Hook to manage orderbook resync on visibility changes, socket reconnects, and staleness detection.
 * Prevents orderbook freezing when user tabs away or socket connection issues occur.
 *
 * It also reports `isStale`. The backend republishes the book at least once a
 * second even when the depth feed is dead, so silence here does not mean "quiet
 * market" — it means we have lost the publisher and whatever is still on screen
 * is a picture of the past. The caller treats that exactly like an unhealthy
 * payload: blank the ladder, explain it, and disable the ticket.
 */
export const useOrderBookResync = ({
  pairId,
  botstatus,
  isEnabled = true,
  onResyncComplete,
  staleThreshold = 3, // Resync if no message for 3 seconds while visible
}: UseOrderBookResyncOptions) => {
  /**
   * When the feed last spoke. A REF, not state, and that is the whole point.
   *
   * markUpdate() is called on EVERY socket message (~10/s per pair). As state it
   * re-rendered every consumer that many times a second, and - because three of
   * the effects below listed it as a dependency - it also tore down and rebuilt
   * the visibilitychange listener, the focus listener AND the 1s staleness
   * interval on every single message, times two because the spot page mounts two
   * OrderBooks. Nothing outside this hook ever read the value; only the watchdog
   * below compares against it, once a second, which a ref serves exactly as well.
   */
  const lastUpdateRef = useRef<number>(Date.now());
  const [isResyncing, setIsResyncing] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const resyncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // A buffer over the 3s resync trigger so a single missed REST retry or a
  // briefly throttled timer does not flash "reconnecting" - but no more than
  // that. The publisher republishes at least once a second, so at 2x (6s) the
  // book has missed ~6 republishes AND the 3s resync attempt has already failed:
  // a genuinely-down feed. 3x (9s) left a frozen ladder presented as live, with
  // the ticket enabled, for a full 9 missed republishes.
  const STALE_UI_MULTIPLIER = 2;

  // Stable ref for the fetch function to avoid recreating effects
  const fetchOrderBookRef = useRef<((pairId: string) => Promise<void>) | null>(null);

  /**
   * Fetch fresh orderbook snapshot from REST API
   * This ensures we have authoritative state after returning from background
   */
  const fetchOrderBookSnapshot = useCallback(async (currentPairId: string) => {
    if (!isEnabled || !currentPairId) return;
    if (botstatus !== "bot" && botstatus !== "binance") return;
    if (isResyncing) return; // Prevent duplicate fetches

    setIsResyncing(true);

    try {
      const { status, result } = await getOrderBook(currentPairId);
      if (status === "success" && result) {
        lastUpdateRef.current = Date.now();
        if (onResyncComplete) {
          onResyncComplete(result);
        }
      }
    } catch (err) {
      // Silently handle errors - will retry on next trigger
      console.log("[useOrderBookResync] Fetch error:", err);
    } finally {
      setIsResyncing(false);
    }
  }, [isEnabled, botstatus, isResyncing, onResyncComplete]);

  // Update the ref whenever the function changes
  fetchOrderBookRef.current = fetchOrderBookSnapshot;

  /**
   * Effect 1: Visibility change handler
   * Fetches fresh snapshot when tab becomes visible again
   */
  useEffect(() => {
    if (!isEnabled || !pairId) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const timeSinceLastUpdate = Date.now() - lastUpdateRef.current;
        // Only resync if data is stale (> 1 second old) to avoid unnecessary fetches
        if (timeSinceLastUpdate > 1000) {
          console.log("[useOrderBookResync] Tab visible, resyncing orderbook");
          fetchOrderBookRef.current?.(pairId);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isEnabled, pairId]);

  /**
   * Effect 2: BFCache restore handler
   * Fetches fresh snapshot when page is restored from back-forward cache
   */
  useEffect(() => {
    if (!isEnabled || !pairId) return;

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        console.log("[useOrderBookResync] BFCache restore, resyncing orderbook");
        fetchOrderBookRef.current?.(pairId);
      }
    };

    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [isEnabled, pairId]);

  /**
   * Effect 3: Window focus handler
   * Fetches fresh snapshot when window regains focus (backup to visibilitychange)
   */
  useEffect(() => {
    if (!isEnabled || !pairId) return;

    const handleFocus = () => {
      const timeSinceLastUpdate = Date.now() - lastUpdateRef.current;
      if (timeSinceLastUpdate > 1000) {
        console.log("[useOrderBookResync] Window focused, resyncing orderbook");
        fetchOrderBookRef.current?.(pairId);
      }
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isEnabled, pairId]);

  /**
   * Effect 4: Staleness watchdog
   * Monitors for silent drops where socket appears connected but isn't receiving updates
   */
  useEffect(() => {
    if (!isEnabled) {
      // A pair we do not subscribe to can never be "stale".
      setIsStale(false);
      return;
    }

    const checkInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastUpdate = now - lastUpdateRef.current;

      // Only check staleness when page is visible
      if (document.visibilityState === "visible") {
        setIsStale(timeSinceLastUpdate > staleThreshold * STALE_UI_MULTIPLIER * 1000);
        if (timeSinceLastUpdate > staleThreshold * 1000) {
          console.log(
            `[useOrderBookResync] Orderbook stale (${(timeSinceLastUpdate / 1000).toFixed(1)}s old), resyncing`
          );
          fetchOrderBookRef.current?.(pairId);
        }
      }
    }, 1000); // Check every second

    return () => clearInterval(checkInterval);
  }, [isEnabled, staleThreshold, pairId]);

  /**
   * Return functions for external use
   */
  return {
    /** Manually trigger a resync */
    resync: useCallback(() => {
      if (pairId) {
        console.log("[useOrderBookResync] Manual resync triggered");
        fetchOrderBookRef.current?.(pairId);
      }
    }, [pairId]),
    /** Update the last update time (call this when receiving orderBook messages) */
    markUpdate: useCallback(() => {
      lastUpdateRef.current = Date.now();
      setIsStale(false);
    }, []),
    /** Current timestamp of last orderBook message */
    lastUpdateTime: lastUpdateRef.current,
    /** Whether a resync is currently in progress */
    isResyncing,
    /**
     * No payload — socket or REST — for long enough that anything still drawn
     * is a stale picture. Callers must stop presenting it as live.
     */
    isStale,
  };
};
