#!/usr/bin/env node

/**
 * System Smoke Test for Cryptodex Crypto Exchange
 *
 * This test verifies that all services are running and key functionality works.
 * Tests the full user journey: register → login → wallet → trade
 */

import axios from 'axios';

// Service endpoints.
//
// THESE WERE STALE. userAPI pointed at 3001 and spotAPI at 3003 - nothing has
// listened on either port in this checkout for a long time, so every user and
// spot assertion below failed with ECONNREFUSED and the smoke test blamed the
// services. They now come from the single table in services.js, so they cannot
// drift away from check-services.js again.
import { BASE_URLS as SERVICES } from './services.js';

// Health checks.
//
// This used to GET `/` on every service and call any 200/401 "accessible",
// which proves only that express bound a socket - it cannot distinguish a
// healthy spot matcher from a spot service whose depth feed has been dead for
// an hour, and it cannot tell which service is on the port at all. Where a real
// health endpoint exists it is read and its verdict decides the result; where
// one does not, the probe hits a route only that service mounts, so a port
// shuffle shows up as a failure instead of a pass.
const HEALTHY_STATES = new Set(['ok', 'healthy', 'up', 'pass']);

async function checkServiceHealth() {
  log('\n=== Service Health Checks ===', colors.blue);

  const services = [
    {
      name: 'User API',
      url: `${SERVICES.userAPI}/api/health`,
      kind: 'health',
      service: 'userapi',
      required: true,
    },
    {
      name: 'Spot API',
      url: `${SERVICES.spotAPI}/api/spot/health`,
      kind: 'health',
      service: 'spotapi',
      required: true,
    },
    {
      name: 'Wallet API',
      url: `${SERVICES.walletAPI}/api/health`,
      kind: 'health',
      service: 'walletapi',
      required: true,
    },
    // THE ENTRIES FOR THE DELETED SERVICES ARE GONE. Those services were
    // deleted from the repository, not stopped, so probing them could only ever
    // produce ECONNREFUSED - a failure line for something that is not supposed
    // to exist. Four processes is the whole venue.
    //
    // THE FOURTH ONE IS THE FRONTEND, and it was missing entirely: this file
    // checked three services on a four-service venue, so a dead Next process
    // was invisible to the one script a reader is told to run. It has no health
    // route, so it is probed for liveness and labelled as such - weaker than
    // health, but it still proves a process is serving the app on 3000.
    {
      name: 'Frontend',
      url: `${SERVICES.frontend}/`,
      kind: 'liveness',
      required: true,
    },
  ];

  for (const service of services) {
    try {
      const response = await axios.get(service.url, { timeout: 5000 });

      if (service.kind === 'health') {
        const payload = response.data || {};
        // `status` IS THE STATE; `verdict` IS THE REASON. This read
        // `payload.verdict ?? payload.status`, the same precedence bug
        // check-services.js documents at length: it works only where the
        // verdict happens to be the word "ok" (spotapi) and marks a perfectly
        // healthy service degraded anywhere the verdict is a reason code.
        // walletapi and userapi answer with a `status` and no `verdict` at
        // all, so the fallback was doing the work by luck.
        const reported = String(payload.status ?? '').toLowerCase();
        const reason = payload.verdict ? ` (verdict: ${payload.verdict})` : '';
        const identityOk =
          !service.service ||
          !payload.service ||
          payload.service === service.service;
        const isHealthy =
          response.status === 200 && identityOk && HEALTHY_STATES.has(reported);
        recordTest(
          `${service.name} reports healthy`,
          isHealthy,
          identityOk
            ? `status: ${reported || '(none)'}${reason} (HTTP ${response.status})`
            : `wrong service on this port: expected ${service.service}, got ${payload.service}`
        );
        continue;
      }

      const isHealthy = response.status >= 200 && response.status < 300;
      recordTest(
        `${service.name} is serving`,
        isHealthy,
        `liveness only (no health route) - HTTP ${response.status}`
      );
    } catch (error) {
      const isCritical = service.required;
      // A 404 means SOMETHING is on the port but not this service - never a
      // pass, optional or not.
      const wrongService = error.response?.status === 404;
      recordTest(
        `${service.name} is accessible`,
        !isCritical && !wrongService,
        wrongService
          ? `port is bound but ${service.url} is not mounted there`
          : isCritical
            ? `Error: ${error.message}`
            : 'Optional service not running'
      );
    }
  }
}

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

