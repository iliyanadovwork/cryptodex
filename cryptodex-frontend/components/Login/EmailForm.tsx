import Link from "next/link";
import styles from "@/styles/common.module.css";
import { Form, InputGroup } from "react-bootstrap";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRecaptchaToken } from "@/hooks/useRecaptchaToken";
import { useDispatch } from "react-redux";
// import { useCookies } from "react-cookie";
import { useRouter } from "next/router";
import axios from "axios";
import browser from "browser-detect";
//improt types
import { MyFormValues } from "./types";
//import lib
import isEmpty from "@/lib/isEmpty";
import { toastAlert } from "@/lib/toastAlert";
import { removeByObj } from "@/lib/validation";
import validation from "./validation";
//import store
import { setUser } from "../../store/auth/userSlice";
import { setUserSetting } from "../../store/UserSetting/dataSlice";
import { onSignInSuccess } from "../../store/auth/sessionSlice";
//improt service
import { apiSignIn, resendOtp } from "../../services/User/AuthService";
import { setCookie, removeCookie } from "@/utils/cookie";
import CookiesLib from "js-cookie";

const initialFormValue: MyFormValues = {
  email: "",
  roleType: 1,
  password: "",
  otp: "",
  isTerms: false,
  newPhoneCode: "",
  newPhoneNo: "",
};

