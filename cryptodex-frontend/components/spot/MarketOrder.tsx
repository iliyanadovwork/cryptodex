import { useState, useEffect, useContext } from "react";
import Image from "next/image";
import spot from "@/styles/Spot.module.css";
import { useRouter, asPath } from "next/router";
import Link from "next/link";
import styles from "@/styles/common.module.css";
import { Form, InputGroup } from "react-bootstrap";
// import socket 
import SocketContext from "../Context/SocketContext";
//import store
import { useSelector } from "../../store";
//improt lib
import { toFixed, toFixedDown, truncateDecimals } from "@/lib/roundOf";
import { formatBalance, formatPrice, formatQty } from "@/lib/numberFormat";
import isEmpty from "@/lib/isEmpty";
import { encryptObject } from "../../lib/cryptoJS";
import { toastAlert } from "@/lib/toastAlert";
import { removeByObj } from "@/lib/validation";
//improt types
import { MarketFormValues } from "./types";
//improt serviec
import { apiOrderPlace } from "../../services/Spot/SpotService";
//import book health
import { useSpotBookHealth } from "@/hooks/useSpotBookHealth";
//import balance pre-flight
import { affordabilityError } from "@/lib/affordability";

let initialBuyValue: MarketFormValues = {
  orderValue: ""
};

let initialSellValue: MarketFormValues = {
  amount: ""
};

