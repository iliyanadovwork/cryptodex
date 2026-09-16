/**
 * THE /v1 AGGREGATOR API IS GONE - AND STAYS GONE
 *
 * This file used to test `/v1/spot/summary` and `/v1/spot/ticker` against each
 * other: that both called the base-coin figure `base_volume` and the
 * quote-currency figure `quote_volume` (they had once published the same two
 * numbers with the names swapped, so the same document said "12,404 BTC traded"
 * on one route and "798,659,205 BTC traded" on the other), and that both quoted
 * the tradable ladder rather than the lagging mongo ticker mirror.
 *
 * Those tests were doing real work, but they were making a fabricated feed
 * self-consistent. The four `/v1/spot` endpoints exist so that exchange data
 * aggregators can ingest a venue and list it: `summary`, `ticker`, `orderbook`
 * and `recentTrade` are that industry-standard shape. This is a paper venue -
 * the volume is invented, the trades are against a synthetic ladder - and
 * publishing invented figures in exactly the format built to be read as real
 * market data is the part that makes them misleading. Correcting the units
 * would have made the numbers more convincing, not more true.
 *
 * So the whole surface was removed: routes/v1.route.js, controllers/
 * v1.controller.js, and the `setOrderBookData` mirror in config/socketIO.js
 * that existed only to feed `/v1/spot/orderbook`.
 *
 * What replaces the old assertions is the one thing still worth pinning: that
 * none of it comes back by accident. The venue's own public market data
 * (`/api/spot/tradePair`, `/ordeBook/:pairId`, `/recentTrade/:pairId`) is
 * untouched and is covered by its own suites.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

describe('the /v1 aggregator surface is removed', () => {
  test('the router and its controller are deleted', () => {
    expect(exists('routes/v1.route.js')).toBe(false);
    expect(exists('controllers/v1.controller.js')).toBe(false);
  });

  test('server.js mounts nothing at /v1', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    // Comments explaining the removal are allowed to say "/v1"; a mount is not.
    const mounts = src
      .split('\n')
      .filter((line) => /app\.use\(|app\.get\(/.test(line))
      .filter((line) => line.includes('/v1'));
    expect(mounts).toEqual([]);
    expect(src).not.toContain('v1.route.js');
  });

  test('no module imports the deleted v1 controller', () => {
    const roots = ['controllers', 'routes', 'config', 'lib', 'grpc'];
    const offenders = [];
    const walk = (dir) => {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith('.js')) {
          const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
          if (/from\s+['"].*v1\.controller\.js['"]|require\(['"].*v1\.controller\.js['"]\)/.test(src)) {
            offenders.push(rel);
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  test('the socket emit path no longer maintains the orderbook mirror', () => {
    const src = fs.readFileSync(path.join(ROOT, 'config/socketIO.js'), 'utf8');
    // Match CODE, not prose: the removal note in that file names the call it
    // replaced, and a substring check on the whole source would fail on the
    // explanation rather than on a regression.
    const live = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(live).not.toContain('setOrderBookData');
  });
});
