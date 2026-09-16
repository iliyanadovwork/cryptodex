export const splitPair = (pair) => {

    switch (pair) {
        case "BTCUSDT": {
            return {
                'firstCurrency': "BTC",
                'secondCurrency': "USDT",
            }
        }
        case "XRPUSDT": {
            return {
                'firstCurrency': "XRP",
                'secondCurrency': "USDT",
            }
        }
        case "ETHUSDT": {
            return {
                'firstCurrency': "ETH",
                'secondCurrency': "USDT",
            }
        }
        default: {
            return {
                'firstCurrency': "",
                'secondCurrency': "",
            }
        }
    }
}

export const replacePair = (currencySymbol) => {
    switch (currencySymbol) {
        case "USD": return "USDT"
        default: return currencySymbol
    }
}
export const replaceTest = (value) => {
    // Check if the value contains an underscore
    if (value.includes('_')) {
        return value.split('_')[1]; // Split and get the part after '_'
    }
    return value; // Return the value as is if no underscore
}