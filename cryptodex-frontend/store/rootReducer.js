import { combineReducers } from "redux";
import auth from "./auth";
import base from "./base";
import UserSetting from "./UserSetting"
import modal from "./Modal"

const rootReducer = (asyncReducers) => (state, action) => {
  const combinedReducer = combineReducers({
    auth,
    base,
    UserSetting,
    modal,
    ...asyncReducers,
  });
  return combinedReducer(state, action);
};

export default rootReducer;
