import axios from "axios";
// import appConfig from "configs/app.config";
// import { TOKEN_TYPE, REQUEST_HEADER_AUTH_KEY } from "constants/api.constant";
// import { PERSIST_STORE_NAME } from "constants/app.constant";
import deepParseJson from "../../lib/deepParseJson";
import store from "../../store";
import { onSignOutSuccess } from "../../store/auth/sessionSlice";
import { Cookies } from "react-cookie";
import nextCookie from "next-cookies";
import Router from "next/router";
import { setUser, initialState } from "../../store/auth/userSlice";
import CookiesLib from "js-cookie";

// const Config: any = require('../../config/indexs')
import Config from "../../config/index";
const cookies = new Cookies();
const unauthorizedCode = [401];

const BaseService = axios.create({
  timeout: 60000,
  baseURL: `${Config.WALLET_API}/api`,
});

BaseService.interceptors.request.use(
  async (config: any) => {
    let accessToken = null;

    // First try to get token from localStorage (redux-persist)
    const rawPersistData = await localStorage.getItem("user");
    const persistData = deepParseJson(rawPersistData);
    accessToken =
      persistData &&
      persistData.auth &&
      persistData.auth.session &&
      persistData.auth.session.token;

    // Fallback: try to get token from cookie (set during login)
    if (!accessToken) {
      accessToken = CookiesLib.get("userToken");
    }

    if (accessToken && accessToken) {
      config.headers["Authorization"] = `${accessToken}`;
    }
    config.headers['timezone'] = Number(new Date().getTimezoneOffset())
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

BaseService.interceptors.response.use(
  (response) => response,
  (error) => {
    const { response } = error;

    if (response && unauthorizedCode.includes(response.status)) {
      document.cookie = 'loggedin' + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
      store.dispatch(onSignOutSuccess());
      store.dispatch(setUser(initialState));
      Router.push("/login");
    }
    return Promise.reject(error);
  }
);

export default BaseService;
