import { useEffect, useContext, useState, useCallback, useRef } from 'react';
import { useRouter } from "next/router";
import dynamic from 'next/dynamic'
//import component
const HomePage = dynamic(() => import('../../components/spot/HomePage'))
const Meta = dynamic(() => import('../../components/Meta'), { ssr: false });
//improt lib
import isEmpty from '../../lib/isEmpty'
//improt store
import {
    setPairList,
    setFirstCurrency,
    setSecondCurrency,
    setMarkData,
    setTradePair,
} from "../../store/trade/dataSlice";
import { useSelector, useDispatch } from "../../store";
//import config
import config from '../../config'
import { tradePageTitle } from "@/lib/tradePageTitle";
//import service
import {
    apigetPairList,
} from "../../services/Spot/SpotService";
import { getAssetByCurrency } from "../../services/Wallet/WalletService";
//improt context
import SocketContext from "../../components/Context/SocketContext";
import { setCookie } from '@/utils/cookie';
import { resolvePairSlug, unknownPairMessage } from "@/lib/pairSlug";
import { toastAlert } from "@/lib/toastAlert";
export default function Spot() {
    let tikerRoot = ''
    const dispatch = useDispatch()
    const history = useRouter();
    const { asPath, isReady } = useRouter();
    const socketContext = useContext<any>(SocketContext);
    const isLogin = useSelector((state: any) => state.auth.session.signedIn);
    const [pairList, setPair] = useState();
    const { marketData } = useSelector((state: any) => state.spot);

    // Use refs to avoid stale closures
    const asPathRef = useRef(asPath);
    const redirectedRef = useRef(false);
    const tikerRootRef = useRef('');

    // Update ref when asPath changes
    useEffect(() => {
        asPathRef.current = asPath;
    }, [asPath]);

    const fetchAssetByCurrency = async (currencyId: string, type: string) => {
        let { status, result } = await getAssetByCurrency(currencyId);
        if (status) {
            if (type == "firstCurrency") {
                dispatch(setFirstCurrency(result));
            }
            if (type == "secondCurrency") {
                dispatch(setSecondCurrency(result));
            }
        }
    };

    /**
     * WHICH MARKET THE URL NAMES - AND WHAT HAPPENS WHEN IT NAMES NONE.
     *
     * The slug used to be read as `split("_")` and matched against the two
     * currency symbols. `/spot/BTCUSD` splits into ONE part, matched nothing,
     * and fell into the branch below that quietly replaces the URL with
     * `pairList[0]` - SOL/USD on this venue. The user got a SOL/USD book, a
     * SOL/USD ticket and no message, having asked for BTC by the exact name the
     * API, the socket topics and the health endpoint use for it.
     *
     * `resolvePairSlug` accepts both spellings and, crucially, REPORTS WHICH
     * ONE HAPPENED. A slug that names no listed market still lands on a working
     * market - a blank trading screen helps nobody - but it now says so.
     */
    const findPair = useCallback(async (pairList: any) => {
        const URLPair = asPathRef.current.split("/")[2]
        if (!isEmpty(URLPair)) {
            // Strip a query string: /spot/BTC_USD?foo=1 names BTC_USD.
            const slug = decodeURIComponent(String(URLPair).split("?")[0]);
            const { pair: resolved, matched } = resolvePairSlug<any>(slug, pairList);
            let pairDetail: any = matched ? resolved : null;
            if (pairDetail && !isEmpty(pairDetail)) {
                dispatch(setPairList(pairList));
                dispatch(setTradePair(pairDetail));
                dispatch(setMarkData(pairDetail));
                const canonical = `${pairDetail.firstCurrencySymbol}_${pairDetail.secondCurrencySymbol}`;
                // The ticker spelling (/spot/BTCUSD) names a real market and is
                // honoured, then rewritten to the one form every link in the app
                // prints, so the address bar and the "Trade" buttons agree.
                if (slug !== canonical) {
                    history.replace({ pathname: '/spot/' + canonical }, undefined, { shallow: true })
                }
                setCookie("spotpair", canonical);
                redirectedRef.current = false; // Reset flag when pair is found
                tikerRoot = pairDetail.firstCurrencySymbol + pairDetail.secondCurrencySymbol
                tikerRootRef.current = tikerRoot;
                socketContext.spotSocket.emit('subscribe', tikerRoot)
                socketContext.spotSocket.emit('subscribe', 'spot')
                if (isLogin) {
                    await fetchAssetByCurrency(pairDetail.firstCurrencyId, "firstCurrency");
                    await fetchAssetByCurrency(pairDetail.secondCurrencyId, "secondCurrency");
                }
            } else {
                // Only redirect if we haven't already redirected
                if (!isEmpty(pairList) && !redirectedRef.current) {
                    redirectedRef.current = true;
                    // SAY IT. This is the branch that used to swap the market
                    // silently: the user asked for one thing, is shown another,
                    // and only a message can tell them which. Keyed, so a
                    // re-render cannot stack duplicates of it.
                    // Held for 8s rather than the default 2s: the trading
                    // screen is still painting its chart and its book at this
                    // moment, and a message that is gone before the page has
                    // settled is the "no message" this fixes.
                    toastAlert(
                        "error",
                        unknownPairMessage(slug, pairList[0]),
                        "unknownPair",
                        "TOP_RIGHT",
                        { autoClose: 8000 }
                    );
                    dispatch(setPairList(pairList));
                    dispatch(setTradePair(pairList[0]));
                    dispatch(setMarkData(pairList[0]));
                    let pair = `${pairList[0].firstCurrencySymbol}_${pairList[0].secondCurrencySymbol}`;
                    history.replace({ pathname: '/spot/' + pair }, undefined, { shallow: true })
                    setCookie("spotpair", pair);
                    tikerRoot = pairList[0].firstCurrencySymbol + pairList[0].secondCurrencySymbol
                    tikerRootRef.current = tikerRoot;
                    socketContext.spotSocket.emit('subscribe', tikerRoot)
                    socketContext.spotSocket.emit('subscribe', 'spot')
                    if (isLogin) {
                        await fetchAssetByCurrency(pairList[0].firstCurrencyId, "firstCurrency");
                        await fetchAssetByCurrency(pairList[0].secondCurrencyId, "secondCurrency");
                    }
                }
            }
        };
    }, [dispatch, socketContext, history, isLogin]);

    const fetchPair = useCallback(async () => {
        try {
            let resp: any = await apigetPairList()
            if (!isEmpty(resp?.data?.result)) {
                setPair(resp.data.result)
            }
        } catch (error) {
            // Silently handle errors
        }
    }, []);

    // Fetch pair list when ready
    useEffect(() => {
        if (isReady) {
            fetchPair();
        }
    }, [isReady, fetchPair]);

    // Initialize pair when pairList is loaded (only run once when pairList is first set)
    useEffect(() => {
        if (!isEmpty(pairList)) {
            findPair(pairList)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pairList])

    // Socket connection
    useEffect(() => {
        if (!isReady)
            return;

        // NAMED, so the cleanup can actually remove it. This effect is keyed on
        // `asPath`, so it re-runs on every pair navigation - and the anonymous
        // handler it used to register was never removed, leaving one more live
        // "connect" listener behind per pair the user visited. They all survived
        // for the life of the page, and every one of them fired (and re-emitted
        // its own subscribe pair) on each reconnect.
        const handleConnect = () => {
            const URLPair = asPath.split("/")[2];
            const currency = URLPair.split('_');
            // prefer the resolved pair ticker, the URL slug casing may differ
            tikerRoot = tikerRootRef.current || (currency[0] + currency[1]);
            tikerRootRef.current = tikerRoot;
            socketContext.spotSocket.emit('subscribe', tikerRoot)
            socketContext.spotSocket.emit('subscribe', 'spot')
        };
        socketContext.spotSocket.on("connect", handleConnect);
        return () => {
            socketContext.spotSocket.off("connect", handleConnect)
            socketContext.spotSocket.emit('unSubscribe', tikerRootRef.current)
            socketContext.spotSocket.emit('unSubscribe', 'spot')
        }
    }, [isReady, asPath, socketContext]);

    return (
        <>
            <Meta
                keyWords="keyWords"
                tittle={tradePageTitle(
                    marketData?.markPrice,
                    marketData?.firstCurrencySymbol,
                    marketData?.secondCurrencySymbol,
                    config.SITE_NAME
                )}
                description={config.SITE_DISCRIPTION}
            />
            <HomePage />
        </>

    );
}
