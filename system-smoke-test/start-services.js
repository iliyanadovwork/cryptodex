#!/usr/bin/env node

/**
 * Start all Cryptodex services in background
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Ports come from the single table in services.js; the copy that used to live
// here claimed 3001..3006 and only the DIRECTORY names were right, so the PID
// file it wrote (and stop-services.js then read) recorded the wrong port for
// every service. The frontend is not started here - it is a Next dev server
// with its own lifecycle - so it is filtered out below.
import { SERVICES as SERVICE_TABLE } from './services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, '..');

const SERVICES = SERVICE_TABLE.filter((s) => s.key !== 'frontend');

const pids = [];

function startService(service) {
  const servicePath = join(BASE_DIR, service.dir);

  if (!existsSync(servicePath)) {
    console.log(`⚠ Skipping ${service.name} - directory not found`);
    return;
  }

  console.log(`Starting ${service.name}...`);

  // Using nodemon for development, with logs going to a file
  const logFile = join(__dirname, 'logs', `${service.name.toLowerCase().replace(' ', '_')}.log`);

  const child = spawn('npm', ['start'], {
    cwd: servicePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: true,
  });

  child.stdout.on('data', (data) => {
    // Optionally write to log file
  });

  child.stderr.on('data', (data) => {
    console.error(`[${service.name}] ${data}`);
  });

  // Store the PID
  pids.push({ name: service.name, pid: child.pid, port: service.port });

  // Don't wait for the child process
  child.unref();

  // Give service time to start
  return new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });
}

async function main() {
  console.log('Starting Cryptodex services...\n');

  for (const service of SERVICES) {
    await startService(service);
  }

  console.log('\n✓ Services started in background');
  console.log('\nService PIDs:');
  pids.forEach(p => console.log(`  ${p.name}: PID ${p.pid} (port ${p.port})`));

  // Save PIDs to file for later stopping
  const fs = await import('fs');
  fs.writeFileSync(
    join(__dirname, '.service-pids.json'),
    JSON.stringify(pids, null, 2)
  );

  console.log('\nWaiting for services to be ready...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('\n✓ Services should be ready now!');
  console.log('Run smoke test with: npm test');
  console.log('Stop services with: npm run stop:services');
}

main().catch(console.error);
