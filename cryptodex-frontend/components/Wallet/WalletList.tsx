import { useState, useEffect } from "react";
import Image from "next/image";
import styles from "@/styles/common.module.css";
import { Container, Table } from "react-bootstrap";
import { useRouter } from "next/router";
//import store
import { useSelector, useDispatch } from "../../store";
import { getAssetData, getPriceConversion } from "../../store/Wallet/dataSlice";
//import lib
import isEmpty from "@/lib/isEmpty";
import { truncateDecimals } from "@/lib/roundOf";
import {
  walletTotals,
  roundedTotals,
  bucketBalance,
  valueInQuote,
  quoteRate,
  TOTAL_ASSETS_LABEL,
  WalletBucket,
} from "@/lib/walletTotals";
import { useTheme } from "next-themes";

/**
 * THE WALLET PAGE.
 * ================
 *
 * This venue has ONE wallet, so:
 *
 *   - the tab strip is a section heading instead of a chooser. A single tab is
 *     a control that cannot do anything, and clicking it to watch nothing
 *     happen is worse than not offering it;
 *   - there is no Transfer control. Both of its dropdowns would hold one entry,
 *     and there is nowhere to transfer to.
 *
 * The headline is computed by lib/walletTotals, so it is the sum of the lines
 * printed beneath it — see that file for why that rule is load-bearing.
 */

// Paper trading has no USDT currency: every spot pair quotes in USD and the
// priceConversion feed only publishes USD/USDC/BTC/SOL/ETH rows. Valuing
// against "USDT" silently found nothing, so every asset was priced at its raw
// quantity and the BTC total stayed at 0.
const QUOTE_COIN = "USD";

