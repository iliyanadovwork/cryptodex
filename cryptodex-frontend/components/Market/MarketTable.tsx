import { useEffect, useContext, useState, useMemo, useRef } from "react";
import { Container, Table } from "react-bootstrap";
import styles from "@/styles/common.module.css";
//import lib
import { toFixed } from "@/lib/roundOf";
//improt context
import SocketContext from "../Context/SocketContext";
import { useRouter } from "next/router";
import { apigetPairList } from "@/services/Spot/SpotService";
import { nWComma } from "@/lib/calculation";
import { getCoinImageUrl } from "@/lib/coinImage";

/**
 * How many pairs the home page teaser shows before "View More Pairs".
 */
const TEASER_ROWS = 5;

/**
 * Rank the pairs the venue actually lists, busiest first.
 *
 * This used to be `.filter(item => item.secondCurrencySymbol === 'USDT')`.
 * There is no USDT on this platform — every spot pair quotes in USD
 * (BTCUSD / ETHUSD / SOLUSD) — so the filter matched nothing and the table
 * rendered zero rows under a header that advertised a quote asset we do not
 * offer. Ranking is quote-agnostic now: whatever pairs the venue lists get
 * sorted by turnover, and each row states its own quote instead of the header
 * asserting one for all of them.
 */
export function rankPairs(pairList: any): any[] {
  if (!Array.isArray(pairList)) return [];
  return [...pairList]
    // An admin can deactivate a pair; a delisted market is not "popular".
    // Pairs that never carried a status are kept — absence is not a "no".
    .filter((item: any) => item && item.status !== "deactive")
    .sort(
      (a: any, b: any) =>
        (parseFloat(b?.secondVolume) || 0) - (parseFloat(a?.secondVolume) || 0)
    );
}

export default function MarketTable({ pairList }: any) {
  const router = useRouter();
  const socketContext = useContext<any>(SocketContext);
  const [data, setData] = useState<any>([]);
  // The socket handler is registered once, but it needs the current rows to
  // patch them. A ref keeps the handler stable so the listener is not
  // re-registered (and leaked) on every price tick.
  const dataRef = useRef<any[]>([]);
  dataRef.current = data;

  // Memoize coin image URLs with fallback
  const coinImageUrls = useMemo(() => {
    const urls: Record<string, string> = {};
    data?.forEach((item: any) => {
      urls[item.firstCurrencySymbol] = getCoinImageUrl(item.firstCurrencySymbol);
    });
    return urls;
  }, [data]);

  useEffect(() => {
    fetchPairList();
  }, []);

  const fetchPairList = async () => {
    // Plain length check rather than the fuzzy isEmpty() helper: "has this list
    // been filled yet" is exactly a length question, and isEmpty's answer for
    // an array depends on which of its several definitions is in play.
    if (data.length === 0) {
      const responseData: any = await apigetPairList();
      setData(rankPairs(responseData?.data?.result));
    }
  };

  useEffect(() => {
    // socket
    const handleMarketPrice = (result: any) => {
      const tempPairList = [...dataRef.current];
      const pairIndex = tempPairList.findIndex(
        (el: any) => el._id == result?.pairId
      );
      if (pairIndex >= 0) {
        tempPairList[pairIndex] = {
          ...tempPairList[pairIndex],
          markPrice: result.data.markPrice,
          change: result.data.change,
          last: result.data.last,
        };
        setData(tempPairList);
      }
    };

    socketContext.spotSocket.on("marketPrice", handleMarketPrice);
    socketContext.spotSocket.emit("subscribe", "spot");
    return () => {
      // Named handler: `.off("marketPrice")` with no handler would tear down
      // every other listener on the page too.
      socketContext.spotSocket.off("marketPrice", handleMarketPrice);
      socketContext.spotSocket.emit("unSubscribe", "spot");
    };
  }, [socketContext?.spotSocket]);

  return (
    <section className={`${styles.popular_currency}`}>
      <Container>
        {/* Named for what it shows. "Popular Cryptocurrencies" implied a
            selection worth ranking; there is one listed market. */}
        <h2 className={styles.h2tag}>The Market</h2>
        <div className={styles.homeTableBg}>
          <Table responsive className={styles.table} data-aos="fade-up" data-aos-duration="1000">
            <thead>
              <tr>
                <th>Name</th>
                <th className='ps-3'>Last Price</th>
                <th>24h Change</th>
                {/* No quote asset in the header: the listed pairs do not all
                    have to share one, and each row prints its own. */}
                <th>Market Price</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data?.length > 0 && data.slice(0, TEASER_ROWS).map((item: any, index: number) => {
                const changeClass = toFixed(item.change) > 0 ? styles.green_text : styles.red_text;
                return (
                  <tr key={item._id ?? index} data-testid="popular-pair-row">
                    <td className='market-icon'>
                      <div className='d-flex align-items-center'>
                        <img
                          src={coinImageUrls[item.firstCurrencySymbol] || "/assets/images/cryptoicons/default.png"}
                          alt={item.firstCurrencySymbol}
                          className="img-fluid me-2"
                          width={32}
                          height={32}
                          style={{ borderRadius: '50%' }}
                        />
                        <span className='fw-semibold'>{item.firstCurrencySymbol}</span>
                        <span className='text-secondary ms-1'>/{item.secondCurrencySymbol}</span>
                      </div>
                    </td>
                    <td className='ps-3'>{nWComma(toFixed(item.last, 2))}</td>
                    <td className={changeClass}>{toFixed(item.change, 2)}%</td>
                    {/* Was prefixed with "$" under a "(USDT)" header — two
                        different currencies claimed for one number. Print the
                        pair's actual quote symbol instead. */}
                    <td>{nWComma(toFixed(item.markPrice, 2))} {item.secondCurrencySymbol}</td>
                    <td>
                      <button
                        className={`${styles.trade_btn} ${styles.primary_btn}`}
                        onClick={() => router.push(`/spot/${item.firstCurrencySymbol}_${item.secondCurrencySymbol}`)}
                      >
                        <label>Trade</label>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
        {/* The "View More Pairs" button that sat here is gone. It pushed to
            /market, which no longer exists, so it was a one-click 404 from the
            most-visited page in the app - and there are no "more pairs" to view:
            this venue lists one market, and each row's own Trade button already
            opens it. */}
      </Container>
    </section>
  );
}
