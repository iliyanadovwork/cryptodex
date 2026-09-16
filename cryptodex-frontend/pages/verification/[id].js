import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Container, Row, Col } from "react-bootstrap";

import styles from "@/styles/common.module.css";
import Mainnavbar from "@/components/navbar";
import { toastAlert } from "../../lib/toastAlert";

import {
  resetPasswordVerification,
  userEmailActivation,
} from "../../services/User/AuthService";

/**
 * THE PAGE EVERY MAILED LINK LANDS ON, AND IT ONLY EVER HANDLED SUCCESS.
 * =====================================================================
 *
 * WHAT IT USED TO DO
 * ------------------
 * It rendered exactly two things: `<p>Loading</p>` and `<p>Invalid Url</p>`,
 * neither of them styled, neither of them offering anywhere to go. Every
 * failure was a toast fired at the same moment as a `history.push` to another
 * route, so the message was racing a navigation. Three concrete dead ends:
 *
 *   EXPIRED / ALREADY USED  the API answers 400, the catch toasts and pushes
 *                           to "/" or "/login". The toast is thrown away by
 *                           the navigation on a slow render and the user is
 *                           dumped on a page that never says what went wrong.
 *   MISTYPED / GARBAGE      userapi could not decrypt it, hit a mongoose
 *                           CastError and answered HTTP 500 "Error on server",
 *                           which this page then showed verbatim. A user's
 *                           typo was reported as our crash. (Fixed on the
 *                           server too - see `userFromMailToken` in userapi
 *                           controllers/auth.controller.js.)
 *   TRUNCATED / NO `auth`   a link cut short by a mail client leaves `auth`
 *                           undefined. The request went out anyway, the error
 *                           shape had no `message`, and `error.response` was
 *                           itself undefined on a network failure - so the
 *                           catch threw and the page sat on "Loading" for
 *                           ever. It also sat there for ever for any `id`
 *                           this file does not know, and on the very first
 *                           render before Next has populated `router.query`.
 *
 * WHAT IT DOES NOW
 * ----------------
 * One explicit state machine - `working` -> `success` | `error` - that always
 * terminates. Nothing navigates away on failure: the reason is rendered ON the
 * page, with the route back to the flow that can reissue the link. `auth` is
 * validated before a request is made, `router.isReady` gates the effect, and
 * an unrecognised `id` is an error rather than a permanent spinner.
 *
 * The `coinwithdraw` and `fiatWithdraw` branches are GONE. They posted to
 * wallet/coinWithdraw and wallet/fiatWithdraw, both of which were removed from
 * walletapi with the rest of the custody surface (routes/wallet.route.js) -
 * there is no withdrawal on a paper venue. They could only 404, and offering a
 * "way forward" for a flow that does not exist is not a way forward.
 */

/** How long the success screen stays up before we move the user on. */
const REDIRECT_DELAY_MS = 1200;

/** What each link kind is called, and where its "try again" lives. */
const FLOWS = {
  register: {
    title: "Account activation",
    onSuccess: "/login",
    actions: [
      { href: "/register", label: "Request a new activation link" },
      { href: "/login", label: "Go to sign in" },
    ],
  },
  forgotPassword: {
    title: "Password reset",
    onSuccess: null, // handled below: we go to /reset-password/<token>
    actions: [
      { href: "/forget", label: "Start a new password reset" },
      { href: "/login", label: "Go to sign in" },
    ],
  },
};

/** Pull a usable message out of anything axios can hand us. */
const messageFrom = (error, fallback) =>
  error?.response?.data?.message ||
  error?.response?.data?.errors?.userId ||
  error?.response?.data?.errors?.authToken ||
  fallback;

export default function EmailVerification() {
  const history = useRouter();
  const { id, auth } = history.query;

  const [phase, setPhase] = useState("working");
  const [message, setMessage] = useState("");

  const flow = FLOWS[id] || null;

  const fail = (text) => {
    setMessage(text);
    setPhase("error");
  };

  const succeed = (text, go) => {
    setMessage(text);
    setPhase("success");
    toastAlert("success", text, "verification");
    if (go) {
      setTimeout(() => history.push(go), REDIRECT_DELAY_MS);
    }
  };

  const emailActivation = async () => {
    try {
      const response = await userEmailActivation({ userId: auth });
      if (response?.data?.success) {
        succeed(
          response.data.message || "Your email has been verified, you can now log in",
          "/login"
        );
        return;
      }
      // A 200 that is not a success. It used to fall through here and leave the
      // page on "Loading" unless the body happened to say status: "failed".
      fail(
        response?.data?.message ||
          "This activation link could not be used. Please request a new one."
      );
    } catch (error) {
      fail(
        messageFrom(
          error,
          "This activation link could not be used. It may have expired, or the address may be incomplete."
        )
      );
    }
  };

  const resetPassword = async () => {
    try {
      const response = await resetPasswordVerification({ authToken: auth });
      if (response?.data?.success) {
        succeed(
          response.data.message || "Link verified. You can now set a new password.",
          "/reset-password/" + auth
        );
        return;
      }
      fail(
        response?.data?.message ||
          "This reset link could not be used. Please request a new one."
      );
    } catch (error) {
      fail(
        messageFrom(
          error,
          "This reset link could not be used. It may have expired or already been used."
        )
      );
    }
  };

  useEffect(() => {
    // `router.query` is empty on the first render of a dynamic route. Acting on
    // it before `isReady` is what made a correct link look like a broken one.
    if (!history.isReady) {
      return;
    }
    if (!flow) {
      fail(
        "This verification address is not one we recognise. Please use the whole link exactly as it was given to you."
      );
      return;
    }
    // A link cut short by a mail client arrives with no token at all. Say so,
    // rather than asking the server about `undefined`.
    if (typeof auth !== "string" || auth.trim() === "") {
      fail(
        "This link is missing its token - it looks like it was cut short. Please use the whole link, or request a new one below."
      );
      return;
    }
    if (id === "forgotPassword") {
      resetPassword();
    } else {
      emailActivation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.isReady, id, auth]);

  const heading = flow ? flow.title : "Verification";
  const actions = flow
    ? flow.actions
    : [
        { href: "/login", label: "Go to sign in" },
        { href: "/", label: "Back to home" },
      ];

  return (
    <>
      <Mainnavbar />
      <div className={styles.login}>
        <Container>
          <Row>
            <Col lg={7} xxl={5} className="m-auto">
              <div className={styles.box_flx}>
                <div className={`login_right ${styles.right_box} mx-auto`}>
                  <h2 className={styles.h2tag}>{heading}</h2>

                  {phase === "working" && (
                    <p role="status" aria-live="polite" data-testid="verification-working">
                      <i className="fa fa-spinner fa-spin me-2"></i>
                      Checking your link...
                    </p>
                  )}

                  {phase === "success" && (
                    <div
                      className="alert alert-success"
                      role="status"
                      aria-live="polite"
                      data-testid="verification-success"
                    >
                      {message}
                    </div>
                  )}

                  {phase === "error" && (
                    <>
                      <div
                        className="alert alert-danger"
                        role="alert"
                        data-testid="verification-error"
                      >
                        {message}
                      </div>
                      <ul className="list-unstyled" data-testid="verification-actions">
                        {actions.map((action) => (
                          <li key={action.href} className="mb-2">
                            <Link href={action.href}>{action.label}</Link>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </Col>
          </Row>
        </Container>
      </div>
    </>
  );
}
