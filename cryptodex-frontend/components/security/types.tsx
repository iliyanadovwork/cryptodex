export type ChangePassFormValue = {
    oldPassword: string,
    password: string,
    confirmPassword: string,
    otp: string
}
export type MobileFormValues = {
    otp: string;
    newPhoneNo: string;
}
export type AssetFormValues = {
    otp: string;
    password: string;
    confirmPassword: string;
}
export type EmailFormValues = {
    otp: string;
    email: string;
}
export type BankFormValues = {
    bankId: string,
    bankName: string;
    accountNo: string;
    holderName: string;
    country?: string,
    bankcode: string;
    city: string;
    bankAddress: string;
    currencyId: string;
    currencySymbol: string;
    isPrimary: string;
}
