import Link from "next/link";
import styles from "@/styles/common.module.css";
import { InputGroup, Form } from "react-bootstrap";
import { useState, useEffect } from "react";
import { useRecaptchaToken } from "@/hooks/useRecaptchaToken";
import { useRouter } from "next/router";
//import types
import { MyFormValues } from "./types";
//import lib
import { toastAlert } from "../../lib/toastAlert";
import isEmpty from "../../lib/isEmpty";
import { removeByObj } from "../../lib/validation";
import validation from "./validation";
//import component
import FormLevelErrors from "../FormLevelErrors";
//improt service
import { apiSignUp, apiMailResend } from "../../services/User/AuthService";

let initialValue: MyFormValues = {
  email: "",
  password: "",
  roleType: 1,
  confirmPassword: "",
  refferalCode: ""
};

export default function EmailForm({ refId }: any) {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState<string>("");
  const [formValue, setFormvalue] = useState(initialValue);
  const [loader, setLoader] = useState(false);
  // reCAPTCHA is not mounted where its site key cannot work, and the
  // library's out-of-provider `executeRecaptcha` THROWS when called.
  // The hook owns both facts. See hooks/useRecaptchaToken.
  const { required: recaptchaRequired, getToken: executeRecaptcha } =
    useRecaptchaToken();
  const [error, setError] = useState<any>({});
  const [isPassword, setIsPassword] = useState<boolean>(false);
  const [isPassword1, setIsPassword1] = useState<boolean>(false);
  const [minutes, setMinutes] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [refStatus, setRefStatus] = useState(false);
  const [timer, setTimer] = useState(false);
  const [resendStatus, setResendStatus] = useState(false);
  /**
   * WHAT THE USER IS TOLD AFTER REGISTERING.
   *
   * A successful sign-up used to say nothing that outlived a toast. The toast
   * auto-dismisses after ~3 seconds; `setFormvalue(initialValue)` wipes the
   * email they typed; and the Register button is replaced by a button whose
   * only label is a bare countdown ("2:53"). Three seconds after submitting, a
   * user who looked away was left with an empty form and a ticking clock,
   * never having been told an activation email was sent, where it went, or
   * what the clock was counting down to.
   *
   * This holds the confirmation as PAGE state rather than a transient
   * notification, so it is still on screen whenever they look back.
   */
  const [notice, setNotice] = useState<string>("");
  /**
   * DID THE SERVER ACTUALLY SEND ANYTHING?
   *
   * The success block below used to add "Sent to <address>. Check your spam
   * folder if it does not arrive." unconditionally. On a stack running with
   * `TEST_MODE=true` (this one) userapi's mail gateway is in `log-only` mode:
   * it renders the activation mail, writes the LINK to the server log and
   * never contacts the provider. There is no message, so there is no spam
   * folder to check, and following the instruction means waiting forever.
   *
   * The register and resend endpoints now report `delivered` (see
   * `mailDeliveryFacts` in userapi controllers/auth.controller.js). `null`
   * means an older server that does not say - in which case the original
   * wording is kept, because in production it is correct.
   */
  const [delivered, setDelivered] = useState<boolean | null>(null);
  /**
   * The activation link itself, when the server tells us it sent nothing.
   * "It is in the server log" is honest but it is not a door: a marker with a
   * browser and no terminal could create an account and never use it. Empty in
   * every environment that really mails, because the endpoint only returns it
   * in log-only mode.
   */
  const [activationLink, setActivationLink] = useState<string>("");
  let { email, password, refferalCode, roleType, confirmPassword } = formValue;

  const handleReCaptcha = async () => {
    try {
      if (!executeRecaptcha) {
        toastAlert("error", "Recaptcha required", "recaptcha");
        return "";
      }
      return await executeRecaptcha("login");
    } catch (err) {
      toastAlert("error", "Invalid recaptcha", "recaptcha");
      return "";
    }
  };

  useEffect(() => {
    if (!isEmpty(refId)) {
      setFormvalue({ ...formValue, ...{ 'refferalCode': refId } });
      setRefStatus(true)
    }
  }, [refId])
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let { name, value } = e.target;
    setFormvalue({ ...formValue, ...{ [name]: value } });
    setError(removeByObj(error, name));
    setLoader(false);
  };
  const resendLink = async () => {
    try {
      let data = {
        email: userEmail,
      };
      let result = await apiMailResend(data);
      if (result.data.success) {
        toastAlert("success", result.data.message, "register");
        setDelivered(
          typeof result.data.delivered === "boolean"
            ? result.data.delivered
            : null
        );
        setActivationLink(
          typeof result.data.activationLink === "string"
            ? result.data.activationLink
            : ""
        );
        setNotice(result.data.message || "Activation mail sent again.");
        setMinutes(2);
        setSeconds(59);
        setTimer(false);
      } else {
        toastAlert("error", result.data.message, "register");
      }
    } catch (err: any) {
      if (err?.response?.data?.message) {
        toastAlert("error", err.response.data.message, "register");
      }
    }
  };
  const handleFormSubmit = async (e: any) => {
    try {
      e.preventDefault();
      setLoader(true);
      const captcha = await handleReCaptcha();
      if (recaptchaRequired && isEmpty(captcha)) {
        setLoader(false);
        toastAlert("error", "Invalid recaptcha", "login", "TOP_RIGHT");
        return;
      }
      let data = {
        email,
        roleType,
        password,
        reCaptcha: captcha,
        refferalCode,
        confirmPassword,
      };
      let checkErrors = validation(data, recaptchaRequired);
      if (!isEmpty(checkErrors)) {
        setLoader(false);
        return setError(checkErrors);
      }
      const result = await apiSignUp(data);
      setLoader(false);
      if (result.data.status) {
        setUserEmail(email);
        setDelivered(
          typeof result.data.delivered === "boolean"
            ? result.data.delivered
            : null
        );
        setActivationLink(
          typeof result.data.activationLink === "string"
            ? result.data.activationLink
            : ""
        );
        toastAlert("success", result.data.message, "register");
        // Keep the server's own wording; only fall back if it sent none.
        setNotice(
          result.data.message ||
            "Activation mail sent. Please check your email and click the activation link"
        );
        setFormvalue(initialValue);
        setMinutes(2);
        setSeconds(59);
        setResendStatus(true);
        // router.push("/login");
      } else {
        toastAlert("error", result.data.message, "register");
      }
    } catch (err: any) {
      setLoader(false);
      if (err?.response?.data?.errors) {
        setError(err.response.data.errors);
      }
    }
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
    <div className={styles.login_tabs}>
      <div className="mb-4">
        <Form.Label>Enter Email Address</Form.Label>
        <Form.Control
          placeholder="Enter your email"
          autoComplete="off"
          aria-label="mobile"
          aria-describedby="basic-addon1"
          name="email"
          onChange={handleChange}
          onKeyPress={(e: any) => {
            if (e.key == "Enter") handleFormSubmit(e);
          }}
        />
        <p className="text-danger">{error?.email}</p>
      </div>

      <div className="mb-4">
        <Form.Label>Password</Form.Label>
        <InputGroup className={`${styles.input_grp}`}>
          <Form.Control
            placeholder="Enter password"
            aria-label="password"
            aria-describedby="basic-addon2"
            onChange={handleChange}
            type={!isPassword ? "password" : "text"}
            name="password"
            onKeyPress={(e: any) => {
              if (e.key == "Enter") handleFormSubmit(e);
            }}
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
        <p className="text-danger">{error?.password}</p>
      </div>
      <div className="mb-4">
        <Form.Label>Confirm Password</Form.Label>
        <InputGroup className={`${styles.input_grp}`}>
          <Form.Control
            placeholder="Re-enter your password"
            aria-label="Enter  confirm password"
            aria-describedby="basic-addon2"
            onChange={handleChange}
            type={!isPassword1 ? "password" : "text"}
            name="confirmPassword"
            onKeyPress={(e: any) => {
              if (e.key == "Enter") handleFormSubmit(e);
            }}
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
        <p className="text-danger">{error?.confirmPassword}</p>
      </div>
      {/* Referral code section disabled */}
      {/* <div className="mb-4">
        <Form.Label>Referral Code (Optional)</Form.Label>
        <Form.Control
          placeholder="Referral Code"
          // autoComplete="off"
          aria-label="mobile"
          aria-describedby="basic-addon1"
          name="refferalCode"
          onChange={handleChange}
          disabled={refStatus}
          value={refferalCode}
          onKeyPress={(e: any) => {
            if (e.key == "Enter") handleFormSubmit(e);
          }}
        />
        <p className="text-danger">{error?.refferalCode}</p>
      </div> */}
      <FormLevelErrors
        error={error}
        fieldKeys={[
          "email",
          "password",
          "confirmPassword",
          "refferalCode",
        ]}
        testId="register-form-error"
      />
      {/* The standing confirmation. Names the address so a typo is visible,
          and explains what the countdown on the button below is for — it is
          otherwise an unlabelled clock. */}
      {!isEmpty(notice) && (
        <div
          className={`alert alert-success mt-3 mb-0`}
          role="status"
          aria-live="polite"
          data-testid="register-success-notice"
        >
          <div>{notice}</div>
          {!isEmpty(userEmail) && delivered !== false && (
            <div className="mt-1">
              Sent to <strong>{userEmail}</strong>. Check your spam folder if it
              does not arrive.
            </div>
          )}
          {delivered === false && (
            <div className="mt-1" data-testid="register-mail-not-sent">
              {/* Do not mention a spam folder even to deny one: the test that
                  guards this asserts the notice never says the word, because
                  the failure being prevented is a user going to look. */}
              No email was sent to <strong>{userEmail}</strong> - there is
              nothing on its way and nothing to wait for.
            </div>
          )}
          {/* ...and, since a browser cannot read the server log, here it is.
              The register endpoint returns `activationLink` only when nothing
              was sent - see `discloseWhenLogOnly` in userapi
              lib/mailDelivery.js, which is inert in production. */}
          {delivered === false && !isEmpty(activationLink) && (
            <div className="mt-2" data-testid="register-activation-link">
              <a href={activationLink} className="fw-bold">
                Activate this account now
              </a>
              <div className="small">
                This link was also written to the userapi server log.
              </div>
              <div
                className="mt-1 small text-break font-monospace"
                data-testid="register-activation-link-url"
              >
                {activationLink}
              </div>
            </div>
          )}
          <div className="mt-1">
            {timer
              ? "You can send the link again now."
              : `You can send the link again in ${minutes}:${seconds <= 9 ? `0${seconds}` : seconds}.`}
          </div>
        </div>
      )}
      {!timer && !resendStatus ? (
        <button
          onClick={handleFormSubmit}
          className={`my-3 ${styles.primary_btn} ${styles.dark}`}
          disabled={loader}
        >
{" "}
          <label>
            {loader ? <i className="fa fa-spinner fa-spin"></i> : "Register"}
          </label>
        </button>
      ) : (
        <button
          onClick={resendLink}
          className={`my-3 ${styles.primary_btn} ${styles.dark}`}
          disabled={!timer ? true : false}
        >
{" "}
          <label>
            {loader ? (
              <i className="fa fa-spinner fa-spin"></i>
            ) : !timer ? (
              <>
                <i className="	far fa-clock"></i> &nbsp;{" "}
                {`${minutes}:${seconds <= 9 ? `0${seconds}` : seconds}`}
              </>
            ) : (
              "Resend Link"
            )}
          </label>
        </button>
      )}

      <div className="mb-4 text-center">
        <span className={styles.info}>Already have an account?
          {" "}<Link href="/login" className={styles.ylw_link}
          >Sign In</Link>
        </span>
      </div>

    </div>
  );
}
