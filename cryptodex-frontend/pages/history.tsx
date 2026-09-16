import styles from "@/styles/common.module.css";
import Mainnavbar from "../components/navbar";
import { Container, Row, Col } from "react-bootstrap";

import dynamic from "next/dynamic";
//import component
const SpotHist = dynamic(() => import("../components/History/Spot"));

/**
 * THE TAB IDS ARE DELIBERATELY NOT RENUMBERED.
 *
 * This page once had seven tabs. The two that survive keep the ids they always
 * had - 0 Spot, 2 Demo Credits - so the `?type=` deep links below still resolve
 * to the same panels they always did. Renumbering them would silently re-point
 * every bookmarked link by one.
 *
 * PAST WITHDRAWALS (id 3) HAS NOW GONE THE SAME WAY. It rendered
 * components/Wallet/WithdrawHistory.tsx against spotapi's
 * `spot/getWithdrawalHistory`, and that route was deleted with the rest of the
 * withdrawal surface - so the tab fetched a 404, swallowed it, and printed "No
 * Records Found" under a heading offering an archive. Its one honest feature,
 * a notice quoting the SERVER's statement that withdrawal is closed, could no
 * longer come from the server either; it fell back to a sentence hard-coded in
 * the component, which is the drift that component's own header was written to
 * prevent. No account on this venue has ever withdrawn - there is no custody to
 * withdraw from - so the archive is of nothing. `?type=withdraw` now lands on
 * Spot rather than on a tab that is gone.
 */

/*
 * `?type=` USED TO PICK A PANEL. THERE IS ONE PANEL.
 *
 * This read the query string and mapped `spot` to tab 0 and `deposit` to tab 2,
 * with `withdraw` falling through to 0 because the tab it named was deleted.
 * With Demo Credits gone the same is true of `deposit`, and with a single panel
 * every old link lands on something real without being routed there. The ids
 * were deliberately never renumbered so bookmarks kept resolving; there is now
 * nothing left to resolve TO, which is the end of that thread rather than a
 * break in it.
 */
export default function History() {
  return (
    <>
      <Mainnavbar />
      <div className={styles.page_box}>
        <div
          className={`mb-5 ${styles.inner_head_box} ${styles.inner_head_box_small}`}
        >
          <Container>
            <Row>
              <Col lg={4} className="text-center mx-auto">
                <h5 className={`${styles.inner_head_title} mb-0`}>
                  My History
                </h5>
              </Col>
            </Row>
          </Container>
        </div>
        <section className={`${styles.peer} ${styles.myorder}`}>
          <Container>
            {/* A "Demo Credits" tab stood beside Spot, rendering the very
                same table the claim page already renders - same columns, same
                rows, same five-per-page. That component's own header said so:
                "both places this table appears". The claim page is the better
                of the two, because the record belongs under the button that
                creates it, so the tab goes - and the strip goes with it, one
                option being no choice at all. */}
            <SpotHist />
          </Container>
        </section>
      </div>
    </>
  );
}
