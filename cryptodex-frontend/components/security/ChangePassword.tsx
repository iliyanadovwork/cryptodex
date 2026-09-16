import { useEffect, useState } from "react";
import { InputGroup, Form, Modal } from "react-bootstrap";
import styles from "@/styles/common.module.css";
import { useRouter } from "next/router";
//import types
import { ChangePassFormValue } from "./types";
//import lib
import { removeByObj } from "@/lib/validation";
import { toastAlert } from "@/lib/toastAlert";
import isEmpty from "@/lib/isEmpty";
import { emailFormat } from "@/lib/stringCase";
//improt store
import { useDispatch, useSelector } from "../../store";
import { setUserSetting } from "../../store/UserSetting/dataSlice";
import { onSignOutSuccess } from "../../store/auth/sessionSlice";
import { setUser, initialState } from "../../store/auth/userSlice";
//import service
import {
  apiEmailOTPRequest,
  apiPasswordChange,
} from "../../services/User/UserServices";

/**
 * THE CODE THIS MODAL ASKS FOR IS AN E-MAIL CODE, AND ONLY AN E-MAIL CODE.
 * =======================================================================
 * `handleSendCode` posts user/sendOTP with **roleType 1**, which is
 * requestOTP's e-mail arm: it writes `user.emailOTP` and mails it. The submit
 * then sends `type: 2`, which is what userapi's `changePassword` needs to
 * verify against that field (`optVerification(2, ...)`).
 *
 * There used to be a second path here - `onOTPsend`, roleType 2 - that asked
 * requestOTP to TEXT the code to a phone, shown when `phoneStatus == "verified"`.
 * It went with the phone and SMS surface. Nothing can set `phoneStatus` to
 * verified any more (phone binding and registration-by-phone are both gone), so
 * that branch was already unreachable, and `sentSms` behind it is being removed
 * too.
 *
 * CONSEQUENCE FOR WHOEVER TRIMS userapi: **user/sendOTP roleType 1 and
 * user/verifyOtp must survive.** Change password is a kept feature and it
 * cannot complete without them - `changePassword` rejects any request whose
 * `type` is neither 1 nor 2, and type 2 is verified against the e-mailed code.
 * Deleting the whole OTP route as "phone OTP" would take change-password with
 * it.
 */

