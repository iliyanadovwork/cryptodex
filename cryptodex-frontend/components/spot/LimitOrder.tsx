import { useState, useEffect, useContext } from "react";

import spot from "@/styles/Spot.module.css";
import styles from "@/styles/common.module.css";
import { useRouter } from "next/router";
import { Form, InputGroup } from "react-bootstrap";
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
import { LimitFormValues } from "./types";
//improt serviec
import { apiOrderPlace } from "../../services/Spot/SpotService";
//import book health
import { useSpotBookHealth } from "@/hooks/useSpotBookHealth";
//import balance pre-flight
import { affordabilityError } from "@/lib/affordability";

let initialBuyValue: LimitFormValues = {
  price: "0",
  quantity: "0",
  total: "0"
};
let initialSellValue: LimitFormValues = {
  price: "0",
  quantity: "0",
  total: "0"
};

export default function LimitOrder({ activeTab }: any) {
  const router = useRouter();
  const isLogin = useSelector((state: any) => state.auth.session.signedIn);
  const {
    firstCurrency,
    secondCurrency,
    tradePair,
    marketData,
    orderBookPrice,
  } = useSelector((state: any) => state.spot);
  const [isClient, setIsClient] = useState(false);
  const [buyFormValue, setBuyFormvalue] =
    useState<LimitFormValues>(initialBuyValue);
  const [sellFormValue, setSellFormvalue] =
    useState<LimitFormValues>(initialSellValue);
  const [orderSide, setOrderSide] = useState<string>("");
  const [error, setError] = useState<any>({});
  const [loader, setLoader] = useState<boolean>(false);
  // A resting limit order still needs a book to rest in: when the ladder is
  // gone nothing on the other side can ever match it, so the ticket says so
  // instead of accepting an order that cannot fill.
  const { tradingPaused, note: pausedNote } = useSpotBookHealth();

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    type: string
  ) => {
    let { value, name } = e.target;
    setLoader(false);
    if (
      name === "price" &&
      value.split(".")[1] &&
      value.split(".")[1].length > tradePair.secondFloatDigit
    ) {
      return;
    } else if (
      name === "quantity" &&
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
      if (name === "price") {
        if (isEmpty(value)) {
          let formData = {
            [name]: value,
            quantity: 0,
            total: 0
          };
          setBuyFormvalue({ ...buyFormValue, ...formData });
        } else {
          let bPrice = value
          let bQuantity = buyFormValue.quantity
          let formData = {
            ...buyFormValue, ...{ [name]: value }
          }
          if (!isEmpty(bPrice) && !isEmpty(bQuantity)) {
            let totalPrice = parseFloat(bPrice) * parseFloat(bQuantity);
            formData = { ...formData, ...{ ['total']: toFixed(totalPrice, tradePair.secondFloatDigit) } }
          }
          setBuyFormvalue(formData);
        }
        return;
      }
      let bPrice = buyFormValue.price
      let bQuantity = value
      let formData = {
        ...buyFormValue, ...{ [name]: value }
      }
      if (!isEmpty(bPrice) && !isEmpty(bQuantity)) {
        let totalPrice = parseFloat(bPrice) * parseFloat(bQuantity);
        formData = { ...formData, ...{ ['total']: toFixed(totalPrice, tradePair.secondFloatDigit) } }
      }
      if (name == "quantity") {
      }
      setBuyFormvalue(formData);
    } else {
      if (name === "price") {
        if (isEmpty(value)) {
          let formData = {
            [name]: value,
            quantity: 0,
            total: 0
          };
          setSellFormvalue({ ...sellFormValue, ...formData });
        } else {
          let sPrice = value
          let sQuantity = sellFormValue.quantity
          let formData = {
            ...sellFormValue, ...{ [name]: value }
          }
          if (!isEmpty(sPrice) && !isEmpty(sQuantity)) {
            let totalPrice = parseFloat(sPrice) * parseFloat(sQuantity);
            formData = { ...formData, ...{ ['total']: toFixed(totalPrice, tradePair.secondFloatDigit) } }
          }
          setSellFormvalue(formData);
        }
        return;
      }
      let sPrice = sellFormValue.price
      let sQuantity = value
      let formData = {
        ...sellFormValue, ...{ [name]: value }
      }
      if (!isEmpty(sPrice) && !isEmpty(sQuantity)) {
        let totalPrice = parseFloat(sPrice) * parseFloat(sQuantity);
        formData = { ...formData, ...{ ['total']: toFixed(totalPrice, tradePair.secondFloatDigit) } }
      }
      if (name == "quantity") {
      }
      setSellFormvalue(formData);
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
      let { price, quantity } = type == "buy" ? buyFormValue : sellFormValue;
      let reqData = {
        price: price,
        quantity: quantity,
        buyorsell: type,
        orderType: "limit",
        spotPairId: tradePair._id,
        newdate: new Date(),
      };
      setOrderSide(type);
      if (isEmpty(reqData.price)) {
        return toastAlert("error", "Price field is required", "orderPlace");
      } else if (isNaN(reqData.price)) {
        return toastAlert("error", "Price allow only numeric", "orderPlace");
      } else if (parseFloat(reqData.price) < 0) {
        return toastAlert(
          "error",
          "Price allow only positive value",
          "orderPlace"
        );
      }
      if (isEmpty(reqData.quantity)) {
        return toastAlert("error", "Quantity field is required", "orderPlace");
      } else if (isNaN(reqData.quantity)) {
        return toastAlert("error", "Quantity allow only numeric", "orderPlace");
      } else if (parseFloat(reqData.quantity) < 0) {
        return toastAlert(
          "error",
          "Quantuty allow only positive value",
          "orderPlace"
        );
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
              // A limit buy reserves price x quantity of the quote currency.
              required: parseFloat(reqData.price) * parseFloat(reqData.quantity),
              available: secondCurrency?.spotBal,
              symbol: tradePair?.secondCurrencySymbol,
              // The same precision the "Available" figure is printed to, so a
              // user who types exactly what the ticket shows is never refused.
              precision: tradePair?.secondFloatDigit,
            }
          : {
              // A limit sell reserves the base currency itself.
              required: reqData.quantity,
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
        let initForm = {
          price: type == "buy" ? buyFormValue.price : sellFormValue.price,
          quantity: "0",
          total: "0"
        }
        setBuyFormvalue(initForm);
        setSellFormvalue(initForm);
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
  useEffect(() => {
    if (orderBookPrice && !isEmpty(orderBookPrice)) {
      if (activeTab == "buy") {
        setBuyFormvalue((prev) => {
          return { ...prev, price: toFixed(orderBookPrice, tradePair.secondFloatDigit) };
        });
      } else {
        // A limit PRICE is denominated in the quote currency, so it rounds to
        // secondFloatDigit - same as the buy branch above and the markPrice
        // effect below. Using firstFloatDigit (base precision) here made the
        // same order-book click render a different price on the Sell tab than
        // the Buy tab (e.g. "50000.120000" vs "50000.12"), and on a pair whose
        // quote needs more decimals than the base it truncated the price.
        setSellFormvalue((prev) => {
          return { ...prev, price: toFixed(orderBookPrice, tradePair.secondFloatDigit) };
        });
      }
    }
  }, [orderBookPrice]);
  useEffect(() => {
    if (tradePair && !isEmpty(tradePair)) {
      if (activeTab == "buy") {
        setBuyFormvalue((prev) => {
          return { ...prev, price: toFixed(tradePair.markPrice, tradePair.secondFloatDigit) };
        });
        setError({})
      } else {
        setSellFormvalue((prev) => {
          return { ...prev, price: toFixed(tradePair.markPrice, tradePair.secondFloatDigit) };
        });
        setError({})
      }
    }
  }, [tradePair, activeTab]);

  const handleTotal = (e: any, type: string) => {
    e.preventDefault();
    const { name, value } = e.target;
    if (!/^\d*\.?\d*$/.test(value)) {
      return;
    }

    if (
      name === "total" &&
      value.split(".")[1] &&
      value.split(".")[1].length > tradePair.secondFloatDigit
    ) {
      return;
    }

    // if (name == "total" && value == "") {
    //   return
    // }
    if(isEmpty(value)) {
      if (type == "buy") {
        setBuyFormvalue({ ...buyFormValue, ...{ [name]: value, quantity: "0" } });
      }
      if (type == "sell") {
        setSellFormvalue({ ...sellFormValue, ...{ [name]: value, quantity: "0" } });
      }
      return;
    }
    if (type == "buy") {
      let formData = { ...buyFormValue, ...{ [name]: value } };
      if (!isEmpty(formData.price) && !isEmpty(formData.total)) {
        let totalPrice = formData.total / formData.price;
        // toFixedDown, not toFixed: deriving quantity from Total/price and
        // ROUNDING it up makes price*quantity exceed the Total the user typed
        // (and can trip a server insufficient-balance reject on a whole-balance
        // order). Every other quantity derivation in this file truncates.
        formData = { ...formData, ...{ ["quantity"]: toFixedDown(totalPrice, tradePair.firstFloatDigit) } };
      }
      setBuyFormvalue(formData);
    }
    if (type == "sell") {
      let formData = { ...sellFormValue, ...{ [name]: value } };
      if (!isEmpty(formData.price) && !isEmpty(formData.total)) {
        let totalPrice = formData.total / formData.price;
        // toFixedDown for the same reason as the buy branch: truncate the
        // derived quantity so it never implies more than the entered Total.
        formData = { ...formData, ...{ ["quantity"]: toFixedDown(totalPrice, tradePair.firstFloatDigit) } };
      }
      setSellFormvalue(formData);
    }
  };



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
                Buying Price
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  className={spot.input_box}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleChange(e, "buy")
                  }
                  name="price"
                  value={buyFormValue.price}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.secondCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            {orderSide == "buy" && (
              <p className="text-danger">{error?.price}</p>
            )}
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Buying Amount
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  className={spot.input_box}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleChange(e, "buy")
                  }
                  name="quantity"
                  value={buyFormValue.quantity}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.firstCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            {orderSide == "buy" && (
              <p className="text-danger">{error?.quantity}</p>
            )}
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Total Order Value
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  name="total"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleTotal(e, "buy")
                  }
                  className={spot.input_box}
                  value={buyFormValue.total}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.secondCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            {orderSide == "buy" && (
              <p className="text-danger">{error?.total}</p>
            )}
          </div>
          {/* <div className={spot.tot_flx}>
            <span>Total</span>
            <p className="mb-0">
              {parseFloat(buyFormValue.price) *
                parseFloat(buyFormValue.quantity) >
                0
                ? toFixedDown(
                  parseFloat(buyFormValue.price) *
                  parseFloat(buyFormValue.quantity),
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
                Selling Price
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  className={spot.input_box}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleChange(e, "sell")
                  }
                  name="price"
                  value={sellFormValue.price}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.secondCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            {orderSide == "sell" && (
              <p className="text-danger">{error?.price}</p>
            )}
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Selling Amount
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  name="quantity"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleChange(e, "sell")
                  }
                  className={spot.input_box}
                  value={sellFormValue.quantity}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.firstCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            {orderSide == "sell" && (
              <p className="text-danger">{error?.quantity}</p>
            )}
          </div>
          <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Total Order Value
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  name="total"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleTotal(e, "sell")
                  }
                  className={spot.input_box}
                  value={sellFormValue.total}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.secondCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            {orderSide == "sell" && (
              <p className="text-danger">{error?.total}</p>
            )}
          </div>
          {/* <div className={`mb-3 ${spot.form_box}`}>
            <div className={spot.input_grp}>
              <InputGroup.Text className={spot.input_text}>
                Total
              </InputGroup.Text>
              <InputGroup>
                <Form.Control
                  placeholder=""
                  type="number"
                  name="quantity"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleChange(e, "sell")
                  }
                  className={spot.input_box}
                  value={parseFloat(sellFormValue.price) *
                    parseFloat(sellFormValue.quantity) >
                    0
                    ? toFixedDown(
                      parseFloat(sellFormValue.price) *
                      parseFloat(sellFormValue.quantity),
                      tradePair?.secondFloatDigit
                    )
                    : 0.0}
                />
                <InputGroup.Text className={`${spot.input_text} ${spot.dark}`}>
                  {tradePair?.secondCurrencySymbol}
                </InputGroup.Text>
              </InputGroup>
            </div>
            {orderSide == "sell" && (
              <p className="text-danger">{error?.quantity}</p>
            )}
          </div> */}
          {/* <div className={spot.tot_flx}>
            <span>Total</span>
            <p className="mb-0">
              {parseFloat(sellFormValue.price) *
                parseFloat(sellFormValue.quantity) >
                0
                ? toFixedDown(
                  parseFloat(sellFormValue.price) *
                  parseFloat(sellFormValue.quantity),
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
