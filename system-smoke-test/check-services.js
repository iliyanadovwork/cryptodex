#!/usr/bin/env node

/**
 * Check if all Cryptodex services are running.
 *
 * WHY THIS FILE KEPT LYING
 * ========================
 * The port table below used to carry the layout of an older checkout: ports
 * nothing listens on any more, and the numbers that DO exist drifted onto the
 * wrong names. So the script reported services as DOWN while they were up and
 * serving, exited 1, and told the operator to start services that were already
 * running. Reporting a healthy venue as broken is the same defect as reporting
 * a broken one as healthy: it teaches the operator to ignore the checker.
 *
 * The live layout, confirmed against the running stack:
 *
 *   Frontend (Next)  3000
 *   User API         2567
 *   Spot API         2568
 *   Wallet API       3002
 *
 * The inventory is services.js; a service that leaves the stack loses its row
 * in the same change.
 *
 * WHY IT NO LONGER GUESSES FROM THE PORT
 * ======================================
 * "Something answered on the port" is not health. A socket that accepts a
 * connection proves only that express bound the port; it says nothing about
 * mongo, redis, the depth feed or whether the matcher is still running - and it
 * cannot tell one service from another, which is exactly how the name/port
 * drift above went unnoticed for so long.
 *
 * ALL THREE BACKEND SERVICES now expose a real health endpoint and this script
 * reads every one of them:
 *   userapi       GET /api/health           -> { status, dependencies }
 *   spotapi       GET /api/spot/health      -> { status, verdict, matcher, depthFeed, ... }
 *   walletapi     GET /api/health           -> { status, dependencies, grpc, standDownGuard }
 * A service that reports "degraded" is listed as degraded, NOT as running, and
 * the reason is printed. Only the Next frontend is still probed for liveness,
 * because it has no health route to ask - and that is labelled as such.
 *
 * THE LIE A ROUND EARLIER: A PORT THAT WAS OPEN ON A DEAD SERVICE
 * ===============================================================
 * walletapi was one of the last backends without a health route, so this script
 * could only ask "is something bound to 3002". It has already been seen to
 * answer YES for a service that had been OOM-killed: the listening socket
 * outlived the process's ability to serve, the checker reported green, and the
 * operator went looking somewhere else.
 *
 * A port cannot answer any of the questions that matter for walletapi:
 *
 *   - ITS MAIN SURFACE IS NOT HTTP. spotapi and userapi read and move every
 *     balance over its gRPC server on 6002. An express process whose gRPC
 *     socket never bound serves /api/wallet perfectly while the whole venue
 *     gets `14 UNAVAILABLE`, and 3002 is wide open the entire time. Its health
 *     payload carries `grpc.bound`.
 *   - IT HAS A GUARD THAT FAILS CLOSED. walletapi refuses every value-moving
 *     route with 503 when it cannot read the stand-down state, so a redis blip
 *     turns the entire money surface off while the port stays open and every
 *     HTTP read keeps answering 200. The payload carries
 *     `standDownGuard.ready` and, when it is false, the `effect` in plain
 *     words - which this script prints.
 *
 * So that liveness probe is gone: `GET /api/currency/getCurrency` returns rows
 * out of mongo and knows nothing about the gRPC server or the guard.
 *
 * AND THE ROUND BEFORE THAT
 * =========================
 * A service that has since been deleted was probed for LIVENESS, against one
 * of its own data routes. That route answered 200 - it returned rows out of
 * redis and knew nothing about the venue's correctness - while the service's
 * own health endpoint was answering
 *
 *   HTTP 503 {"service":"sentinelapi","status":"degraded",
 *             "verdict":"margin_invariant_violated","violationCount":1, ...}
 *
 * So the script printed "7/7 services running" and exited 0 over the top of a
 * margin invariant violation the service was actively shouting about. A
 * checker that disagrees with the services' own health is worse than none,
 * because it is trusted. Liveness is now used ONLY where nothing better
 * exists, and it always says so. The margin-sentinel branches further down
 * (`violationCount`, `acknowledgedCount`, `pendingCount`) are kept: they cost
 * nothing, no surviving service emits those fields, and they are the record of
 * how that failure was caught.
 *
 * Each probe also asserts the SERVICE IDENTITY where it can (the health payload
 * carries `service`, and the liveness probes use a route only that service
 * mounts), so a future port shuffle fails loudly instead of silently marking the
 * wrong box green.
 */

import http from 'http';
// ONE table, in services.js, imported by every script here - see the note at
// the top of that file for the four divergent copies this replaced.
import { SERVICES as SERVICE_TABLE } from './services.js';

