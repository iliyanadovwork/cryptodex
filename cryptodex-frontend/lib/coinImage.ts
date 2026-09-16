import config from "../config";

/**
 * Get coin image URL from symbol
 * Uses local cryptoicons folder first, then falls back to backend API
 */
export function getCoinImageUrl(symbol?: string, fallbackImageUrl?: string): string | undefined {
  // If API already provided the image URL, use it
  if (fallbackImageUrl) {
    return fallbackImageUrl;
  }

  if (!symbol) return undefined;

  // Map common symbols to their image filenames
  const symbolMap: Record<string, string> = {
    'BTC': 'btc',
    'ETH': 'eth',
    'USDT': 'usdt',
    'USDC': 'usdc',
    'BNB': 'bnb',
    'SOL': 'solana',
    'XRP': 'xrp',
    'ADA': 'ada',
    'DOGE': 'doge',
    'DOT': 'dot',
    'MATIC': 'matic',
    'AVAX': 'avax',
    'LINK': 'link',
    'UNI': 'uni',
    'LTC': 'ltc',
    'BCH': 'bch',
    'ATOM': 'atom',
    'FIL': 'fil',
    'TRX': 'trx',
    'ETC': 'etc',
    'XLM': 'xlm',
    'ALGO': 'algo',
    'VET': 'vet',
    'XMR': 'xmr',
    'EOS': 'eos',
    'XTZ': 'xtz',
    'DASH': 'dash',
  };

  const imageName = symbolMap[symbol] || symbol.toLowerCase();
  // Use local cryptoicons folder
  return `/assets/images/cryptoicons/${imageName}.png`;
}
