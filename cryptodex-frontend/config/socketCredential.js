/**
 * Where the browser keeps the credential the API accepts.
 *
 * There is exactly one answer and it is NOT lib/localStorage's `user_token`
 * (nothing in this app ever writes that key). Every authenticated REST call
 * goes through services/Common/BaseService.ts, whose request interceptor reads
 * redux-persist's `user` blob at auth.session.token and falls back to the
 * `userToken` cookie set at login. The socket join has to present the same
 * credential the REST layer presents, so it reads it from the same two places,
 * in the same order.
 *
 * Kept in its own module so socketConnectivity.js does not have to import the
 * axios stack (and the store, and next/router) just to find a string.
 */
import CookiesLib from "js-cookie";
import deepParseJson from "../lib/deepParseJson";

export const getSocketCredential = () => {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    const persistData = deepParseJson(localStorage.getItem("user"));
    const token =
      persistData &&
      persistData.auth &&
      persistData.auth.session &&
      persistData.auth.session.token;
    if (token) {
      return token;
    }
  } catch (err) {
    // fall through to the cookie
  }
  return CookiesLib.get("userToken") || "";
};

export default getSocketCredential;
