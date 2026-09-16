import { useEffect, useRef } from "react";
//improt store
import { useSelector, useDispatch, injectReducer } from "../store";
import {
  getAssetData,
  getCurrency,
  getPriceConversion,
  marketPriceTick,
} from "../store/Wallet/dataSlice";
import { getUserDetails } from "../store/auth/userSlice";

import { getFavourite, getMode, getsiteSetting } from "../store/UserSetting/dataSlice";
import { getSpotfav, getSpotpairList, setPairList as setSpotPairs } from "../store/trade/dataSlice";
import WalletSlice from "../store/Wallet/dataSlice";
import spotSlice from "../store/trade/dataSlice";
//import lib
import isEmpty from "../lib/isEmpty";
// impoet services
import { getPairList as getSpotPairList } from "@/services/Spot/SpotService";
import { spotSocket } from "../config/socketConnectivity";
injectReducer("wallet", WalletSlice);
injectReducer("spot", spotSlice);

export default function HelperRoute() {
  const isLogin = useSelector((state: any) => state.auth.session.signedIn);
  const { currency } = useSelector((state: any) => state.wallet);
  const { pairList } = useSelector((state: any) => state.spot);
  const dispatch = useDispatch();

  const fetchSpotPair = async () => {
    try {
      const { status, result } = await getSpotPairList();
      if (status) {
        dispatch(setSpotPairs(result));
      }
    } catch (err) { }
  };

  useEffect(() => {
    console.log('*** HelperRoute useEffect called, isLogin:', isLogin);
    if (isEmpty(pairList)) {
      fetchSpotPair()
    }
    if (isEmpty(currency)) {
      dispatch(getCurrency());
    }
    dispatch(getFavourite())
    dispatch(getsiteSetting());
    dispatch(getPriceConversion());
    if (isLogin) {
      console.log('*** User is logged in, dispatching getAssetData...');
      dispatch(getMode());
      dispatch(getAssetData());
      // dispatch(getSpotfav());
      dispatch(getUserDetails());
    } else {
      console.log('*** User is NOT logged in, skipping asset data fetch');
    }
  }, []);

  /**
   * THE PRICE FEED, KEPT ALIVE FOR THE WHOLE SESSION.
   *
   * "Total Assets Value" was a snapshot. It is computed from `priceConversion`,
   * which the effect above fetches ONCE - so, measured, the figure did not move
   * at all while a page stayed open. This listens to the venue's own
   * `marketPrice` broadcast and writes each tick into that table, and both
   * surfaces that print the total recompute from it.
   *
   * IT LIVES HERE because this component is mounted at _app.tsx:171, a sibling
   * of <Component/>, so no route change unmounts it. Putting it on a page would
   * make the total live on that page and static everywhere else.
   *
   * The broadcast is global - spotapi's socketEmitAll calls `socketIO.emit`
   * (config/socketIO.js:126), not a room - so no `unSubscribe("spot")` from a
   * page being left can silence it, and no `subscribe` is needed to receive it.
   * The handler is named so the removal below takes only this listener.
   */
  const pairsRef = useRef<any[]>([]);
  useEffect(() => {
    pairsRef.current = Array.isArray(pairList) ? pairList : [];
  }, [pairList]);

  useEffect(() => {
    // null during SSR - see config/socketConnectivity.js
    if (!spotSocket) return;
    const onMarketPrice = (result: any) => {
      const price = parseFloat(result?.data?.markPrice ?? result?.data?.last);
      if (!Number.isFinite(price) || price <= 0) return;
      const pair = pairsRef.current.find(
        (p: any) => String(p?._id) === String(result?.pairId)
      );
      if (!pair?.firstCurrencySymbol || !pair?.secondCurrencySymbol) return;
      dispatch(
        marketPriceTick({
          base: pair.firstCurrencySymbol,
          quote: pair.secondCurrencySymbol,
          price,
        })
      );
    };
    spotSocket.on("marketPrice", onMarketPrice);
    return () => {
      spotSocket.off("marketPrice", onMarketPrice);
    };
  }, [dispatch]);

  return <></>;
}
