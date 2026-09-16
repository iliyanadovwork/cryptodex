import ApiService from "./ApiService";

// Helper function to safely extract error message
function getErrorMessage(err: any): string {
  if (err?.response?.data?.message) {
    return err.response.data.message;
  }
  if (err?.response?.data?.error) {
    return err.response.data.error;
  }
  if (err?.message) {
    return err.message;
  }
  return "An error occurred";
}

export async function getPairList() {
  try {
    let respData: any = await ApiService.fetchData({
      url: "spot/tradePair",
      method: "get",
    });
    return {
      status: true,
      result: respData.data.result,
      message: respData.data.message,
    };
  } catch (err: any) {
    return {
      status: false,
      message: getErrorMessage(err),
    };
  }
}

export async function getRecentTrade(pairId: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: `spot/recentTrade/${pairId}`,
      method: "get",
    });
    return {
      status: true,
      result: respData.data.result,
      message: respData.data.message,
    };
  } catch (err: any) {
    return {
      status: false,
      message: getErrorMessage(err),
    };
  }
}

/**
 * `getSpotSystemHealth` USED TO BE HERE, AND THE PAGE IT BACKED IS GONE.
 *
 * It read GET /api/spot/health - matcher state, every depth stream's readyState
 * and lastUpdateId, the paper ladder's age, the last fill - and pages/dev/
 * spot-health.tsx re-polled it every second and printed the raw JSON. That page
 * was PUBLIC: no login, no link, and nothing stopped a logged-out visitor (or a
 * crawler) opening it and watching the engine's internals tick over. It is a
 * debugging aid, not a feature of the product, and a debugging aid that ships
 * to users is just an unlabelled admin screen.
 *
 * The ENDPOINT stays: it is what an uptime monitor and a human debugging a
 * stalled book reach for, it is documented as unauthenticated on purpose
 * (spotapi routes/spot.route.js), and it returns system state rather than
 * anybody's account. What is removed is the shipped page that served it to
 * whoever asked. Traders get the plain-English book state on the order book
 * itself - see hooks/useSpotBookHealth and components/FeedStaleBadge.
 */

export async function getOrderBook(pairId: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: `spot/ordeBook/${pairId}`,
      method: "get",
    });
    return {
      status: "success",
      loading: false,
      result: respData.data.result,
    };
  } catch (err: any) {
    return {
      status: "failed",
      loading: false,
    };
  }
}
export async function apiOrderPlace(data: any) {
  return ApiService.fetchData({
    url: "spot/orderPlace",
    method: "post",
    data,
  });
}

export async function getOpenOrder(data: any, pairId: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: `spot/openOrder/${pairId}`,
      method: "get",
      params: data,
    });
    return {
      status: "success",
      loading: false,
      result: respData.data.result,
    };
  } catch (err: any) {
    return {
      status: "failed",
      loading: false,
    };
  }
}

export async function getOrderHistory(data: any, pairId: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: `spot/orderHistory/${pairId}`,
      method: "get",
      params: data,
    });
    return {
      status: "success",
      loading: false,
      result: respData.data.result,
    };
  } catch (err: any) {
    return {
      status: "failed",
      loading: false,
    };
  }
}

export async function getTradeHistory(data: any, pairId: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: `spot/tradeHistory/${pairId}`,
      method: "get",
      params: data,
    });
    return {
      status: "success",
      loading: false,
      result: respData.data.result,
    };
  } catch (err: any) {
    return {
      status: "failed",
      loading: false,
    };
  }
}
export async function cancelOrder(orderInfo: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: 'spot/cancelOrder',
      method: "post",
      data: { id: orderInfo }
    });
    return {
      status: "success",
      loading: false,
      message: respData.data.message,
    };
  } catch (err: any) {
    return {
      status: "failed",
      loading: false,
      message: getErrorMessage(err),
    };
  }
}

export async function getFav() {
  return ApiService.fetchData({
    url: "dashboard/spotFavPair",
    method: "get",
  });
}
export async function addFav(data:any) {
  return ApiService.fetchData({
    url: "dashboard/spotFavPair",
    method: "post",
    data,
  });
}
export async function apigetPairList() {
  return ApiService.fetchData({
    url: "spot/tradePair",
    method: "get",
  });
}
export async function getDepthChart(pairId: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: 'spot/depth-chart',
      method: "post",
      data: { id: pairId }
    });
    return {
      status: "success",
      loading: false,
      // The endpoint answers { success, result: { pairId, buy, sell } }. This
      // used to return only `message` (which the endpoint never sends), so the
      // caller got undefined and the depth chart had nothing to draw.
      result: respData?.data?.result,
      message: respData?.data?.message,
    };
  } catch (err: any) {
    return {
      status: "failed",
      loading: false,
      message: getErrorMessage(err),
    };
  }
}

