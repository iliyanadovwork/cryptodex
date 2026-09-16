/**
 * Custom Datafeed adapter for TradingView Charting Library v26
 * Converts new PeriodParams API to legacy rangeStartDate/rangeEndDate format
 */

import { LiveBarBuilder, tradeTimeValue } from './chartBars';

// Helper function to fetch data
function sendRequest(datafeedUrl, urlPath, params) {
  // Manually construct the URL to avoid issues with URL API
  let url = datafeedUrl;
  if (!url.endsWith('/')) {
    url += '/';
  }
  url += urlPath;

  // Add query parameters
  const queryParams = [];
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null) {
      queryParams.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
    }
  });

  if (queryParams.length > 0) {
    url += '?' + queryParams.join('&');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  return fetch(url.toString(), {
    signal: controller.signal,
    headers: {
      'Accept': 'application/json',
    },
  })
    .then(response => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    })
    .catch(error => {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.warn('[Datafeed] Request timeout:', urlPath);
        throw new Error(`Request timeout for ${urlPath}`);
      }
      console.error('[Datafeed] Request failed:', error.message, url);
      throw error;
    });
}

// History Provider
function HistoryProvider(datafeedUrl) {
  this._datafeedUrl = datafeedUrl;
  // The newest bar seen per symbol+resolution, so `subscribeBars` can start
  // from the candle already drawn rather than opening a flat one next to it.
  this._latestBars = {};
}

const barCacheKey = (symbolInfo, resolution) =>
  [
    (symbolInfo && (symbolInfo.name || symbolInfo.ticker)) || '',
    String(resolution),
  ].join('|');

/** The newest bar a previous `getBars` returned for this symbol and resolution. */
HistoryProvider.prototype.latestBarFor = function(symbolInfo, resolution) {
  return this._latestBars[barCacheKey(symbolInfo, resolution)] || null;
};

/**
 * Remember the newest bar of a page.
 *
 * `getBars` is called repeatedly as the user scrolls back, and those pages are
 * OLDER than the first one. Only a later bar may replace what is held, or
 * scrolling into the past would drag the live candle back with it.
 *
 * The page IS sorted ascending upstream (`$sort: { Date: 1 }` in
 * controllers/chart/chart.controller.js), so the last element is the newest.
 * It is scanned for the maximum anyway: taking the last element would make this
 * silently pick the OLDEST bar if that sort were ever dropped, and the failure
 * would show as a live candle stuck in the past rather than as an error.
 */
HistoryProvider.prototype._rememberLatestBar = function(symbolInfo, resolution, bars) {
  if (!Array.isArray(bars) || bars.length === 0) return;

  let newest = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar || !Number.isFinite(Number(bar.time))) continue;
    if (newest === null || Number(bar.time) > Number(newest.time)) newest = bar;
  }
  if (newest === null) return;

  const key = barCacheKey(symbolInfo, resolution);
  const held = this._latestBars[key];
  if (held && Number(held.time) >= Number(newest.time)) return;
  this._latestBars[key] = newest;
};

HistoryProvider.prototype.getBars = function(symbolInfo, resolution, periodParams) {
  const _this = this;

  // Extract timestamps from PeriodParams object
  const from = periodParams.timeFrom || Math.floor(Date.now() / 1000) - 86400;
  const to = periodParams.timeTo || Math.floor(Date.now() / 1000);

  const requestParams = {
    symbol: symbolInfo.name || symbolInfo.ticker || '',
    resolution: resolution,
    from: from,
    to: to,
  };

  console.log('HistoryProvider.getBars:', requestParams);

  return new Promise(function(resolve, reject) {
    sendRequest(_this._datafeedUrl, 'history', requestParams)
      .then(function(response) {
        console.log('History response:', response);
        if (response.s !== 'ok' && response.s !== 'no_data') {
          reject(response.errmsg);
          return;
        }

        const bars = [];
        const meta = {
          noData: false,
        };

        if (response.s === 'no_data') {
          meta.noData = true;
          meta.nextTime = response.nextTime;
        } else {
          const volumePresent = response.v !== undefined;
          const ohlPresent = response.o !== undefined;

          for (let i = 0; i < response.t.length; ++i) {
            const barValue = {
              time: response.t[i] * 1000,
              close: Number(response.c[i]),
              open: Number(response.c[i]),
              high: Number(response.c[i]),
              low: Number(response.c[i]),
            };

            if (ohlPresent) {
              barValue.open = Number(response.o[i]);
              barValue.high = Number(response.h[i]);
              barValue.low = Number(response.l[i]);
            }

            if (volumePresent) {
              barValue.volume = Number(response.v[i]);
            }

            bars.push(barValue);
          }
        }

        console.log('Parsed bars:', bars.length, 'bars');
        _this._rememberLatestBar(symbolInfo, resolution, bars);
        resolve({ bars: bars, meta: meta });
      })
      .catch(function(reason) {
        console.warn('HistoryProvider: getBars() failed, error=' + reason);
        reject(reason);
      });
  });
};