let results = {
  passed: 0,
  failed: 0,
  tests: [],
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function recordTest(name, passed, details = '') {
  results.tests.push({ name, passed, details });
  if (passed) {
    results.passed++;
    log(`  ✓ ${name}`, colors.green);
  } else {
    results.failed++;
    log(`  ✗ ${name}`, colors.red);
    if (details) log(`    ${details}`, colors.red);
  }
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Test data generators
// (The three `generateTest*` helpers that were here had no callers left once
// `createOrGetTestUser` went; `testRegistration` builds its own timestamped
// address inline.)

let testData = {
  email: '',
  password: '',
  username: '',
  userId: '',
  token: '',
  // Resolved from the venue's own /api/spot/tradePair, not hard-coded. See the
  // note in testSpotTrading about the invented BTCUSDT constant this replaced.
  spotPairId: null,
  spotPairName: null,
};

// ============================================
// USER AUTHENTICATION FLOW
// ============================================

// THE `createOrGetTestUser` HELPER THAT SAT HERE IS GONE.
//
// Nothing called it - `runSmokeTest` goes straight to `testRegistration` - and
// it had rotted where it stood: it posted `otpTextBox: false` to bypass an
// e-mail OTP step that no longer exists, and it reused a fixed account
// (`smoketest@cryptodex.test`) whose balances carry over between runs, which is
// the opposite of what the demo-grant assertion below needs. Every run now
// registers a fresh account through the real endpoints, which is also the only
// way to prove registration still seeds a wallet.

async function testRegistration() {
  log('\n=== User Registration Flow ===', colors.blue);

  // Use unique timestamp to avoid duplicates
  const timestamp = Date.now();
  testData.email = `smoketest_${timestamp}@test.com`;
  testData.password = `Test@12345`;
  testData.username = `smoke_user_${timestamp}`;

  try {
    // Register new user
    // Note: Validation requires roleType, confirmPassword, reCaptcha, checkbox
    const registerResponse = await axios.post(`${SERVICES.userAPI}/api/auth/register`, {
      roleType: 1, // 1 = email registration
      email: testData.email,
      password: testData.password,
      confirmPassword: testData.password,
      reCaptcha: 'smoke_test_bypass',
      checkbox: true, // terms acceptance
    }, { timeout: 15000 });

    // Registration returns: { status: true, message: "Activation mail sent...", isMobile: false }
    const regSuccess = registerResponse.data?.status === true || registerResponse.status === 200 || registerResponse.status === 201;
    recordTest(
      'User registration',
      regSuccess,
      registerResponse.data?.message || `Status: ${registerResponse.status}`
    );

    if (regSuccess) {
      // Verify the user using test-mode bypass endpoint
      try {
        const verifyResponse = await axios.post(`${SERVICES.userAPI}/api/auth/test-verify`, {
          email: testData.email,
        }, { timeout: 10000 });

        if (verifyResponse.data?.success) {
          recordTest('Email verification (test mode)', true, 'User verified via test mode');
        } else {
          recordTest('Email verification (test mode)', false, verifyResponse.data?.message || 'Verification failed');
        }
      } catch (verifyError) {
        recordTest('Email verification (test mode)', false, verifyError.response?.data?.message || verifyError.message);
      }
    }
  } catch (error) {
    recordTest('User registration', false, error.response?.data?.message || error.message);
  }
}

async function testLogin() {
  log('\n=== User Login Flow ===', colors.blue);

  try {
    const loginResponse = await axios.post(`${SERVICES.userAPI}/api/auth/login`, {
      roleType: 1, // 1 = email login
      email: testData.email,
      password: testData.password,
      // Note: OTP is bypassed when TEST_MODE=true in User API
      loginHistory: {
        ipaddress: '127.0.0.1',
        broswername: 'smoke-test',
        countryName: 'Local',
      },
    }, { timeout: 15000 });

    // Login returns: { success: true, status: "SUCCESS", message: "...", token: "...", result: {...} }
    const success = loginResponse.data?.success === true && loginResponse.data?.token;
    recordTest('User login', success, success ? 'Token received' : JSON.stringify(loginResponse.data) || 'No token in response');

    if (success) {
      testData.token = loginResponse.data.token;
      if (loginResponse.data.result?._id) {
        testData.userId = loginResponse.data.result._id;
      }
    }
  } catch (error) {
    const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    recordTest('User login', false, errorMsg);
  }
}

async function testUserProfile() {
  log('\n=== User Profile ===', colors.blue);

  if (!testData.token) {
    recordTest('Get user profile', false, 'No authentication token available');
    return;
  }

  try {
    // Token already includes 'Bearer ' prefix from login response
    const profileResponse = await axios.get(`${SERVICES.userAPI}/api/user/profile`, {
      headers: { Authorization: testData.token },
    });

    recordTest(
      'Get user profile',
      profileResponse.data?.success === true || profileResponse.status === 200,
      profileResponse.data?.result?.email || 'Profile retrieved'
    );
  } catch (error) {
    recordTest('Get user profile', false, error.response?.data?.message || error.message);
  }
}

// ============================================
// WALLET OPERATIONS
// ============================================

async function testWalletOperations() {
  log('\n=== Wallet Operations ===', colors.blue);

  // Get supported currencies (no auth needed) - correct endpoint is /api/currency/getCurrency
  try {
    const currenciesResponse = await axios.get(`${SERVICES.walletAPI}/api/currency/getCurrency`, { timeout: 10000 });
    recordTest(
      'Get supported currencies',
      currenciesResponse.status === 200 || currenciesResponse.data?.status === 'success' || Array.isArray(currenciesResponse.data),
      `Currencies endpoint accessible`
    );
  } catch (error) {
    recordTest('Get supported currencies', false, error.response?.data?.message || error.message);
  }

  if (!testData.token) {
    recordTest('Read the new account balances', false, 'No authentication token available');
    return;
  }

  // THIS USED TO GET `/api/dashboard/lifeTimeReward` ON THE USER API, AND IT
  // FAILED ON A PERFECTLY HEALTHY VENUE.
  //
  // That route was part of a product surface that was deleted from the
  // repository. It answers 404 now and always will, so the one script
  // a reader is pointed at exited 1 against a stack with nothing wrong with it -
  // the same defect check-services.js documents at length, in the same
  // direction (a checker that contradicts reality teaches you to ignore it).
  //
  // What replaces it is a stronger check anyway. `lifeTimeReward` proved only
  // that userapi could answer an authenticated GET, which testUserProfile above
  // already proves. Reading the new account's balances out of walletapi proves
  // three things this run had no assertion for:
  //
  //   1. the token minted by userapi is accepted by a DIFFERENT service;
  //   2. walletapi's authenticated wallet surface works, not just the
  //      unauthenticated currency list;
  //   3. registration actually seeded the demo grant - which is the only
  //      money a paper-trading account ever has, and the thing a reader will
  //      look for first.
  try {
    // Token already includes 'Bearer ' prefix from login response
    const assetsResponse = await axios.get(
      `${SERVICES.walletAPI}/api/wallet/getAssetsDetails`,
      {
        headers: { Authorization: testData.token },
        timeout: 10000,
      }
    );

    const rows = Array.isArray(assetsResponse.data?.result)
      ? assetsResponse.data.result
      : [];
    recordTest(
      'Read the new account balances (userapi token accepted by walletapi)',
      assetsResponse.status === 200 && rows.length > 0,
      rows.length
        ? `${rows.length} asset rows: ${rows.map((r) => r.coin).join(', ')}`
        : `HTTP ${assetsResponse.status}, no asset rows returned`
    );

    // The demo grant. Asserted as "> 0", NOT as a specific number: the amount
    // is a product decision that has already been changed once (10,000 -> 1,000)
    // and a smoke test that pins it turns a deliberate change into a red build.
    // What matters here is that a fresh account can afford to trade at all.
    const spendable = rows.filter(
      (r) => ['USD', 'USDC'].includes(r.coin) && Number(r.spotBal) > 0
    );
    recordTest(
      'Fresh account was seeded with spendable demo funds',
      spendable.length > 0,
      spendable.length
        ? spendable.map((r) => `${r.spotBal} ${r.coin}`).join(' + ')
        : 'no USD or USDC balance on a newly registered account - nothing could be bought'
    );
  } catch (error) {
    recordTest(
      'Read the new account balances (userapi token accepted by walletapi)',
      false,
      error.response?.data?.message || error.message
    );
  }
}

// ============================================
// TRADING OPERATIONS
// ============================================

async function testSpotTrading() {
  log('\n=== Spot Trading ===', colors.blue);

  // Get trading pairs first to find an available pair.
  //
  // THE DEFAULT USED TO BE THE STRING 'BTCUSDT' AND IT WAS NOT A PAIR ON THIS
  // VENUE. Every pair here quotes in USD (BTCUSD, ETHUSD, SOLUSD) and the spot
  // routes below are keyed by the pair's Mongo `_id`, not by a ticker. The
  // fallback therefore asked for a market that does not exist - and several of
  // those routes answer 200 with an empty payload for an unknown pair, so the
  // fallback did not fail loudly, it passed quietly. Resolving the id from
  // /api/spot/tradePair is the only value worth testing against; if that call
  // fails there is nothing to fall back TO, and the tests that need a pair say
  // so instead of testing a fiction.
  let availablePair = null;
  try {
    const pairsResponse = await axios.get(`${SERVICES.spotAPI}/api/spot/tradePair`, { timeout: 10000 });
    const pairsSuccess = pairsResponse.status === 200 || Array.isArray(pairsResponse.data?.result) || Array.isArray(pairsResponse.data);

    const rows = Array.isArray(pairsResponse.data?.result)
      ? pairsResponse.data.result
      : Array.isArray(pairsResponse.data)
        ? pairsResponse.data
        : [];

    recordTest(
      'Get trading pairs',
      pairsSuccess && rows.length > 0,
      rows.length
        ? `${rows.length} active pairs: ${rows.map((p) => p.tikerRoot || p.pairName).join(', ')}`
        : 'no pairs returned - nothing on this venue is tradeable'
    );

    if (rows.length > 0) {
      availablePair = rows[0]._id || rows[0].pairId || null;
      testData.spotPairId = availablePair;
      testData.spotPairName = rows[0].tikerRoot || rows[0].pairName || '(unnamed)';
    }
  } catch (error) {
    recordTest('Get trading pairs', false, error.response?.data?.message || error.message);
  }

  if (!availablePair) {
    recordTest(
      'Resolve a pair to probe',
      false,
      'no pair id available - skipping order book, recent trades and market price'
    );
    return;
  }

  const on = ` (${testData.spotPairName})`;

  // Get order book (note: typo in original route "ordeBook")
  try {
    const orderBookResponse = await axios.get(`${SERVICES.spotAPI}/api/spot/ordeBook/${availablePair}`, { timeout: 10000 });
    recordTest(
      `Get order book${on}`,
      orderBookResponse.status === 200 || orderBookResponse.data?.status === 'success',
      'Order book data retrieved'
    );
  } catch (error) {
    recordTest(`Get order book${on}`, false, error.response?.data?.message || error.message);
  }

  // Get recent trades - use the available pair.
  //
  // THE CATCH BLOCK USED TO PASS ON A 404 ("Pair not in database (acceptable)").
  // That was written when the pair id was the invented BTCUSDT constant. The id
  // now comes from the venue's own pair list one call earlier, so a 404 here
  // means the service cannot serve a pair it just told us about - never an
  // acceptable answer, and exactly the kind of pass-on-the-error-path that let
  // a deleted service's test report green with its service in the bin.
  try {
    const tradesResponse = await axios.get(`${SERVICES.spotAPI}/api/spot/recentTrade/${availablePair}`, { timeout: 10000 });
    recordTest(
      `Get recent trades${on}`,
      tradesResponse.status === 200 || tradesResponse.data?.success === true || Array.isArray(tradesResponse.data?.result),
      'Recent trades data retrieved'
    );
  } catch (error) {
    recordTest(
      `Get recent trades${on}`,
      false,
      error.response?.data?.message || error.message
    );
  }

  // Get market price
  try {
    const priceResponse = await axios.get(`${SERVICES.spotAPI}/api/spot/marketPrice/${availablePair}`, { timeout: 10000 });
    recordTest(
      `Get market price${on}`,
      priceResponse.status === 200 || priceResponse.data?.success === true,
      'Market price data retrieved'
    );
  } catch (error) {
    recordTest('Get market price', false, error.response?.data?.message || error.message);
  }
}

// ============================================
// MARKET DATA ENDPOINTS
// ============================================

async function testMarketData() {
  log('\n=== Market Data ===', colors.blue);

  // Get trends from Spot API
  try {
    const trendsResponse = await axios.get(`${SERVICES.spotAPI}/api/spot/get-trends`, { timeout: 10000 });
    recordTest(
      'Get market trends',
      trendsResponse.status === 200 || Array.isArray(trendsResponse.data),
      'Market trends data retrieved'
    );
  } catch (error) {
    recordTest('Get market trends', false, error.response?.data?.message || error.message);
  }

  // Get chart data.
  //
  // THIS ASKED FOR `chart/BTCUSDT`, WHICH IS NOT A MARKET ON THIS VENUE - the
  // three pairs quote in USD. The route answers 200 for an unknown symbol, so
  // the assertion `status === 200` passed on a market that does not exist and
  // would have gone on passing with the chart pipeline entirely broken. It now
  // uses the pair id resolved from /api/spot/tradePair.
  if (!testData.spotPairId) {
    recordTest('Get chart data', false, 'no pair resolved - see Spot Trading above');
    return;
  }
  try {
    const chartResponse = await axios.get(
      `${SERVICES.spotAPI}/api/spot/chart/${testData.spotPairId}`,
      { timeout: 10000 }
    );
    recordTest(
      `Get chart data (${testData.spotPairName})`,
      chartResponse.status === 200 || Array.isArray(chartResponse.data),
      'Chart data retrieved'
    );
  } catch (error) {
    recordTest('Get chart data', false, error.response?.data?.message || error.message);
  }
}

// ============================================
// MAIN TEST RUNNER
// ============================================

async function runSmokeTest() {
  log('\n╔════════════════════════════════════════════════════════════╗', colors.magenta);
  log('║     CRYPTODEX CRYPTO EXCHANGE - SYSTEM SMOKE TEST        ║', colors.magenta);
  log('╚════════════════════════════════════════════════════════════╝', colors.magenta);

  const startTime = Date.now();

  try {
    // Health checks
    await checkServiceHealth();
    await sleep(500);

    // Authentication flow
    await testRegistration();
    await sleep(500);
    await testLogin();
    await sleep(500);
    await testUserProfile();
    await sleep(500);

    // Wallet operations
    await testWalletOperations();
    await sleep(500);

    // Trading operations
    await testSpotTrading();
    await sleep(500);

    // Market data
    await testMarketData();

  } catch (error) {
    log('\nUnexpected error during smoke test:', colors.red);
    log(error.message, colors.red);
  }

  // Print summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const totalTests = results.passed + results.failed;
  const passRate = ((results.passed / totalTests) * 100).toFixed(1);

  log('\n' + '─'.repeat(60), colors.blue);
  log('SMOKE TEST SUMMARY', colors.blue);
  log('─'.repeat(60), colors.blue);
  log(`  Total Tests:  ${totalTests}`, colors.reset);
  log(`  Passed:       ${results.passed}`, colors.green);
  log(`  Failed:       ${results.failed}`, colors.red);
  log(`  Pass Rate:    ${passRate}%`, passRate >= 80 ? colors.green : colors.yellow);
  log(`  Duration:     ${duration}s`, colors.reset);
  log('─'.repeat(60), colors.blue);

  // Exit with appropriate code
  if (results.failed > 0) {
    process.exit(1);
  } else {
    log('\n✓ All smoke tests passed!', colors.green);
    process.exit(0);
  }
}

// Run the smoke test
runSmokeTest().catch(error => {
  log(`\nFatal error: ${error.message}`, colors.red);
  console.error(error);
  process.exit(1);
});
