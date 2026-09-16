/**
 * Service Health Endpoint Tests (AVAILABILITY / PRIVACY)
 *
 * GET /api/health is UNAUTHENTICATED by design - it is what a human or an
 * uptime monitor reaches for when the service feels wrong, and requiring a
 * token would make it useless for the case it exists for (process up, auth
 * broken). That makes two properties load-bearing:
 *
 *   1. It reports process/dependency state and NOTHING derived from a user.
 *   2. It answers on every path, including its own failure.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import {
  buildHealthSnapshot,
  mongoStateLabel,
} from '../../lib/serviceHealth.js';

const base = {
  mongoReadyState: 1,
  redisConnected: true,
  uptimeSeconds: 42,
  mailDeliveryMode: 'log-only',
  mailProviderConfigured: true,
  checkedAt: '2026-01-01T00:00:00.000Z',
};

describe('mongoStateLabel', () => {
  test.each([
    [0, 'disconnected'],
    [1, 'connected'],
    [2, 'connecting'],
    [3, 'disconnecting'],
  ])('maps readyState %i to "%s"', (state, label) => {
    expect(mongoStateLabel(state)).toBe(label);
  });

  test('an unrecognised readyState is reported as unknown, not as connected', () => {
    expect(mongoStateLabel(99)).toBe('unknown');
    expect(mongoStateLabel(undefined)).toBe('unknown');
  });
});

describe('buildHealthSnapshot severity model', () => {
  test('all dependencies up reports ok with 200', () => {
    const { httpCode, body } = buildHealthSnapshot(base);
    expect(httpCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual({ mongo: 'connected', redis: 'connected' });
  });

  test('mongo down is a HARD failure: 503 unhealthy', () => {
    // Every route in this service queries mongo, so the process is up but
    // cannot serve. An orchestrator should act on this.
    const { httpCode, body } = buildHealthSnapshot({
      ...base,
      mongoReadyState: 0,
    });
    expect(httpCode).toBe(503);
    expect(body.status).toBe('unhealthy');
  });

  test('a connecting mongo is not treated as healthy', () => {
    const { httpCode, body } = buildHealthSnapshot({
      ...base,
      mongoReadyState: 2,
    });
    expect(httpCode).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.dependencies.mongo).toBe('connecting');
  });

  test('redis down is a SOFT failure: degraded but still 200', () => {
    // Redis backs caches; auth still works. Killing the process would be worse
    // than serving degraded.
    const { httpCode, body } = buildHealthSnapshot({
      ...base,
      redisConnected: false,
    });
    expect(httpCode).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.dependencies.redis).toBe('disconnected');
  });

  test('mongo down outranks redis being up', () => {
    const { httpCode, body } = buildHealthSnapshot({
      ...base,
      mongoReadyState: 0,
      redisConnected: true,
    });
    expect(httpCode).toBe(503);
    expect(body.status).toBe('unhealthy');
  });
});

describe('health snapshot privacy contract (SECURITY)', () => {
  test('exposes only a fixed set of service-state fields', () => {
    const { body } = buildHealthSnapshot(base);
    expect(Object.keys(body).sort()).toEqual(
      ['checkedAt', 'dependencies', 'email', 'service', 'status', 'uptimeSeconds'].sort()
    );
    expect(Object.keys(body.dependencies).sort()).toEqual(['mongo', 'redis']);
    expect(Object.keys(body.email).sort()).toEqual(
      ['configured', 'deliveryMode', 'provider'].sort()
    );
  });

  test('reports whether mail is configured as a boolean, never the key itself', () => {
    const { body } = buildHealthSnapshot({
      ...base,
      mailProviderConfigured: 're_a_real_looking_secret',
    });
    expect(body.email.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain('re_a_real_looking_secret');
  });

  test('an unconfigured provider is reported as false', () => {
    const { body } = buildHealthSnapshot({
      ...base,
      mailProviderConfigured: '',
    });
    expect(body.email.configured).toBe(false);
  });

  test('the serviceHealth module never touches a model or the request', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/serviceHealth.js'),
      'utf8'
    );
    expect(src).not.toMatch(/require\(|from ["'].*models/);
    expect(src).not.toMatch(/\breq\b/);
    expect(src).not.toMatch(/findOne|find\(|countDocuments|aggregate/);
  });

  test('the health controller reads no collection and echoes no request field', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'controllers/health.controller.js'),
      'utf8'
    );
    expect(src).not.toMatch(/findOne|countDocuments|aggregate|\.find\(/);
    expect(src).not.toMatch(/req\.(body|query|params|headers)/);
  });
});

describe('health endpoint wiring', () => {
  const routeSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'routes/health.route.js'),
    'utf8'
  );
  const serverSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'server.js'),
    'utf8'
  );

  test('the route is unauthenticated', () => {
    expect(routeSrc).not.toMatch(/passport/);
    expect(routeSrc).toMatch(/router\.route\("\/"\)\.get\(healthCtrl\.healthCheck\)/);
  });

  test('it is mounted at /api/health', () => {
    expect(serverSrc).toMatch(/app\.use\('\/api\/health', healthAPI\)/);
  });

  test('it is mounted before the authenticated routers', () => {
    const healthAt = serverSrc.indexOf("app.use('/api/health'");
    const userAt = serverSrc.indexOf("app.use('/api/user'");
    expect(healthAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(-1);
    expect(healthAt).toBeLessThan(userAt);
  });

  test('the handler responds on its own failure path too', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'controllers/health.controller.js'),
      'utf8'
    );
    const catchBody = src.slice(src.lastIndexOf('} catch'));
    expect(catchBody).toMatch(/return res\.status\(503\)/);
  });
});