/**
 * LIVE CANDLES, FROM THE TRADE SOCKET THE REST OF THE APP ALREADY USES.
 * =====================================================================
 *
 * This used to register the subscriber and return, leaving `onTick` - the
 * library's only way to be told about a new candle - stored and never called.
 * The chart therefore drew history and stood still; it looked correct because
 * `getBars` returns data right up to the current second, and because changing
 * the pair, the interval or the theme re-creates the widget and re-runs
 * `getBars`. Only sitting still revealed it.
 *
 * The disabled code was going to POLL. It does not need to: every fill is
 * already pushed to this client as a `recentTrade` event, which is what feeds
 * the trade tape and the price header. Folding the same stream into the open
 * candle keeps the chart on the same clock as the rest of the page, and costs
 * no extra requests.
 */
function DataPulseProvider(historyProvider, options) {
  this._historyProvider = historyProvider;
  this._subscribers = {};
  this._builders = {};
  this._handlers = {}; // the exact listener reference, needed to detach it
  this._socket = (options && options.socket) || null;
  this._pairId = (options && options.pairId) || null;
}

DataPulseProvider.prototype.subscribeBars = function(symbolInfo, resolution, onTick, listenerGuid) {
  const _this = this;
  const builder = new LiveBarBuilder(resolution);

  this._subscribers[listenerGuid] = {
    symbolInfo: symbolInfo,
    resolution: resolution,
    onTick: onTick,
  };
  this._builders[listenerGuid] = builder;

  // Start from the newest bar history gave us, so the first live print extends
  // the candle already on screen instead of opening a flat one beside it.
  const seed = this._historyProvider.latestBarFor(symbolInfo, resolution);
  if (seed) builder.seed(seed);

  if (!this._socket) {
    // No socket supplied - the chart still renders history, it simply will not
    // move. Said plainly rather than failing, because this is the shape a
    // server render or a test double has.
    console.warn('[Datafeed] no socket supplied; chart will not receive live updates');
    return;
  }

  const handler = function(message) {
    // Both producers send { pairId, data: [...] }: spot.controller.js
    // recentTradeSocket on every fill, and lib/binanceWebSocket.js on a
    // throttled flush. A message for another market is not ours.
    if (!message || (_this._pairId && String(message.pairId) !== String(_this._pairId))) return;

    const trades = message.data;
    if (!Array.isArray(trades) || trades.length === 0) return;

    // LATE SEED. The library's order is getBars then subscribeBars, so the seed
    // above is normally in place - but a subscription that arrives first would
    // otherwise open its own bucket-aligned bar while the history bar covering
    // the same period sits at its own (last-trade) timestamp, drawing the period
    // twice. Seeding on the first print that matters closes that window;
    // `seed` refuses anything not newer, so this is a no-op once seeded.
    if (builder.current() === null) {
      const late = _this._historyProvider.latestBarFor(symbolInfo, resolution);
      if (late) builder.seed(late);
    }

    // Oldest first. The feed does not promise an order, and applying a batch
    // backwards would set `close` from the wrong print.
    const ordered = trades.slice().sort(function(a, b) {
      const at = tradeTimeValue(a);
      const bt = tradeTimeValue(b);
      return (at === null ? -Infinity : at) - (bt === null ? -Infinity : bt);
    });

    let latest = null;
    for (let i = 0; i < ordered.length; i++) {
      const bar = builder.accept(ordered[i]);
      if (bar) latest = bar;
    }

    // ONE callback per message, not one per trade. A republished window is 25
    // rows; ticking the library 25 times to arrive at the same candle is 25
    // redraws for one result.
    if (latest) {
      onTick({
        time: latest.time,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
      });
    }
  };

  this._handlers[listenerGuid] = handler;
  this._socket.on('recentTrade', handler);
};

DataPulseProvider.prototype.unsubscribeBars = function(listenerGuid) {
  const handler = this._handlers[listenerGuid];
  if (handler && this._socket) {
    // BY REFERENCE. `off("recentTrade")` with no handler removes EVERY listener
    // for that event on the shared socket singleton - including the trade tape's
    // - because the emitter drops the whole event rather than one subscriber.
    this._socket.off('recentTrade', handler);
  }
  delete this._handlers[listenerGuid];
  delete this._subscribers[listenerGuid];
  delete this._builders[listenerGuid];
};

/**
 * Main Datafeed Class
 *
 * @param {string} datafeedUrl
 * @param {{socket?: object, pairId?: string}} [options] the live trade feed.
 *   Both are injected rather than imported so this module stays free of the
 *   socket singleton - which does not exist during a server render - and so the
 *   tests can drive it with a stub emitter. Omit them and the chart renders
 *   history exactly as before, without live updates.
 */
