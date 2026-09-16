import { createContext } from 'react';

const TradeContext = createContext({
    spotPair: '',
    setSpotPair: {},
    tradePairList: '',
    setTradePairList: {},
    firstCurrencyAsset: '',
    setFirstCurrencyAsset: {},
    secondCurrencyAsset: '',
    setSecondCurrencyAsset: {}
});

export default TradeContext;