const HOST = '127.0.0.1';
const TIMEOUT_MS = 5000;

/**
 * THE HEALTH_ROUTES BRIDGE THAT USED TO SIT HERE IS GONE, AS ITS OWN NOTE SAID
 * IT SHOULD BE.
 *
 * It existed because services.js still marked walletapi and one now-deleted
 * service `kind: 'liveness'` after both had grown a real health route, and it
 * upgraded those two entries in passing. It was explicitly "a bridge for one
 * edit, not a second copy of the table". services.js now names walletapi's
 * health route itself and the other service no longer exists, so the map had
 * one dead entry and one no-op entry - which is how a bridge becomes the fifth
 * divergent copy the table was created to end.
 *
 * The table is used exactly as it is written.
 */
export const SERVICES = SERVICE_TABLE;

/**
 * One HTTP GET with a hard timeout.
 *
 * The old helper had no timeout at all, so a service that accepted the
 * connection and then never answered hung the whole check forever - the one
 * failure mode an operator most wants reported.
 */
function httpGet(port, path) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port, path, timeout: TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          // Health payloads carry the full depth-feed dump; cap what we buffer.
          if (body.length < 64 * 1024) body += chunk;
        });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `no response within ${TIMEOUT_MS}ms` });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

/**
 * States a health payload may report in its `status` field. userapi answers
 * "ok"; spotapi and walletapi answer "healthy". Anything else - "degraded",
 * "unhealthy", "unknown", a missing field - is NOT running. (The services that
 * have since been deleted answered "healthy" too; the set is unchanged by
 * their removal.)
 */
const HEALTHY_STATES = new Set(['ok', 'healthy', 'up', 'pass']);

/**
 * `status` IS THE STATE. `verdict` IS THE REASON.
 * ==============================================
 * This used to read `payload.verdict ?? payload.status`, i.e. it preferred
 * `verdict` and only fell back to `status`. That works for spotapi, whose
 * verdict happens to be the word "ok" - and it was wrong for every other
 * service on the venue at the time. The two examples below are reconciliation
 * services DELETED IN 1f0dc62; they are kept because they are the evidence for
 * the rule, and the rule still binds every payload this script reads:
 *
 *   auditorapi   healthy -> {status:"healthy", verdict:"margin_reconciled"}
 *   sentinelapi          -> {status:"degraded", verdict:"margin_invariant_violated"}
 *   sentinelapi ack'd    -> {status:"healthy", verdict:"margin_invariant_acknowledged"}
 *
 * A verdict is a machine-readable REASON CODE, not a state word, so testing it
 * for membership of a set of state words marks a perfectly healthy service
 * degraded ("margin_reconciled" is not in the set) and would have marked an
 * acknowledged violation degraded as well. `status` is the field every one of
 * these four services uses to say how it is; the verdict is carried into the
 * detail line, where a reason belongs.
 */
export function interpretHealthBody(body, expectedService) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return { state: 'down', detail: 'health endpoint did not return JSON' };
  }
  if (payload === null || typeof payload !== 'object') {
    return { state: 'down', detail: 'health endpoint did not return an object' };
  }

  // IDENTITY CHECK, BEFORE THE VERDICT. This is the assertion the old
  // port-only check could not make, and its absence is precisely how "Spot
  // API" ended up pointed at the wallet service. It runs first because a
  // "healthy" from the wrong process is not evidence about the right one.
  if (
    expectedService &&
    payload.service &&
    payload.service !== expectedService
  ) {
    return {
      state: 'down',
      detail: `wrong service on this port: expected ${expectedService}, got ${payload.service}`,
    };
  }

  const reported = String(payload.status ?? '').toLowerCase();
  if (!reported) {
    return { state: 'down', detail: 'health payload carried no status' };
  }

  if (!HEALTHY_STATES.has(reported)) {
    return { state: 'degraded', detail: describeDegradation(payload, reported) };
  }

  return { state: 'up', detail: describeHealthy(payload) };
}

/** `margin_invariant_violated` -> `margin invariant violated` */
const readableVerdict = (verdict) =>
  String(verdict).replace(/_/g, ' ').trim();

/**
 * WHY a service says it is not well, in the words of its own payload. An
 * operator who is told only "degraded" has to go and run the curl themselves,
 * which is the state this whole script exists to remove.
 */
