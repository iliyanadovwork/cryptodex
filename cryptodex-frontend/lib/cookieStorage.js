import { Cookies } from "react-cookie";

const cookies = new Cookies();

export const setRedirect = (redirect) => {
  // Set the cookie to expire in one year from now
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);
  cookies.set("signInRedirect", redirect, { expires });
  // cookies.set("signInRedirect", redirect, { maxAge: 60 * 60 * 1 });
};

export const getRedirect = () => {
  return cookies.get("signInRedirect");
};

export const clearRedirect = () => {
  return cookies.remove("signInRedirect");
};
