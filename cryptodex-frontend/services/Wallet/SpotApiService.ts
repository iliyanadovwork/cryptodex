import axios from "axios";
import Config from "../../config/index";
import deepParseJson from "../../lib/deepParseJson";
import CookiesLib from "js-cookie";

// Create axios instance for Spot API (port 3003)
const SpotApiService = axios.create({
  timeout: 60000,
  baseURL: `${Config.SPOT_API}/api`,
});

// Add auth interceptor
SpotApiService.interceptors.request.use(
  async (config: any) => {
    if (typeof window !== "undefined") {
      let accessToken = null;

      // Get token from localStorage
      accessToken = localStorage.getItem("authToken");

      if (!accessToken) {
        // Try from redux-persist
        const rawPersistData = await localStorage.getItem("user");
        const persistData = deepParseJson(rawPersistData);
        accessToken =
          persistData &&
          persistData.auth &&
          persistData.auth.session &&
          persistData.auth.session.token;
      }

      if (!accessToken) {
        // Try from js-cookie
        accessToken = CookiesLib.get("userToken");
      }

      if (accessToken) {
        config.headers["Authorization"] = accessToken;
      }
    }
    config.headers['timezone'] = Number(new Date().getTimezoneOffset());
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default SpotApiService;
