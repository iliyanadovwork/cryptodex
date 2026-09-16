import { useState, useEffect, useContext, useMemo, useRef, useCallback } from "react";
import Image from "next/image";
import spot from "@/styles/Spot.module.css";

//improt store
import { useSelector } from "../../store";
//import lib
import { toFixed, toFixedDown } from "../../lib/roundOf";
import { formatPrice, formatQty, formatPct } from "@/lib/numberFormat";
import isEmpty from "../../lib/isEmpty";
import { getCoinImageUrl } from "../../lib/coinImage";
import SocketContext from "../Context/SocketContext";
import { setMarkData, setMergeMarkData, setTickerStale } from "@/store/trade/dataSlice";
import { useDispatch } from "react-redux";
import { nWComma } from "@/lib/calculation";
import { useRouter } from "next/router";
//import feed freshness
import { useFeedFreshness } from "@/hooks/useFeedFreshness";
import FeedStaleBadge from "./FeedStaleBadge";
//import 24h range reconciliation
import { widenRange, displayRange, EMPTY_RANGE, TickerRange } from "@/lib/tickerRange";
import { lastTradePrice } from "@/lib/lastPrice";

/**
 * How long the venue tick may go quiet before the header stops calling it live.
 *
 * `marketPrice` is published by a 30s cron per active pair (spotapi
 * config/cron.js -> binance.controller.updateBinancePrices) and it emits every
 * cycle whether or not the price moved. So it is a heartbeat: 90s of silence is
 * three missed beats, which is a dead feed rather than a quiet market.
 */
const TICKER_STALE_MS = 90000;

