// import packages
import axios from 'axios';

// import lib
import config from './index';
import { getAuthToken } from '../lib/localStorage'
import isLogin from '../lib/isLogin'

// import action
import { removeAuthToken } from '../lib/localStorage'

axios.defaults.baseURL = config.API_URL;
axios.defaults.headers.common['Authorization'] = getAuthToken();

export const setAuthorization = (token) => {
    axios.defaults.headers.common['Authorization'] = token;
}

export const removeAuthorization = () => {
    delete axios.defaults.headers.common["Authorization"];
}

export const handleResp = (respData, type = 'success', doc, callBy) => {
    try {
        if (doc === true && type == 'success' && respData && respData.data) {
            return { message: 'success', data: respData.data, success: true }
        }
        if (type == 'success' && respData && respData.data) {
            return respData.data
        }
        if (type == 'error' && respData && respData.response && respData.response.status == 401 && callBy != 'pair') {
            if (isLogin()) {
                removeAuthToken()
                removeAuthorization()
                window.location.href = '/login'
                document.cookie = 'user_token' + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
                return true
            }
        }
        if (type == 'error' && respData && respData.response && respData.response.data) {
            return respData.response.data
        }


    } catch (err) {
        return {
            success: false,
            message: 'Something went wrong',
        }
    }
}
export const checkAuth = (respData, type = 'success') => {
    try {
        if (type == 'error' && respData && respData.response && respData.response.status == 401) {
            if (isLogin()) {
                removeAuthToken()
                removeAuthorization()
                window.location.href = '/login'
                document.cookie = 'user_token' + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
                return true
            }
        }
    } catch (err) {
        return false
    }
}
export default axios;
