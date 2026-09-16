import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import { apiGetUserProfile } from "../../services/User/UserServices";
import isEmpty from "../../lib/isEmpty";
export const initialState = {
  userId: "",
  firstName: "",
  lastName: "",
  email: "",
  blockNo: "",
  address: "",
  city: "",
  state: "",
  country: "",
  postalCode: "",
  emailStatus: "",
  phoneStatus: "",
  phoneCode: "",
  phoneNo: "",
  type: "",
  createAt: "",
  bankDetail: {},
  profileImage: "",
  refferalCode: "",
  refferedBy: "",
  perncetage: "0",
  _id: "",
  changepassword: "false",
  percentage: 0
};

export const getUserDetails = createAsyncThunk("auth/user", async () => {
  const response = await apiGetUserProfile();
  return response.data.result;
});

export const userSlice = createSlice({
  name: "auth/user",
  initialState: initialState,
  reducers: {
    setUser: (_, action) => action.payload,
    userLoggedOut: () => initialState,
    setUserProfileImage: (state, action) => {
      state.profileImage = action.payload;
    },
    setProfilePercentage: (state, action) => {
      let perncetage = 0;
      // if (state.emailStatus == "verified"){
      //   console.log('emailStatus')
      //   perncetage += 10
      // } 
      // if (state.phoneStatus == "verified"){
      //   console.log('phoneStatus')
      //   perncetage += 10
      // } 
      // if (!isEmpty(state.profileImage)){
      //   console.log('profileImage11')
      //   perncetage += 10
      // } 
      // if (!isEmpty(state.antiphishingcode)) {
      //   perncetage += 10
      // }
      // if (state.twoFAStatus=='enabled') {
      //   perncetage += 20
      // }
      // if (state.idProof=='approved') {
      //   perncetage += 10
      // }
      // if (state.addressProof=='approved') {
      //   perncetage += 10
      // }
      // if (state.addressProof=='true') {
      //   perncetage += 10
      // }
      // if (!isEmpty(state.bankDetail)) {
      //   perncetage += 10
      // }
      // if (state.changepassword == true){
      //   console.log('changepassword833')
      //   perncetage += 10
      // } 
      state.perncetage = perncetage

    },

  },

  extraReducers: {
    [getUserDetails.fulfilled]: (state, action) => {
      (state.userId = action.payload.userId),
        (state.firstName = action.payload.firstName),
        (state.lastName = action.payload.lastName),
        (state.email = action.payload.email),
        (state.blockNo = action.payload.blockNo),
        (state.address = action.payload.address),
        (state.city = action.payload.city),
        (state.state = action.payload.state),
        (state.country = action.payload.country),
        (state.postalCode = action.payload.postalCode),
        (state.emailStatus = action.payload.emailStatus),
        (state.phoneStatus = action.payload.phoneStatus),
        (state.phoneCode = action.payload.phoneCode),
        (state.phoneNo = action.payload.phoneNo),
        (state.type = action.payload.type),
        (state.createAt = action.payload.createAt),
        (state.bankDetail = action.payload.bankDetail),
        (state.refferalCode = action.payload.refferalCode),
        (state.refferedBy = action.payload.refferedBy),
      (state.changepassword = action.payload.changepassword);
      (state._id = action.payload._id);
      (state.percentage = action.payload.percentage);
      (state.assetPasswordStatus = action.payload.assetPasswordStatus);
    },
  },
});

export const { setUser, setUserProfileImage, setProfilePercentage } = userSlice.actions;

export default userSlice.reducer;