function describeDegradation(payload, reported) {
  const parts = [reported];
  if (payload.verdict) parts.push(readableVerdict(payload.verdict));

  // spotapi
  if (payload.matcher && payload.matcher.running === false) {
    parts.push('matcher not running');
  }
  // The deleted reconciliation sentinels carried the matcher as its own health
  // block rather than a boolean. Nothing emits this shape today; the branch is
  // kept because it costs nothing and a future service may.
  if (
    payload.matcher &&
    payload.matcher.status &&
    !HEALTHY_STATES.has(String(payload.matcher.status).toLowerCase())
  ) {
    parts.push(`matcher ${payload.matcher.status}`);
  }
  if (payload.dependencies) {
    for (const [dep, value] of Object.entries(payload.dependencies)) {
      if (value !== 'connected' && value !== 'ok') parts.push(`${dep}: ${value}`);
    }
  }
  // walletapi: the socket the REST of the venue talks to. A
  // process serving HTTP with an unbound gRPC server is the failure the old
  // port probe could not see at all, so it is named first among equals.
  if (payload.grpc && payload.grpc.bound === false) {
    parts.push(
      `gRPC server NOT BOUND${payload.grpc.address ? ` (${payload.grpc.address})` : ''}` +
        `${payload.grpc.error ? `: ${payload.grpc.error}` : ''}`
    );
  }
  // A guard that fails closed turns a dependency blip into a total refusal of
  // the money surface. The service states the consequence; print it verbatim
  // rather than making the operator remember which guard does what.
  if (payload.standDownGuard && payload.standDownGuard.ready === false) {
    const g = payload.standDownGuard;
    const sources = ['walletLookup', 'sharedMark', 'walletAuthority']
      .filter((k) => g[k] !== undefined && g[k] !== 'ok')
      .map((k) => `${k} ${g[k]}`);
    parts.push(
      `stand-down guard FAILING CLOSED${sources.length ? ` (${sources.join(', ')})` : ''}` +
        `${g.effect ? ` - ${g.effect}` : ''}`
    );
  }
  if (payload.depthFeed?.summary && !payload.depthFeed.summary.allConnected) {
    const s = payload.depthFeed.summary;
    parts.push(`depth feed ${s.connected}/${s.total} connected`);
  }
  // The margin sentinels. Naming the account and the drift is the difference
  // between a red light and something a human can act on.
  if (payload.violationCount > 0) {
    parts.push(
      `${payload.violationCount} margin violation${
        payload.violationCount === 1 ? '' : 's'
      }`
    );
    const first = Array.isArray(payload.violations) ? payload.violations[0] : null;
    if (first) {
      parts.push(
        `e.g. user ${first.userId} coin ${first.coinId} drift ${first.drift}`
      );
    }
  }
  if (payload.error) parts.push(String(payload.error));
  if (payload.reason) parts.push(String(payload.reason));
  if (payload.remedy) parts.push(String(payload.remedy));
  return parts.join('; ');
}

function describeHealthy(payload) {
  const parts = [];
  if (payload.matcher) {
    // spotapi reports a boolean; another service may report a block.
    if (typeof payload.matcher.running === 'boolean') {
      parts.push(`matcher ${payload.matcher.running ? 'running' : 'idle'}`);
    } else if (payload.matcher.status) {
      parts.push(`matcher ${payload.matcher.status}`);
    }
  }
  if (payload.depthFeed?.summary) {
    const s = payload.depthFeed.summary;
    parts.push(`depth ${s.connected}/${s.total}`);
  }
  if (payload.dependencies) {
    parts.push(
      Object.entries(payload.dependencies)
        .map(([dep, value]) => `${dep} ${value}`)
        .join(', ')
    );
  }
  // Say the gRPC server is up when it is up. Half the point of reading these
  // two payloads is that the socket the venue actually trades over is now
  // something an operator can SEE, not only something they hear about when it
  // breaks.
  if (payload.grpc && payload.grpc.bound === true) {
    parts.push(`grpc bound${payload.grpc.port ? ` :${payload.grpc.port}` : ''}`);
  }
  if (payload.standDownGuard && payload.standDownGuard.ready === true) {
    parts.push('stand-down guard ready');
  }
  if (typeof payload.accountsScanned === 'number') {
    parts.push(`${payload.accountsScanned} accounts reconciled`);
  }
  // GREEN, BUT NEVER SILENT. An acknowledged margin violation answers 200 on
  // purpose; it is still a real violation and it is still on the line.
  if (payload.acknowledgedCount > 0) {
    parts.push(
      `${payload.acknowledgedCount} ACKNOWLEDGED margin violation${
        payload.acknowledgedCount === 1 ? '' : 's'
      }`
    );
  }
  if (payload.pendingCount > 0) {
    parts.push(`${payload.pendingCount} drift(s) inside the grace window`);
  }
  if (typeof payload.uptimeSeconds === 'number') {
    parts.push(`up ${Math.round(payload.uptimeSeconds)}s`);
  } else if (typeof payload.uptimeSec === 'number') {
    parts.push(`up ${Math.round(payload.uptimeSec)}s`);
  }
  return parts.join(' | ') || 'healthy';
}

