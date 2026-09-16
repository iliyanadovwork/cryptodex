// import package
import CryptoJS from 'crypto-js';

// import lib
import config from '../config';
import isEmpty from './isEmpty';

// encryptJs/decryptJs were removed. They hardcoded an AES key in source, used that same
// value as the IV, and encrypted with ZeroPadding while decrypting with Pkcs7. Nothing
// called them. The live path is encryptString/decryptString below, which takes its key
// from NEXT_PUBLIC_CRYPTO_SECRET_KEY.

export const replaceSpecialCharacter = (value, type) => {
    try {
        let textValue = value;
        if (!isEmpty(textValue)) {
            if (type == 'encrypt') {
                // textValue = textValue.toString().replace('+', 'xMl3Jk').replace('/', 'Por21Ld').replace('=', 'Ml32');
                textValue = textValue.toString().replace(/\+/g, 'xMl3Jk').replace(/\//g, 'Por21Ld').replace(/\=/g, 'Ml32');
            } else if (type == 'decrypt') {
                // textValue = textValue.replace('xMl3Jk', '+').replace('Por21Ld', '/').replace('Ml32', '=');
                textValue = textValue.replace(/\xMl3Jk/g, '+').replace(/\Por21Ld/g, '/').replace(/\Ml32/g, "=");
            }
        }
        return textValue
    } catch (err) {
        return ''
    }
}

export const encryptString = (encryptValue, isSpecialCharacters = false) => {
    try {
        encryptValue = encryptValue.toString()
        let ciphertext = CryptoJS.AES.encrypt(encryptValue, config.CRYPTO_SECRET_KEY).toString();
        if (isSpecialCharacters) {
            return replaceSpecialCharacter(ciphertext, 'encrypt')
        }
        return ciphertext
    }
    catch (err) {
        return ''
    }
}

export const decryptString = (decryptValue, isSpecialCharacters = false) => {
    try {
        if (isSpecialCharacters) {
            decryptValue = replaceSpecialCharacter(decryptValue, 'decrypt')
        }

        let bytes = CryptoJS.AES.decrypt(decryptValue, config.CRYPTO_SECRET_KEY);
        let originalText = bytes.toString(CryptoJS.enc.Utf8);
        return originalText
    }
    catch (err) {
        return ''
    }
}

export const encryptObject = (encryptValue) => {
    try {
        let ciphertext = CryptoJS.AES.encrypt(JSON.stringify(encryptValue), config.CRYPTO_SECRET_KEY).toString();
        return ciphertext
    }
    catch (err) {
        console.log('err: ', err);

        return ''
    }
}

export const decryptObject = (decryptValue) => {
    try {
        let bytes = CryptoJS.AES.decrypt(decryptValue, config.CRYPTO_SECRET_KEY);
        let decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
        return decryptedData
    }
    catch (err) {
        return ''
    }
}