import styles from "@/styles/common.module.css";
import { Container } from "react-bootstrap";
import { useState } from "react";
import dynamic from "next/dynamic";
//import component
const OrderHistory = dynamic(() => import("../History/OrderHistory"));
const TradeHistory = dynamic(() => import("../History/TradeHistory"));
const TransactionHistory = dynamic(() => import("../History/TransactionHist"));

export default function History() {
  const [activeTab, setActiveTab] = useState(0);

  const handleTabClick = (index: number) => {
    setActiveTab(index);
  };

  return (
    <>
      <section className={`${styles.peer} ${styles.myorder}`}>
        <div className={styles.tabbox}>
          <div
            className={`${activeTab === 0 ? styles.active : ""}`}
            onClick={() => handleTabClick(0)}
          >
            Order History
          </div>
          <div
            className={`${activeTab === 1 ? styles.active : ""}`}
            onClick={() => handleTabClick(1)}
          >
            Trade History{" "}
          </div>
        </div>
        {activeTab === 0 && <OrderHistory />}
        {activeTab === 1 && <TradeHistory />}
      </section>
    </>
  );
}
