import { combineReducers } from '@reduxjs/toolkit'
import data from './dataSlice'


const userSettingReducer = combineReducers({
    data,

})

export default userSettingReducer