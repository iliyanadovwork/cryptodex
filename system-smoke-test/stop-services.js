#!/usr/bin/env node

/**
 * Stop all running Cryptodex services
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
// The fallback sweep below used to kill a hard-coded port range that included
// ports nothing runs on, while MISSING userapi (2567) and spotapi (2568)
// entirely - so "stop all services" reliably left the two most important ones
// running. One table, in services.js.
import { PORTS as SERVICE_PORTS } from './services.js';

const PID_FILE = join(import.meta.dirname, '.service-pids.json');

function killProcess(pid) {
  return new Promise((resolve) => {
    exec(`kill ${pid}`, (error) => {
      if (error && !error.message.includes('no such process')) {
        // Error occurred but process might not exist
      }
      resolve();
    });
  });
}

async function main() {
  if (!existsSync(PID_FILE)) {
    console.log('No PID file found. Services may not be running.');
    console.log('If services are running, manually kill them using:');
    console.log('  pkill -f "npm start"');
    process.exit(0);
  }

  const pids = JSON.parse(readFileSync(PID_FILE, 'utf8'));

  console.log('Stopping Cryptodex services...\n');

  for (const service of pids) {
    console.log(`Stopping ${service.name} (PID ${service.pid})...`);
    await killProcess(service.pid);
    console.log(`  ✓ Stopped`);
  }

  // Clean up PID file
  const fs = await import('fs');
  fs.unlinkSync(PID_FILE);

  // Also try to kill any remaining node processes for the ports
  for (const port of SERVICE_PORTS) {
    exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, () => {});
  }

  console.log('\n✓ All services stopped');
}

main().catch(console.error);
