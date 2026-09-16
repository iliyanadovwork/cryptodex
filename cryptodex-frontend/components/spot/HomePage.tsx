import React, { useEffect, useState, useRef } from "react";
import Script from "next/script";
import spot from "@/styles/Spot.module.css";
import styles from "../../styles/common.module.css";
import { Scrollbars } from "react-custom-scrollbars-2";
import { Tab, Nav, Form, Modal, Button } from "react-bootstrap";
import "slick-carousel/slick/slick.css";
import "slick-carousel/slick/slick-theme.css";
import OrderForm from "../../components/spot/OrderForm";
import Mainnavbar from "../../components/navbar";
import dynamic from "next/dynamic";
//import component'
import OrderBook from "./OrderBook";
import MarketPrice from "./MarketPrice";
import RecentTrade from "./RecentTrade";
import OpenOrder from "./OpenOrder";
import OrderHistory from "./OrderHistory";
import TradeHistory from "./TradeHistory";
import OrderCount from "./CountRef";
import FeedStaleBadge from "./FeedStaleBadge";
import { getMode } from "@/store/UserSetting/dataSlice";
import { changePair } from "@/services/User/UserServices";
import { useDispatch, useSelector } from "../../store";

const Chart = dynamic(() => import("./Chart").then((mod) => mod.default), {
  ssr: false,
});

