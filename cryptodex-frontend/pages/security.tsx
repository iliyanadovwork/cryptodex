import styles from "@/styles/common.module.css";
import { Container, Row, Col } from "react-bootstrap";
import Mainnavbar from "../components/navbar";
import React, { useEffect, useState } from "react";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";
//import store
import { useSelector } from "../store";
//import lib
import { toastAlert } from "@/lib/toastAlert";
import isEmpty from "@/lib/isEmpty";
//import component
const ChangePassword = dynamic(
  () => import("@/components/security/ChangePassword")
);

import { handleAuthSSR } from "../utils/auth";

/**
 * WHY "SECURE EMAIL" NO LONGER HAS A BUTTON.
 * ==========================================
 * The row used to open a Set-email-ID modal (components/security/BindEmail).
 * That modal could not complete for any user on this venue, and had not been
 * able to for some time:
 *
 *   - its whole body was gated on `phoneStatus == "verified"`. A user without
 *     a verified phone got a single button captioned "Verify your mobile" and
 *     no way to verify one, because phone binding was already unmounted;
 *   - and even past that gate it was unfinishable. userapi's `emailUpdate`
 *     verifies the code with `optVerification(1, ...)`, which reads
 *     `user.otp` - the SMS code, written only by the roleType-2 branch of
 *     requestOTP. With SMS removed nothing can ever write that field, so the
 *     Confirm button could only return "Invalid OTP" forever.
 *
 * A button that opens a dialog no one can finish is worse than no button: it
 * reads as a task the user has failed to complete. So the row now STATES the
 * address the account is reachable at, and the address is set where it is
 * actually set - at registration, confirmed by the activation mail.
 *
 * The route (user/emailChange) still exists in userapi; this is a frontend
 * decision about a control that cannot work, not a claim that the endpoint
 * was deleted.
 */
