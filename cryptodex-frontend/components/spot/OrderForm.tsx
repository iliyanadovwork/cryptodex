import React, { useState, useEffect, useContext } from "react";
import spot from "@/styles/Spot.module.css";
//import context
import SocketContext from "../../components/Context/SocketContext";
// import style from "@/styles/template.module.css";
import { Tab } from "react-bootstrap";
//import store
import { useSelector, useDispatch } from "../../store";
//improt store
import {
  setFirstCurrency,
  setSecondCurrency,
} from "../../store/trade/dataSlice";
//import component
import LimitOrder from "./LimitOrder";
import MarketOrder from "./MarketOrder";

/**
 * "USING CRYPTODEX FOR FEES" IS GONE, AND THE FEES THEMSELVES ARE NOT.
 * =================================================================
 * The ordinary maker/taker fee still applies to every fill and is still
 * printed below; only the pay-the-fee-in-CRYPTODEX option was withdrawn.
 *
 * It was a switch that could not move a number. End to end it ran:
 *
 *   this toggle -> PUT user/setting/updateCryptodexFee
 *               -> UserSetting.enableCryptodexFee in mongo + redis
 *               -> spotapi `deductCryptodex`, on every fill
 *
 * and `deductCryptodex` resolves the fee coin by scanning the currency list for
 * one named CRYPTODEX. This venue lists BTC, ETH, SOL, USD and USDC and no
 * CRYPTODEX, so it returned `{isEnabled:false}` every time and the fee was
 * charged exactly as it would have been with the switch off. There was no
 * discount in that path either - the same fee, denominated differently - so
 * the Taker and Maker percentages underneath never moved regardless.
 *
 * The control was already hidden behind a `cryptodexFeeAvailable(currencyList)`
 * guard for that reason, which made it dead weight on every render. Its
 * endpoint went with the userapi round that removed the rest of the
 * pay-in-CRYPTODEX surface, so the client goes too rather than being left to 404
 * if the coin is ever listed again.
 */
export default function OrderForm() {
  const { firstCurrency, secondCurrency, tradePair } = useSelector(
    (state: any) => state.spot
  );

  const dispatch = useDispatch();
  const socketContext = useContext<any>(SocketContext);

  useEffect(() => {
    // socket
    //
    // The cleanup used to be RETURNED FROM INSIDE the .on() callback, so the
    // effect itself returned undefined and never unsubscribed. Every matching
    // event dispatches setFirstCurrency/setSecondCurrency, which replaces the
    // firstCurrency/secondCurrency objects this effect depends on, re-running it
    // and stacking ANOTHER listener with none removed. Worse, the older
    // listeners captured the PREVIOUS pair's currencies, so after a pair switch a
    // stale one could overwrite the current pair's balance row with a different
    // coin's figure. A named handler with a real effect-level targeted off fixes
    // both (targeted so it never removes another component's listener on the
    // shared socket singleton).
    const handler = (result: any) => {
      if (result.currencyId == firstCurrency.currencyId) {
        dispatch(setFirstCurrency(result));
      } else if (result.currencyId == secondCurrency.currencyId) {
        dispatch(setSecondCurrency(result));
      }
    };
    socketContext.spotSocket.on("updateTradeAsset", handler);
    return () => {
      socketContext.spotSocket.off("updateTradeAsset", handler);
    };
  }, [firstCurrency, secondCurrency]);

  const [activeTab, setActiveTab] = useState("buy");
  // The order type is CONTROLLED now (it was Tab.Container's own
  // defaultActiveKey). The sliding rule has to know which half is active, and
  // react-bootstrap keeps that state to itself.
  const [orderType, setOrderType] = useState("market");

  const handleTabClick = (tab: any) => {
    setActiveTab(tab);
  };

  return (
    <>
      <div className={spot.orderform_inner}>
        <div className={spot.orderform_navtab}>          
          {/* Real buttons in a tablist. The previous markup was <li onClick>,
              which cannot be focused or operated from the keyboard at all - on
              the control that decides whether you are buying or selling. */}
          <div
            className={spot.side_tabs}
            data-side={activeTab}
            role="tablist"
            aria-label="Order side"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "buy"}
              data-side-tab="buy"
              className={spot.side_tab}
              onClick={() => handleTabClick("buy")}
            >
              Buy
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "sell"}
              data-side-tab="sell"
              className={spot.side_tab}
              onClick={() => handleTabClick("sell")}
            >
              Sell
            </button>
            {/* The single element that moves. aria-hidden: it is the same fact
                aria-selected already states. */}
            <span className={spot.side_tabs_rule} aria-hidden="true" />
          </div>          
          <Tab.Container
            activeKey={orderType}
            onSelect={(k) => k && setOrderType(k)}
          >
            <div className={`${spot.ordertab}`}>
              {/* Same control as the Buy/Sell row above, in neutral: a mode, not
                  a direction. Replaces react-bootstrap's pill Nav, whose <a>
                  links carried no visible focus state. */}
              <div
                className={spot.type_tabs}
                data-type={orderType}
                role="tablist"
                aria-label="Order type"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={orderType === "limit"}
                  data-type-tab="limit"
                  className={spot.type_tab}
                  onClick={() => setOrderType("limit")}
                >
                  Limit
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={orderType === "market"}
                  data-type-tab="market"
                  className={spot.type_tab}
                  onClick={() => setOrderType("market")}
                >
                  Market
                </button>
                <span className={spot.type_tabs_rule} aria-hidden="true" />
              </div>
            </div>
            <Tab.Content>
              <Tab.Pane eventKey="limit">
                <LimitOrder activeTab={activeTab} />
              </Tab.Pane>
              <Tab.Pane eventKey="market">
                <MarketOrder activeTab={activeTab} />
              </Tab.Pane>
            </Tab.Content>
          </Tab.Container>
          {/* THE FEE PANEL IS GONE, WITH THE FEES.
              It printed the pair's taker_fees / maker_rebate under a "Fee"
              heading. This venue charges nothing on any fill - see
              lib/liquidityRole.feeRateFor in spotapi, which returns 0 for every
              order in every role - so the panel advertised a schedule that is
              not applied to anything. */}
        </div>
      </div>
    </>
  );
}
