export const currencySymbol = (currency: string) => {
    try {
        currency = currency.toUpperCase()
        if (currency == 'USD' || currency == 'USDT') return "$";
        if (currency == 'EUR') return "€";
        return currency
    } catch (err) {
        return ''
    }
}