export default function MarketOrder({ activeTab }: any) {
  const router = useRouter();
  const socketContext = useContext<any>(SocketContext);

  const isLogin = useSelector((state: any) => state.auth.session.signedIn);
  const { firstCurrency, secondCurrency, tradePair, marketData } = useSelector(
    (state: any) => state.spot
  );
  const [isClient, setIsClient] = useState(false);
  const [buyFormValue, setBuyFormvalue] =
    useState<MarketFormValues>(initialBuyValue);
  const [sellFormValue, setSellFormvalue] =
    useState<MarketFormValues>(initialSellValue);
  const [orderSide, setOrderSide] = useState<string>("");
  const [error, setError] = useState<any>({});
  const [mData, setMData] = useState<any>({});
  const [loader, setLoader] = useState<boolean>(false);
  // A market order with no book behind it is the exact order the reviewer could
  // still submit: it can only ever be rejected.
  const { tradingPaused, note: pausedNote } = useSpotBookHealth();


  useEffect(() => {
    // socket
    // socketContext.spotSocket.on("marketPrice", (result: any) => {
    //   if (tradePair._id == result.pairId) {
    //     setMData(result?.data);
    //   }
    // });
    setMData(marketData)
  }, [tradePair, marketData]);
  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    type: string
  ) => {
    let { value, name } = e.target;
    setLoader(false);
    if (
      name === "orderValue" &&
      value.split(".")[1] &&
      value.split(".")[1].length > tradePair.secondFloatDigit
    ) {
      return;
    } else if (
      name === "amount" &&
      value.split(".")[1] &&
      value.split(".")[1].length > tradePair.firstFloatDigit
    ) {
      return;
    }
    if (!isEmpty(value) && !/^\d*\.?\d*$/.test(value)) {
      return;
    }
    setError(removeByObj(error, name));
    if (type == "buy") {
      setBuyFormvalue({ ...buyFormValue, ...{ [name]: value } });
    } else {
      setSellFormvalue({ ...sellFormValue, ...{ [name]: value } });
    }
  };


  const handleSubmit = async (e: any, type: string = "buy") => {
    try {
      e.preventDefault();
      // Belt and braces: the button is disabled, but a keyboard submit or a
      // verdict that lands mid-click must not slip an order through either.
      if (tradingPaused) {
        return toastAlert("error", pausedNote, "orderPlace");
      }
      let side: string = type == "buy" ? "orderValue" : "amount";
      let reqData = {
        [side]: type == "buy" ? buyFormValue.orderValue : sellFormValue.amount,
        buyorsell: type,
        orderType: "market",
        spotPairId: tradePair._id,
        newdate: new Date(),
      };
      setOrderSide(type);

      if (type == "buy") {
        if (isEmpty(reqData.orderValue)) {
          return toastAlert(
            "error",
            "Order Value field is required",
            "orderPlace"
          );
        } else if (isNaN(reqData.orderValue)) {
          return toastAlert(
            "error",
            "Order Value allow only numeric",
            "orderPlace"
          );
        } else if (parseFloat(reqData.orderValue) < 0) {
          return toastAlert(
            "error",
            "Order Value allow only positive value",
            "orderPlace"
          );
        }
      } else {
        if (isEmpty(reqData.amount)) {
          return toastAlert("error", "Quantity field is required", "orderPlace");
        } else if (isNaN(reqData.amount)) {
          return toastAlert("error", "Quantity allow only numeric", "orderPlace");
        } else if (parseFloat(reqData.amount) < 0) {
          return toastAlert(
            "error",
            "Quantity allow only positive value",
            "orderPlace"
          );
        }
      }
      // The "Available" figure is printed two rows above this button. Sending
      // an order this form can already see is unaffordable can only come back
      // saying so — and when the account's balance row has never been written
      // the server's affordability check deliberately fails open and answers
      // with the LIQUIDITY message instead. See lib/affordability: this is a
      // pre-flight on our own displayed number, never a rewrite of a server
      // verdict.
      const cannotAfford = affordabilityError(
        type == "buy"
          ? {
              // A market BUY is sized in the quote currency already.
              required: reqData.orderValue,
              available: secondCurrency?.spotBal,
              symbol: tradePair?.secondCurrencySymbol,
              // The same precision the "Available" figure is printed to, so a
              // user who types exactly what the ticket shows is never refused.
              precision: tradePair?.secondFloatDigit,
            }
          : {
              // A market SELL spends the base currency.
              required: reqData.amount,
              available: firstCurrency?.spotBal,
              symbol: tradePair?.firstCurrencySymbol,
              precision: tradePair?.firstFloatDigit,
            }
      );
      if (cannotAfford) {
        return toastAlert("error", cannotAfford, "orderPlace");
      }
      setLoader(true);
      let encryptToken: any = {
        token: await encryptObject(reqData),
      };
      const result: any = await apiOrderPlace(encryptToken);
      setLoader(false);
      if (result.data.status) {
        toastAlert("success", result.data.message, "orderPlace");
        setBuyFormvalue(initialBuyValue);
        setSellFormvalue(initialSellValue);
        setError({});
        setOrderSide("");
      } else {
        // order was rejected — surface it as an error, not a green success toast
        toastAlert("error", result.data.message, "orderPlace");
      }
    } catch (err: any) {
      setLoader(false);
      if (!isEmpty(err?.response?.data?.message))
        toastAlert("error", err.response.data.message, "orderPlace");
      if (err?.response?.data?.errors) {
        setError(err.response.data.errors);
      }
    }
  };

  useEffect(() => {
    setIsClient(true);
  }, []);




  /**
   * WHAT THE ORDER IS LIKELY TO GET YOU.
   *
   * The limit ticket computes a Total from what you type, so a number there has
   * a visible consequence. This ticket computed nothing: you entered a figure
   * and the form said nothing about what it buys. It is the market form's
   * equivalent of that Total.
   *
   * An ESTIMATE, and it says so. The fill is re-derived against the resting
   * ladder (spot.controller.js:5327-5339), so this is markPrice arithmetic for
   * orientation rather than a quote - which is why the price slot beside it
   * reads "Market" rather than showing a number.
   */
  const estimate = (raw: any, mode: "buy" | "sell") => {
    const px = parseFloat(mData?.markPrice);
    const n = parseFloat(raw);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(n) || n <= 0) return null;
    const digits =
      mode === "buy" ? tradePair?.firstFloatDigit : tradePair?.secondFloatDigit;
    const symbol =
      mode === "buy"
        ? tradePair?.firstCurrencySymbol
        : tradePair?.secondCurrencySymbol;
    const value = mode === "buy" ? n / px : n * px;
    return `≈ ${toFixedDown(value, digits ?? 8)} ${symbol ?? ""}`.trim();
  };

  /**
   * A share of the balance the ticket is already showing.
   *
   * Read from the same figure printed under "Available" and truncated to the
   * same precision, so pressing 100% cannot produce a number the affordability
   * pre-flight then refuses over a rounding tail.
   */
  const applyPercent = (pct: number, mode: "buy" | "sell") => {
    const bal = mode === "buy" ? secondCurrency?.spotBal : firstCurrency?.spotBal;
    const digits =
      mode === "buy" ? tradePair?.secondFloatDigit : tradePair?.firstFloatDigit;
    const n = parseFloat(bal);
    if (!Number.isFinite(n) || n <= 0) return;
    const next = toFixedDown((n * pct) / 100, digits ?? 8);
    if (mode === "buy") setBuyFormvalue({ ...buyFormValue, orderValue: next });
    else setSellFormvalue({ ...sellFormValue, amount: next });
  };

  const PercentRow = ({ mode }: { mode: "buy" | "sell" }) => (
    <div className={spot.pct_row}>
      {[25, 50, 75, 100].map((pct) => (
        <button
          key={pct}
          type="button"
          className={spot.pct_btn}
          disabled={tradingPaused}
          onClick={() => applyPercent(pct, mode)}
        >
          {pct}%
        </button>
      ))}
    </div>
  );

  return (
    <div className={spot.orderform_bookwrap}>
      {activeTab == "buy" ? (
        <div className={spot.orderform_bookwrap_inner}>
          <div className={spot.place_order_bal}>
            <label>Available</label>
            <span className={spot.tabular_nums}>
              {!isEmpty(secondCurrency?.spotBal)
                ? formatBalance(
                  secondCurrency.spotBal,
                  tradePair?.secondFloatDigit,
                  "0"
                )
                : isClient
                  ? "0"
                  : "—"}{" "}
              <small>{tradePair?.secondCurrencySymbol}</small>
            </span>
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Price
              </InputGroup.Text>
              <InputGroup>
                {/* THE WORD, NOT A NUMBER.
                    A market order has no price until it fills, so this says so.
                    It showed markPrice, which is a 30-second reference figure
                    the order does not price from - and a number in a price slot
                    on an order ticket reads as a quote. The reference is still
                    in the header, labelled and updating identically. While the
                    book is out it shows a dash: there is nothing to execute
                    against at all. */}
                <Form.Control
                  placeholder=""
                  type="text"
                  className={spot.input_box}
                  disabled
                  name="market"
                  value={tradingPaused ? "—" : "Market"}
                />
              </InputGroup>
            </div>
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Buying order value
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  className={spot.input_box}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleChange(e, "buy")
                  }
                  name="orderValue"
                  value={buyFormValue.orderValue}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.secondCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            <PercentRow mode="buy" />
            {estimate(buyFormValue.orderValue, "buy") && (
              <p className={spot.est_line} data-testid="market-estimate-buy">
                You receive{" "}
                <span className={spot.tabular_nums}>
                  {estimate(buyFormValue.orderValue, "buy")}
                </span>
              </p>
            )}
            {orderSide == "buy" && (
              <p className="text-danger">{error?.orderValue}</p>
            )}
          </div>

          {/* <div className={spot.tot_flx}>
            <span>Total</span>
            <p className="mb-0">
              {parseFloat(buyFormValue.orderValue) > 0
                ? toFixedDown(
                  parseFloat(buyFormValue.orderValue),
                  tradePair?.secondFloatDigit
                )
                : 0.0}
              <span className="ms-2">{tradePair?.secondCurrencySymbol}</span>
            </p>
          </div> */}
          <div className={`${spot.form_box}`}>
            {isClient && tradingPaused && (
              <p className={spot.trade_paused_note} role="status" data-testid="ticket-paused-note">
                {pausedNote}
              </p>
            )}
            {isClient && isLogin ? (
              <button
                className={spot.order_buy_btn}
                onClick={(e) => handleSubmit(e, "buy")}
                disabled={tradingPaused || (orderSide == "buy" && loader)}
              >
                {loader && orderSide == "buy" ? (
                  <i className="fa fa-spinner fa-spin"></i>
                ) : (
                  "Buy"
                )}
              </button>
            ) : isClient ? (
              <button
                className={`${styles.animate} ${styles.primary_btn} w-100 d-block text-center`}
                onClick={() => router.push("/login")}
              >
                <label>Log In / Register </label>
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={spot.orderform_bookwrap_inner}>
          <div className={spot.place_order_bal}>
            <label>Available</label>
            <span className={spot.tabular_nums}>
              {!isEmpty(firstCurrency?.spotBal)
                ? formatBalance(firstCurrency.spotBal, tradePair.firstFloatDigit, "0")
                : isClient
                  ? "0"
                  : "—"}{" "}
              <small>{tradePair?.firstCurrencySymbol}</small>
            </span>
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Price
              </InputGroup.Text>
              <InputGroup>
                {/* See the buy side: a market order has no price until it
                    fills, so the slot says so rather than showing a reference
                    figure the order does not price from. */}
                <Form.Control
                  placeholder=""
                  type="text"
                  className={spot.input_box}
                  disabled
                  name="market"
                  value={tradingPaused ? "—" : "Market"}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.secondCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Selling amount
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  className={spot.input_box}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleChange(e, "sell")
                  }
                  name="amount"
                  value={sellFormValue.amount}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.firstCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            <PercentRow mode="sell" />
            {estimate(sellFormValue.amount, "sell") && (
              <p className={spot.est_line} data-testid="market-estimate-sell">
                You receive{" "}
                <span className={spot.tabular_nums}>
                  {estimate(sellFormValue.amount, "sell")}
                </span>
              </p>
            )}
            {orderSide == "sell" && (
              <p className="text-danger">{error?.amount}</p>
            )}
          </div>
          {/* <div className={spot.tot_flx}>
            <span>Total</span>
            <p className="mb-0">
              {parseFloat(sellFormValue.amount) > 0
                ? toFixedDown(
                  parseFloat(sellFormValue.amount),
                  tradePair?.firstFloatDigit
                )
                : 0.0}
              <span className="ms-2">{tradePair?.firstCurrencySymbol}</span>
            </p>
          </div> */}
          <div className={`${spot.form_box}`}>
            {isClient && tradingPaused && (
              <p className={spot.trade_paused_note} role="status" data-testid="ticket-paused-note">
                {pausedNote}
              </p>
            )}
            {isClient && isLogin ? (
              <button
                className={spot.order_sell_btn}
                onClick={(e) => handleSubmit(e, "sell")}
                disabled={tradingPaused || (orderSide == "sell" && loader)}
              >
                {loader && orderSide == "sell" ? (
                  <i className="fa fa-spinner fa-spin"></i>
                ) : (
                  "Sell"
                )}
              </button>
            ) : isClient ? (
              <button
                className={`${styles.animate} ${styles.primary_btn} w-100 d-block text-center`}
                onClick={() => router.push("/login")}
              >
                <label>Log In / Register </label>
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
