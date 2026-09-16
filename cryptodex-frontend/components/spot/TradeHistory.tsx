import { useEffect, useState, useContext } from "react";
import { useSelector } from "../../store";
import spot from "@/styles/Spot.module.css";
import { Table } from "react-bootstrap";
import InfiniteScroll from "react-infinite-scroll-component";
import { mergePage, showsNoRecords } from "@/lib/pagedTable";
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
import { getTradeHistory } from "../../services/Spot/SpotService";
import Image from "next/image";
import { useTheme } from "next-themes";
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
export default function TradeHistory() {
  const { theme, setTheme } = useTheme();
  const { tradePair } = useSelector((state: any) => state.spot);
  const socketContext = useContext<any>(SocketContext);
  const isLogin = useSelector((state: any) => state.auth.session.signedIn);
  // state
  const [loader, setLoader] = useState<boolean>(false);
  const [orderData, setOrderData] = useState<any>(initialValues);
  const [copiedItems, setCopiedItems] = useState<any>({});

  const { currentPage, nextPage, limit, count, data } = orderData;

  // This table paints every row it is handed, so its emptiness is the
  // payload's. The empty state is decided here and NOT from `nextPage`, which
  // is a paging flag - see lib/pagedTable.ts.
  const noRecords = showsNoRecords(data);

  // function
  const fetchOrderHistory = async (reqData: any, pairId: string) => {
    try {
      const { status, loading, result } = await getTradeHistory(
        reqData,
        pairId
      );

      setLoader(loading);
      if (status == "success") {
        setOrderData({
          currentPage: result.currentPage,
          nextPage: result.nextPage,
          limit: result.limit,
          count: result.count,
          // Page 1 replaces, later pages append, and a row already held is
          // not added twice - see lib/pagedTable.ts. This was a bare
          // `[...data, ...result.data]`, which on a pair switch appended the
          // NEW pair's first page to the OLD pair's rows: the effect calls
          // setOrderData(initialValues) but this closure still holds the
          // previous render's `data`.
          data: mergePage(data, result.data, result.currentPage),
        });
      } else {
        setOrderData({
          ...orderData,
          ...{ nextPage: false },
        });
      }
    } catch (err) {}
  };

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
    fetchOrderHistory(reqData, tradePair._id);
  };

  const handleCopy = (index: number, id: string) => {    
    navigator.clipboard
      .writeText(id)
      .then(() => {
        setCopiedItems((prevCopiedItems: any) => ({
          ...prevCopiedItems,
          [index]: true,
        }));
        toastAlert("success", "Trade ID copied to clipboard", "login");
    
        setTimeout(() => {
          setCopiedItems((prevCopiedItems: any) => {
            const newCopiedItems = { ...prevCopiedItems };
            delete newCopiedItems[index];
            return newCopiedItems;
          });
        }, 5000);
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (!isEmpty(tradePair._id) && isLogin && !isEmpty(currentPage)) {
      let reqData = {
        page: currentPage,
        limit,
      };
      fetchOrderHistory(reqData, tradePair._id);
      setOrderData(initialValues);

      // socket
      socketContext.spotSocket.on("tradeHistory", (result: any) => {
        if (result.pairId == tradePair._id) {
          setOrderData({
            currentPage: result.currentPage,
            nextPage: result.nextPage,
            limit: result.limit,
            count: result.count,
            data: result.data,
          });
        }
      });
      return () => {
        socketContext.spotSocket.off("tradeHistory");
      };
    }
  }, [tradePair, isLogin]);
  
  if (!isLogin) {
    return (
      <NoAuth />
    )
  }

  return (
    <div className={spot.box}>
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
              <th>Order No.</th>
              <th>Date</th>
              <th>Pair</th>
              <th>Side</th>
              <th>Price</th>
              <th>Executed</th>
              <th>Total Order Value</th>
            </tr>
          </thead>
          <tbody>
            {!loader &&
              data?.length > 0 &&
              data.map((item: any, index: number) => {
                // Keyed by the ORDER, not the row's position. This list
                // prepends (newest first) and is re-sorted wholesale by the
                // socket handler above, so an index key hands a row's
                // identity to whatever slides into its slot - the same
                // defect that made the open-order cancel dialog act on the
                // wrong order.
                return (
                  <tr key={item._id || index}>
                    <td>
                      <i
                        className={copiedItems[index] ? 'fas fa-check' : 'far fa-copy'}
                        onClick={() => {
                          if (copiedItems[index]) return;
                          return handleCopy(index, item.orderCode)
                        }}
                        style={IconStyle}
                      ></i>
                      {" "}{item.orderCode} 
                    </td>
                    <td>
                      {dateTimeFormat(item.createdAt, "YYYY-MM-DD HH:mm")}
                    </td>
                    <td>
                      {item.firstCurrency}/{item.secondCurrency}
                    </td>
                    <td>{capitalize(item.buyorsell)}</td>
                    <td className={spot.tabular_nums}>
                      {formatPrice(item.tradePrice, tradePair.secondFloatDigit, "—")}
                    </td>
                    <td className={spot.tabular_nums}>
                      {formatQty(item.tradeQty, tradePair.firstFloatDigit, "—")}
                    </td>
                    <td className={spot.tabular_nums}>
                      {formatPrice(item.tradePrice * item.tradeQty, tradePair.secondFloatDigit, "—")}
                    </td>
                  </tr>
                );
              })}
            {loader && (
              <tr>
                <td colSpan={10}>
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