export default function WalletList() {
  const dispatch = useDispatch();
  const router = useRouter();
  const { assets, currency, priceConversion } = useSelector(
    (state: any) => state.wallet
  );
  const [Wallet, setWallet] = useState<any>([]);
  // Every wallet, added up. This is what "Total Assets Value" means.
  const [totalBTC, setTotalBTC] = useState<number>(0);
  const [totalUSD, setTotalUSD] = useState<number>(0);
  // Each bucket on its own. The headline is the sum of exactly these.
  const [byBucket, setByBucket] = useState<Record<WalletBucket, number>>({
    spot: 0,
  });
  const { theme } = useTheme();

  const handleAsset = () => {
    try {
      let tempArr = [...assets];
      currency?.length > 0 &&
        currency.map((item: any) => {
          // Paper trading quotes everything in USD (there is no USDT currency
          // and priceConversion has no USDT rows), so value assets in USD.
          let PriceCnv = priceConversion.find(
            (el: any) =>
              el.baseSymbol == item.coin && el.convertSymbol == QUOTE_COIN
          );
          let pairIndex =
            tempArr &&
            tempArr.findIndex((el: any) => {
              return el._id == item._id;
            });
          if (pairIndex >= 0 && !isEmpty(pairIndex)) {
            let btnStatus = "deActive";
            if (item?.type == "crypto" && item.status == "active") {
              btnStatus = "active";
            } else if (item.type == "token") {
              tempArr[pairIndex].tokenAddressArray.map((el: any) => {
                let currDoc = currency.find((e: any) => {
                  return e._id == el.currencyId;
                });
                if (currDoc?.status == "active") {
                  btnStatus = "active";
                }
              });
            }
            // THE ROW'S SUB TOTAL AND ITS ESTIMATED VALUE MUST BE THE SAME
            // QUANTITY. `bal` used to be the tab's HEADLINE field only
            // (spotBal), while the Sub Total column added spotInOrder on top —
            // so a row with funds resting in an order printed SUB TOTAL 9000
            // beside ESTIMATED VALUE 8400 for a 1:1 asset. Both figures now
            // come from the same bucket definition the headline sums.
            const subTotal = bucketBalance(tempArr[pairIndex], "spot");
            tempArr[pairIndex] = {
              ...tempArr[pairIndex],
              ...{
                image: item.image,
                decimals:
                  item.type == "token"
                    ? item.decimals
                    : !isEmpty(item.contractDecimal)
                      ? item.contractDecimal
                      : item.decimals,
                status: item.status,
                // What this row holds in the wallet on screen, and what that
                // is worth. One number, two columns.
                //
                // `quoteRate` is what the headline sums with too, so the demo
                // dollars this venue issues (USD, USDC) are a dollar in BOTH
                // places - see lib/walletTotals. Valuing USDC from the feed
                // here made a fresh 1,000 + 1,000 account read 2000.90.
                subTotal,
                USDValue: valueInQuote(
                  subTotal,
                  quoteRate(item.coin, PriceCnv?.convertPrice)
                ),
                btnStatus,
                type: item.type,
              },
            };
          }
        });

      // THE HEADLINE FIGURE IS A TRUE TOTAL, AND IT IS THE SUM OF THE LINES
      // PRINTED DIRECTLY UNDER IT.
      // It used to be `selectedAmount` — the value of whichever tab happened to
      // be open — so moving money between the user's own wallets made "Total
      // Assets Value" fall, and switching tabs made it jump. It now sums every
      // bucket lib/walletTotals recognises.
      const priceOf = (coin: string) =>
        priceConversion?.find(
          (el: any) => el.baseSymbol == coin && el.convertSymbol == QUOTE_COIN
        )?.convertPrice;
      const totals = walletTotals(tempArr, priceOf);

      // Rounded to the cent FIRST, then summed, so the headline is exactly the
      // sum of the lines printed under it rather than a few cents away from it.
      const shown = roundedTotals(totals.byBucket, 2);
      setByBucket(shown.byBucket);
      setTotalUSD(shown.total);
      let btcPrice = priceConversion.find(
        (el: any) => el.baseSymbol == QUOTE_COIN && el.convertSymbol == "BTC"
      );
      if (!isEmpty(btcPrice?.convertPrice)) {
        // Converted from the figure that is PRINTED beside it, not from the
        // unrounded sum. The two are one sentence - "0.0315 BTC ≈ 2000.00 USD"
        // - and a reader dividing one by the other must get the rate back.
        setTotalBTC(shown.total * parseFloat(btcPrice.convertPrice));
      } else {
        setTotalBTC(0);
      }
      setWallet(tempArr);
    } catch (err) {
      console.log("err:------ ", err);
    }
  };

  /**
   * One spot row.
   *
   * Every size column reads the same asset fields the wallet total reads, and
   * Estimated Value is priced from `item.subTotal` — the WHOLE holding, not
   * just the spendable part — so the row can no longer disagree with itself or
   * with the headline. That subtotal is Available + In Orders, both printed
   * here; locked is in the sum too but is structurally zero on this venue.
   *
   * It had a column of its own until the sum became just those two visible
   * numbers. The quantity did not go anywhere: it is still what gets priced,
   * which is the property the tests hold.
   */
  const renderSpotRow = (item: any, index: number) => {
    const cell = (raw: any) => {
      const n = parseFloat(raw);
      return Number.isFinite(n) && n >= 0
        ? truncateDecimals(n, item.decimals)
        : 0;
    };
    // ESTIMATED VALUE IS DOLLARS, NOT UNITS OF THE ROW'S COIN.
    // It used to run through `cell` like the size columns, so it inherited the
    // coin's own precision: a BTC row printed its dollar value as 0.00000000
    // and a 6-decimal stablecoin printed 1000.000000. Every row of that column
    // is the same currency - the header says so - so it gets that currency's
    // two decimal places regardless of which coin the row is for.
    const usd = (raw: any) => {
      const n = parseFloat(raw);
      return Number.isFinite(n) && n >= 0 ? truncateDecimals(n, 2) : 0;
    };
    return (
      <tr key={index} data-testid={`spot-row-${item.coin}`}>
        <td>
          <div>
            {!isEmpty(item.image) && (
              <Image
                src={item.image}
                alt="image"
                className="img-fluid me-3"
                width={27}
                height={27}
              />
            )}
            <span>{item.coin}</span>
          </div>
        </td>
        <td data-testid="spot-available">{cell(item.spotBal)}</td>
        <td data-testid="spot-in-order">{cell(item.spotInOrder)}</td>
        <td data-testid="spot-estimated">{usd(item.USDValue)}</td>
      </tr>
    );
  };


  useEffect(() => {
    const fetchData = async () => {
      try {
        if (isEmpty(priceConversion) || isEmpty(assets))
          await dispatch(getPriceConversion());
        await dispatch(getAssetData());
      } catch (error) {
        console.error("Error fetching data:", error);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    // price conversion is optional, handleAsset falls back to a 1:1 value
    if (isEmpty(Wallet) && !isEmpty(assets) && !isEmpty(currency)) {
      handleAsset();
    }
  }, [assets, currency, priceConversion]);

  useEffect(() => {
    if (!isEmpty(Wallet)) {
      handleAsset();
    }
    // `priceConversion` BELONGS HERE. The effect above carries it but is gated
    // on `isEmpty(Wallet)`, and Wallet is set non-empty by the first successful
    // compute - so it never runs again, and this one listened to `assets`
    // alone. That was harmless while the price table was fetched once and never
    // rewritten. It is not harmless now that a live tick rewrites it: navbar.tsx
    // recomputes on every change, so without this the headline would freeze
    // while the figure in the account menu moved - the two of them on screen
    // together under one caption, which is the defect navbar.tsx:26 records.
  }, [assets, priceConversion]);

  return (
    <>
      <div className={`mb-5 ${styles.inner_head_box}`}>
        <Container>
          <div className={`${styles.asset_box} ${styles.asset_box_wallet}`}>
            <div>
              {/* Says what it counts, from the one exported constant the
                  navbar dropdown also renders. The label used to be written out
                  by hand in both places over two different numbers, and it sat
                  above a TAB-SCOPED figure, so an internal transfer looked like
                  money appearing or vanishing. See lib/walletTotals. */}
              <p data-testid="total-assets-label">{TOTAL_ASSETS_LABEL}</p>
              {/* THE CURRENCY YOU HOLD COMES FIRST.
                  This led with the BTC equivalent, the way Binance heads a
                  wallet ("0.0124 BTC ≈ $1,000"). That reads well across
                  hundreds of markets where BTC is a unit of account; here it
                  put a BTC figure at the top of a page whose BTC row says
                  0.00000000, so the headline appeared to contradict the table
                  directly beneath it. The faucet issues USD and the only
                  market quotes in USD, so USD is what a reader is counting in.
                  The BTC equivalent is kept, just second. */}
              <h5 data-testid="total-assets-value">
                {truncateDecimals(totalUSD, 2)} {QUOTE_COIN} ≈{" "}
                {truncateDecimals(totalBTC, 8)} BTC
              </h5>
              {/* NO PER-WALLET BREAKDOWN, BECAUSE THERE IS ONE WALLET.
                  A per-bucket breakdown existed so a reader could check the
                  headline against its parts; with one bucket left, a single
                  line would restate the headline word for word. The headline is
                  still the sum of exactly what lib/walletTotals counts, and the
                  spot table below prints every field that sum is built from. */}
            </div>
            <div className="buttonWalletFlex">
              <button
                className={`me-3 ${styles.primary_btn}`}
                onClick={() => router.push("/faucet")}
              >
                <label>Claim Demo Funds</label>
              </button>
              <button
                className={`${styles.primary_btn}`}
                onClick={() => router.push("/reset")}
              >
                <label>Reset Demo Account</label>
              </button>
            </div>
          </div>
        </Container>
      </div>

      <Container>
        {/* A search box and an "above zero" checkbox stood here. Both were
            built for a wallet listing dozens of coins. This venue lists two, so
            the search could only ever narrow the table to one row, and the
            checkbox could only ever hide BTC-when-empty - the row you need in
            order to buy any, along with its Trade button. A filter whose only
            effect is to hide the control you are looking for is worse than no
            filter at all. */}

        {/* Names the table below it. It is NOT a tab strip: there is one wallet
            on this venue, and a chooser with a single option is a control that
            can only ever do nothing. */}
        <p className={styles.wallet_caption} data-testid="wallet-section-spot">
          Spot wallet
        </p>

        <div className={styles.asset_table}>
          <Table responsive>
            <thead>
              <tr>
                <th>Coin</th>
                <th> Available </th>
                <th>In Orders</th>
                {/* A "Locked" column stood here. It was added because locked
                    funds were invisible while still counted in Sub Total, so
                    Available + In Orders could fall short of it with nothing on
                    screen explaining the gap.
                    
                    Nothing on this venue can lock a balance: withdrawals answer
                    410, and a resting spot order MOVES its funds into
                    walletbalance_spot_inOrder rather than reserving them in
                    place, which is what "In Orders" reports. So the counter is
                    structurally zero - no code path writes it - and the gap the
                    column explained cannot open.
                    
                    getWallet still reports the derived free/locked split
                    (wallet.controller.js:370) so nothing breaks quietly if that
                    ever changes; this is only the column. */}
                {/* Sub Total was Available + In Orders, with both of them
                    printed immediately to its left - a sum a reader can do at a
                    glance. It earned its place while Locked was a third term
                    that was easy to miss; with Locked gone it restated two
                    visible numbers. The quantity itself still exists and
                    Estimated Value is still priced from it (see renderSpotRow),
                    it just no longer gets a column of its own. */}
                <th>Value ({QUOTE_COIN})</th>
                {/* An Action column held a Trade button on every row. Both
                    resolved to the same place: this venue lists one market, so
                    the BTC row and the USD row could only ever open
                    /spot/BTC_USD - a destination the navbar already links as
                    "Spot". It also opened in a new tab. */}
              </tr>
            </thead>
            <tbody>
              {Wallet?.length > 0 ? (
                Wallet.map((item: any, index: number) => {
                  // USD is typed "fiat" but in paper trading it is a demo
                  // currency: the faucet credits it and every spot pair
                  // (BTCUSD/ETHUSD/SOLUSD) settles in it, so hiding fiat rows
                  // hid the user's actual spot buying power.
                  //
                  // ONE renderer for both the filtered and unfiltered cases.
                  // The two branches used to be copy-pasted, which is how the
                  // Sub Total / Estimated Value mismatch had to be found and
                  // fixed twice to be fixed at all.
                  return renderSpotRow(item, index);
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
        </div>
      </Container>
    </>
  );
}
