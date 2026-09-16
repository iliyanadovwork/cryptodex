import { combineReducers } from '@reduxjs/toolkit'
import data from './dataSlice'


const pairListReducer = combineReducers({
    data
})

export default pairListReducer