export default function Spot() {
  let countRef = useRef();
  let countRef2 = useRef();
  const dispatch = useDispatch();
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [check, setCheck] = useState<boolean>(false);
  const [isActive, setActive] = useState("open_order");

  const { showSpot } = useSelector(
    (state: any) => state.UserSetting?.data?.mode
  );

  useEffect(() => {
    setScriptLoaded(true);
  }, []);
  const [pair_box, setpair_box] = useState(false);
  const pair_sidebar = () => {
    setpair_box(!pair_box);
  };

  const pairChange = async (e: any) => {
    try {
      let { checked } = e.target;
      setCheck(!checked);
      let data = {
        showSpot: checked,
        type: "spot-show",
      };
      const { status } = await changePair(data);
      if (status) {
        dispatch(getMode());
      }
    } catch (err: any) { }
  };
  useEffect(() => {
    setCheck(showSpot);
  }, [showSpot]);

  const [show, setShow] = useState(false);
  const handleClose = () => setShow(false);
  const handleShow = () => setShow(true);

  return (
    <>
      <div>
        <Mainnavbar />
        <div className={`${spot.trade_wrapper} ${spot.trade_wrapper_desktop}`}>
          {/* Orderbook.
              Both layouts below are always mounted — only CSS hides one — so
              both OrderBooks receive every payload. This one owns the shared
              `spot.bookHealth` verdict the order tickets read; the mobile copy
              renders itself but does not write it. Two writers meant
              last-writer-wins, and the loser could be the instance that had the
              real payload. */}
          <OrderBook publishHealth />

          {/* Market Info */}

          <MarketPrice pair_sidebar={pair_sidebar} />
          {/* Chart. The candles come from the same venue feed as the header, so
              when that feed dies the last candle just sits there looking live —
              the ribbon says otherwise. The chart owns its own canvas, so this
              rides above it rather than trying to restyle it. */}
          <div className={spot.chart_wrapper}>
            <div className={spot.chart_stale_overlay}>
              <FeedStaleBadge />
            </div>
            <div className={spot.chart_inner}>
              <Chart containerId={"tv_chart_container_1"} />
            </div>
          </div>
          {/* Order Form */}
          <div className={spot.orderform_wrapper}>
            <OrderForm />
          </div>

          {/* The standalone Recent Trades panel that used to sit here is gone.
              It duplicated the order book's own "Trades" tab, and the bottom row
              now gives its whole width to the order/trade history table. The
              mobile layout keeps its own Recent Trades tab. */}

          {/* Order History Table */}
          <div className={spot.history_table}>
            <div className={spot.history_table_wrap}>
              <Tab.Container defaultActiveKey="open_order">
                <div className={`${spot.orderbook_flex}`}>
                  <Nav
                    variant="pills"
                    className={`${spot.order_tab} primary_tab order-tab-compact`}
                  >
                    <Nav.Item>
                      <Nav.Link
                        eventKey="open_order"
                        onClick={() => {
                          setActive("open_order");
                        }}
                      >
                        <OrderCount ref={countRef2} />
                      </Nav.Link>
                    </Nav.Item>
                    <Nav.Item>
                      <Nav.Link
                        eventKey="order_his"
                        onClick={() => {
                          setActive("order_his");
                        }}
                      >
                        Order History (7 Days)
                      </Nav.Link>
                    </Nav.Item>
                    <Nav.Item>
                      <Nav.Link
                        eventKey="trade_his"
                        onClick={() => {
                          setActive("trade_his");
                        }}
                      >
                        Trade History (7 Days)
                      </Nav.Link>
                    </Nav.Item>
                  </Nav>
                  {isActive == "open_order" && (
                    <div className="futer-history-right">
                      <Form.Check
                        className={spot.pair_checkbox}
                        type="checkbox"
                        id="default-checkbox"
                        checked={check}
                        onClick={(e: any) => pairChange(e)}
                        label="Show all trading pairs"
                      />
                    </div>
                  )}
                </div>
                <Tab.Content>
                  <Tab.Pane eventKey="open_order" className="px-2">
                    <Scrollbars style={{ width: "100%", height: 300 }}>
                      <OpenOrder countRef={countRef} countRef2={countRef2} />
                    </Scrollbars>
                  </Tab.Pane>
                  <Tab.Pane eventKey="order_his" className="px-2">
                    <Scrollbars style={{ width: "100%", height: 300 }}>
                      <OrderHistory />
                    </Scrollbars>
                  </Tab.Pane>
                  <Tab.Pane eventKey="trade_his" className="px-2">
                    <Scrollbars style={{ width: "100%", height: 300 }}>
                      <TradeHistory />
                    </Scrollbars>
                  </Tab.Pane>
                </Tab.Content>
              </Tab.Container>
            </div>
          </div>
        </div>

        {/* For Mobile */}
        <div className={spot.trade_wrapper_mobile}>
          {/* Market Info */}
          <MarketPrice pair_sidebar={pair_sidebar} />

          <Tab.Container defaultActiveKey="chart">
            <Nav
              variant="pills"
              className={`${spot.order_tab} primary_tab order-tab-compact px-2 mb-2`}
            >
              <Nav.Item>
                <Nav.Link eventKey="chart">Chart</Nav.Link>
              </Nav.Item>
              <Nav.Item>
                <Nav.Link eventKey="order_book">Order Book</Nav.Link>
              </Nav.Item>
              <Nav.Item>
                <Nav.Link eventKey="recent_trades">Recent Trades</Nav.Link>
              </Nav.Item>
              <Nav.Item>
                <Nav.Link eventKey="trade_history">Trade History</Nav.Link>
              </Nav.Item>
            </Nav>
            <Tab.Content>
              <Tab.Pane eventKey="chart" className="px-2">
                <div className={spot.chart_wrapper}>
                  <div className={spot.chart_stale_overlay}>
                    <FeedStaleBadge />
                  </div>
                  <div className={spot.chart_inner}>
                    <Chart containerId={"tv_chart_container_2"} />
                  </div>
                </div>
              </Tab.Pane>
              <Tab.Pane eventKey="order_book" className="px-2">
                <Scrollbars style={{ width: "100%", height: 500 }}>
                  {/* Renders from its own copy of the verdict; the desktop
                      instance above is the one that publishes it. */}
                  <OrderBook publishHealth={false} />
                </Scrollbars>
              </Tab.Pane>
              <Tab.Pane eventKey="recent_trades" className="px-2">
                <Scrollbars style={{ width: "100%", height: 500 }}>
                  <RecentTrade />
                </Scrollbars>
              </Tab.Pane>
              <Tab.Pane eventKey="trade_history" className="px-2">
                <div className={spot.history_table}>
                  <div className={spot.history_table_wrap}>
                    <Tab.Container defaultActiveKey="open_order">
                      <div className={`${spot.orderbook_flex}`}>
                        <Nav
                          variant="pills"
                          className={`${spot.order_tab} primary_tab order-tab-compact`}
                        >
                          <Nav.Item>
                            <Nav.Link
                              eventKey="open_order"
                              onClick={() => {
                                setActive("open_order");
                              }}
                            >
                              <OrderCount ref={countRef} />
                            </Nav.Link>
                          </Nav.Item>
                          <Nav.Item>
                            <Nav.Link
                              eventKey="order_his"
                              onClick={() => {
                                setActive("order_his");
                              }}
                            >
                              Order History (7 Days)
                            </Nav.Link>
                          </Nav.Item>
                          <Nav.Item>
                            <Nav.Link
                              eventKey="trade_his"
                              onClick={() => {
                                setActive("trade_his");
                              }}
                            >
                              Trade History (7 Days)
                            </Nav.Link>
                          </Nav.Item>
                        </Nav>
                        {isActive == "open_order" && (
                          <div className="futer-history-right">
                            <Form.Check
                              className={spot.pair_checkbox}
                              type="checkbox"
                              id="default-checkbox"
                              checked={check}
                              onClick={(e: any) => pairChange(e)}
                              label="Show all trading pairs"
                            />
                          </div>
                        )}
                      </div>
                      <Tab.Content>
                        <Tab.Pane eventKey="open_order" className="px-2">
                          <Scrollbars style={{ width: "100%", height: 250 }}>
                            <OpenOrder countRef={countRef} />
                          </Scrollbars>
                        </Tab.Pane>
                        <Tab.Pane eventKey="order_his" className="px-2">
                          <Scrollbars style={{ width: "100%", height: 250 }}>
                            <OrderHistory />
                          </Scrollbars>
                        </Tab.Pane>
                        <Tab.Pane eventKey="trade_his" className="px-2">
                          <Scrollbars style={{ width: "100%", height: 250 }}>
                            <TradeHistory />
                          </Scrollbars>
                        </Tab.Pane>
                      </Tab.Content>
                    </Tab.Container>
                  </div>
                </div>
              </Tab.Pane>
            </Tab.Content>
          </Tab.Container>

          <div className={spot.order_btn_mobile_wrapper}>
            <button className={spot.order_buy_btn} onClick={handleShow}>
              Buy
            </button>
            <button className={spot.order_sell_btn} onClick={handleShow}>
              Sell
            </button>
          </div>
        </div>
      </div>

      {/* modal */}
      <Modal
        show={show}
        onHide={handleClose}
        backdrop="static"
        className={`${styles.custom_modal} bottom_modal`}
      >
        <Modal.Header closeButton className={`${styles.modal_head}`}>
          <Modal.Title className={styles.title}></Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <OrderForm />
        </Modal.Body>
      </Modal>
    </>
  );
}
