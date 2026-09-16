// import package
import { Server } from 'socket.io';
import parser from "socket.io-msgpack-parser";
// import socket credential check
import {
  handleCreateRoom,
  isPrivateRoomName,
  startPrivateRoomRecheck,
} from './socketAuth.js'

let socketIO = '';

export const createSocketIO = (server) => {
    socketIO = new Server(server, {
        // Enable WebSocket transport for better real-time performance
        // Polling is still available as fallback
        transports: ['websocket', 'polling'],

        // Heartbeat configuration for detecting stale connections
        // pingInterval: Server sends ping every 15 seconds
        // pingTimeout: Server waits 30 seconds for pong before considering client disconnected
        // This is much better than the previous 10 minute timeout!
        pingInterval: 15000,  // 15 seconds
        pingTimeout: 30000,   // 30 seconds (total 45s cycle before disconnect)

        // parser (msgpack parser is commented out, using default JSON)
        // parser,

        // CORS configuration
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    })

    socketIO.on('connection', (socket) => {
        console.log('[SocketIO] Client connected:', socket.id);

        /**
         * Join this socket's PRIVATE room.
         *
         * The payload is { token } - the same JWT the REST layer verifies. Any
         * userId in the payload is ignored: config/socketAuth.js decides which
         * room this socket is entitled to. The client is told the outcome both
         * through the ack and through ROOMJOINED / ROOMREJECTED, so a refusal
         * cannot present as a feed that merely never updates.
         */
        socket.on('CREATEROOM', function (payload, ack) {
            handleCreateRoom(socket, payload, ack).catch(() => { });
        });

        /**
         * Join a PUBLIC market channel - "spot", "depthChart" or a pair symbol.
         * These stay open to anonymous visitors: the chart, the depth widget
         * and the market tables must keep working with no credential.
         *
         * The one thing subscribe must not do is double as an unguarded
         * CREATEROOM, so it refuses ObjectId-shaped names, which are private
         * rooms and never public channels.
         */
        socket.on("subscribe", function (pair) {
            if (pair && !isPrivateRoomName(pair)) {
                socket.join(pair);
            }
        });

        socket.on("unSubscribe", function (pair) {
            if (pair && !isPrivateRoomName(pair)) {
                socket.leave(pair);
            }
        });

        /**
         * The client-driven relays that used to live here (pendingOrder,
         * filledOrder, orderHistory, orderBook, recentTrades) have been
         * removed. Each took a payload straight off a client socket and
         * re-emitted it - the first three into socketEmitOne(..., data.toUserId),
         * i.e. into any room the sender named, the last two into
         * socketEmitAll(), i.e. to the entire venue. Nothing in this product
         * emits them: the frontend's only outbound events are CREATEROOM,
         * subscribe and unSubscribe, and no service connects here as a client.
         * They were purely a way for one client to write into another client's
         * private feed, which is the same defect as an unauthenticated join
         * pointing the other way.
         *
         * The dead stubs that sat alongside them (makerSpotBalance,
         * takerSpotBalance, binancePriceList, binanceTicker, orderBookByPairId,
         * updateBalance) had empty bodies and no callers; they went with them.
         */

        socket.on('disconnecting', () => {
            console.log('DISCONNET', socket.rooms); // the Set contains at least the socket ID
        });

        // Log disconnection for debugging
        socket.on('disconnect', (reason) => {
            console.log('[SocketIO] Client disconnected:', socket.id, 'reason:', reason);
        });
    })

    // A join is a one-off; a session is not. Logging in again rotates the
    // tokenId in redis and deleting the account removes the row, and neither
    // reaches a socket that already joined - so re-check the credential of the
    // sockets that hold a private room, and evict the ones that no longer have
    // a live session.
    startPrivateRoomRecheck(socketIO);

}

export const socketEmitAll = (type, data) => {

    try {
        // Was: `if (type == 'orderBook') setOrderBookData(data)`, which kept a
        // module-level mirror of every book emit purely so `/v1/spot/orderbook`
        // could answer from it. That endpoint is gone (see server.js), so the
        // mirror had no reader left - every emit was paying to maintain a cache
        // nothing could query.
        // Log important events for debugging
        if (type === 'orderBook' || type === 'marketPrice') {
            console.log(`[Socket] Emitting ${type}:`, {
                pairId: data.pairId || data._id,
                symbol: data.symbol,
                hasData: !!data
            });
        }
        socketIO.emit(type, data)
    } catch (err) {
        console.log('[socketEmitAll] Error:', err.message);
    }
}

export const socketEmitOne = (type, data, userId) => {
    try {
        socketIO.sockets.in(userId.toString()).emit(type, data);
    } catch (err) {
    }
}
