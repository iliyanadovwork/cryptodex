import { useState } from "react";
import styles from "@/styles/common.module.css";
import { InputGroup, Form } from "react-bootstrap";
import { useRouter } from "next/router";
//import lib
import { removeByObj } from "@/lib/validation";
import { toastAlert } from "@/lib/toastAlert";
import isEmpty from "@/lib/isEmpty";
import { emailFormat } from "@/lib/stringCase";
//import store
import { useDispatch, useSelector } from "../../store";
import { setUserSetting } from "../../store/UserSetting/dataSlice";
import { onSignOutSuccess } from "../../store/auth/sessionSlice";
import { setUser, initialState } from "../../store/auth/userSlice";
//improt service
import { deactiveReq, deactiveConfirm } from "../../services/User/UserServices";

/**
 * THE ONLY SCREEN IN THIS PRODUCT THAT STILL LOOKED LIKE A WIREFRAME.
 * ==================================================================
 * What was here: a bare "Account Deactivation" heading, ONE unlabelled input,
 * a lowercase "Please enter otp" placeholder and a Confirm button. No sentence
 * anywhere said what pressing it would do to the account, and the two steps -
 * ask for a code, then spend it - were told apart only by the placeholder text
 * silently changing. It is the most destructive action the product offers and
 * it was the least explained one.
 *
 * WHY THE EMAIL FIELD IS GONE
 * ---------------------------
 * The first step used to ask the user to type their email address, and userapi
 * ignores it. `deactiveRequest` looks the account up by `req.user.id` and
 * NOTHING else - deliberately, because when it did trust the body anyone could
 * post any registered address and have a live deactivation code mailed to that
 * person (see the note on that handler, and userapi
 * tests/unit/account-deactivation.test.js GUARD 1). Asking for a value the
 * server refuses to read is a field that can only be got wrong: type a
 * different address and the code still goes to your own, with no hint of why.
 * So the screen now STATES which account is about to be closed, from the
 * session, and offers a button.
 *
 * WHERE THE CODE COMES FROM
 * -------------------------
 * `/deactive-req` renders the mail through `mailTemplateLang`, and on this
 * stack userapi is in `log-only` delivery (GET :2567/api/health ->
 * email.deliveryMode): nothing is sent. It now reports `delivered` and, when it
 * sent nothing, returns the `verificationCode` it stored, exactly as
 * `/sendOTP` and `/forgotPassword` already did - `discloseWhenLogOnly` in
 * userapi lib/mailDelivery.js makes that inert in production. This is the third
 * and last of the three flows that could not be finished without shell access
 * to the server.
 *
 * WHAT HAPPENS AFTER A SUCCESSFUL CONFIRM
 * ---------------------------------------
 * The server purges the redis `userToken` row, so the token this browser holds
 * is dead the moment the call returns. The old code left the user sitting on a
 * signed-in-looking page whose every request would 401. We sign out locally and
 * send them to /login, which is the state they are actually in.
 */

type FormValue = {
  otp: string;
};

const initialFormValue: FormValue = {
  otp: "",
};

