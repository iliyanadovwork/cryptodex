import { createContext } from 'react';

const MyAccountContext = createContext({
    setKycDetail: {},
    setPersonalData: {}
});

export default MyAccountContext;