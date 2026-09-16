// The KYC label formatters that used to live here (kycStatus, idProofName,
// addressProofName, bankProofName) went with the KYC screens. `transactionStatus`
// below is the only export anything imports - components/History/TransactionHist.
export const transactionStatus = (status) => {
    switch (status) {
        case 'fiat_deposit': return "Deposit";
        case 'fiat_withdraw': return "Withdraw";
        case 'coin_deposit': return "Deposit";
        case 'coin_withdraw': return "Withdraw";
        case 'coin_transfer': return "Internal";
        case 'fiat_transfer': return "Internal";
        default: return ""
    }
}

export const triggerCondition = (status) => {
    switch (status) {
        case 'equal': return "=";
        case 'greater_than': return "<=";
        case 'lesser_than': return ">=";
        default: return "-"
    }
}

export const bankCodeName = (currency) => {
    switch (currency) {
        case 'USD': return "IBAN_CODE";
        case 'EUR': return "BIC_SWIFT_CODE";
        case 'INR': return "IFSC_CODE";
        default: return "BNAK_CODE"
    }
}
export const directionStatus = (status) => {
    switch (status) {
        case 'closed_long': return "Closed Long";
        case 'closed_short': return "Closed Short ";
        default: return "-"
    }
}