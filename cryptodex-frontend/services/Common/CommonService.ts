import ApiService from "./ApiService";

export async function apiGetCurrency() {
  return ApiService.fetchData({
    url: "currency/getCurrency",
    method: "get",
  });
}

export async function apiGetPriceConversion() {
  return ApiService.fetchData({
    url: "common/priceConversion",
    method: "get",
  });
}
