#!/usr/bin/env node

/**
 * Diagnostic script to check service status.
 *
 * The port list here was the worst of the stale copies: it walked a range of
 * ports against the wrong names - labelling the wallet service "Spot API" and
 * so on - and then hard-coded a SECOND, different set of wrong ports for the
 * per-route checks. Every line of its output was misattributed. It now reads
 * the single table in services.js.
 */

import http from 'http';
import { SERVICES } from './services.js';

const TIMEOUT_MS = 5000;

function checkPort(port, path = '/') {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, timeout: TIMEOUT_MS },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (data.length < 4096) data += chunk;
        });
        res.on('end', () =>
          resolve({ port, status: res.statusCode, data: data.substring(0, 200) })
        );
      }
    );
    // No timeout at all used to mean a wedged service hung the diagnostic.
    req.on('timeout', () => {
      req.destroy();
      resolve({ port, status: 'DOWN', error: `no response within ${TIMEOUT_MS}ms` });
    });
    req.on('error', (err) => resolve({ port, status: 'DOWN', error: err.message }));
  });
}

async function main() {
  console.log('=== Cryptodex Service Diagnostic ===\n');

  console.log('Port Status:');
  for (const service of SERVICES) {
    const r = await checkPort(service.port);
    const status = r.status === 'DOWN' ? `DOWN (${r.error})` : `UP (${r.status})`;
    const icon = r.status === 'DOWN' ? '✗' : '✓';
    console.log(`  ${icon} Port ${service.port} (${service.name}): ${status}`);
    if (r.data && r.data.length > 0) {
      console.log(`    Response: "${r.data.substring(0, 80)}"`);
    }
  }

  console.log('\nDetailed Service Checks:\n');

  const byName = Object.fromEntries(SERVICES.map((s) => [s.name, s]));

  // THE PAIR-SCOPED SPOT ROUTES NEED A PAIR THAT EXISTS ON THIS VENUE.
  // They were probed as `/api/spot/ordeBook/BTCUSDT` and
  // `/api/spot/recentTrade/BTCUSDT`. `:pairId` is a mongo _id and there is no
  // BTCUSDT pair here, so getRecentTrade took its "pair not found" branch and
  // this diagnostic printed a permanent `404 /api/spot/recentTrade/BTCUSDT`
  // against a perfectly healthy spot service. A diagnostic that shows a
  // standing red line teaches the operator to ignore red lines. The id is now
  // read from the pair list first, and if that read fails the probes say so
  // instead of blaming the routes.
  const spot = byName['Spot API'];
  const pairList = await checkPort(spot.port, '/api/spot/tradePair');
  let pairId = null;
  try {
    // checkPort truncates the body, so parse only what a first row needs.
    const match = /"_id"\s*:\s*"([a-f0-9]{24})"/i.exec(pairList.data || '');
    pairId = match ? match[1] : null;
  } catch (err) {
    pairId = null;
  }

  const ROUTE_CHECKS = [
    {
      service: 'User API',
      routes: ['/api/health'],
    },
    {
      service: 'Spot API',
      routes: [
        '/api/spot/health',
        '/api/spot/tradePair',
        // The route really is spelled "ordeBook" in routes/spot.route.js.
        ...(pairId
          ? [`/api/spot/ordeBook/${pairId}`, `/api/spot/recentTrade/${pairId}`]
          : []),
      ],
    },
    {
      service: 'Wallet API',
      routes: ['/api/health', '/api/currency/getCurrency'],
    },
    // `byName` below is built from the one table in services.js, so a row
    // naming a service that is not in that table does not just print a red
    // line - it throws on `service.port` of undefined and takes the whole
    // diagnostic down. Keep this list and that table in step.
  ];

  for (const check of ROUTE_CHECKS) {
    const service = byName[check.service];
    console.log(`${check.service} Routes (port ${service.port}):`);
    if (check.service === 'Spot API' && !pairId) {
      console.log(
        '  SKIPPED the pair-scoped routes: no pair id could be read from ' +
          '/api/spot/tradePair (that read is itself checked above)'
      );
    }
    for (const route of check.routes) {
      const r = await checkPort(service.port, route);
      if (r.status === 'DOWN') {
        console.log(`  ERROR ${route}: ${r.error}`);
      } else {
        console.log(`  ${r.status} ${route}`);
      }
    }
    console.log('');
  }
}

main().catch(console.error);
