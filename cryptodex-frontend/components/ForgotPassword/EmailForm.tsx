import { useState } from "react";
import Link from "next/link";
import styles from "@/styles/common.module.css";
import { InputGroup, Form } from "react-bootstrap";
import { useRecaptchaToken } from "@/hooks/useRecaptchaToken";
//import lib
import { removeByObj } from "@/lib/validation";
import { toastAlert } from "@/lib/toastAlert";
import isEmpty from "@/lib/isEmpty";
//improt service
import { apiForgotPassword } from "../../services/User/AuthService";
//import component
import FormLevelErrors from "../FormLevelErrors";

type FomrValue = {
  email: string;
};
let initialFormValue: FomrValue = {
  email: "",
};
export default function EmailForm() {
  // reCAPTCHA is not mounted where its site key cannot work, and the
  // library's out-of-provider `executeRecaptcha` THROWS when called.
  // The hook owns both facts. See hooks/useRecaptchaToken.
  const { required: recaptchaRequired, getToken: executeRecaptcha } =
    useRecaptchaToken();
  const [formValue, setFormValue] = useState<FomrValue>(initialFormValue);
  const [error, setError] = useState<any>({});
  const [loader, setLoader] = useState<boolean>(false);
  const { email } = formValue;
  /**
   * THE ONLY WAY BACK INTO A LOCKED-OUT ACCOUNT, AND IT USED TO BE A TOAST.
   * ======================================================================
   * Submitting this form raised a green "Reset password link sent to
   * registered mail ID" toast, which faded, and that was the end of the
   * interaction. On this stack userapi's mail gateway runs in `log-only` mode
   * (GET /api/health -> email.deliveryMode): the reset mail is rendered, the
   * link is written to the process log, and the provider is never contacted.
   * Nothing was sent, so the user waited for a mail that could not arrive -
   * and this page is the ONLY route to a password reset. Permanently locked
   * out, told help was on the way.
   *
   * `/api/auth/forgotPassword` now reports `delivered`, and in log-only mode
   * returns the `resetLink` it wrote to the log. Held as page state rather
   * than a toast, because the whole point is that the user has to be able to
   * act on it.
   */
  const [notice, setNotice] = useState<string>("");
  const [delivered, setDelivered] = useState<boolean | null>(null);
  const [resetLink, setResetLink] = useState<string>("");
  const [sentTo, setSentTo] = useState<string>("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let { name, value } = e.target;
    setFormValue({ ...formValue, ...{ [name]: value } });
    setError(removeByObj(error, name));
    setLoader(false);
  };

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

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    try {
      setLoader(true);
      const captcha = await handleReCaptcha();
      if (recaptchaRequired && isEmpty(captcha)) {
        setLoader(false);
        toastAlert("error", "Invalid recaptcha", "login", "TOP_RIGHT");
        return;
      }
      let reqData = {
        email,
        roleType: 1,
        reCaptcha: captcha,
      };

      let response = await apiForgotPassword(reqData);
      if (response.data.success == true) {
        setLoader(false);
        setSentTo(email);
        setFormValue(initialFormValue);
        setError({});
        // `null` = an older server that does not say. Keep the mail wording in
        // that case, because in production it is the correct wording.
        setDelivered(
          typeof response.data.delivered === "boolean"
            ? response.data.delivered
            : null
        );
        setResetLink(
          typeof response.data.resetLink === "string"
            ? response.data.resetLink
            : ""
        );
        setNotice(
          response.data.message || "Reset password link sent to registered mail ID"
        );
        toastAlert("success", response.data.message, "forgotPassword");
      }
    } catch (err: any) {
      setLoader(false);
      if (err?.response?.data?.errors) {
        setError(err.response.data.errors);
      }
      if (err?.response?.data?.message) {
        toastAlert("error", err.response.data.message, "forgotPassword");
      }
    }
  };
  return (
    <>
      <div className={styles.login_tabs}>
        <div className="mb-4">
          <Form.Label>Email Address</Form.Label>
          <InputGroup>
            <Form.Control
              placeholder="Enter Email Address"
              aria-label="mobile"
              aria-describedby="basic-addon1"
              name="email"
              onChange={handleChange}
              value={email}
            />
          </InputGroup>
          <p className="text-danger">{error?.email}</p>
        </div>
        <FormLevelErrors
          error={error}
          fieldKeys={["email"]}
          testId="forgot-form-error"
        />
        {!isEmpty(notice) && (
          <div
            className="alert alert-success mt-3 mb-0"
            role="status"
            aria-live="polite"
            data-testid="forgot-success-notice"
          >
            <div>{notice}</div>
            {delivered !== false && !isEmpty(sentTo) && (
              <div className="mt-1">
                Sent to <strong>{sentTo}</strong>. Check your spam folder if it
                does not arrive.
              </div>
            )}
            {delivered === false && !isEmpty(resetLink) && (
              <div className="mt-2" data-testid="forgot-reset-link">
                <a href={resetLink} className="fw-bold">
                  Open the reset link for {sentTo}
                </a>
                <div
                  className="mt-1 small text-break font-monospace"
                  data-testid="forgot-reset-link-url"
                >
                  {resetLink}
                </div>
              </div>
            )}
            {/* Delivery is off but the server sent no link: an older userapi.
                Say where to look rather than leaving a dead end. */}
            {delivered === false && isEmpty(resetLink) && (
              <div className="mt-1" data-testid="forgot-reset-link-missing">
                No email was sent and this server did not return the link. It
                was written to the userapi server log.
              </div>
            )}
          </div>
        )}
        <button
          className={`my-3 ${styles.primary_btn} ${styles.dark}`}
          onClick={handleSubmit}
          disabled={loader}
        >
{" "}
          <label>
            {loader ? <i className="fa fa-spinner fa-spin"></i> : "Confirm"}{" "}
          </label>
        </button>
      </div>
    </>
  );
}
