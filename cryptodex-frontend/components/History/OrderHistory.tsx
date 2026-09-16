import styles from "@/styles/common.module.css";
import { Dropdown, Table } from "react-bootstrap";
import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
// import services
import { apiGetMySpotHistory } from "@/services/history.service";
//import component
const Pagination = dynamic(() => import("@/lib/pagination"), { ssr: false });
//import lib
import { dateTimeFormat } from "@/lib/dateTimeHelper";
import { formatPrice, formatQty } from "@/lib/numberFormat";
import { capitalize } from "@/lib/stringCase";
import isEmpty from "@/lib/isEmpty";
//import store
import { useSelector } from "@/store";
import Image from "next/image";
import { useTheme } from "next-themes";
import { toastAlert } from "@/lib/toastAlert";

const initialFormValue = {
  page: 1,
  limit: 5,
  search: "",
  pairName: "all",
  orderType: "all",
  buyorsell: "all",
  status: "all",
};

const spinner: React.CSSProperties = {
  fontSize: "36px",
};
const IconStyle: React.CSSProperties = {
  color: "#FDE573",
};

/**
 * Decimals for a size in this row's base currency.
 *
 * Each history row carries the pair's own precision (firstFloatDigit /
 * secondFloatDigit are written onto the record at order time), so nothing here
 * needs the live pair list — which is just as well, because /history renders
 * rows for pairs that may no longer be on it. 8 is the fallback because BTC is
 * the tightest thing traded here and a satoshi is the natural floor.
 */
export const qtyDigits = (item: any): number => {
  const n = parseInt(item?.firstFloatDigit, 10);
  return Number.isFinite(n) && n >= 0 ? n : 8;
};