export default function Security() {
  const router = useRouter();
  const { email } = useSelector(
    (state: any) => state.auth.user
  );
  const [password_modal, setpassword_modal] = useState(false);
  const [isClient, setIsClient] = useState<boolean>(false);


  useEffect(() => {
    setIsClient(true);
  }, []);
  return (
    <>
      <Mainnavbar />
      <div className={styles.page_box}>
        <div className={styles.security}>
          <div className={`mb-5 ${styles.inner_head_box}`}>
            <Container>
              <div className={`${styles.inner_head_box_flex}`}>
                <div className={styles.usr_flx_head}>
                  <div className={styles.usr_flx}>
                    {/* THE SAME PERSON GLYPH THE NAVBAR DRAWS.
                        This was a raster placeholder in a peach that appeared
                        nowhere else in the product - and, being a bitmap, it
                        could not take a colour from the theme the way every
                        other icon here does. There is no avatar to upload on
                        this venue, so it is a marker rather than a picture, and
                        the marker may as well be the one already in the navbar.
                        `currentColor` means it cannot drift off-palette. */}
                    <svg
                      width={36}
                      height={36}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="me-3"
                      style={{ color: "var(--grey)" }}
                      aria-hidden="true"
                    >
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                      <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                    <div>
                      {/* THE ADDRESS, ONCE. This printed `emailFormat(email)` -
                          a masked "tra...@...ex.test" - while the full address
                          sat unmasked to its right and the Secure Email card
                          printed a third, masked copy below it. Masking a value
                          spelled out on the same screen protects nothing and
                          reads as three different values for one field. */}
                      <h5 data-testid="security-email-value">
                        {isClient && email}
                      </h5>
                    </div>
                  </div>
                </div>
                {/* A UID with a copy button stood here, beside a second
                    rendering of the address. The UID was a support-ticket
                    reference: /support-ticket, /contactus and /faq are all
                    deleted, so nothing asks you to quote it and no screen
                    accepts it. The address is in the header. */}
              </div>
            </Container>
          </div>
          <Container className="mb-5">
            <Row>
              {/* 2FA section removed - using email OTP for login only */}
              <Col lg={6}>
                <div
                  className={`mb-4 ${styles.box} ${styles.account_settings_box}`}
                >
                  <div className={styles.set_flx}>
                    {/* ICON COLOUR IS THE THEME'S, AND IT MEANS SOMETHING.
                        Both icons were #EAB486, a tan that appears nowhere else
                        in the app - leftover styling against a blue-on-black
                        palette. The padlock takes the accent (#1d94ff, the same
                        blue as the Modify button it sits above). The warning
                        glyph on the Deactivate card takes the red the order
                        book uses for sells (#f6465d), because that card holds
                        the only irreversible control on the page and the colour
                        should say so. */}
                    <svg
                      width="24"
                      height="29"
                      viewBox="0 0 24 29"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M20 9.66732H22.6667C23.4031 9.66732 24 10.2643 24 11.0007V27.0007C24 27.7371 23.4031 28.334 22.6667 28.334H1.33333C0.59696 28.334 0 27.7371 0 27.0007V11.0007C0 10.2643 0.59696 9.66732 1.33333 9.66732H4V8.33398C4 3.9157 7.58172 0.333984 12 0.333984C16.4183 0.333984 20 3.9157 20 8.33398V9.66732ZM2.66667 12.334V25.6673H21.3333V12.334H2.66667ZM10.6667 17.6673H13.3333V20.334H10.6667V17.6673ZM5.33333 17.6673H8V20.334H5.33333V17.6673ZM16 17.6673H18.6667V20.334H16V17.6673ZM17.3333 9.66732V8.33398C17.3333 5.38846 14.9455 3.00065 12 3.00065C9.05448 3.00065 6.66667 5.38846 6.66667 8.33398V9.66732H17.3333Z"
                        fill="#1d94ff"
                      />
                    </svg>

                    <div>
                      <p>Login Password</p>
                      <span>This password is used for your login check</span>
                      <button
                        className={`${styles.dark} ${styles.primary_btn}`}
                        onClick={() => {
                          setpassword_modal(true);
                        }}
                      >
                        <label>Modify</label>
                      </button>
                    </div>
                  </div>
                </div>
              </Col>
              {/* A "Secure Email" card stood here, and it had no action.
                  Its Completed/Pending badge could only ever read Completed:
                  userapi refuses a login unless `status == "verified"`
                  (auth.controller.js:810), so an unverified account cannot
                  reach this page to see "Pending". Beneath it sat a third
                  rendering of the address - masked, while the header printed it
                  in full - and a sentence saying password codes arrive by
                  e-mail, which the Change Password dialog says at the moment it
                  matters. A card whose status cannot vary, whose value is
                  printed above it, and whose advice is repeated where it is
                  needed, is prose rather than a control. */}
              {/* WHAT THIS PAGE NO LONGER OFFERS, AND WHY.
                  =========================================
                  Three rows used to sit here and all three are gone, on
                  purpose, because this is a paper-trading venue whose money is
                  imaginary:

                    Asset Password  a credential nothing on this venue ever
                                    challenged - written by an endpoint, read by
                                    no withdrawal, transfer or trade.
                    Two-Factor Auth an authenticator app in front of a login
                                    that guards virtual balances.
                    Anti-phishing   a code stamped into outbound mail so a user
                                    could tell real mail from forged mail.

                  ON THE SECOND ONE, PRECISELY, because the record matters: 2FA
                  WORKED when it was removed. It was verified live against this
                  stack first - with an authenticator enrolled, a login with no
                  code got the TWO_FA challenge and no token, a wrong code got
                  400 and no token, and only a correct code got in. An earlier
                  round HAD shipped it broken and an earlier round HAD fixed it;
                  removing it now is a scope decision, not a repair, and nobody
                  reading this later should think otherwise.

                  The "Security level" meter went with them. It scored four
                  factors - e-mail, 2FA, ID verification, anti-phishing - and
                  three of those no longer exist, so it could only ever have
                  read "Low" for every account forever. A meter that cannot move
                  is worse than no meter; that exact bug is what the note it
                  replaced was written to kill.

                  A FOURTH ROW, Secure Phone, has since gone the same way with
                  the phone and SMS surface (user/phoneChange, the roleType-2
                  SMS arm of user/sendOTP). It offered "Add" against a binding
                  flow that no longer exists.

                  What is left is what this venue can honestly offer: the
                  password you sign in with, the address it can reach you at,
                  and the way out. */}

              {/* THE WAY OUT, WHICH HAD NO DOOR.
                  ===============================
                  /deactive is a complete, working feature - userapi's
                  `deactiveRequest` / `confirmDeActive` e-mail a code, stand the
                  wallet down, purge the session and cancel every resting order,
                  in an order chosen so that no failure can leave an account
                  half-closed - and NOTHING IN THE PRODUCT LINKED TO IT. It was
                  reachable only by typing the URL, which means that in practice
                  a user could not close their account at all.
                  This is where it belongs: the one screen that manages the
                  account. */}
              <Col lg={6}>
                <div
                  className={`mb-4 ${styles.box} ${styles.account_settings_box}`}
                >
                  <div className={styles.set_flx}>
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2.667c5.155 0 9.333 4.178 9.333 9.333 0 5.155-4.178 9.333-9.333 9.333-5.155 0-9.333-4.178-9.333-9.333 0-5.155 4.178-9.333 9.333-9.333zM10.667 6.667v8h2.666v-8h-2.666zm0 10.666V20h2.666v-2.667h-2.666z"
                        fill="#f6465d"
                      />
                    </svg>

                    <div>
                      <p>Deactivate Account</p>
                      <span data-testid="security-deactivate-copy">
                        Closes this account: your session ends, any resting
                        orders are cancelled and the wallet is stood down. We
                        e-mail a confirmation code first, and nothing happens
                        until you enter it.
                      </span>
                      <button
                        className={`${styles.dark} ${styles.primary_btn}`}
                        data-testid="security-deactivate-link"
                        onClick={() => router.push("/deactive")}
                      >
                        <label>Deactivate</label>
                      </button>
                    </div>
                  </div>
                </div>
              </Col>
            </Row>
          </Container>
        </div>
      </div>


      {/* change password modal - the only modal this page still mounts */}
      <ChangePassword
        password_modal={password_modal}
        setpassword_modal={setpassword_modal}
      />
    </>
  );
}
