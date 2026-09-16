import styles from '@/styles/common.module.css';

/**
 * THE PER-ROW CANCEL BUTTON, AND NOTHING ELSE.
 *
 * This component used to own the confirmation dialog and the cancel request as
 * well, and that is what made the blocker possible. The dialog lived INSIDE the
 * row, and its submit handler closed over the row's live `orderInfo` prop; the
 * table keyed its rows by array position, so a row leaving the table above this
 * one did not unmount anything - React reused this component and swapped
 * `orderInfo` while the dialog was open. Confirm then cancelled whatever order
 * had taken over that index.
 *
 * The button now does one thing: it hands the order it was rendered for to the
 * table, which takes a snapshot and owns the dialog (see OpenOrder.tsx and
 * CancelModal.tsx). A row can now come and go freely without any open dialog
 * changing its mind about which order it is about, and without the dialog
 * disappearing from under the user when the row unmounts.
 */
export default function CancelBtn({ orderInfo, onRequestCancel, busy }: any) {
    return (
        <button
            className={`mb-4 ${styles.primary_btn1}`}
            onClick={() => onRequestCancel && onRequestCancel(orderInfo)}
            disabled={!!busy}
        >
            {busy ? <i className="fa fa-spinner fa-spin" ></i> : 'Cancel'}
        </button>
    );
}
