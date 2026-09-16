import { combineReducers } from '@reduxjs/toolkit'
import data from './dataSlice'


const commonModal = combineReducers({
    data,
})

export default commonModal