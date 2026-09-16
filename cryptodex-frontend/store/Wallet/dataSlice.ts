import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import { apiGetAssetData } from "../../services/Wallet/WalletService";
import { apiGetCurrency, apiGetPriceConversion } from "../../services/Common/CommonService";

export const getPriceConversion: any = createAsyncThunk(
  "wallet/data/priceconversion",
  async () => {
    const response: any = await apiGetPriceConversion();
    return response.data.result;
  }
);

export const getCurrency: any = createAsyncThunk(
  "wallet/data/currency",
  async () => {
    const response: any = await apiGetCurrency();
    return response.data.result;
  }
);

export const getAssetData: any = createAsyncThunk(
  "wallet/data/assets",
  async () => {
    console.log('*** getAssetData thunk called, fetching assets...');
    try {
      const response: any = await apiGetAssetData();
      console.log('*** getAssetData response:', response);
      return response.data.result;
    } catch (err) {
      console.error('*** getAssetData error:', err);
      throw err;
    }
  }
);
// `getWithdrawLimit` was here, reading walletapi's wallet/getWithdrawLimit into
// a `withdrawLimit` field. The endpoint is deleted (404 on the running stack)
// and nothing ever dispatched the thunk, so the field could only ever hold its
// initial 0. It went with the rest of the withdrawal surface: there is no
// withdrawal on this venue, so there is no limit to read.

const initialCurrencyState: any = []
const initialPriceCNVState: any = []
const initialAssetState: any = []

const dataSlice: any = createSlice({
  name: "wallet/data",
  initialState: {
    currency: initialCurrencyState,
    priceConversion: initialPriceCNVState,
    assets: initialAssetState,
    toastAlertStatus: false,
    loading: false,
    /**
     * "THE LEDGER MOVED. RE-READ IT."
     * ==============================
     *
     * One slice holds a balance - `state.wallet.assets`, written by
     * getAssetData() from walletapi GET wallet/assets. `revision` is a signal a
     * screen can raise to say "a balance changed by something other than an
     * ordinary read", and `refreshWalletBalances()` below is the only thing
     * that raises it.
     *
     * STATED PLAINLY: NOTHING CURRENTLY SUBSCRIBES to `revision`. It is kept
     * rather than deleted because the two screens that move money (FaucetForm,
     * ResetForm) already dispatch through `refreshWalletBalances`, which is
     * also the call that re-reads the assets they depend on; the signal riding
     * along costs one integer and keeps the hook in place for the next screen
     * that needs it. It is NOT load-bearing today and should not be described
     * as if it were.
     *
     * WHAT IT NEVER COVERED: a balance changed in ANOTHER TAB or on another
     * device - no signal crosses the tab boundary.
     */
    revision: 0
  },

  reducers: {
    updateAssetData: (state, action) => {
      state.assets = action.payload;
    },
    /**
     * "A wallet balance just changed by something that is not the engine."
     * Raised ONLY by refreshWalletBalances(); never by a plain read, because a
     * read that raised it would make every mounted page re-read on every read.
     */
    walletBalancesChanged: (state) => {
      state.revision = (state.revision || 0) + 1;
    },

    /**
     * A LIVE PRICE, INTO THE TABLE BOTH TOTALS ARE COMPUTED FROM.
     *
     * "Total Assets Value" was a snapshot: measured, it did not move at all
     * while a page stayed open, because `priceConversion` is fetched once on
     * mount and nothing rewrote it. Both surfaces that print the figure -
     * navbar.tsx and Wallet/WalletList.tsx - derive it from this table, so
     * writing the live price HERE is what keeps them equal. Updating either
     * component alone would re-create the defect navbar.tsx:26 records, where
     * the two figures read 57701.32 and 57385.36 at the same moment.
     *
     * It is fed from the venue's own `marketPrice` broadcast rather than by
     * re-fetching this table. The table is maintained by a five-minute cron, so
     * polling it would step the headline in five-minute jumps - and it holds a
     * different number from the one the trade screen prints: measured, 79174.01
     * here against a markPrice of 79228.72, $55 apart.
     *
     * BOTH DIRECTIONS ARE WRITTEN. The rows come in pairs, and WalletList
     * multiplies the printed USD total by the inverse row to render
     * "X USD ≈ Y BTC". Updating one and not the other would leave the two
     * halves of that sentence disagreeing about the rate.
     */
    marketPriceTick: (
      state,
      action: { payload: { base: string; quote: string; price: number } }
    ) => {
      const { base, quote, price } = action.payload || ({} as any);
      if (!base || !quote || !Number.isFinite(price) || price <= 0) return;
      if (!Array.isArray(state.priceConversion)) return;
      for (const row of state.priceConversion) {
        if (row.baseSymbol === base && row.convertSymbol === quote) {
          row.convertPrice = price;
        } else if (row.baseSymbol === quote && row.convertSymbol === base) {
          row.convertPrice = 1 / price;
        }
      }
    }
  },
  extraReducers: {
    [getPriceConversion.fulfilled]: (state, action) => {
      state.loading = false;
      state.priceConversion = action.payload;
    },
    [getPriceConversion.pending]: (state) => {
      state.loading = true;
    },
    [getPriceConversion.rejected]: (state) => {
      state.loading = false;
    },
    [getCurrency.fulfilled]: (state, action) => {
      state.loading = false;
      state.currency = action.payload;
    },
    [getCurrency.pending]: (state) => {
      state.loading = true;
    },
    [getCurrency.rejected]: (state) => {
      state.loading = false;
      state.currency = [];
    },
    [getAssetData.fulfilled]: (state, action) => {
      state.loading = false;
      // console.log(action.payload, 'action.payload')
      state.assets = action.payload;
    },
    [getAssetData.pending]: (state) => {
      state.loading = true;
    },
    [getAssetData.rejected]: (state) => {
      state.loading = false;
      state.assets = [];
    },
  }
});

export const { updateAssetData, walletBalancesChanged, marketPriceTick } = dataSlice.actions;

/**
 * THE ONE THING A WALLET-MUTATING SCREEN DISPATCHES.
 *
 * Re-reads the asset rows and raises the "balances moved" revision. Call this
 * after any action that moves money without going through the matching engine -
 * a faucet claim, a demo-account reset - so no screen is left describing a
 * balance that is no longer true.
 *
 * See the `revision` note above for what does and does not watch that signal
 * now that the venue has one wallet.
 */
export const refreshWalletBalances = () => (dispatch: any) => {
  dispatch(getAssetData());
  dispatch(walletBalancesChanged());
};

export default dataSlice.reducer;
