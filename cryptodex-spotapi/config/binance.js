// import package
import Binance from 'node-binance-api';

// import lib
import config from './index.js';

const BinanceOptions = {
    APIKEY: config.BINANCE_GATE_WAY.API_KEY,
    APISECRET: config.BINANCE_GATE_WAY.API_SECRET,
    'family': 4,
    useServerTime: true,
    recvWindow: 60000,
};

const nodeBinanceAPI = new Binance().options(BinanceOptions);

// Binance API Node - enabled with WebSocket support
const binanceApiNode = new Binance().options(BinanceOptions);

// WebSocket methods wrapper
const wsMethods = {
    partialDepth: (pairs, callback) => {
        try {
            const symbols = pairs.map(p => p.symbol);
            // Use depthCache WebSocket for each symbol
            symbols.forEach(symbol => {
                nodeBinanceAPI.websockets.depthCache(symbol, (depth) => {
                    if (depth && depth.symbol) {
                        callback({ symbol: depth.symbol, ...depth });
                    }
                });
            });
        } catch (err) {
            console.log('partialDepth error:', err.message);
        }
    },
    depth: (pairs, callback) => {
        try {
            const symbols = pairs.map(p => p.symbol);
            symbols.forEach(symbol => {
                nodeBinanceAPI.websockets.depth(symbol, (depth) => {
                    if (depth && depth.symbol) {
                        callback({ symbol: depth.symbol, ...depth });
                    }
                });
            });
        } catch (err) {
            console.log('depth error:', err.message);
        }
    },
    ticker: (symbols, callback) => {
        try {
            const symbolList = symbols && symbols.length > 0 ? symbols.map(s => s.symbol || s) : [];
            nodeBinanceAPI.websockets.miniTicker(symbolList.length > 0 ? symbolList : false, (ticker) => {
                if (Array.isArray(ticker)) {
                    ticker.forEach(t => callback(t));
                } else {
                    callback(ticker);
                }
            });
        } catch (err) {
            console.log('ticker error:', err.message);
        }
    },
    recentTrades: (symbols, callback) => {
        try {
            const symbolList = symbols.map(p => p.symbol);
            symbolList.forEach(symbol => {
                nodeBinanceAPI.websockets.trades([symbol], (trades) => {
                    if (trades && trades.length > 0) {
                        callback({ symbol, trades });
                    }
                });
            });
        } catch (err) {
            console.log('recentTrades error:', err.message);
        }
    },
    chart: (symbol, interval, callback) => {
        try {
            nodeBinanceAPI.websockets.candles(symbol, interval, (candles) => {
                if (candles) {
                    callback({ symbol, interval, candles });
                }
            });
        } catch (err) {
            console.log('chart error:', err.message);
        }
    },
    terminate: () => {
        try {
            nodeBinanceAPI.websockets.terminate();
        } catch (err) {
            console.log('terminate error:', err.message);
        }
    }
};

// Attach ws methods to binanceApiNode
binanceApiNode.ws = wsMethods;

export {
    nodeBinanceAPI,
    binanceApiNode
}