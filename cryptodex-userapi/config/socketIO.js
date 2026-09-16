// import package
import { Server } from 'socket.io';
// import socket credential check
import {
    handleCreateRoom,
    startPrivateRoomRecheck
} from './socketAuth.js';
let socketIO = '';

export const createSocketIO = (server) => {
    socketIO = new Server(server, {
        transports: ['websocket'],
        pingTimeout: 600000,
        // parser,
        cors: {
            origin: "*"
        }
    })

    socketIO.on('connection', (socket) => {
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

        // There is no `subscribe` handler here and never was: this service has
        // no public channels. Its one socketEmitOne() call site is
        // notification.controller.js, emitting into a room named by user _id.
        // If a public channel is ever added, gate its join the way spotapi's
        // does - isPrivateRoomName() exists in ./socketAuth.js for that.

        /**
         * The client-driven relays that used to live here (pendingOrder,
         * filledOrder, orderHistory, orderBook, recentTrades) have been
         * removed. Each took a payload straight off a client socket and
         * re-emitted it - the first three into socketEmitOne(..., data.toUserId),
         * i.e. into any room the sender named, the last two into
         * socketEmitAll(), i.e. to the entire venue. Nothing in this product
         * emits them: the frontend's only outbound socket events anywhere are
         * CREATEROOM, subscribe and unSubscribe, it never opens a socket to
         * this service at all (config/socketConnectivity.js connects only to
         * spotapi), and no service connects here as a
         * client either. They were purely a way for one client to write into
         * another client's private feed, which is the same defect as an
         * unauthenticated join pointing the other way.
         *
         * The dead stubs that sat alongside them (makerSpotBalance,
         * takerSpotBalance, binancePriceList, binanceTicker, orderBookByPairId,
         * updateBalance) had empty bodies and no callers; they went with them.
         */

        socket.on('disconnecting', () => {
            console.log('DISCONNET', socket.rooms); // the Set contains at least the socket ID
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
        socketIO.emit(type, data)
    } catch (err) {
    }
}

export const socketEmitOne = (type, data, userId) => {
    try {
        socketIO.sockets.in(userId.toString()).emit(type, data);
    } catch (err) {
    }
}