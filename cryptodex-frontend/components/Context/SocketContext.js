import { createContext } from "react";

// The spot engine and the user service are the only publishers of sockets.
const SocketContext = createContext({
  spotSocket: "",
  userSocket: "",
});

export default SocketContext;