export default function MarketPrice(props: any) {
  const dispatch = useDispatch();
  const { asPath, isReady } = useRouter();
  const tikerRoot = asPath.split("/")[2];

  const [usdtValue, setusdValue] = useState<any>();
  const { marketData, tradePair, lastTrade } = useSelector((state: any) => state.spot);

  // Get coin image URL with fallback
  const coinImageUrl = useMemo(
    () => getCoinImageUrl(tradePair?.firstCurrencySymbol, tradePair?.firstCurrencyImage),
    [tradePair?.firstCurrencySymbol, tradePair?.firstCurrencyImage]
  );
  const { priceConversion } = useSelector((state: any) => state.wallet);
  const socketContext = useContext<any>(SocketContext);
  const [mpData, setmpData] = useState<any>();
  const pairIdRef = useRef<string>();
  // When we last heard the venue tick for the pair on screen. Seeded on mount
  // and on every pair change so a fresh pair gets a full grace window.
  const [lastTickAt, setLastTickAt] = useState<number>(() => Date.now());
  /**
   * THE 24H HIGH/LOW PROBLEM, AND WHAT THIS HOLDS.
   *
   * `high` and `low` arrive exactly once, on the REST pair payload. The 30s
   * live tick (spotapi binance.controller.updateBinancePrices) publishes only
   * markPrice / last / price / change / changePrice — no high, no low. So those
   * two figures freeze at page load while the price beside them keeps moving,
   * and the header routinely ends up printing a "24H High" the current price
   * has already gone past, or a "24H Low" above it: two numbers on one line,
   * one disproving the other.
   *
   * This is the range of prices THIS SESSION HAS ACTUALLY SEEN. It is not a
   * 24-hour statistic and does not pretend to be one; it is only ever used to
   * WIDEN the server's figures (lib/tickerRange), never to narrow them. A price
   * we watched trade is proof the day's range includes it, whatever the frozen
   * snapshot says.
   */
  const [observedRange, setObservedRange] = useState<TickerRange>(EMPTY_RANGE);

  // Sync mpData when marketData changes
  useEffect(() => {
    if (!isEmpty(marketData && tradePair)) {
      // Check if marketData has _id property (it might not from socket events)
      if (marketData._id && marketData._id.toString() == tradePair._id.toString()) {
        setmpData(marketData);
      }
    }
  }, [marketData, tradePair]);

  // Calculate USDT value
  useEffect(() => {
    if (!isEmpty(mpData && priceConversion && tradePair)) {
      if (tradePair.secondCurrencySymbol == "USDT") {
        setusdValue(mpData.markPrice);
      } else {
        let MarkValue = priceConversion.find(
          (item: any) =>
            item.baseSymbol == tradePair.secondCurrencySymbol &&
            item.convertSymbol == "USDT"
        );
        if (MarkValue?.convertPrice) {
          setusdValue(mpData.markPrice * MarkValue.convertPrice);
        }
      }
    }
  }, [mpData, priceConversion, tradePair]);

  // Socket handler with stable callback
  const handleMarketPrice = useCallback((result: any) => {
    // Use ref to avoid closure issues
    if (pairIdRef.current && pairIdRef.current == result.pairId) {
      // The `marketPrice` tick is a PARTIAL payload — it only carries
      // markPrice/last/price/change/changePrice. Merge it instead of replacing,
      // otherwise the 24H high/low/volume/turnover fields (which only arrive on
      // the REST pair payload) are wiped and render as "—" after the first tick.
      setmpData((prev: any) => ({ ...(prev || {}), ...(result?.data || {}) }));
      dispatch(setMergeMarkData(result?.data));
      // Every tick is evidence about the day's range. widenRange returns the
      // SAME object when nothing moved outside it, so this does not re-render
      // the header twice a minute for nothing.
      setObservedRange((prev) =>
        widenRange(prev, [result?.data?.markPrice, result?.data?.last])
      );
      // We just heard from the venue: the header is telling the truth again.
      setLastTickAt(Date.now());
    }
  }, [dispatch]);

  // Reset the clock on a pair change — a new pair has not gone quiet, we simply
  // have not asked about it yet.
  useEffect(() => {
    setLastTickAt(Date.now());
    // Prices observed for the PREVIOUS pair say nothing about this one, and
    // carrying them over would produce a BTC-sized "high" on a SOL header.
    setObservedRange(EMPTY_RANGE);
  }, [tradePair?._id]);

  // The pair's own current price counts as observed too — otherwise a header
  // that never receives a tick (a quiet pair) keeps the frozen snapshot alone.
  useEffect(() => {
    // The executed price counts as observed too, and it is now what the
    // headline prints - without it the 24H High/Low cells could sit on the
    // wrong side of the very number beside them, which is the contradiction
    // observedRange exists to prevent.
    setObservedRange((prev) =>
      widenRange(prev, [
        mpData?.markPrice,
        mpData?.last,
        lastTradePrice(lastTrade, tradePair?._id, undefined),
      ])
    );
  }, [mpData?.markPrice, mpData?.last, lastTrade, tradePair?._id]);

  // What the two ticker cells actually print: the server's snapshot, widened to
  // contain every price we have seen. Never narrower than either input, so it
  // cannot contradict the live price sitting next to it.
  const range = displayRange(mpData?.high, mpData?.low, observedRange);

  // Only pairs whose ticker is actually published can be judged on its silence.
  // The 30s cron only covers `binance` pairs; an admin-created "bot" pair has
  // no marketPrice publisher at all, and flagging those as a dead feed forever
  // would be a permanent false alarm rather than honesty.
  const tickerIsPublished = tradePair?.botstatus === "binance";

  const tickerStale = useFeedFreshness({
    lastUpdate: lastTickAt,
    thresholdMs: TICKER_STALE_MS,
    isEnabled: !isEmpty(tradePair?._id) && tickerIsPublished,
  });

  // Publish it so the chart and the trade log can stop claiming to be live too.
  useEffect(() => {
    dispatch(setTickerStale(tickerStale));
  }, [dispatch, tickerStale]);

  useEffect(() => {
    // Update ref when tradePair changes
    if (tradePair?._id) {
      pairIdRef.current = tradePair._id;
    }

    // socket
    // TARGETED off: this handler is named, so remove only it. A bare
    // off("marketPrice") on a pair switch would also strip PairList's and any
    // other component's "marketPrice" listeners on the shared socket singleton.
    socketContext.spotSocket.on("marketPrice", handleMarketPrice);
    return () => {
      socketContext.spotSocket.off("marketPrice", handleMarketPrice);
    };
  }, [tradePair?._id, handleMarketPrice]);

  useEffect(() => {
    socketContext.spotSocket.emit("subscribe", "spot");
    return () => {
      // The bare `off("marketPrice")` that stood here removed EVERY listener
      // for the event, including ones this component never attached - the
      // hazard the comment above spells out. It was redundant besides: this
      // component's only handler is removed by reference in the effect above.
      // It now takes HelperRoute's session-long price listener with it, so
      // leaving the trade screen would freeze the wallet total until reload.
      socketContext.spotSocket.emit("unSubscribe", "spot");
    };
  }, []);
  return (
    <>
      <div className={spot.marketinfo_wrap}>
        <div className={spot.marketinfo_inner}>
          {/* Left side: Pair selector and main price */}
          <div className={spot.marketinfo_div}>
            <div className={spot.marketinfo_div_left}>
              <div className={spot.marketinfo_div_left_layout}>
                {/* A LABEL, NOT A PICKER. This venue lists exactly one market,
                    so the dropdown offered a choice that did not exist: it
                    opened onto a one-row list of the pair already on screen.
                    The PairList it opened also carried a live "marketPrice"
                    subscription of its own, which is now one fewer socket
                    listener and one fewer per-tick redux dispatch per page. */}
                <div className={spot.marketinfo_pair_wrap}>
                  <div className={spot.marketinfo_pair_div}>
                    {coinImageUrl && (
                      <img
                        src={coinImageUrl}
                        className={spot.coin_logo_img}
                        width={24}
                        height={24}
                        alt="coin"
                      />
                    )}
                    <h1>
                      {isReady
                        ? tikerRoot?.split("_")[0] + "/" + tikerRoot?.split("_")[1]
                        : "--"}
                    </h1>
                  </div>
                </div>
              </div>
            </div>
            {/* Main price display. When the feed is dead this number is the
                last one we received, so it is dimmed and labelled rather than
                presented as the current market.

                THE HEADLINE IS THE LAST TRADED PRICE, not the venue tick. It
                used to print `markPrice`, which the 30s cron republishes on its
                own schedule, so the biggest number on the page disagreed with
                the order book, the last-price marker and the top of the trade
                log for most of every cron cycle. The venue's own figure is
                still shown, honestly labelled, in the "Index Price" cell to
                the right. See lib/lastPrice. */}
            <div
              className={`${spot.marketInfoMainPrice} ${tickerStale ? spot.feed_stale_values : ""}`}
              data-testid="marketinfo-main-price"
            >
              {formatPrice(
                lastTradePrice(lastTrade, tradePair?._id, mpData?.markPrice),
                tradePair?.secondFloatDigit
              )} {tradePair?.secondCurrencySymbol}
            </div>
            <FeedStaleBadge />
          </div>

          {/* Right side: Scrollable ticker stats */}
          <div className={spot.marketinfo_div_right}>
            <div className={spot.tickerScrollWrapper}>
              <div
                className={`${spot.ticker_list} ${tickerStale ? spot.feed_stale_values : ""}`}
                data-testid="ticker-stats"
              >
                <div>
                  {/* INDEX, not "Mark Price". A mark price is a fair price
                      computed for margin accounting, deliberately distinct from
                      the last trade so it cannot be wicked. This venue is spot;
                      it has no such thing, so the label would be wrong.

                      The FIGURE is worth keeping and is not a duplicate of the
                      headline beside it: the headline is the last fill on THIS
                      paper engine, while this is the Binance tick the ladder
                      mirrors. They can drift, and seeing the real market next to
                      your synthetic fills is the point of a paper venue. The
                      backend field stays `markPrice` - only what the user reads
                      changes. */}
                  <div className={spot.tickeritem_label}>Index Price</div>
                  <div className={`${spot.tickerprice_text} ${spot.tabular_nums}`}>
                    {formatPrice(mpData?.markPrice, tradePair?.secondFloatDigit, "—")}
                  </div>
                </div>
                <div>
                  <div className={spot.tickeritem_label}>24H Change</div>
                  {/* Backend naming: `changePrice` is the absolute 24H delta
                      (Binance priceChange) and `change` is the percentage
                      (Binance priceChangePercent). There is no `changePct`. */}
                  <div className={`${spot.tickerprice_text} ${parseFloat(mpData?.changePrice) < 0 ? spot.red : spot.green} ${spot.tabular_nums}`}>
                    {formatPrice(mpData?.changePrice, tradePair?.secondFloatDigit, "—")}
                    <span style={{ marginLeft: '4px' }}>
                      {formatPct(mpData?.change, 2, "—")}
                    </span>
                  </div>
                </div>
                <div>
                  <div className={spot.tickeritem_label}>24H High</div>
                  <div
                    className={`${spot.tickerprice_text} ${spot.tabular_nums}`}
                    data-testid="ticker-24h-high"
                  >
                    {formatPrice(range.high, tradePair?.secondFloatDigit, "—")}
                  </div>
                </div>
                <div>
                  <div className={spot.tickeritem_label}>24H Low</div>
                  <div
                    className={`${spot.tickerprice_text} ${spot.tabular_nums}`}
                    data-testid="ticker-24h-low"
                  >
                    {formatPrice(range.low, tradePair?.secondFloatDigit, "—")}
                  </div>
                </div>
                <div>
                  <div className={spot.tickeritem_label}>24H Volume ({tradePair?.firstCurrencySymbol})</div>
                  <div className={`${spot.tickerprice_text} ${spot.tabular_nums}`}>
                    {formatQty(mpData?.firstVolume, tradePair?.firstFloatDigit, "—")}
                  </div>
                </div>
                <div>
                  <div className={spot.tickeritem_label}>24H Turnover ({tradePair?.secondCurrencySymbol})</div>
                  <div className={`${spot.tickerprice_text} ${spot.tabular_nums}`}>
                    {formatQty(mpData?.secondVolume, tradePair?.secondFloatDigit, "—")}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
