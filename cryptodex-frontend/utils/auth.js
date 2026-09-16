import Router from "next/router";
import nextCookie from "next-cookies";
import jwt_decode from "jwt-decode";
import store from "../store";
import { onSignOutSuccess } from "../store/auth/sessionSlice";
import { setUser, initialState } from "../store/auth/userSlice";
import { setRedirect } from "../lib/cookieStorage";
import config from '../config'
export const handleAuthSSR = async (ctx) => {
  const { pathname } = ctx;
  const { loggedin } = nextCookie(ctx);
  const publicRoutes = ["/"];
  const authRoutes = [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
  ];

  const redirectOnGuest = () => {
    if (typeof window !== "undefined") {
      Router.push("/login");
    } else {
      ctx.res.writeHead(302, { Location: "/login" });
      ctx.res.end();
    }
  };
  const redirectOnHome = () => {
    if (typeof window !== "undefined") {
      Router.push("/");
    } else {
      ctx.res.writeHead(302, { Location: "/" });
      ctx.res.end();
    }

  };
  if (!loggedin && !publicRoutes.includes(pathname) && !authRoutes.includes(pathname)) {
    store.dispatch(onSignOutSuccess());
    store.dispatch(setUser(initialState));
    setRedirect(pathname);
    return redirectOnGuest();
  } else if (loggedin && authRoutes.includes(pathname)) {
    return redirectOnHome();
  }
};