/** Decimals for a price, in this row's quote currency. */
export const priceDigits = (item: any): number => {
  const n = parseInt(item?.secondFloatDigit, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
};

/**
 * What the order actually filled at.
 *
 * `averagePrice` on the history record is the total consideration for the fills
 * (quote currency), so the per-unit executed price is averagePrice /
 * filledQuantity. A limit order that never filled still has its own limit price
 * to show; a market order that never filled has nothing, and says so with a
 * dash rather than by repeating its order type as if it were a price.
 */
export const executedPrice = (item: any): string => {
  const filled = parseFloat(item?.filledQuantity);
  const avg = parseFloat(item?.averagePrice);
  if (Number.isFinite(filled) && filled > 0 && Number.isFinite(avg) && avg > 0) {
    return formatPrice(avg / filled, priceDigits(item), "—");
  }
  if (item?.orderType != "market") {
    return formatPrice(item?.price, priceDigits(item), "—");
  }
  return "—";
};

/**
 * How much of the order is still outstanding.
 *
 * An unfilled MARKET buy is sized in quote currency, not in base, so
 * `openQuantity - filledQuantity` is a subtraction across two different units
 * and its result is meaningless — which is why the original special-cased it to
 * 0. Kept, but clamped: a fill that slightly overshoots openQuantity must not
 * print a negative "remaining".
 */
export const remainingQuantity = (item: any): number => {
  if (item?.orderType == "market" && item?.buyorsell == "buy") return 0;
  const open = parseFloat(item?.openQuantity);
  const filled = parseFloat(item?.filledQuantity);
  if (!Number.isFinite(open)) return 0;
  const remaining = open - (Number.isFinite(filled) ? filled : 0);
  return remaining > 0 ? remaining : 0;
};
export default function OrderHistory() {
  // state
  const [count, setcount] = useState(0);
  const [data, setData] = useState([]);
  const [loader, setLoader] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [filter, setFilter] = useState(initialFormValue);
  const { pairList } = useSelector((state: any) => state.spot);
  const [copiedItems, setCopiedItems] = useState<any>({});
  const { theme, setTheme } = useTheme();
  // function
  const fetchOrderHistory = async (filter: any) => {
    try {
      const respData: any = await apiGetMySpotHistory(filter);
      if (respData.data.result.data) {
        setData(respData.data.result.data);
        setcount(respData.data.result.count);
        setLoader(false);
      }
    } catch (err) {
      console.log(err, "err");
      setLoader(false);
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
      .catch(() => {});
  };

  useEffect(() => {
    setFilter({ ...filter, page: currentPage });
    setData([]);
    setLoader(true);
  }, [currentPage]);

  useEffect(() => {
    fetchOrderHistory(filter);
  }, [filter]);

  const handleSearch = (e: any) => {
    e.preventDefault();
    fetchOrderHistory(filter);
  };

  const handleReset = (e: any) => {
    e.preventDefault();
    setFilter(initialFormValue);

    fetchOrderHistory(initialFormValue);
  };
  const handleSide = (e: string) => {
    setFilter({ ...filter, ["buyorsell"]: e });
  };
  const handleStatus = (e: string) => {
    setFilter({ ...filter, ["status"]: e });
  };
  const handleOrderType = (e: string) => {
    setFilter({ ...filter, ["orderType"]: e });
  };

  return (
    <>
      <div className={`${styles.table_box_flx} mw-75 border-0`}>
        {/* A "Pair" filter stood here. It was built from pairList, so on a
            venue listing one market it offered exactly two choices - "All" and
            "BTCUSD" - which return the same rows. `pairName: "all"` is still
            sent with the filter below, so the request shape is unchanged and
            the filter would come back on its own if a second market were ever
            listed. */}
        <div>
          <label>Order Type</label>
          <Dropdown
            className={`${styles.drp_down}`}
            onSelect={(e: any) => handleOrderType(e)}
          >
            <Dropdown.Toggle variant="primary" className="ms-0">
              {!isEmpty(filter) && filter.orderType != undefined
                ? capitalize(filter.orderType)
                : "All"}
            </Dropdown.Toggle>
            <Dropdown.Menu>
              <Dropdown.Item eventKey="all">All</Dropdown.Item>
              <Dropdown.Item eventKey="limit">Limit</Dropdown.Item>
              <Dropdown.Item eventKey="market">Market</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
        </div>
        <div>
          <label>Side </label>
          <Dropdown
            className={`${styles.drp_down}`}
            onSelect={(e: any) => handleSide(e)}
          >
            <Dropdown.Toggle variant="primary" className="ms-0">
              {!isEmpty(filter) && filter.buyorsell != undefined
                ? capitalize(filter.buyorsell)
                : "All"}
            </Dropdown.Toggle>
            <Dropdown.Menu>
              <Dropdown.Item eventKey="all">All</Dropdown.Item>
              <Dropdown.Item eventKey="buy">Buy</Dropdown.Item>
              <Dropdown.Item eventKey="sell">Sell</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
        </div>
        <div>
          <label>Status </label>
          <Dropdown
            className={`${styles.drp_down}`}
            onSelect={(e: any) => handleStatus(e)}
          >
            <Dropdown.Toggle variant="primary" className="ms-0">
              {!isEmpty(filter) && filter.status != undefined
                ? capitalize(filter.status)
                : "All"}
            </Dropdown.Toggle>
            <Dropdown.Menu>
              <Dropdown.Item eventKey="all">All</Dropdown.Item>
              <Dropdown.Item eventKey="open">Open</Dropdown.Item>
              <Dropdown.Item eventKey="completed">Completed</Dropdown.Item>
              <Dropdown.Item eventKey="cancel">Cancelled</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
        </div>
        {/* <div className="w-auto">
          <button
            className={`${styles.dark} ${styles.primary_btn}`}
            onClick={handleSearch}
          >
            <label>Search</label>
          </button>
        </div> */}
        <div className="w-auto">
          <button className={`${styles.clear_btn}`} onClick={handleReset}>
            <label>Clear</label>
            <Image
              src="/assets/images/clear_icon.png"
              className="img-fluid me-3"
              alt="img"
              width={16}
              height={17}
            />
          </button>
        </div>
      </div>

      <div className={`mb-3 ${styles.table_box}`}>
        <Table responsive borderless>
          <thead>
            <tr>
              <th>Order Time</th>
              {/* <th>Order ID</th> */}
              <th className="pe-5">Trade Type </th>
              <th>Price</th>
              <th>Quantity</th>
              <th>Filled / Remaining </th>
              {/* <th>Transaction ID</th> */}
              <th>Side</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loader ? (
              <tr>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td colSpan={7}>
                  <i className="fa fa-spinner fa-spin" style={spinner}></i>
                </td>
              </tr>
            ) : data?.length > 0 ? (
              data.map((item: any, key: number) => {
                // Identity, not position: the pair filter and the
                // pager both replace this set wholesale.
                return (
                  <tr key={item._id || key}>
                    <td>{dateTimeFormat(item.orderDate)}</td>
                    {/* <td>
                      <i
                        className={copiedItems[key] ? 'fas fa-check' : 'far fa-copy'}
                        onClick={() => {
                          if (copiedItems[key]) return;
                          return handleCopy(key, item.orderCode)
                        }}
                        style={IconStyle}
                      ></i> {" "} {item.orderCode}
                    </td> */}
                    <td>
                      {item.orderType == "limit"
                        ? "Limit"
                        : item.orderType == "market"
                          ? "Market"
                          : "Stop Limit"}
                    </td>
                    {/* PRICE, NOT THE WORD "MARKET".
                        Every market row in this column printed the literal
                        string "Market" — which the Trade Type column one cell
                        to the left already says. So the one place a user looks
                        to find out what a market order actually FILLED AT
                        showed no price at all, for every market order they had
                        ever placed. The fill price is on the record:
                        averagePrice is the total consideration, so the executed
                        price is averagePrice / filledQuantity (the same
                        derivation /spot's own order history already uses).
                        "Market" survives only for an order with no fill to
                        report, where there genuinely is no price yet. */}
                    <td data-testid="order-price">
                      {executedPrice(item)}
                    </td>
                    {/* Sizes were truncated to a hardcoded 4dp, so a 0.00008
                        BTC order — an ordinary size at $64k — rendered as
                        "0.0001", and anything smaller as a flat "0.0000". Each
                        row carries its own pair precision; use it. */}
                    <td data-testid="order-quantity">
                      {formatQty(
                        item.orderType == "market"
                          ? item.filledQuantity
                          : item.openQuantity,
                        qtyDigits(item),
                        "—"
                      )}
                    </td>
                    <td>
                      {formatQty(item.filledQuantity, qtyDigits(item), "—")}/
                      {formatQty(remainingQuantity(item), qtyDigits(item), "—")}
                    </td>
                    {/* <td>{item._id}</td> */}
                    <td>{capitalize(item.buyorsell)}</td>
                    <td
                      className={
                        item.status == "cancel"
                          ? "text-red"
                          : item.status == "completed"
                            ? "text-green"
                            : ""
                      }
                    >
                      {" "}
                      {item.status == "cancel"
                        ? "Cancelled"
                        : capitalize(item.status)}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={12}>
                  <div className="d-flex flex-column gap-3 align-items-center m-5">
                    {theme === "light_theme" ? (
                      <Image
                        src="/assets/images/nodata_light.svg"
                        alt="No data"
                        className="img-fluid"
                        width={96}
                        height={96}
                      />
                    ) : (
                      <Image
                        src="/assets/images/nodata.svg"
                        alt="No data"
                        className="img-fluid"
                        width={96}
                        height={96}
                      />
                    )}
                    <h6>No Records Found</h6>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </Table>
        {count > 0 && (
          <Pagination
            currentPage={currentPage}
            totalCount={count}
            pageSize={5}
            onPageChange={(page: number) => setCurrentPage(page)}
          />
        )}
      </div>
    </>
  );
}