export async function checkService(service) {
  const res = await httpGet(service.port, service.probe.path);
  if (!res.ok) {
    return { ...service, state: 'down', detail: res.error };
  }

  if (service.probe.kind === 'health') {
    if (res.status !== 200) {
      // A health route that answers non-200 is answering "not healthy"; both
      // implementations use 503 for that.
      const parsed = interpretHealthBody(res.body, service.probe.service);
      return {
        ...service,
        state: parsed.state === 'up' ? 'degraded' : parsed.state,
        detail: `HTTP ${res.status}${parsed.detail ? ` - ${parsed.detail}` : ''}`,
      };
    }
    const parsed = interpretHealthBody(res.body, service.probe.service);
    return { ...service, ...parsed };
  }

  // LIVENESS. 2xx means the route exists on this port, i.e. the expected
  // service is the one listening. A 404 means SOMETHING is bound to the port
  // but it is not the service this table claims - the exact failure the old
  // port-only probe reported as success.
  if (res.status >= 200 && res.status < 300) {
    return {
      ...service,
      state: 'up',
      detail: `liveness only (no health route) - HTTP ${res.status}`,
    };
  }
  if (res.status === 404) {
    return {
      ...service,
      state: 'down',
      detail: `port ${service.port} is bound, but ${service.probe.path} is not mounted there`,
    };
  }
  return { ...service, state: 'down', detail: `HTTP ${res.status}` };
}

async function main() {
  console.log('Checking Cryptodex services...\n');

  const results = [];
  for (const service of SERVICES) {
    results.push(await checkService(service));
  }

  const running = results.filter((r) => r.state === 'up');
  const degraded = results.filter((r) => r.state === 'degraded');
  const stopped = results.filter((r) => r.state === 'down');

  console.log('Running services:');
  if (running.length === 0) {
    console.log('  None');
  } else {
    running.forEach((s) =>
      console.log(`  ✓ ${s.name} (port ${s.port}) - ${s.detail}`)
    );
  }

  if (degraded.length > 0) {
    console.log('\nDegraded services (listening, but reporting a problem):');
    degraded.forEach((s) =>
      console.log(`  ! ${s.name} (port ${s.port}) - ${s.detail}`)
    );
  }

  if (stopped.length > 0) {
    console.log('\nStopped services:');
    stopped.forEach((s) =>
      console.log(`  ✗ ${s.name} (port ${s.port}) - ${s.detail}`)
    );
  }

  const healthChecked = results.filter((r) => r.probe.kind === 'health');
  const livenessOnly = results.filter((r) => r.probe.kind === 'liveness');

  console.log(`\n${running.length}/${SERVICES.length} services running`);
  // BE PRECISE ABOUT THE EVIDENCE. "7/7 running" is what this script printed
  // over the top of a service that was shouting 503, so every line that claims
  // a service is well now also says how well that was established.
  console.log(
    `${healthChecked.length} checked against their own health endpoint` +
      (livenessOnly.length
        ? `, ${livenessOnly.length} by liveness only ` +
          `(${livenessOnly.map((s) => s.name).join(', ')} - no health route to ask)`
        : ' - nothing was judged by a port being open')
  );

  // A DEGRADED SERVICE IS NOT A STOPPED SERVICE, and telling the operator to
  // start a stack that is already up is how this script wasted their time
  // before. Say what is actually wrong.
  if (degraded.length > 0) {
    console.log(
      `\n✗ ${degraded.length} service(s) report themselves DEGRADED. They are ` +
        'running; they are not well. Read the reason above before trading ' +
        'against them.'
    );
    if (stopped.length > 0) {
      console.log('\nTo start the stopped services:');
      console.log('  npm run start:services');
    }
    process.exit(1);
  }

  if (stopped.length > 0) {
    console.log('\nTo start all services:');
    console.log('  npm run start:services');
    process.exit(1);
  }

  console.log('\n✓ All services running! Run smoke test with:');
  console.log('  npm test');
  process.exit(0);
}

// Only run when invoked directly, so the table and the parsers can be imported
// by a test without the process exiting underneath it.
if (process.argv[1] && process.argv[1].endsWith('check-services.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
