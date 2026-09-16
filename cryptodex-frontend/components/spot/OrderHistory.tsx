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
import { getOrderHistory } from "../../services/Spot/SpotService";
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
export default function OrderHistory() {
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
      const { status, loading, result } = await getOrderHistory(
        reqData,
        pairId
      );

      setLoader(loading);
      if (status == "success") {
        // Page 1 replaces, later pages append, de-duplicated by id - see
        // lib/pagedTable.ts. `[...data, ...]` appended the NEW pair's first
        // page to the OLD pair's rows on a pair switch, because this closure
        // still holds the `data` from the render the effect fired on.
        const orderedData = mergePage(data, result.data, result.currentPage).sort((a: any, b: any) => {
          // `.getTime()`, as the socket handler further down already does.
          // `Date - Date` is the same number at runtime (both sides go through
          // valueOf) but it is a type error, and it was the only one tsc
          // reported in this file.
          return new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime();
      }
      );
        setOrderData({
          currentPage: result.currentPage,
          nextPage: result.nextPage,
          limit: result.limit,
          count: result.count,
          data: orderedData,
        });
      } else {
        setOrderData({
          ...orderData,
          ...{ nextPage: false },
        });
      }
    } catch (err) { }
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
        toastAlert("success", "Order ID copied to clipboard", "login");
    
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
            limit
        }
        fetchOrderHistory(reqData, tradePair._id)
        setOrderData(initialValues)

        // socket
        socketContext.spotSocket.on("orderHistory", (result: any) => {

            if (isEmpty(result) || isEmpty(result.data)) return;
            const existingData = [...data, ...result.data];

            const uniqueMap = new Map();
            existingData.forEach((item: any) => {
              uniqueMap.set(item._id, item); 
            });
            
            const uniqueData = Array.from(uniqueMap.values());
            
            const orderData = uniqueData.sort((a: any, b: any) => {
              return new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime();
            });


            if (result.pairId == tradePair._id) {
                setOrderData({
                    currentPage: result.currentPage,
                    nextPage: result.nextPage,
                    limit: result.limit,
                    count: result.count,
                    data: orderData,
                });
            }
        });
        return () => {
            socketContext.spotSocket.off("orderHistory");
        }
    }
}, [tradePair, isLogin])
  
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
              <th>Order Time</th>
              <th>Pair</th>
              <th>Type</th>
              {/* <th>Order ID</th> */}
              <th>Side</th>
              <th>Executed Price</th>
              <th>Price</th>
              <th>Executed</th>
              <th>Amount</th>
              <th>Total Order Value</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {!loader &&
              data?.length > 0 &&
              data.map((item: any, index: number) => {
                // Keyed by the ORDER, not the row's position. This list
                // prepends (newest first) and is re-sorted wholesale by the
                // socket handler above, so an index key hands a row's identity
                // to whatever slides into its slot - the same defect that made
                // the open-order cancel dialog act on the wrong order.
                return (
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
                      {" "}{item.orderCode} {" "}
                    </td> */}
                    <td>{capitalize(item.buyorsell)}</td>
                    <td className={spot.tabular_nums}>
                      {" "}
                      {(item.status == "cancel" || item.status == "open") ? "-" : item.averagePrice > 0
                        ? formatPrice(item.averagePrice / item.filledQuantity, tradePair.secondFloatDigit, "—")
                        : "-"}
                    </td>
                    <td className={spot.tabular_nums}>
                      {item.orderType == "market"
                        ? "Market"
                        : item.price > 0
                          ? formatPrice(item.price, tradePair.secondFloatDigit, "—")
                          : "-"}
                    </td>
                    <td className={spot.tabular_nums}>
                      {formatQty(item.filledQuantity, tradePair.firstFloatDigit, "—")}
                    </td>
                    <td className={spot.tabular_nums}>
                      {item.orderType == "market" && item.buyorsell == "buy"
                        ? formatQty(item.filledQuantity, tradePair.firstFloatDigit, "—")
                        : formatQty(item.openQuantity, tradePair.firstFloatDigit, "—")}
                    </td>
                    <td className={spot.tabular_nums}>
                      {item.averagePrice == 0 && item.filledQuantity > 0
                        ? formatPrice(item.price * item.openQuantity, tradePair.secondFloatDigit, "—")
                        : item.filledQuantity > 0
                          ? formatPrice(item.averagePrice ? item.averagePrice : item.price * item.filledQuantity, tradePair.secondFloatDigit, "—")
                          : "-"}
                    </td>
                    {item.status == "cancel" && <td>Cancelled</td>}
                    {item.status != "cancel" && <td>{capitalize(item.status)}</td>}
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
