// import lib
import isEmpty from './isEmpty';

export const capitalize = (value) => {
    if (typeof value !== 'string') return ''
    return value.charAt(0).toUpperCase() + value.slice(1)
}

export const firstLetterCase = (value) => {
    if (!isEmpty(value)) {
        return value.charAt(0).toUpperCase();
    }
    return ''
}

export const emailFormat = (email) => {
    try {
        if (!isEmpty(email)) {
            let domain = email.substring(email.indexOf('@'), email.indexOf('.'))
            domain = domain.substring(domain.length - 2, domain.length)
            return email.substring(0, 3) + "...@..." + domain + email.substring(email.indexOf('.'), email.length)
        }
        return ''
    } catch (err) {
        return ''
    }
}

export const cnvtBoolean = value => {
    if (typeof value === 'boolean' && value == true) return true;
    if (typeof value === 'boolean' && value == false) return false;
    if (typeof value === 'string' && value == 'true') return true;
    if (typeof value === 'string' && value == 'false') return false;
}

export const upperCase = (s) => {
    if (isEmpty(s)) {
        return ''
    }
    return s.toUpperCase()
}

export const SizeFormat = (text, size = 23) => {
    try {
        if (!isEmpty(text) && text.length > size) {
            return text.substring(0, size) + "...";
        }
        return text;
    } catch (err) {
        return "";
    }
};