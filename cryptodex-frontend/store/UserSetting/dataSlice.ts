import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import {
  apiUpdateUserSetting,
  apiGetUserSetting,
  apigetSiteSetting,
  apiSiteSettings,
} from "../../services/User/UserServices";
export const getUserSetting: any = createAsyncThunk(
  "user/data/profile",
  async (data) => {
    const response = await apiGetUserSetting(data);
    return response.data.result;
  }
);

export const updateuserSetting: any = createAsyncThunk(
  "user/data/profile",
  async (data) => {
    const response = await apiUpdateUserSetting(data);
    return response.data.result;
  }
);
export const getFavourite: any = createAsyncThunk(
  "user/data/favourite",
  async () => {
    // Spot is the only product this venue lists, so `spotFav` is the only
    // favourites key anything reads. This thunk READS; it deliberately does not
    // write to or clean up localStorage, because a stale key nothing reads
    // costs a few bytes in one browser profile and breaks nothing, while a
    // removeItem inside a read path is a side effect nobody calling it expects.
    let data = {
      spotCount: JSON.parse(localStorage.getItem("spotFav") || "[]"),
    }
    return data
  }
);
export const getsiteSetting: any = createAsyncThunk(
  "user/data/siteSetting",
  async (data) => {
    const response = await apigetSiteSetting(data);
    return response.data.result;
  }
);
export const getMode: any = createAsyncThunk("user/data/mode", async (data) => {
  console.log(data, '------45')
  const response = await apiSiteSettings(data);
  return response.data.result;
});

/**
 * `models/userSettings` — the type this object used to be annotated with — does
 * not exist and never has in this repository's history. The import survived
 * because it was type-only and every compiler in the chain elided it; the
 * annotation was a promise nothing could check. The shape below is the promise
 * now.
 */
const initialState = {
  theme: "",
  loading: true,
  _id: "",
  passwordChange: "",
  siteNotification: "",
  userId: "",
  languageId: "",
  createdAt: "",
  updatedAt: "",
  currencySymbol: "",
  LatestEvent: false,
  announcement: false,
  tradingviewAlert: false,
  tradeOrderPlaceAlertMobile: false,
  tradeOrderPlaceAlertWeb: false,
  defaultWallet: "spotBal",
  loginNotification: false,
  country: "",
};

const dataSlice: any = createSlice({
  name: "user/data",
  initialState: {
    defaultTheme: "dark",
    userSetting: initialState,
    siteSetting: {},
    referralSetting: {},
    mode: {},
    favourite: {},
  },

  reducers: {
    /**
     * `UserSetting` is in the redux-persist whitelist, so whatever this reducer
     * stores is written into every user's localStorage at every login. Keep it
     * to settings the product can act on.
     *
     * `action.payload || {}` because logout dispatches `setUserSetting({})` and
     * a response that omits the block would otherwise throw inside a reducer.
     *
     * THE PAYLOAD IS FILTERED ON THE WAY IN. Stored user documents can still
     * carry settings no screen in this product reads. `UserSetting` is in the
     * redux-persist whitelist, so anything let through here is written into
     * every user's localStorage on every login, where the next reader would
     * reasonably take it for state that means something. The destructure below
     * drops them so the store holds only settings this product can act on.
     */
    setUserSetting: (state, action) => {
      const {
        showFuture,
        showInverse,
        showOFuture,
        showOInverse,
        leverage,
        ...settings
      } = action.payload || {};
      state.defaultTheme = settings.defaultTheme;
      state.userSetting = settings;
    },
    setsiteSetting: (state, action) => {
      state.siteSetting = action.payload;
    },
    setTheme: (state, action) => {
      state.defaultTheme = action.payload;
      state.userSetting.theme = action.payload;
    },
    // The site-wide "mode" block (showSpot, enableCryptodexFee) - not a trading
    // mode. Named for what it holds, so the next reader is not sent looking for
    // something it does not carry.
    setSiteMode: (state, action) => {
      state.mode = action.payload;
    },
    setDefaultTheme: (state, action) => {
      state.defaultTheme = action.payload;
    },
    setCurrency: (state, action) => {
      state.userSetting.currencySymbol = action.payload;
    },
    setNotificationLatestEvent: (state, action) => {
      state.userSetting.LatestEvent = action.payload;
    },
    setNotificationAnonement: (state, action) => {
      state.userSetting.announcement = action.payload;
    },
    setNotificationTradingViewAlert: (state, action) => {
      state.userSetting.tradingviewAlert = action.payload;
    },
    setLanugae: (state, action) => {
      state.userSetting.languageId = action.payload;
    },
    setTradeOrderPlaceAletWindows: (state, action) => {
      state.userSetting.tradeOrderPlaceAlertWeb = action.payload;
    },
    setTradeOrderPlaceAletMobile: (state, action) => {
      state.userSetting.tradeOrderPlaceAlertMobile = action.payload;
    },
    setDefaultWallet: (state, action) => {
      state.userSetting.defaultWallet = action.payload;
    },
    setloginNotification: (state, action) => {
      state.userSetting.loginNotification = action.payload;
    },
    setpasswordChange: (state, action) => {
      state.userSetting.passwordChange = action.payload;
    },
    setReferralSetting: (state, action) => {
      state.referralSetting = action.payload;
    },
    setFavourite: (state, action) => {
      state.favourite = action.payload;
    },
  },
  extraReducers: {
    [getUserSetting.fulfilled]: (state, action) => {
      state.userSetting.loading = false;
      state.userSetting = action.payload;
    },
    [getUserSetting.pending]: (state) => {
      state.userSetting.loading = true;
    },

    [updateuserSetting.fulfilled]: (state, action) => {
      state.userSetting.loading = false;
      state.userSetting = action.payload;
    },
    [updateuserSetting.pending]: (state) => {
      state.userSetting.loading = true;
    },
    [getsiteSetting.fulfilled]: (state, action) => {
      state.siteSetting = action.payload;
    },
    [getMode.fulfilled]: (state, action) => {
      console.log(action.payload, '-------162')
      state.mode = action.payload;
    },
    [getFavourite.fulfilled]: (state, action) => {
      state.favourite = action.payload;
    },
  },
});

export const {
  setNotificationAnonement,
  setNotificationLatestEvent,
  setTradeOrderPlaceAletWindows,
  setDefaultTheme,
  setCurrency,
  setUserSetting,
  setTheme,
  setSiteMode,
  setDefaultWallet,
  setTradeOrderPlaceAletMobile,
  setLanugae,
  setNotificationTradingViewAlert,
  setloginNotification,
  setpasswordChange,
  setsiteSetting,
  setReferralSetting,
  setFavourite,
} = dataSlice.actions;

export default dataSlice.reducer;
