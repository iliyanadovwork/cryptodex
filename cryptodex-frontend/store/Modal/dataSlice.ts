import { createSlice } from "@reduxjs/toolkit";

const initialState: any = {
  'transfer': false
}

const dataSlice: any = createSlice({
  name: "modal",
  initialState,
  reducers: {
    updateModal: (state, action) => {
      const { id, value } = action.payload
      state[id] = value;
    }
  },
  extraReducers: {}
});

export const {
  updateModal
} = dataSlice.actions;

export default dataSlice.reducer;