export default function EmailForm() {
  const submitButtonRef = useRef(null);
  // reCAPTCHA is not mounted where its site key cannot work, and the
  // library's out-of-provider `executeRecaptcha` THROWS when called.
  // The hook owns both facts. See hooks/useRecaptchaToken.
  const { required: recaptchaRequired, getToken: executeRecaptcha } =
    useRecaptchaToken();
  const dispatch = useDispatch();
  const router = useRouter();
  const [formValue, setFormvalue] = useState(initialFormValue);
  const [error, setError] = useState<any>({});
  const [loader, setLoader] = useState(false);
  const [loginHistory, setLoginHistory] = useState({});
  const [isMobile, setisMobile] = useState(false);
  const [checkbox, setCheckBox] = useState(false);
  //otpbox
  const [minutes, setMinutes] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [timer, setTimer] = useState(false);
  const [resendOtpBtnStatus, setResendOtpBtnStatus] = useState(false);
  const [otpTextBox, setOtpTextBox] = useState(false);
  /**
   * THE LOGIN CODE, WHEN THE SERVER TELLS US IT COULD NOT SEND IT.
   * =============================================================
   * This second step is skipped entirely while userapi runs with
   * TEST_MODE=true, which is how this venue runs - so on this stack it is not
   * reached. It matters for the OTHER way delivery gets switched off:
   * `mailDeliveryMode` (userapi lib/mailDelivery.js) also goes log-only on
   * DEV_EMAIL_BYPASS=true alone, and the skip in userLogin does not consult
   * that flag. On such a run the sign-in page would demand a code that was
   * rendered to a log and never sent - the front door locked while every
   * recovery surface worked.
   *
   * /api/auth/login now reports `delivered` and, having ALREADY verified the
   * password, returns the code it could not deliver. Inert in production.
   */
  const [codeNotice, setCodeNotice] = useState<string>("");
  const [codeDelivered, setCodeDelivered] = useState<boolean | null>(null);
  const [shownCode, setShownCode] = useState<string>("");

  const applyCodeDelivery = (data: any) => {
    setCodeDelivered(typeof data?.delivered === "boolean" ? data.delivered : null);
    setShownCode(
      typeof data?.verificationCode === "string" ? data.verificationCode : ""
    );
    setCodeNotice(data?.message || "");
  };
  // const [cookies, setCookie] = useCookies(["name"]);
  const [isPassword, setIsPassword] = useState<boolean>(false);
  const {
    email,
    password,
    isTerms,
    newPhoneCode,
    newPhoneNo,
    otp,
    roleType,
  } = formValue;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let { name, value } = e.target;
    if (name == 'otp') {
      if (/[^0-9]/.test(value)) return;
    }
    setFormvalue({ ...formValue, ...{ [name]: value } });
    setError(removeByObj(error, name));
    setLoader(false);
    if (name == "otp" && value?.length == 6) {
      setTimeout(() => {
        autoSubmit();
      }, 500);
    }
  };
  const handleReCaptcha = useCallback(async () => {
    try {
      if (!executeRecaptcha) {
        // toastAlert("error", "Recaptcha required", "recaptcha");
        console.log('Execute recaptcha not yet available');
        return "";
      }
      return await executeRecaptcha("emailLogin");
    } catch (err) {
      console.log(err, "Error on recaptcha");
      toastAlert("error", "Invalid recaptcha!", "recaptcha");
      return "";
    }
  }, [executeRecaptcha]);

  const autoSubmit = () => {
    // Trigger a click on the submit button
    if (submitButtonRef.current) {
      submitButtonRef.current.click();
    }
  };

  const handleFormSubmit = async (e: any) => {
    e.preventDefault();
    try {
      setLoader(true);
      const captcha = await handleReCaptcha();
      if (recaptchaRequired && isEmpty(captcha)) {
        setLoader(false);
        toastAlert("error", "Invalid recaptcha", "login", "TOP_RIGHT");
        return;
      }
      let data = {
        email,
        password,
        isTerms,
        roleType,
        loginHistory,
        newPhoneCode,
        newPhoneNo,
        otp,
        otpTextBox,
        reCaptcha: captcha,
        checkbox,
      };
      let checkErrors = validation(data);
      console.log("checkErrors--------",checkErrors);
      
      if (!isEmpty(checkErrors)) {
        setLoader(false);
        setError(checkErrors);
        return;
      }
      let response = await apiSignIn(data);

      if (response.data.status == "SUCCESS") {
        // Clear old cookies first (in case they have wrong path)
        CookiesLib.remove("loggedin", { path: "/" });
        CookiesLib.remove("loggedin");
        CookiesLib.remove("userToken", { path: "/" });
        CookiesLib.remove("userToken");

        dispatch(onSignInSuccess(response.data.token));
        setError({});
        dispatch(setUser(response.data.result));
        dispatch(setUserSetting(response.data.userSetting));

        // Save token directly to localStorage as a reliable fallback
        if (typeof window !== "undefined") {
          localStorage.setItem("authToken", response.data.token);
        }

        // Set cookies with proper attributes
        CookiesLib.set("loggedin", true, { expires: 365, path: "/", sameSite: 'lax' });
        CookiesLib.set("userToken", response.data.token, { expires: 365, path: "/", sameSite: 'lax' });

        // Also use the setCookie utility for consistency
        setCookie("loggedin", true);
        setCookie("userToken", response.data.token);

        console.log("Auth token saved to localStorage:", !!localStorage.getItem("authToken"));
        console.log("Cookies set:", {
          loggedin: CookiesLib.get("loggedin"),
          hasToken: !!CookiesLib.get("userToken")
        });

        // Wait longer for redux-persist to save to localStorage
        setTimeout(() => {
          setFormvalue(initialFormValue);
          setLoader(false);
          toastAlert("success", response.data.message, "login");
          console.log("Redirecting to wallet...");
          router.push("/wallet");
          // router.push("/spot/BTC_USDT");
        }, 1000);
      } else if (response.data.status == "OTP_SENT") {
        setError({});
        setisMobile(isMobile);
        setLoader(false);
        toastAlert("success", response.data.message, "login");
      } else if (response.data.status == "OTP") {
        setError({});
        setMinutes(2);
        setSeconds(59);
        setLoader(false);
        setResendOtpBtnStatus(true);
        setOtpTextBox(true);
        applyCodeDelivery(response.data);
        toastAlert("success", response.data.message, "login");
      }
    } catch (err: any) {
      setLoader(false);
      if (err?.response?.data?.errors) {
        setError(err.response.data.errors);
      }
      if (err?.response?.data?.message)
        toastAlert("error", err.response.data.message, "login");
    }
  };
  // const handleCheck = () => {
  //   setCheckBox(checkbox ? false : true);
  //   setError(removeByObj(error, "checkbox"));
  //   setLoader(false);
  // };

  const handleResendOtp = async (e: any) => {
    e.preventDefault();
    setLoader(true);
    let reqData = {
      email,
      newPhoneCode,
      newPhoneNo,
      password,
      isTerms,
      roleType,
      otp,
      otpTextBox,
      loginHistory,
    };
    try {
      let response = await resendOtp(reqData);
      setLoader(false);

      if (response.data.status == "RESEND_OTP") {
        setMinutes(2);
        setSeconds(59);
        setOtpTextBox(true);
        setTimer(false);
        applyCodeDelivery(response.data);
        toastAlert("success", response.data.message, "login");
        // setValidateError(error);
        // grecaptchaObject.reset()
        return;
      }
    } catch (err: any) {
      setLoader(false);
      if (err?.response?.data?.error) {
        setError(err.response.data.error);
        return;
      }
      toastAlert("error", err.response.data.message, "login");
    }
  };
  // Same-origin, no third party. This used to call https://ipapi.co/json/ on
  // every mount — blocked cross-origin on a local http stack, two console
  // errors per page load, and a geolocation lookup a hobby paper-trading stack
  // has no business making. pages/api/client-info reports the address the Next
  // server actually saw. A failure here must never block the sign-in, so the
  // browser half is filled in regardless.
  const getGeoInfo = async () => {
    const browserResult = browser();
    const base = {
      broswername: browserResult.name,
      ismobile: browserResult.mobile,
      os: browserResult.os,
    };
    try {
      let respData = await axios({
        method: "get",
        url: `/api/client-info`,
      });
      setLoginHistory({
        countryName: respData.data.country_name,
        countryCode: respData.data.country_calling_code,
        ipaddress: respData.data.ip,
        region: respData.data.region,
        ...base,
      });
    } catch (err) {
      setLoginHistory({
        countryName: "",
        countryCode: "",
        ipaddress: "",
        region: "",
        ...base,
      });
    }
  };
  useEffect(() => {
    getGeoInfo();
  }, []);

  // useEffect(() => {
  //   handleReCaptcha();
  // }, [handleReCaptcha]);

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
      if (seconds == 1 && minutes == 0 && resendOtpBtnStatus) {
        setTimer(true);
      }
    };
  });
  return (
    <div className={styles.login_tabs}>
      {!otpTextBox && (
        <>
          <div className="mb-4">
            <Form.Label>Email Address</Form.Label>
            <Form.Control
              placeholder="Enter your email"
              aria-label="mobile"
              aria-describedby="basic-addon1"
              onChange={handleChange}
              name="email"
              type="text"
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
        </>
      )}

      {otpTextBox && (
        <div className="mb-4">
          <Form.Label>OTP</Form.Label>
          <Form.Control
            placeholder="Enter OTP code"
            aria-label="otp"
            type="text"
            aria-describedby="basic-addon2"
            onChange={handleChange}
            name="otp"
            value={otp}
            onKeyPress={(e: any) => {
              if (e.key == "Enter") handleFormSubmit(e);
            }}
          />
          <p className="text-danger">{error?.otp}</p>
          {codeDelivered === false && !isEmpty(codeNotice) && (
            <div
              className="alert alert-success py-2 mb-0"
              role="status"
              aria-live="polite"
              data-testid="login-code-notice"
            >
              <div>{codeNotice}</div>
              {!isEmpty(shownCode) ? (
                <div
                  className="mt-1 fs-5 fw-bold font-monospace"
                  data-testid="login-code"
                >
                  {shownCode}
                </div>
              ) : (
                <div className="mt-1" data-testid="login-code-missing">
                  No email was sent and this server did not return the code. It
                  was written to the userapi server log.
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {(minutes != 0 || seconds != 0) && otpTextBox && (
        <p>
          {" "}
          OTP valid up to :{" "}
          {`${minutes}:${seconds <= 9 ? `0${seconds}` : seconds}`}{" "}
        </p>
      )}
      {/* {!otpTextBox && (
        <Form.Group
          className={`mb-3 ${styles.check_box}`}
          controlId="exampleForm.ControlInput1"
        >
          <Form.Check
            type="checkbox"
            label="I accept and agree to the terms & conditions."
            className={styles.check}
            name="radioGroup"
            id={`default-checkbox1`}
            onClick={handleCheck}
          />
          <p className="text-danger">{error?.checkbox}</p>
        </Form.Group>
      )} */}

      {/* <span className={styles.info}>
        Clicking the button means you have read and agreed to{" "}
      </span>
      <Link
        href="/terms"
        className={styles.ylw_link}
        // onClick={() => router.push("/terms")}
      >
        Cryptodex Service Agreement{" "}
      </Link> */}
      {!timer ? (
        <button
          className={`my-3 ${styles.primary_btn} ${styles.dark}`}
          onClick={handleFormSubmit}
          ref={submitButtonRef}
          disabled={loader}
        >
{" "}
          <label className="mb-0">
            {loader ? <i className="fa fa-spinner fa-spin"></i> : "Log In"}
          </label>
        </button>
      ) : (
        <button
          className={`my-3 ${styles.primary_btn} ${styles.dark}`}
          onClick={handleResendOtp}
          disabled={loader}
        >
{" "}
          <label>
            {loader ? <i className="fa fa-spinner fa-spin"></i> : "Resend OTP"}
          </label>
        </button>
      )}
    <div className="mb-4 text-center">
        <span className={styles.info}>Don't have an account?
          {" "}<Link href="/register" className={styles.ylw_link}
          >Sign Up</Link>
          </span>
      </div>
      <Link
        href="/forget"
        className={`text-center d-block ${styles.ylw_link}`}
        // onClick={() => router.push("/forget")}
      >
        Forgot Password?
      </Link>
    </div>
  );
}