export default function EmailForm() {
  const router = useRouter();
  const dispatch = useDispatch();
  const { email, emailStatus } = useSelector((state: any) => state.auth.user);

  const [formValue, setFormValue] = useState<FormValue>(initialFormValue);
  const [error, setError] = useState<any>({});
  const [loader, setLoader] = useState<boolean>(false);
  const [submit, setSubmit] = useState<boolean>(false);
  const [check, setCheck] = useState<boolean>(false);
  // What became of the code we just claimed to send. See the note above.
  const [codeNotice, setCodeNotice] = useState<string>("");
  const [codeDelivered, setCodeDelivered] = useState<boolean | null>(null);
  const [shownCode, setShownCode] = useState<string>("");

  const { otp } = formValue;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let { name, value } = e.target;
    setFormValue({ ...formValue, ...{ [name]: value } });
    setError(removeByObj(error, name));
    setLoader(false);
  };

  const handleSignOut = () => {
    document.cookie =
      "loggedin" + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    dispatch(setUser(initialState));
    dispatch(onSignOutSuccess());
    dispatch(setUserSetting({}));
  };

  const handleRequest = async (e: any) => {
    e.preventDefault();
    try {
      setLoader(true);
      // `roleType` is ignored by userapi - there is one channel now - and the
      // account is chosen by the session. `requestType` is what the 3-minute
      // throttle keys on.
      let reqData = {
        roleType: 1,
        requestType: "deactive",
      };
      let response = await deactiveReq(reqData);
      if (response.data.success == true) {
        setSubmit(true);
        setLoader(false);
        setFormValue(initialFormValue);
        setError({});
        // `null` = an older server that does not report delivery; keep the
        // mail wording, which is the correct wording in production.
        setCodeDelivered(
          typeof response.data.delivered === "boolean"
            ? response.data.delivered
            : null
        );
        setShownCode(
          typeof response.data.verificationCode === "string"
            ? response.data.verificationCode
            : ""
        );
        setCodeNotice(
          response.data.message ||
            "Verification code sent to your email ID, Verification code is valid only for 3 minutes"
        );
        toastAlert("success", response.data.message, "deactive");
      }
    } catch (err: any) {
      setLoader(false);
      if (err?.response?.data?.errors) {
        setError(err.response.data.errors);
      }
      if (err?.response?.data?.message) {
        toastAlert("error", err.response.data.message, "deactive");
      }
    }
  };

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    try {
      if (isEmpty(otp)) {
        return setError({ otp: "Please enter the confirmation code" });
      }
      if (!check) {
        return toastAlert(
          "error",
          "Please confirm you understand what deactivation does",
          "deactive"
        );
      }
      setLoader(true);
      let reqData = {
        roleType: 2,
        otp,
      };
      let response = await deactiveConfirm(reqData);
      if (response.data.success == true) {
        setSubmit(false);
        setLoader(false);
        setFormValue(initialFormValue);
        setError({});
        setCodeNotice("");
        setCodeDelivered(null);
        setShownCode("");
        toastAlert("success", response.data.message, "deactive");
        // The session is already gone server-side; catch up locally.
        handleSignOut();
        setTimeout(() => {
          router.push("/login");
        }, 1200);
      }
    } catch (err: any) {
      setLoader(false);
      if (err?.response?.data?.errors) {
        setError(err.response.data.errors);
      }
      if (err?.response?.data?.error) {
        setError(err.response.data.error);
      }
      if (err?.response?.data?.message) {
        toastAlert("error", err.response.data.message, "deactive");
      }
    }
  };

  const handleCancel = () => {
    setSubmit(false);
    setFormValue(initialFormValue);
    setError({});
    setCheck(false);
    // Do not leave a stale code on screen: it expires in three minutes, and
    // offering an expired code is the same class of lie this screen was
    // finished to remove.
    setCodeNotice("");
    setCodeDelivered(null);
    setShownCode("");
    router.push("/security");
  };

  return (
    <>
      <div className={styles.login_tabs}>
        {!submit ? (
          <>
            <p data-testid="deactivate-intro">
              Deactivating closes this account. Your session ends immediately,
              every order you have resting on the book is cancelled, and your
              wallets are stood down so no balance can move.
            </p>
            <ul data-testid="deactivate-effects">
              <li>
                You will be signed out here and will not be able to sign in
                again.
              </li>
              <li>
                Open orders are cancelled and whatever they reserved is returned
                to your balance.
              </li>
              <li>
                Nothing is deleted. Your balances, order history and trade
                history stay exactly as they are, so the account can be restored
                by the operator if this was a mistake.
              </li>
            </ul>
            <p data-testid="deactivate-account">
              {emailStatus == "verified" && !isEmpty(email)
                ? `The account that will be closed is ${emailFormat(email)}.`
                : "The account that will be closed is the one you are signed in as."}
            </p>
            <p data-testid="deactivate-step-hint">
              We send a six-digit confirmation code to that address first.
              Nothing changes until you enter it on the next step.
            </p>
            <button
              className={`my-3 ${styles.primary_btn} ${styles.dark}`}
              data-testid="deactivate-send-code"
              onClick={handleRequest}
              disabled={loader}
            >
{" "}
              <label className="mb-0">
                {loader ? (
                  <i className="fa fa-spinner fa-spin"></i>
                ) : (
                  "Send confirmation code"
                )}
              </label>
            </button>
          </>
        ) : (
          <>
            <p data-testid="deactivate-confirm-intro">
              Enter the six-digit confirmation code to close this account. The
              code is valid for three minutes.
            </p>
            {!isEmpty(codeNotice) && (
              <div
                className="alert alert-success py-2 mb-3"
                role="status"
                aria-live="polite"
                data-testid="deactivate-code-notice"
              >
                <div>{codeNotice}</div>
                {codeDelivered === false && !isEmpty(shownCode) && (
                  <div
                    className="mt-1 fs-5 fw-bold font-monospace"
                    data-testid="deactivate-code"
                  >
                    {shownCode}
                  </div>
                )}
                {/* Delivery off and no code returned: an older userapi. Point
                    at the log rather than leave a dead field. */}
                {codeDelivered === false && isEmpty(shownCode) && (
                  <div className="mt-1" data-testid="deactivate-code-missing">
                    No email was sent and this server did not return the code.
                    It was written to the userapi server log.
                  </div>
                )}
              </div>
            )}
            <div className={`mb-3 ${styles.input_box}`}>
              <Form.Label htmlFor="deactivate-otp">
                Confirmation code <span className={styles.required}>*</span>
              </Form.Label>
              <InputGroup className={`${styles.input_grp}`}>
                <Form.Control
                  id="deactivate-otp"
                  placeholder="Enter the 6-digit confirmation code"
                  aria-label="Confirmation code"
                  data-testid="deactivate-otp"
                  name="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  onChange={handleChange}
                  value={otp}
                />
              </InputGroup>
              <p className="text-danger">{error?.otp}</p>
            </div>
            <Form.Group className={`mb-3 ${styles.check_box}`}>
              <Form.Check
                type="checkbox"
                id="deactivate-consent"
                data-testid="deactivate-consent"
                checked={check}
                onChange={() => setCheck(check ? false : true)}
                label="I understand that this signs me out, cancels my resting orders and closes this account to trading."
              />
            </Form.Group>
            {/* One heavy button, and it is the destructive one. `.login_tabs
                .primary_btn` is `width: 100%` with a filled chevron block, so
                two of them side by side read as two equally-weighted choices -
                which is exactly wrong for "close my account" against "go
                back". Cancel is a text link, the way out of every other
                irreversible-looking form on this venue. */}
            <button
              className={`my-3 ${styles.primary_btn} ${styles.dark}`}
              data-testid="deactivate-confirm"
              onClick={handleSubmit}
              disabled={loader}
            >
{" "}
              <label className="mb-0">
                {loader ? (
                  <i className="fa fa-spinner fa-spin"></i>
                ) : (
                  "Deactivate my account"
                )}
              </label>
            </button>
            <div className="text-center">
              <a
                href="/security"
                className={styles.ylw_link}
                data-testid="deactivate-cancel"
                onClick={(e) => {
                  e.preventDefault();
                  handleCancel();
                }}
              >
                Cancel and go back to Security
              </a>
            </div>
          </>
        )}
        {/* Anything userapi reports that is not about the code field. It used
            to read `error?.email`, against an email input that no longer
            exists - so a form-level refusal had nowhere to land and the user
            saw only a toast that had already faded. */}
        {!isEmpty(error?.message) && (
          <p className="text-danger" data-testid="deactivate-form-error">
            {error.message}
          </p>
        )}
      </div>
    </>
  );
}
