/**
 * Custom Datafeed adapter for TradingView Charting Library v26
 * Converts new PeriodParams API to legacy rangeStartDate/rangeEndDate format
 */

// Helper function to fetch data
function sendRequest(datafeedUrl, urlPath, params) {
  const url = new URL(urlPath, datafeedUrl);
  Object.keys(params).forEach(key => {
    url.searchParams.append(key, params[key]);
  });

  return fetch(url.toString())
    .then(response => response.json())
    .catch(error => {
      console.error('Datafeed request failed:', error);
      throw error;
    });
}

// History Provider
function HistoryProvider(datafeedUrl) {
  this._datafeedUrl = datafeedUrl;
}

HistoryProvider.prototype.getBars = function(symbolInfo, resolution, periodParams) {
  const _this = this;

  // Extract timestamps from PeriodParams object
  const from = periodParams.timeFrom || Math.floor(Date.now() / 1000) - 86400;
  const to = periodParams.timeTo || Math.floor(Date.now() / 1000);

  const requestParams = {
    symbol: symbolInfo.ticker || '',
    resolution: resolution,
    from: from,
    to: to,
  };

  return new Promise(function(resolve, reject) {
    sendRequest(_this._datafeedUrl, 'history', requestParams)
      .then(function(response) {
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

        resolve({ bars: bars, meta: meta });
      })
      .catch(function(reason) {
        console.warn('HistoryProvider: getBars() failed, error=' + reason);
        reject(reason);
      });
  });
};

// Symbols Data Provider
function SymbolsStorage(datafeedUrl, requester) {
  this._datafeedUrl = datafeedUrl;
  this._symbols = {};
  this._ready = false;
}

SymbolsStorage.prototype.init = function() {
  const _this = this;
  return sendRequest(this._datafeedUrl, 'symbols', {})
    .then(function(response) {
      if (Array.isArray(response)) {
        response.forEach(function(symbol) {
          _this._symbols[symbol.symbol] = symbol;
        });
      }
      _this._ready = true;
      return _this._symbols;
    })
    .catch(function(error) {
      console.warn('Failed to load symbols:', error);
      _this._ready = true;
      return {};
    });
};

SymbolsStorage.resolveSymbol = function(symbolName) {
  // Default symbol info
  return Promise.resolve({
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
    pricescale: 100000000,
    minmov: 1,
  });
};

// Quotes Provider
function QuotesProvider(datafeedUrl) {
  this._datafeedUrl = datafeedUrl;
}

QuotesProvider.prototype.getQuotes = function(symbols) {
  const _this = this;
  return sendRequest(this._datafeedUrl, 'quotes', { symbols: symbols.join(',') })
    .then(function(response) {
      if (!Array.isArray(response)) {
        return [];
      }
      return response.map(function(quote) {
        return {
          symbol: quote.s,
          price: Number(quote.bp || quote.lp),
          volume: Number(quote.bv || quote.v),
        };
      });
    })
    .catch(function(error) {
      console.warn('QuotesProvider failed:', error);
      return [];
    });
};

// Data Pulse Provider for real-time updates
function DataPulseProvider(historyProvider) {
  this._historyProvider = historyProvider;
  this._subscribers = {};
  this._timers = {};
}

DataPulseProvider.prototype.subscribeBars = function(symbolInfo, resolution, onTick, listenerGuid) {
  const _this = this;
  this._subscribers[listenerGuid] = {
    symbolInfo: symbolInfo,
    resolution: resolution,
    onTick: onTick,
  };

  // Poll every 3 seconds for updates
  this._timers[listenerGuid] = setInterval(function() {
    _this._historyProvider.getBars(symbolInfo, resolution, {
      timeFrom: Math.floor(Date.now() / 1000) - 300,
      timeTo: Math.floor(Date.now() / 1000),
      countBack: 1,
      firstDataRequest: false,
    }).then(function(result) {
      if (result.bars && result.bars.length > 0) {
        result.bars.forEach(function(bar) {
          onTick(bar);
        });
      }
    }).catch(function(error) {
      // Silently ignore polling errors
    });
  }, 3000);
};

DataPulseProvider.prototype.unsubscribeBars = function(listenerGuid) {
  if (this._timers[listenerGuid]) {
    clearInterval(this._timers[listenerGuid]);
    delete this._timers[listenerGuid];
  }
  delete this._subscribers[listenerGuid];
};

// Main Datafeed Class
function CustomDatafeed(datafeedUrl) {
  this._datafeedURL = datafeedUrl;
  this._historyProvider = new HistoryProvider(datafeedUrl);
  this._quotesProvider = new QuotesProvider(datafeedUrl);
  this._dataPulseProvider = new DataPulseProvider(this._historyProvider);
  this._configuration = null;
  this._symbolsStorage = new SymbolsStorage(datafeedUrl);
}

CustomDatafeed.prototype.onReady = function(callback) {
  const _this = this;

  // Get configuration
  sendRequest(this._datafeedURL, 'config', {})
    .then(function(configuration) {
      _this._configuration = configuration || {
        supports_search: false,
        supports_group_request: true,
        supported_resolutions: ['1', '5', '15', '30', '60', '1D', '1W', '1M'],
        supports_marks: false,
        supports_timescale_marks: false,
      };
      callback(_this._configuration);
    })
    .catch(function() {
      _this._configuration = {
        supports_search: false,
        supports_group_request: true,
        supported_resolutions: ['1', '5', '15', '30', '60', '1D', '1W', '1M'],
        supports_marks: false,
        supports_timescale_marks: false,
      };
      callback(_this._configuration);
    });
};

CustomDatafeed.prototype.resolveSymbol = function(symbolName, onResolve, onError) {
  sendRequest(this._datafeedURL, 'symbols', { symbol: symbolName })
    .then(function(response) {
      if (response.s !== undefined) {
        onError('unknown_symbol');
      } else {
        onResolve(response);
      }
    })
    .catch(function() {
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
        pricescale: 100000000,
        minmov: 1,
      });
    });
};

CustomDatafeed.prototype.getBars = function(symbolInfo, resolution, periodParams, onResult, onError) {
  this._historyProvider.getBars(symbolInfo, resolution, periodParams)
    .then(function(result) {
      onResult(result.bars, result.meta);
    })
    .catch(onError);
};

CustomDatafeed.prototype.subscribeBars = function(symbolInfo, resolution, onTick, listenerGuid) {
  this._dataPulseProvider.subscribeBars(symbolInfo, resolution, onTick, listenerGuid);
};

CustomDatafeed.prototype.unsubscribeBars = function(listenerGuid) {
  this._dataPulseProvider.unsubscribeBars(listenerGuid);
};

CustomDatafeed.prototype.getQuotes = function(symbols, onDataCallback, onErrorCallback) {
  this._quotesProvider.getQuotes(symbols).then(onDataCallback).catch(onErrorCallback);
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
      // Silently fail
    });
};

CustomDatafeed.prototype.calculateHistoryDepth = function(resolution, resolutionBack, intervalBack) {
  return undefined;
};

// Export as ES module
export { CustomDatafeed };

// Also export to window for backwards compatibility
if (typeof window !== 'undefined') {
  if (!window.Datafeeds) {
    window.Datafeeds = {};
  }
  window.Datafeeds.CustomDatafeed = CustomDatafeed;
}
