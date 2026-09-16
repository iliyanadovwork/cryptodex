// import package
import CryptoJS from 'crypto-js';

// import lib
import config from '../config/index.js';
import isEmpty from './isEmpty.js';

// encryptJs/decryptJs were removed. They hardcoded an AES key in source, used that same
// value as the IV, encrypted with ZeroPadding while decrypting with Pkcs7, and logged the
// plaintext they were handed. Nothing outside the tests ever called them. The live path is
// encryptString/decryptString below, which takes its key from CRYPTO_SECRET_KEY.

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
        let ciphertext = CryptoJS.AES.encrypt(encryptValue, config.cryptoSecretKey).toString();
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

        let bytes = CryptoJS.AES.decrypt(decryptValue, config.cryptoSecretKey);
        let originalText = bytes.toString(CryptoJS.enc.Utf8);
        return originalText
    }
    catch (err) {
        console.log(err)
        return ''
    }
}

export const encryptObject = (encryptValue) => {
    try {
        let ciphertext = CryptoJS.AES.encrypt(JSON.stringify(encryptValue), config.cryptoSecretKey).toString();
        return ciphertext
    }
    catch (err) {
        return ''
    }
}

export const decryptObject = (decryptValue) => {
    try {
        let bytes = CryptoJS.AES.decrypt(decryptValue, config.cryptoSecretKey);
        let decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
        return decryptedData
    }
    catch (err) {
        return ''
    }
}