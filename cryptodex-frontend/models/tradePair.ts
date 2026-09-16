export interface tradePairModel {
  _id: string;
  botstatus: string;
  change: number;
  changePrice: number;
  firstCurrencyId: string;
  firstCurrencySymbol: string;
  firstFloatDigit: number;
  firstVolume: number;
  firstCurrencyImage?: string;
  secondCurrencyImage?: string;
  high: number;
  last: number;
  low: number;
  markPrice: number;
  secondCurrencyId: string;
  secondCurrencySymbol: string;
  secondFloatDigit: number;
  secondVolume: number;
  // Additional fields that may be present
  baseCoinSymbol?: string;
  quoteCoinSymbol?: string;
  quoteFloatDigit?: number;
  indexPrice?: number;
  fundingRate?: string;
  fundingTime?: string;
  tikerRoot?: string;
  /*
   * NO FEE FIELDS. This venue charges nothing, and as of 2026-09-06 it does not
   * merely rate them at zero: feeRateFor, feeForSide, withChargedFees,
   * withoutServiceFee and calculateServiceFee were deleted, orders no longer
   * carry makerFee/takerFee, trades record no fee, and maker_rebate/taker_fees
   * were dropped from the pair schema. A served pair therefore has no fee field
   * of any name, which pair-fee-publication.test.js pins in spotapi.
   */
}
