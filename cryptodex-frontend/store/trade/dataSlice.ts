import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import { tradePairModel } from "../../models/tradePair";
import {
    getFav, apigetPairList
} from "../../services/Spot/SpotService";
import { DEFAULT_BOOK_HEALTH, sameHealth } from "../../lib/orderBookHealth";

export const getSpotfav: any = createAsyncThunk(
    "trade/fav",
    async () => {
        const response: any = await getFav();
        return response.data.result;
    }
);
export const getSpotpairList: any = createAsyncThunk(
    "trade/data",
    async () => {
        const response: any = await apigetPairList();
        return response.data.result;
    }
);


const initialTradePairState: tradePairModel = {
    _id: "",
    botstatus: "",
    change: 0,
    changePrice: 0,
    firstCurrencyId: "",
    firstCurrencySymbol: "",
    firstFloatDigit: 0,
    firstVolume: 0,
    firstCurrencyImage: "",
    secondCurrencyImage: "",
    high: 0,
    last: 0,
    low: 0,
    markPrice: 0,
    secondCurrencyId: "",
    secondCurrencySymbol: "",
    secondFloatDigit: 0,
    secondVolume: 0,
};


const dataSlice: any = createSlice({
    name: "trade/data",
    initialState: {
        loading: true,
        pairList: [],
        firstCurrency: {},
        secondCurrency: {},
        marketData: initialTradePairState,
        tradePair: initialTradePairState,
        usdValue: 0,
        favPair: [],
        allMarketData: [],
        orderBookPrice: {},
        openOrders: [],
        // Published order book health, shared so the order ticket can refuse to
        // send an order the book cannot fill. Written only by OrderBook.tsx.
        bookHealth: DEFAULT_BOOK_HEALTH,
        // True when the venue tick has gone silent for long enough that
        // everything ticker-derived on screen is a picture of the past.
        tickerStale: false,
        /**
         * THE LAST PRICE THAT ACTUALLY TRADED HERE.
         *
         * `marketData.markPrice` is the VENUE tick, published by a 30s cron
         * (spotapi config/cron.js -> updateBinancePrices). The order book and
         * the trade log are fed by the matching engine and move continuously.
         * Painting the headline and the book's last-price marker from the 30s
         * figure meant that during any sustained move the two of them sat a
         * whole cron cycle behind — above every ask when the market was falling,
         * below every bid when it was rising — while the ladder and the most
         * recent trade underneath them showed the real price. Four prices on
         * one screen, three of them agreeing and the two biggest ones wrong.
         *
         * This is written from the `recentTrade` stream, the same engine output
         * that fills the trade log, and read by anything that wants to print
         * "the price" rather than "the venue's 30-second-old price".
         */
        lastTrade: { pairId: null as any, price: null as any, at: 0 }
    },
    reducers: {
        setPairList: (state, action) => {
            state.pairList = action.payload;
        },
        setFirstCurrency: (state, action) => {
            state.firstCurrency = action.payload;
        },
        setSecondCurrency: (state, action) => {
            state.secondCurrency = action.payload;
        },
        setMarkData: (state, action) => {
            state.marketData = action.payload;
        },
        // Merge a PARTIAL ticker update into marketData. The `marketPrice` socket
        // event only carries markPrice/last/price/change/changePrice, so replacing
        // wholesale (setMarkData) drops _id, the currency symbols and the 24H
        // high/low/volume fields that only the REST pair payload provides.
        setMergeMarkData: (state, action) => {
            state.marketData = { ...state.marketData, ...action.payload };
        },
        setTradePair: (state, action) => {
            state.tradePair = action.payload;
        },
        setFavPair: (state, action) => {
            state.favPair = action.payload;
        },
        setOrderBookPrice: (state, action) => {
            state.orderBookPrice = action.payload;
        },
        setUpdateAllMarkData: (state, action) => {
            state.allMarketData = action.payload;
        },
        setOpenOrders: (state, action) => {
            state.openOrders = action.payload;
        },
        // The book republishes at least once a second, and the desktop and
        // mobile OrderBook instances both consume it, so this fires several
        // times a second with an identical verdict. Writing a fresh object every
        // time would re-render every subscriber (both order tickets) for no
        // reason — assign only when the verdict actually changed.
        setBookHealth: (state, action) => {
            const next = { ...DEFAULT_BOOK_HEALTH, ...(action.payload || {}) };
            const current = state.bookHealth || DEFAULT_BOOK_HEALTH;
            // Both OrderBook instances (desktop layout + mobile layout) publish
            // into this one slot, and they do not reach the first payload of a
            // new pair at the same moment. A `pending` write carries no
            // information — it means "I have not heard yet" — so it must never
            // overwrite a real verdict the other instance has already observed
            // for the SAME pair, or the two of them flip the ticket between
            // "loading" and its true state for as long as they disagree.
            if (next.pending && !current.pending && String(current.pairId) === String(next.pairId)) {
                return;
            }
            if (sameHealth(current, next)) return;
            state.bookHealth = next;
        },
        setUpdateMarkData: (state, action) => {
            state.marketData.markPrice = action.payload.markPrice;
            state.marketData.high = action.payload.high;
            state.marketData.last = action.payload.last;
            state.marketData.low = action.payload.low;
            state.marketData.change = action.payload.change;
            state.marketData.changePrice = action.payload.changePrice;
            state.marketData.secondVolume = action.payload.secondVolume;
            state.marketData.firstVolume = action.payload.firstVolume;
        },
        // setUpdateTradePair: (state, action) => {
        //     state.tradePair.last:22751.56
        //     state.tradePair.low:22292.37
        //     state.tradePair.high:23078.71
        //     state.tradePair.firstVolume:246858.91988
        //     state.tradePair.secondVolume:5616972681.011094
        //     state.tradePair.changePrice-182.39
        //     state.tradePair.change:-0.795
        // },
        // The venue tick (`marketPrice`) heartbeats every 30s per pair whether or
        // not the price moved, so a long silence means the feed is gone, not
        // that the market is quiet. MarketPrice.tsx owns this flag; everything
        // that paints a ticker-derived number reads it and stops claiming the
        // number is current. It is deliberately NOT the order book verdict: a
        // purged ladder does not make the last traded price a lie.
        setTickerStale: (state, action) => {
            const next = !!action.payload;
            if (state.tickerStale === next) return;
            state.tickerStale = next;
        },
        /**
         * Record the newest executed trade for a pair.
         *
         * Guards, in order:
         *  - a price that is not a finite positive number is not a price, and
         *    must never replace one that is;
         *  - a payload for a DIFFERENT pair than the one it claims is dropped by
         *    the caller, but an empty pairId here would make the reading side
         *    unable to tell whose price this is, so it is required;
         *  - an unchanged price for the same pair returns without writing. The
         *    trade stream fires many times a second and every write re-renders
         *    the header, the book marker and the ticket.
         */
        setLastTrade: (state, action) => {
            const pairId = action.payload?.pairId;
            const price = parseFloat(action.payload?.price);
            if (pairId === null || pairId === undefined || pairId === "") return;
            if (!Number.isFinite(price) || price <= 0) return;
            const current = state.lastTrade || {};
            if (String(current.pairId) === String(pairId) && current.price === price) return;
            state.lastTrade = { pairId, price, at: Date.now() };
        },
        setusdValue: (state, action) => {
            state.usdValue = action.payload;
        },
        setFavepair: (state, action) => {
            state.usdValue = action.payload;
        },
    },
    extraReducers: {
        [getSpotfav.fulfilled]: (state, action) => {
            state.favPair = action.payload;
        },
        [getSpotpairList.pending]: (state, action) => {
            state.loading = true;
            state.pairList = action.payload;
            state.allMarketData = action.payload
        },
        [getSpotpairList.fulfilled]: (state, action) => {
            state.loading = false;
            state.pairList = action.payload;
            state.allMarketData = action.payload
        },
    },
});

export const {
    setPairList,
    setFirstCurrency,
    setSecondCurrency,
    setMarkData,
    setMergeMarkData,
    setTradePair,
    setusdValue,
    setUpdateMarkData,
    setFavPair,
    setOrderBookPrice,
    setUpdateAllMarkData,
    setOpenOrders,
    setBookHealth,
    setTickerStale,
    setLastTrade
} = dataSlice.actions;

export default dataSlice.reducer;
