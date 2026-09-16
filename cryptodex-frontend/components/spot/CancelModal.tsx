import { Modal } from 'react-bootstrap';
import styles from '@/styles/common.module.css';
import spot from "@/styles/Spot.module.css";
//import lib
import { formatPrice, formatQty } from "@/lib/numberFormat";
import { capitalize } from "../../lib/stringCase";

/**
 * THE CANCEL CONFIRMATION, ABOUT ONE SPECIFIC ORDER.
 *
 * This dialog used to take no order at all. Its body was the sentence "Are you
 * sure want to cancel this order" and two buttons, and Confirm called a handler
 * that read the order out of a LIVE PROP on the row it was rendered inside. So
 * it named nothing the user could check, and it acted on whatever that prop
 * held at the moment Confirm was pressed - which, with the table's rows keyed
 * by array position, was a different order as soon as a row above filled.
 *
 * Both halves are fixed here and in OpenOrder.tsx:
 *
 *   - `order` is a SNAPSHOT taken when the dialog opened. This component never
 *     reads the table, so nothing the table does can change what is on screen
 *     or what Confirm sends.
 *
 *   - the snapshot is PRINTED. A confirmation that does not say what it is
 *     confirming cannot be checked by the person confirming it, which is why
 *     the live reproduction of the swap was invisible to the user until the
 *     balance moved. Side, type, price, amount and the venue's own order code
 *     are all shown, so "cancel the 61000 buy" is a claim the user can verify
 *     before pressing anything.
 *
 * `gone` is the third state. With rows keyed by identity, an order that fills
 * or is cancelled elsewhere unmounts its row - and, if this dialog still lived
 * inside that row, it would blink out of existence mid-read. That is better
 * than cancelling the wrong order and still not good enough: the user is
 * part-way through a decision and the venue silently withdraws the question.
 * The dialog is owned by the table instead of by the row, so it survives, and
 * when the order it is about is definitely no longer open it says so and offers
 * only Close. It never offers Confirm for an order that cannot be cancelled.
 */
export default function CancelModal({ order, gone, busy, onClose, onConfirm }: any) {
    const digits = order?.pairDetail || order || {};
    const side = order?.buyorsell || order?.type;

    return (
        <Modal
            show={!!order}
            centered
            onHide={() => onClose && onClose()}
            className={styles.custom_modal}
        >
            <Modal.Header closeButton className={styles.modal_head}>
                <Modal.Title>
                    {gone
                        ? "This order is no longer open"
                        : "Are you sure want to cancel this order"}
                </Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <div className={`${spot.form_box}`}>
                    {order && (
                        <ul
                            className="list-unstyled mb-3"
                            data-testid="cancel-order-summary"
                        >
                            <li className="d-flex justify-content-between">
                                <span>Pair</span>
                                <span>
                                    {order.firstCurrency}/{order.secondCurrency}
                                </span>
                            </li>
                            <li className="d-flex justify-content-between">
                                <span>Side</span>
                                <span>
                                    {capitalize(side || "")} {capitalize(order.orderType || "")}
                                </span>
                            </li>
                            <li className="d-flex justify-content-between">
                                <span>Price</span>
                                <span className={spot.tabular_nums}>
                                    {order.price == "market"
                                        ? "Market"
                                        : formatPrice(order.price, digits.secondFloatDigit, "—")}
                                </span>
                            </li>
                            <li className="d-flex justify-content-between">
                                <span>Amount</span>
                                <span className={spot.tabular_nums}>
                                    {formatQty(
                                        order.openQuantity ?? order.quantity,
                                        digits.firstFloatDigit,
                                        "—"
                                    )}
                                </span>
                            </li>
                            {order.orderCode && (
                                <li className="d-flex justify-content-between">
                                    <span>Order ID</span>
                                    <span>{order.orderCode}</span>
                                </li>
                            )}
                        </ul>
                    )}

                    {gone ? (
                        <>
                            <p data-testid="cancel-order-gone">
                                It was filled or cancelled while this dialog was open, so
                                there is nothing left to cancel. No other order has been
                                touched.
                            </p>
                            <div className='row'>
                                <div className='col-md-12'>
                                    <button
                                        className={spot.order_buy_btn}
                                        data-testid="cancel-order-close"
                                        onClick={() => onClose && onClose()}
                                    >
                                        Close
                                    </button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className='row'>
                            <div className='col-md-6'>
                                <button
                                    className={spot.order_buy_btn}
                                    onClick={() => onClose && onClose()}
                                    disabled={!!busy}
                                >
                                    Cancel
                                </button>
                            </div>
                            <div className='col-md-6'>
                                <button
                                    className={spot.order_sell_btn}
                                    onClick={() => onConfirm && onConfirm()}
                                    disabled={!!busy}
                                >
                                    {busy ? <i className="fa fa-spinner fa-spin"></i> : 'Confirm'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </Modal.Body>
        </Modal>
    )
}
