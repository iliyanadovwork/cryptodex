import SpotApi from "./Spot/ApiService";

export async function apiGetMySpotHistory(data: any) {
    return SpotApi.fetchData({
        url: "spot/getMySpotHistory",
        method: "get",
        params: data
    });
}
 
export async function apiGetMyTradeHistory(data: any) {
    return SpotApi.fetchData({
        url: "spot/getFilledOrderHistory",
        method: "get",
        params: data
    });
}