let initialFormValue: ChangePassFormValue = {
  oldPassword: "",
  password: "",
  confirmPassword: "",
  otp: "",
};
export default function ChangePassword({
  password_modal,
  setpassword_modal,
}: any) {
  const dispatch = useDispatch();
  const history = useRouter();
  const { email, emailStatus } = useSelector((state: any) => state.auth.user);
  const [formValue, setFormValue] =
    useState<ChangePassFormValue>(initialFormValue);
  const [error, setError] = useState<any>({});
  const [loader, setLoader] = useState<boolean>(false);
  const [otpButtonType, setOTPButtonType] = useState<string>("Send");
  const [check, setCheck] = useState<boolean>(false);
  const [isPassword, setIsPassword] = useState<boolean>(false);
  const [isPassword1, setIsPassword1] = useState<boolean>(false);
  const [isPassword2, setIsPassword2] = useState<boolean>(false);
  const [minutes, setMinutes] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [timer, setTimer] = useState(false);
  /**
   * WHAT HAPPENED TO THE CODE WE JUST CLAIMED TO SEND.
   * =================================================
   * Pressing Send raised "Verification code sent to your email ID", and that
   * was the last the user heard of it. On this stack userapi is in `log-only`
   * delivery (GET /api/health -> email.deliveryMode): /sendOTP writes
   * `user.emailOTP`, renders the mail, logs it, and never contacts a provider.
   * The fourth field of this dialog is therefore unanswerable, and
   * `changePassword` REQUIRES it - deliberately, see the note on that handler
   * in userapi controllers/user.controller.js. So Change Password could not be
   * completed by anyone without shell access to the server.
   *
   * The code is still required and still verified. /sendOTP now reports
   * `delivered` and, when it sent nothing, returns the `verificationCode` it
   * stored so this dialog can show it. `discloseWhenLogOnly` in userapi
   * lib/mailDelivery.js makes that inert in production, and the route is
   * authenticated - the code belongs to the session already holding it.
   */
  const [codeNotice, setCodeNotice] = useState<string>("");
  const [codeDelivered, setCodeDelivered] = useState<boolean | null>(null);
  const [shownCode, setShownCode] = useState<string>("");

  let { oldPassword, password, confirmPassword, otp } = formValue;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let { name, value } = e.target;
    setFormValue({ ...formValue, ...{ [name]: value } });
    setError(removeByObj(error, name));
    setLoader(false);
  };

  const handleSendCode = async () => {
    try {
      let data = {
        roleType: 1,
        requestType: "ChangePass",
      };
      const result = await apiEmailOTPRequest(data);
      if (result.data.status) {
        setOTPButtonType("Resend");
        setMinutes(2);
        setSeconds(59);
        // `null` = an older server that does not report delivery; keep the
        // mail wording, which is the correct wording in production.
        setCodeDelivered(
          typeof result.data.delivered === "boolean"
            ? result.data.delivered
            : null
        );
        setShownCode(
          typeof result.data.verificationCode === "string"
            ? result.data.verificationCode
            : ""
        );
        setCodeNotice(
          result.data.message ||
            "Verification code sent to your email ID, Verification code is valid only for 3 minutes"
        );
        toastAlert("success", result.data.message, "pass","TOP_RIGHT");
      } else {
        toastAlert("success", result.data.message, "pass","TOP_RIGHT");
      }
    } catch (err: any) {
      toastAlert("error", err?.response?.data?.message || "Could not send the verification code", "pass","TOP_RIGHT");
    }
  };

  const handleLogout = () => {
    document.cookie =
      "loggedin" + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    dispatch(setUser(initialState));
    dispatch(onSignOutSuccess());
    dispatch(setUserSetting({}));
    toastAlert("success", "Logout successfully", "login");
    history.push("/login");
  };

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    try {
      let reqData = {
        oldPassword,
        password,
        confirmPassword,
        otp,
        // Always 2 - "verify against the e-mailed code". It used to fall back
        // to 1, the SMS code, when the address was unverified; that branch
        // asked userapi to check a field only the removed SMS sender ever
        // wrote, so it could not succeed. There is one kind of code now.
        type: 2,
      };
      console.log(check, "-check")
      if (
        !check &&
        !isEmpty(reqData.oldPassword) &&
        !isEmpty(reqData.password) &&
        !isEmpty(reqData.confirmPassword)
      ) {
        return toastAlert("error", "Please enable check box", "pass","TOP_RIGHT");
      }
      const result = await apiPasswordChange(reqData);

      if (result.data.success) {
        setMinutes(0)
        setSeconds(0)
        toastAlert("success", result.data.message, "pass","TOP_RIGHT");
        setTimeout(() => {
          handleLogout();
        }, 1000);
      }
    } catch (err: any) {
      if (!isEmpty(err?.response?.data?.errors)) {
        setError(err.response.data.errors);
      }
      if (!isEmpty(err?.response?.data?.message))
        toastAlert("error", err.response.data.message, "pass","TOP_RIGHT");
    }
  };

  const handleClose = () => {
    setpassword_modal(false);
    setError({});
    setFormValue(initialFormValue);
    // Do not leave a stale code on screen for the next time the dialog opens -
    // it would have expired, and offering an expired code is the same class of
    // lie this dialog was fixed for.
    setCodeNotice("");
    setCodeDelivered(null);
    setShownCode("");
  };

  useEffect(() => {
    let myInterval = setInterval(() => {
      if (seconds > 0) {
        setSeconds(seconds - 1);
      }
      if (seconds === 0) {
        if (minutes === 0) {
          clearInterval(myInterval);
        } else {
          setMinutes(minutes - 1);
          setSeconds(59);
        }
      }
    }, 1000);
    return () => {
      clearInterval(myInterval);
      if (seconds == 1 && minutes == 0) {
        setTimer(true);
      }
    };
  });

  return (
    <>
      <Modal
        show={password_modal}
        onHide={handleClose}
        centered
        backdrop="static"
        className={styles.custom_modal}
      >
        <Modal.Header closeButton className={styles.modal_head}>
          <Modal.Title>Change Password</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <div className={`mb-3 ${styles.input_box}`}>
              <Form.Label>
                Old password <span className={styles.required}>*</span>
              </Form.Label>
              <InputGroup className={`${styles.input_grp}`}>
                <Form.Control
                  type={!isPassword ? "password" : "text"}
                  placeholder="Please enter the old password"
                  name="oldPassword"
                  onChange={handleChange}
                />
                <InputGroup.Text id="basic-addon2" className="border-start-0">
                  {" "}
                  <i
                    className={`${styles.eye} ${isPassword ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"
                      }`}
                    onClick={() => setIsPassword(isPassword ? false : true)}
                  ></i>{" "}
                </InputGroup.Text>
              </InputGroup>
              <p className="text-danger">{error?.oldPassword}</p>
            </div>
            <div className={`mb-3 ${styles.input_box}`}>
              <Form.Label>
                New password <span className={styles.required}>*</span>
              </Form.Label>
              <InputGroup className={`${styles.input_grp}`}>
                <Form.Control
                  type={!isPassword1 ? "password" : "text"}
                  placeholder="Please enter a new password"
                  name="password"
                  onChange={handleChange}
                />
                <InputGroup.Text id="basic-addon2" className="border-start-0">
                  {" "}
                  <i
                    className={`${styles.eye} ${isPassword1 ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"
                      }`}
                    onClick={() => setIsPassword1(isPassword1 ? false : true)}
                  ></i>{" "}
                </InputGroup.Text>
              </InputGroup>
              <p className="text-danger">{error?.password}</p>
            </div>
            <div className={`mb-3 ${styles.input_box}`}>
              <Form.Label>
                Confirm New password <span className={styles.required}>*</span>
              </Form.Label>
              <InputGroup className={`${styles.input_grp}`}>
                <Form.Control
                  type={!isPassword2 ? "password" : "text"}
                  placeholder="Please enter a new password again"
                  name="confirmPassword"
                  onChange={handleChange}
                />
                <InputGroup.Text id="basic-addon2" className="border-start-0">
                  {" "}
                  <i
                    className={`${styles.eye} ${isPassword2 ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"
                      }`}
                    onClick={() => setIsPassword2(isPassword2 ? false : true)}
                  ></i>{" "}
                </InputGroup.Text>
              </InputGroup>
              <p className="text-danger">{error?.confirmPassword}</p>
            </div>
            {emailStatus == "verified" && (
              <div className={`mb-3 ${styles.input_box}`}>
                <Form.Label className="d-flex">
                  Your secure email address is {emailFormat(email)}
                  <span className={styles.required}>*</span>
                </Form.Label>
                <InputGroup className={`${styles.input_grp}`}>
                  <Form.Control
                    placeholder="Enter your email verification code "
                    aria-label="Recipient's username"
                    aria-describedby="basic-addon2"
                    name="otp"
                    type='number'
                    onChange={handleChange}
                  />
                  {minutes == 0 && seconds == 0 &&
                    <InputGroup.Text id="basic-addon2">
                      {" "}
                      <span className={styles.all} onClick={handleSendCode}>
                        {" "}
                        {otpButtonType}
                      </span>{" "}
                    </InputGroup.Text>
                  }
                </InputGroup>
                <p className="text-danger">{error?.otp}</p>
                {!isEmpty(codeNotice) && (
                  <div
                    className="alert alert-success py-2 mb-0"
                    role="status"
                    aria-live="polite"
                    data-testid="change-password-code-notice"
                  >
                    <div>{codeNotice}</div>
                    {codeDelivered === false && !isEmpty(shownCode) && (
                      <div
                        className="mt-1 fs-5 fw-bold font-monospace"
                        data-testid="change-password-code"
                      >
                        {shownCode}
                      </div>
                    )}
                    {/* Delivery off and no code returned: an older userapi.
                        Point at the log rather than leave a dead field. */}
                    {codeDelivered === false && isEmpty(shownCode) && (
                      <div
                        className="mt-1"
                        data-testid="change-password-code-missing"
                      >
                        No email was sent and this server did not return the
                        code. It was written to the userapi server log.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {(minutes != 0 || seconds != 0) && (
              <p>
                {" "}
                Verification code valid up to :{" "}
                {`${minutes}:${seconds <= 9 ? `0${seconds}` : seconds}`}{" "}
              </p>
            )}
            <Form.Group
              className={`mb-3 ${styles.check_box}`}
              controlId="exampleForm.ControlInput1"
            >
              {/* WHAT THE USER IS ASKED TO ACKNOWLEDGE HAS TO BE TRUE.
                  =================================================
                  The old line was: "I have been informed that if I log in to
                  this account on a new device after changing the login
                  password, I will be temporarily unable to withdraw coins
                  within 24 hours." It is boilerplate from a custodial exchange
                  and every clause of it is false here.

                  There is no 24-hour hold, no cooling-off period and no
                  withdrawal to hold: userapi changePassword
                  (controllers/user.controller.js) verifies the old password and
                  the OTP, writes the new password, mails an alert and returns.
                  It sets no timer and touches no wallet, and this venue has no
                  coin withdrawal at all - /withdraw is the demo-account reset.

                  Nor does a password change end any session: the redis
                  `userToken` row carries one `tokenId` per account and only a
                  LOGIN mints a new one (auth.controller.js), so changing the
                  password leaves every existing token valid. What does end a
                  session is signing in somewhere else, which overwrites that
                  one tokenId and invalidates the token the other device holds -
                  and that is true whether or not the password ever changes.

                  So the acknowledgement now states the two things that do
                  happen, both of which are consequences the user should agree
                  to before pressing Confirm. */}
              <Form.Check
                onClick={() => setCheck(check ? false : true)}
                type="checkbox"
                id={`default-checkbox`}
                data-testid="change-password-consent"
                label={`I understand that changing my password signs me out here and I will need to sign in again with the new password, and that this account allows one signed-in device at a time — signing in somewhere else ends the session on this one.`}
              />
            </Form.Group>
          </Form>
          <div className={`mt-4 ${styles.modal_footer}`}>
            <button className={`${styles.primary_btn}`} onClick={handleClose}>
              <label>Cancel</label>
            </button>
            <button
              className={`${styles.primary_btn} ${styles.dark}`}
              onClick={handleSubmit}
              disabled={loader}
            >
              <label>
                {loader ? <i className="fa fa-spinner fa-spin"></i> : "Confirm"}
              </label>
            </button>
          </div>
        </Modal.Body>
      </Modal>
    </>
  );
}
