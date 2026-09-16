import { useEffect, useState, useContext } from "react";
import { useSelector } from "../../store";
import spot from "@/styles/Spot.module.css";
import { Table } from "react-bootstrap";
import InfiniteScroll from "react-infinite-scroll-component";
import { mergePage, showsNoRecords, visibleRowsForPair } from "@/lib/pagedTable";
//import types
import { OpenOrderFormValues } from "./types";
//improt lib
import isEmpty from "@/lib/isEmpty";
import { dateTimeFormat } from "../../lib/dateTimeHelper";
import { truncateDecimals } from "../../lib/roundOf";
import { formatPrice, formatQty } from "@/lib/numberFormat";
import { capitalize } from "../../lib/stringCase";
//import context
import SocketContext from "../Context/SocketContext";
//improt service
import { getOpenOrder } from "../../services/Spot/SpotService";
//import component
import CancelOrder from "./CancelOrder";
import CancelModal from "./CancelModal";
import { isSameOrder, requestCancel, stillOpen } from "@/lib/cancelOrderRequest";
import Image from "next/image";
import { useTheme } from "next-themes";
import { publishTabCount } from "@/lib/tabCount";
import { useDispatch } from "../../store";
import { setOpenOrders } from "@/store/trade/dataSlice";
import { toastAlert } from "@/lib/toastAlert";
import NoAuth from "./NoAuth";

