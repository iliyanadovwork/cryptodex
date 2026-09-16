import { useEffect } from 'react';
import { useRouter } from 'next/router';
//improt lib
import isEmpty from '../../lib/isEmpty'
//import service
import { apigetPairList } from '../../services/Spot/SpotService';

export default function SpotIndex() {
  const router = useRouter();

  useEffect(() => {
    const redirectToDefaultPair = async () => {
      try {
        // Redirect to the first active pair. The pair list is the only source
        // of truth for which markets are configured, and spotapi now returns it
        // in a deterministic (ticker) order - it used to come straight off a
        // redis hash, so "first" was decided by hash internals and could send a
        // user to a different market on a different day.
        let resp: any = await apigetPairList()
        let pairList = resp?.data?.result
        if (!isEmpty(pairList)) {
          let pair = `${pairList[0].firstCurrencySymbol}_${pairList[0].secondCurrencySymbol}`;
          router.replace(`/spot/${pair}`);
          return;
        }
      } catch (error) {
        // Silently handle errors
      }
      // BTC_USD, not BTC_USDT: this venue quotes USD and has never listed a
      // USDT market, so the old fallback named a pair that does not exist -
      // which lands on the "no such market" path instead of a working book.
      router.replace('/spot/BTC_USD');
    };
    redirectToDefaultPair();
  }, [router]);

  return null;
}
