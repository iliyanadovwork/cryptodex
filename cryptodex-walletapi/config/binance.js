// import package
import BinanceApiNode from 'binance-api-node'

// import lib
import config from './index.js';

const binanceApiNode = BinanceApiNode.default({
    apiKey: config.BINANCE_GATE_WAY.API_KEY,
    apiSecret: config.BINANCE_GATE_WAY.API_SECRET
})

export {
    binanceApiNode
}