const initialValues: OpenOrderFormValues = {
  currentPage: 1,
  nextPage: true,
  limit: 10,
  count: 0,
  data: [],
};
const spinner: React.CSSProperties = {
  fontSize: "36px",
};
const IconStyle: React.CSSProperties = {
  color: "#FDE573",
};
export default function OpenOrder({ countRef, countRef2 }: any) {
  const { theme, setTheme } = useTheme();
  const dispatch = useDispatch()
  const { showSpot } = useSelector(
    (state: any) => state.UserSetting?.data?.mode
  );
  const socketContext = useContext<any>(SocketContext);
  const { tradePair } = useSelector((state: any) => state.spot);
  const [orderData, setOrderData] = useState<any>(initialValues);
  const [loader, setLoader] = useState<boolean>(false);
  const [copiedItems, setCopiedItems] = useState<any>({});
  const { currentPage, nextPage, limit, count, data } = orderData;

  /**
   * THE ORDER THE CANCEL DIALOG IS ABOUT - A SNAPSHOT, OWNED BY THE TABLE.
   *
   * Both halves of this matter, and both were wrong.
   *
   * It is a SNAPSHOT because the dialog used to read a live prop on the row it
   * was rendered inside, and answer Confirm with whatever that prop held at the
   * time. It is owned by the TABLE, not the row, because a row unmounting - now
   * that rows are keyed by `_id`, which is what makes React stop reusing them -
   * would otherwise delete an open dialog out from under the user.
   *
   * Captured once, on the click. Nothing the socket, the pager or the matcher
   * does afterwards can reach it.
   */
  const [pendingCancel, setPendingCancel] = useState<any>(null);
  const [cancelling, setCancelling] = useState<boolean>(false);

  /**
   * WHEN WE ARE ENTITLED TO SAY "this order is no longer open".
   *
   * Absence from `data` is NOT on its own evidence that an order has gone: the
   * table is paged, and the socket push replaces `data` with page one, so an
   * order the user reached by scrolling can vanish from `data` while still
   * resting perfectly happily on the venue. Claiming it was filled would be a
   * lie, and a lie that costs the user the cancel they came to make.
   *
   * `data.length >= count` is the same condition `fetchMoreData` uses to decide
   * there is nothing left to fetch: everything the user has is loaded. Only
   * then does absence mean gone. Short of that the dialog stays a normal
   * confirmation - the snapshot makes it safe either way, and spotapi answers a
   * cancel for an order that is no longer in the book with "Order not found",
   * which is surfaced as-is.
   */
  const pendingIsGone =
    !!pendingCancel &&
    !cancelling &&
    data.length >= count &&
    !stillOpen(pendingCancel, data);

  // The rows this table will actually PAINT. The body below drops rows whose
  // market is not the one on screen unless "showSpot" is on, so the payload's
  // length is not the table's length - and the empty state is about the table.
  const visibleRows = visibleRowsForPair(data, tradePair?._id, showSpot);
  const noRecords = showsNoRecords(visibleRows);
  const isLogin = useSelector((state: any) => state.auth.session.signedIn);

  // function
  const fetchOpenOrder = async (reqData: any, pairId: string) => {
    try {
      const { status, loading, result } = await getOpenOrder(reqData, pairId);
      setLoader(loading);
      if (status == "success") {
        // One merged set for the table AND for the store: OrderBook.tsx reads
        // `state.spot.openOrders` to mark the price levels the user has resting
        // (`openOrders.filter(...)` on both sides of the book), so dispatching
        // page 2 alone would have unmarked every level from page 1.
        const merged = mergePage(data, result.data, result.currentPage);
        totalCount(result)
        setOrderData({
          currentPage: result.currentPage,
          nextPage: result.nextPage,
          limit: result.limit,
          count: result.count,
          // PAGE 1 REPLACES, LATER PAGES APPEND (lib/pagedTable.ts). This was
          // `result.data` outright, with the append commented out beside it -
          // so once `nextPage` started telling the truth, scrolling a 12-order
          // book to the bottom fetched page 2 and REPLACED the ten rows on
          // screen with the last two. mergePage also drops a row page 1 already
          // had, which a live open-order book re-sends whenever an order fills
          // between the two requests.
          data: merged,
        });
        dispatch(setOpenOrders(merged))
      } else {
        setOrderData({
          ...orderData,
          ...{ nextPage: false },
        });
      }
    } catch (err) { }
  };
  /**
   * THE BADGE COUNTS THE USER'S OPEN ORDERS, NOT THE ROWS LOADED SO FAR.
   *
   * This used to be handed `result.data` - ONE PAGE of the response - and
   * counted it. The table is paginated ten rows at a time, so a user with
   * twenty-three open orders was shown "Open Orders(10)" until they scrolled,
   * and the number then climbed as they did: a count of what the client had
   * fetched, presented as a count of what they have resting.
   *
   * The two server-side totals are both taken BEFORE the slice:
   *   `count`     - every open order this user has, across all markets;
   *   `pairCount` - the ones on the market currently on screen.
   * Which one the badge wants is decided by exactly the condition the table's
   * own row filter uses (`visibleRowsForPair`): with "show all markets" on the
   * table shows everything, otherwise only this pair.
   *
   * `pairCount` is optional so an older payload - or the socket push before
   * spotapi is restarted - still produces a sensible number rather than a
   * blank badge: falling back to counting the payload is what this did all
   * along, and it is right whenever the payload IS the whole set.
   */
  const totalCount = (result: any) => {
    try {
      const rows = Array.isArray(result?.data) ? result.data : [];
      const countedFromPayload = rows.filter(
        (item: any) =>
          showSpot ||
          tradePair?._id?.toString() === item?.pairId?.toString()
      ).length;

      const serverTotal = showSpot ? result?.count : result?.pairCount;
      const count =
        typeof serverTotal === "number" && serverTotal >= 0
          ? serverTotal
          : countedFromPayload;

      // Desktop tab header reads countRef2, mobile reads countRef; HomePage
      // passes only countRef to the mobile copy. Poking them by hand meant the
      // second write threw into a silent catch, so whether the first one landed
      // depended on statement order and on the badge already being mounted.
      publishTabCount(count, countRef, countRef2);
    } catch (err) {
      // Silently handle errors
    }
  }
  const fetchMoreData = () => {
    if (data.length >= count) {
      setOrderData({
        ...orderData,
        ...{ nextPage: false },
      });
      return;
    }

    let reqData = {
      page: currentPage + 1,
      limit,
    };
    fetchOpenOrder(reqData, tradePair._id);
  };
  const test = () => {
    publishTabCount(10, countRef, countRef2);
  };

  /**
   * Cancels the SNAPSHOT, never the row.
   *
   * `target` is read out of state once and passed by value, so even a re-render
   * landing between the click and the await cannot redirect the request. The
   * dialog closes only after the answer, and only for the order it was about.
   */
  const confirmCancel = async () => {
    const target = pendingCancel;
    if (!target || cancelling) return;
    try {
      setCancelling(true);
      const { status, message } = await requestCancel(target);
      toastAlert(status == "success" ? "success" : "error", message, "cancelOrder");
    } catch (err) {
      // requestCancel already turns a transport failure into a failed status;
      // this only catches a throw from the toast itself.
    } finally {
      setCancelling(false);
      setPendingCancel(null);
    }
  };

  const handleCopy = (index: number, id: string) => {
    navigator.clipboard
      .writeText(id)
      .then(() => {
        setCopiedItems((prevCopiedItems: any) => ({
          ...prevCopiedItems,
          [index]: true,
        }));
        toastAlert("success", "Order ID copied to clipboard", "login");

        setTimeout(() => {
          setCopiedItems((prevCopiedItems: any) => {
            const newCopiedItems = { ...prevCopiedItems };
            delete newCopiedItems[index];
            return newCopiedItems;
          });
        }, 5000);
      })
      .catch(() => { });
  };

  useEffect(() => {
    if (!isEmpty(tradePair._id) && isLogin && !isEmpty(currentPage)) {
      let reqData = {
        page: currentPage,
        limit,
      };
      setOrderData(initialValues);
      // A dialog about a BTC order must not survive a switch to ETH: the order
      // it names is not in this table any more and the user did not ask about it.
      setPendingCancel(null);
      fetchOpenOrder(reqData, tradePair._id);

      // socket
      socketContext.spotSocket.on("openOrder", (result: any) => {
        if ((!showSpot && result.pairId == tradePair._id) || showSpot) {
          totalCount(result)
          setOrderData({
            currentPage: result.currentPage,
            nextPage: result.nextPage,
            limit: result.limit,
            count: result.count,
            data: result.data,
          });
          dispatch(setOpenOrders(result.data))
        }
      });
      return () => {
        socketContext.spotSocket.off("openOrder");
      };
    }
  }, [tradePair._id, isLogin]);

  if (!isLogin) {
    return (
      <NoAuth />
    )
  }

  return (
    <div className={spot.box}>
      {/* ONE dialog, owned by the table and outside the scroller, so no row
          coming or going can reuse it, poison it, or delete it. */}
      <CancelModal
        order={pendingCancel}
        gone={pendingIsGone}
        busy={cancelling}
        onClose={() => { if (!cancelling) setPendingCancel(null); }}
        onConfirm={confirmCancel}
      />
      <InfiniteScroll
        dataLength={data.length}
        next={fetchMoreData}
        hasMore={nextPage}
        /* NOT the empty state - see lib/pagedTable.ts. InfiniteScroll renders
           `loader` whenever `hasMore` is true, so the "no records found" block
           that used to sit here was governed by the PAGING flag: once
           `nextPage` started telling the truth it printed underneath a full
           first page, and disappeared from a genuinely empty table. It is now
           the second child below, decided by the rows this table paints. */
        loader={<></>}
        height={250}
      >
        <Table className={`${spot.spot_history_table}`}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Pair</th>
              <th>Type</th>
              {/* <th>Order ID</th> */}
              <th>Side</th>
              <th>Price</th>
              <th>Amount</th>
              <th>Filled</th>
              <th>Total Order Value</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!loader &&
              data?.length > 0 &&
              data.map((item: any, index: number) => {
                if (showSpot || tradePair._id.toString() == item.pairId.toString()) {
                  return (
                    /* KEYED BY THE ORDER, NOT BY THE ROW'S POSITION.
                       `key={index}` meant a row leaving the table - which
                       happens by itself every time an order fills - unmounted
                       nothing: React reused the row that had been sitting at
                       that index and handed it a DIFFERENT order. The index
                       fallback is only for a payload with no `_id` at all, which
                       no live open order has. */
                    <tr key={item._id || index}>
                      <td>
                        {dateTimeFormat(item.orderDate, "YYYY-MM-DD HH:mm")}
                      </td>
                      <td>
                        {item.firstCurrency}/{item.secondCurrency}
                      </td>
                      <td>{capitalize(item.orderType)}</td>
                      {/* <td>
                      <i
                        className={copiedItems[index] ? 'fas fa-check' : 'far fa-copy'}
                        onClick={() => {
                          if (copiedItems[index]) return;
                          return handleCopy(index, item.orderCode)
                        }}
                        style={IconStyle}
                      ></i>
                      {" "} {item.orderCode}
                      </td> */}
                      <td>{capitalize(item.buyorsell || item.type)}</td>
                      <td className={spot.tabular_nums}>
                        {item.price == "market"
                          ? "Market"
                          : formatPrice(item.price, item?.pairDetail?.secondFloatDigit, "—")}
                      </td>
                      <td className={spot.tabular_nums}>
                        {item.openQuantity
                          ? formatQty(item.openQuantity, item?.pairDetail?.firstFloatDigit, "—")
                          : formatQty(Number(item?.quantity || 0) + Number(item?.filledQuantity || 0), item?.pairDetail?.firstFloatDigit, "—")}
                      </td>
                      <td className={spot.tabular_nums}>
                        {/* A resting order has filledQuantity 0 — that is a real
                            value, not missing data, so render "0" not "—". */}
                        {formatQty(item.filledQuantity || 0, item?.pairDetail?.firstFloatDigit, "—")}
                      </td>
                      <td className={spot.tabular_nums}>
                        {formatPrice(item.orderValue || 0, item?.pairDetail?.secondFloatDigit, "—")}
                      </td>
                      <td>
                        <CancelOrder
                          orderInfo={item}
                          onRequestCancel={setPendingCancel}
                          busy={cancelling && isSameOrder(pendingCancel, item)}
                        />
                      </td>
                    </tr>
                  );
                }
              })}
            {loader && (
              <tr>
                <td colSpan={9}>
                  <div className={spot.table_empty}>
                    <i className="fa fa-spinner fa-spin" style={spinner}></i>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </Table>
        {noRecords && (
          <div className="nodata">
            {theme === "light_theme" ? (
              <Image
                src="/assets/images/nodata_light.svg"
                alt="image"
                className="img-fluid"
                width={96}
                height={96}
              />
            ) : (
              <Image
                src="/assets/images/nodata.svg"
                alt="image"
                className="img-fluid"
                width={96}
                height={96}
              />
            )}
            <h6 className="text-center">No records found</h6>
          </div>
        )}
      </InfiniteScroll>
    </div>
  );
}