export function CustomDatafeed(datafeedUrl, options) {
  this._datafeedURL = datafeedUrl;
  this._historyProvider = new HistoryProvider(datafeedUrl);
  this._dataPulseProvider = new DataPulseProvider(this._historyProvider, options);
  this._configuration = null;
}

CustomDatafeed.prototype.onReady = function(callback) {
  const _this = this;

  console.log('[Datafeed] onReady called, URL:', this._datafeedURL);

  // Return default configuration immediately to prevent blocking
  const defaultConfig = {
    supports_search: false,
    supports_group_request: true,
    supported_resolutions: ['1', '5', '15', '30', '60', '1D', '1W', '1M'],
    supports_marks: false,
    supports_timescale_marks: false,
  };

  // Try to get configuration from server, but use defaults on failure
  sendRequest(this._datafeedURL, 'config', {})
    .then(function(configuration) {
      console.log('[Datafeed] Config response:', configuration);
      _this._configuration = configuration || defaultConfig;
      callback(_this._configuration);
    })
    .catch(function(error) {
      console.warn('[Datafeed] Config fetch failed, using defaults:', error.message);
      _this._configuration = defaultConfig;
      callback(defaultConfig);
    });
};

CustomDatafeed.prototype.resolveSymbol = function(symbolName, onResolve, onError) {
  console.log('[Datafeed] resolveSymbol:', symbolName);

  sendRequest(this._datafeedURL, 'symbols', { symbol: symbolName })
    .then(function(response) {
      console.log('[Datafeed] Symbols response:', response);

      if (response.s !== undefined) {
        onError('unknown_symbol');
        return;
      }

      // Fix the response for proper crypto trading
      // Backend returns stock market settings, override for crypto
      response.session = '24x7';
      response.timezone = 'UTC';
      response.has_intraday = true;
      response.has_no_volume = false; // We do have volume
      response.pricescale = 100; // 2 decimal places for USDT pairs
      response.minmov = 1;
      response.volume_precision = 5; // Show volume with up to 5 decimal places

      console.log('[Datafeed] Fixed symbol info:', response);
      onResolve(response);
    })
    .catch(function(error) {
      console.warn('[Datafeed] Symbol resolution failed, using defaults:', error.message);
      // Return default symbol info on error
      onResolve({
        ticker: symbolName,
        name: symbolName,
        description: symbolName,
        type: 'crypto',
        session: '24x7',
        exchange: '',
        listed_exchange: '',
        timezone: 'UTC',
        has_intraday: true,
        supported_resolutions: ['1', '5', '15', '30', '60', '1D', '1W', '1M'],
        pricescale: 100,
        minmov: 1,
        volume_precision: 5,
      });
    });
};

CustomDatafeed.prototype.getBars = function(symbolInfo, resolution, periodParams, onResult, onError) {
  console.log('[Datafeed] getBars called:', symbolInfo?.name, resolution);
  this._historyProvider.getBars(symbolInfo, resolution, periodParams)
    .then(function(result) {
      onResult(result.bars, result.meta);
    })
    .catch(function(error) {
      console.error('[Datafeed] getBars failed:', error.message);
      // Return empty bars instead of error to prevent chart from breaking
      onResult([], { noData: true });
    });
};

CustomDatafeed.prototype.subscribeBars = function(symbolInfo, resolution, onTick, listenerGuid) {
  this._dataPulseProvider.subscribeBars(symbolInfo, resolution, onTick, listenerGuid);
};

CustomDatafeed.prototype.unsubscribeBars = function(listenerGuid) {
  this._dataPulseProvider.unsubscribeBars(listenerGuid);
};

CustomDatafeed.prototype.getQuotes = function(symbols, onDataCallback, onErrorCallback) {
  // Simple implementation
  onDataCallback([]);
};

CustomDatafeed.prototype.subscribeQuotes = function(symbols, fastSymbols, onRealtimeCallback, listenerGuid) {
  // Not implemented for now
};

CustomDatafeed.prototype.unsubscribeQuotes = function(listenerGuid) {
  // Not implemented for now
};

CustomDatafeed.prototype.getMarks = function(symbolInfo, from, to, onDataCallback, resolution) {
  onDataCallback([]);
};

CustomDatafeed.prototype.getTimescaleMarks = function(symbolInfo, from, to, onDataCallback, resolution) {
  onDataCallback([]);
};

CustomDatafeed.prototype.getServerTime = function(callback) {
  sendRequest(this._datafeedURL, 'time', {})
    .then(function(response) {
      const time = parseInt(response);
      if (!isNaN(time)) {
        callback(time);
      }
    })
    .catch(function() {
      // Silently fail - use local time
      callback(Math.floor(Date.now() / 1000));
    });
};

CustomDatafeed.prototype.calculateHistoryDepth = function(resolution, resolutionBack, intervalBack) {
  return undefined;
};

export default CustomDatafeed;
