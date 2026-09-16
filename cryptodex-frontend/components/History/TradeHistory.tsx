import styles from "@/styles/common.module.css";
import { Dropdown, Table } from "react-bootstrap";
import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
// import services
import { apiGetMyTradeHistory } from "@/services/history.service";
//import component
const Pagination = dynamic(() => import("@/lib/pagination"), { ssr: false });
//import lib
import { dateTimeFormat } from "@/lib/dateTimeHelper";
// NOT `toFixed` from roundOf. That is Number.prototype.toFixed: a fixed four
// decimal places that ROUNDS, so this table showed 0.0155 for the same fill the
// trade page showed as 0.01553693. See lib/historyPrecision.
import { formatPrice, formatQty } from "@/lib/numberFormat";
import { qtyDigitsFor, priceDigitsFor } from "@/lib/historyPrecision";
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
export default function TradeHistory() {
  // state
  const [count, setcount] = useState(0);
  const [data, setData] = useState([]);
  const [loader, setLoader] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [filter, setFilter] = useState(initialFormValue);
  const { pairList } = useSelector((state: any) => state.spot);
  const { _id } = useSelector((state: any) => state.auth.user);
  const { theme, setTheme } = useTheme();
  const [copiedItems, setCopiedItems] = useState<any>({});
  // function
  const fetchOrderHistory = async (filter: any) => {
    try {
      const respData: any = await apiGetMyTradeHistory(filter);
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
  return (
    <div className={`mb-3 ${styles.table_box}`}>
      <div className={`${styles.table_box_flx} mw-75 border-0`}>
        {/* A "Pair" filter stood here. It was built from pairList, so on a
            venue listing one market it offered exactly two choices - "All" and
            "BTCUSD" - which return the same rows. `pairName: "all"` is still
            sent with the filter below, so the request shape is unchanged and
            the filter would come back on its own if a second market were ever
            listed. */}

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

      <Table responsive borderless>
        <thead>
          <tr>
            <th>Order No.</th>
            <th>Date</th>
            {/* <th>Transaction ID</th> */}
            <th>Price</th>
            <th>Quantity</th>
            <th>Total Order Value</th>
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
                  <td>
                    <i
                      className={copiedItems[key] ? 'fas fa-check' : 'far fa-copy'}
                      onClick={() => {
                        if (copiedItems[key]) return;
                        return handleCopy(key, item.buyUserId == _id ? item.buyOrdCode : item.sellOrdCode)
                      }}
                      style={IconStyle}
                    ></i> {" "} {item.buyUserId == _id ? item.buyOrdCode : item.sellOrdCode}
                  </td>
                  <td>{dateTimeFormat(item.createdAt)}</td>
                  {/* <td>{item._id}</td> */}
                  <td className={styles.tabular_nums}>
                    {formatPrice(
                      item.tradePrice,
                      priceDigitsFor(item, pairList),
                      "—"
                    )}
                  </td>
                  <td className={styles.tabular_nums}>
                    {formatQty(item.tradeQty, qtyDigitsFor(item, pairList), "—")}
                  </td>
                  <td className={styles.tabular_nums}>
                    {formatPrice(
                      item.tradePrice * item.tradeQty,
                      priceDigitsFor(item, pairList),
                      "—"
                    )}
                  </td>
                  <td>{item && item.buyUserId == _id ? "Buy" : "Sell"}</td>
                  <td
                    className={
                      item.status == "cancel"
                        ? "text-red"
                        : item.status == "completed"
                          ? "text-green"
                          : ""
                    }
                  >
                    {capitalize(item.status)}
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
  );
}
