
"use strict";
// import model
import {
  SpotPair,
} from '../../models/index.js';

import https from 'https';
import http from 'http';

// REMOVED, and it did not belong in a running service:
//
//   process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
//
// Setting it at module scope disables TLS certificate verification for the
// ENTIRE PROCESS, permanently. This module is on the boot import chain
// (server.js -> routes/spot.route.js -> chart/chart.controller.js -> here), so
// it executed on every spotapi start, and every HTTPS call the service made
// afterwards -- including the Binance depth/ticker/klines feeds the whole venue
// prices from -- would accept any certificate from any host. It is not scoped
// to a request and cannot be undone by a later caller.
//
// The identical line was already removed from the sibling file for the same
// reason; see the note at the top of ./request-processor.js, which calls it
// "the serious one". Nothing here needs it: the only outbound call in this file
// is initGetAllMarketsdata(), which uses plaintext `http` to localhost:5000 and
// has no caller anywhere in the service.


var symbols = [];

export const initGetAllMarketsdata = () => {
	// An object of options to indicate where to post to
	var post_options = {
		host: "localhost",
		path: "/api/markets",
		method: "GET",
		port: "5000"
	};
	// Set up the request
	var request = http.request(post_options, response => {
		var result = "";
		response.setEncoding("utf8");
		response.on("data", chunk => {
			result += chunk;
		});
		response.on("end", () => {
			if (response.statusCode !== 200) {
				return;
			}
			var receivedData = JSON.parse(result);
			var newCuurencyArray = receivedData.map(item => {
				var blankObj = {};
				blankObj["name"] = item.name;
				blankObj["description"] = item.name;
				blankObj["exchange"] = item.exchange;
				blankObj["type"] = "crypto";
				return blankObj;
			});
			//this.addSymbols(newCuurencyArray);
		});
	});
	request.on("error", function (e) {
		console.log("problem with request: ", e.message);
	});
	request.end();
};

function searchResultFromDatabaseItem(item) {
	return {
		symbol: item.name,
		full_name: item.name,
		description: item.description,
		exchange: item.exchange,
		type: item.type
	};
}

export const search = function (searchString, type, exchange, maxRecords) {
	var MAX_SEARCH_RESULTS = !!maxRecords ? maxRecords : 50;
	var results = []; // array of WeightedItem { item, weight }
	var queryIsEmpty = !searchString || searchString.length === 0;
	var searchStringUpperCase = searchString.toUpperCase();

	for (var i = 0; i < symbols.length; ++i) {
		var item = symbols[i];

		if (type && type.length > 0 && item.type != type) {
			continue;
		}
		if (exchange && exchange.length > 0 && item.exchange != exchange) {
			continue;
		}

		var positionInName = item.name.toUpperCase().indexOf(searchStringUpperCase);
		var positionInDescription = item.description.toUpperCase().indexOf(searchStringUpperCase);

		if (queryIsEmpty || positionInName >= 0 || positionInDescription >= 0) {
			var found = false;
			for (var resultIndex = 0; resultIndex < results.length; resultIndex++) {
				if (results[resultIndex].item == item) {
					found = true;
					break;
				}
			}
			if (!found) {
				var weight = positionInName >= 0 ? positionInName : 8000 + positionInDescription;
				results.push({
					item: item,
					weight: weight
				});
			}
		}
	}

	return results
		.sort(function (weightedItem1, weightedItem2) {
			return weightedItem1.weight - weightedItem2.weight;
		})
		.map(function (weightedItem) {
			return searchResultFromDatabaseItem(weightedItem.item);
		})
		.slice(0, Math.min(results.length, MAX_SEARCH_RESULTS));
};


export const addSymbols = function (newSymbols) {
	symbols = symbols.concat(newSymbols);
};

export const symbolInfo = function (symbolName, tradeType) {
	if (tradeType == 'spot') {
		var data = symbolName.split(':');
		var exchange = (data.length > 1 ? data[0] : "").toUpperCase();
		var symbol = (data.length > 1 ? data[1] : symbolName).toUpperCase();
		for (var i = 0; i < symbols.length; ++i) {
			var item = symbols[i];

			if (item.name.toUpperCase() == symbol && (exchange.length === 0 || exchange == item.exchange.toUpperCase())) {
				return item;
			}
		}
	}

	return null;
};

export const initialChartSymbol = async () => {
	try {
		let symbolData = await SpotPair.aggregate([
			{
				"$project": {
					"_id": 0,
					"name": {
						"$concat": ["$firstCurrencySymbol", "$secondCurrencySymbol"]
					},
					"description": {
						"$concat": ["$firstCurrencySymbol", "$secondCurrencySymbol"]
					},
					"exchange": 'Trading',
					"type": 'crypto',
					"botstatus": 1
				}
			}
		])

		symbols = symbolData
		return true
	} catch (err) {
		return false
	}
}



initialChartSymbol();

export const getSymbol = () => {
	return symbols
}
