/**
 * THE SUPERVISOR - PID 1 for a container that runs four processes.
 * ================================================================
 *
 * Starts userapi, walletapi, spotapi and the gateway, then holds the container
 * alive. It exists to enforce one rule:
 *
 *     IF ANY ONE OF THE FOUR DIES, THE CONTAINER DIES.
 *
 * That is the whole point. A container that keeps answering on :8080 while
 * spotapi is dead is worse than one that is plainly down: the venue would
 * accept logins, show balances, and silently never fill an order. Railway
 * cannot restart what it does not know is broken, so any exit here becomes a
 * non-zero exit of PID 1, which Railway sees and acts on.
 *
 * WHY NOT supervisord / s6-overlay
 *
 * Both are the standard answer and both are the wrong shape here. supervisord's
 * default is to RESTART a dead program and keep the container up - exactly the
 * "limp along silently" failure being avoided - and getting it to do the
 * opposite needs an event listener process and a custom script. s6-overlay adds
 * an init system, a second language (execline) and ~10 MB to an image whose job
 * is to be cheap. Both would also need their own log plumbing to get four
 * streams onto stdout with a service tag. This file is 90 lines of the runtime
 * that is already installed, and does exactly the three things required:
 * fail-fast, tagged stdout, clean signal forwarding.
 *
 * LOGS. Every child's stdout and stderr is read line by line and re-emitted on
 * this process's stdout with a fixed-width `[service]` tag, so `railway logs`
 * shows one interleaved stream that can still be grepped per service. Nothing
 * is written to a file: in a container, stdout IS the log.
 *
 * BOOT ORDER. The three services are started together, not in sequence. They do
 * not need each other to boot - each dials the others' gRPC lazily, and
 * dbConnection retries mongo every second - and staging them would only add
 * dead time to every deploy. The gateway waits until all three are listening,
 * so Railway's healthcheck cannot see a half-built venue and mark the deploy
 * live too early.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

/**
 * In the image everything lives under /app. APP_ROOT and the three *_DIR
 * overrides exist so this file can be run - and its fail-fast behaviour
 * verified - straight out of a checkout, without building an image. A
 * supervisor whose one job is "die correctly" is worth being able to test.
 */
const ROOT = process.env.APP_ROOT || "/app";
const dirOf = (name, fallback) => process.env[`${name.toUpperCase()}_DIR`] || fallback;

/**
 * THREE PROCESSES, ONE VARIABLE SET - the part Railway makes awkward.
 *
 * Railway gives a service ONE environment. These three processes need two
 * things that differ between them:
 *
 *   DATABASE_URI  each service owns its own mongo database
 *                 (<prefix>_user, <prefix>_wallet, <prefix>_spot - the same
 *                 three names ops/reset-and-seed.mjs creates from --db-prefix)
 *   GRPC_URL      each service's OWN gRPC bind address. The other two
 *                 addresses it dials are GRPC_USER_URL / GRPC_WALLET_URL /
 *                 GRPC_SPOT_URL, which are already three separate variables and
 *                 are the same for all three processes.
 *
 * Rather than make the owner paste three near-identical mongo URIs, both are
 * DERIVED here from what Railway already hands over:
 *
 *   MONGO_URL (or MONGO_PUBLIC_URL / DATABASE_URL) + DB_PREFIX  ->  DATABASE_URI
 *   GRPC_{USER,WALLET,SPOT}_URL                                 ->  GRPC_URL
 *
 * An explicit USERAPI_DATABASE_URI / WALLETAPI_DATABASE_URI /
 * SPOTAPI_DATABASE_URI still wins, for the case where the three databases are
 * not on one server or are not named by a common prefix.
 */
const MONGO_BASE =
  process.env.MONGO_URL || process.env.MONGO_PUBLIC_URL || process.env.DATABASE_URL || "";
const DB_PREFIX = process.env.DB_PREFIX || "cryptodex";

/**
 * Put `dbName` into a mongo URI's path without trampling its query string.
 * `mongodb://u:p@host:27017/?retryWrites=true` must become
 * `mongodb://u:p@host:27017/cryptodex_user?retryWrites=true`, not
 * `...:27017/?retryWrites=truecryptodex_user`.
 */
function withDatabase(uri, dbName) {
  if (!uri) return "";
  const hash = uri.indexOf("#");
  const base = hash === -1 ? uri : uri.slice(0, hash);
  const q = base.indexOf("?");
  const beforeQuery = q === -1 ? base : base.slice(0, q);
  const query = q === -1 ? "" : base.slice(q);
  // Strip whatever database (if any) is already in the path, then append ours.
  const schemeEnd = beforeQuery.indexOf("://") + 3;
  const firstSlash = beforeQuery.indexOf("/", schemeEnd);
  const hostPart = firstSlash === -1 ? beforeQuery : beforeQuery.slice(0, firstSlash);
  return `${hostPart}/${dbName}${query}`;
}

function databaseUriFor(name, dbSuffix) {
  const explicit = process.env[`${name.toUpperCase()}_DATABASE_URI`];
  if (explicit) return explicit;
  return withDatabase(MONGO_BASE, `${DB_PREFIX}_${dbSuffix}`);
}

const SERVICES = [
  {
    name: "userapi",
    dir: dirOf("userapi", `${ROOT}/userapi`),
    port: Number(process.env.USERAPI_PORT || 2567),
    databaseUri: databaseUriFor("userapi", "user"),
    grpcUrl: process.env.GRPC_USER_URL || "127.0.0.1:6001",
  },
  {
    name: "walletapi",
    dir: dirOf("walletapi", `${ROOT}/walletapi`),
    port: Number(process.env.WALLETAPI_PORT || 3002),
    databaseUri: databaseUriFor("walletapi", "wallet"),
    grpcUrl: process.env.GRPC_WALLET_URL || "127.0.0.1:6002",
  },
  {
    name: "spotapi",
    dir: dirOf("spotapi", `${ROOT}/spotapi`),
    port: Number(process.env.SPOTAPI_PORT || 2568),
    databaseUri: databaseUriFor("spotapi", "spot"),
    grpcUrl: process.env.GRPC_SPOT_URL || "127.0.0.1:6003",
  },
];

const TAG_WIDTH = 10;
const tag = (name) => `[${name}]`.padEnd(TAG_WIDTH);
const say = (name, line) => process.stdout.write(`${tag(name)} ${line}\n`);

let shuttingDown = false;
const children = [];

/** Re-emit a child stream line by line so tags stay attached to whole lines. */
function pipeTagged(stream, name) {
  let buf = "";
  stream.setEncoding("utf8");
  // A read stream that emits 'error' with no listener throws, which for PID 1
  // is an uncontrolled crash that bypasses the clean killAll/exit path. A
  // stdout/stderr pipe hiccup while a child is being torn down must not take the
  // supervisor down uncleanly - surface it as a log line and carry on.
  stream.on("error", (err) => say(name, `<stream error: ${err && err.message}>`));
  stream.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      say(name, buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    // Guard against a child that never emits a newline.
    if (buf.length > 16384) {
      say(name, buf);
      buf = "";
    }
  });
  stream.on("end", () => {
    if (buf) say(name, buf);
  });
}

function start(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env || {}) },
  });
  const entry = { name, child, alive: true };
  children.push(entry);
  pipeTagged(child.stdout, name);
  pipeTagged(child.stderr, name);

  child.on("exit", (code, signal) => {
    entry.alive = false;
    if (shuttingDown) return;
    say(
      "supervisor",
      `FATAL: ${name} exited (code=${code} signal=${signal}). ` +
        `Taking the container down so this is visible rather than silent.`
    );
    killAll("SIGTERM");
    // Give siblings a moment to flush, then leave with a non-zero status.
    setTimeout(() => process.exit(code === 0 ? 1 : code || 1), 2000);
  });

  child.on("error", (err) => {
    say("supervisor", `FATAL: could not spawn ${name}: ${err.message}`);
    // Signal any siblings already spawned before leaving, mirroring the exit
    // FATAL path above. Without this, a spawn error on (say) the third service
    // orphans the first two - visible on the local-checkout test path the header
    // documents (a bad *_DIR -> ENOENT after earlier services are up).
    killAll("SIGTERM");
    setTimeout(() => process.exit(1), 2000);
  });

  return child;
}

function killAll(signal) {
  shuttingDown = true;
  for (const { child } of children) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Resolves once something is listening on 127.0.0.1:port, or rejects on timeout.
 *
 * The ceiling is kept just under Railway's healthcheckTimeout (railway.json,
 * 300s) rather than at 120s: each service opens its port only AFTER its first
 * mongo connect (dbConnection retries forever), so a cold free-tier Atlas whose
 * first SRV connect lands at ~130s is perfectly healthy - a 120s ceiling would
 * make the supervisor kill the container while Railway was still willing to
 * wait. Keep this, the Dockerfile HEALTHCHECK --start-period, and
 * railway.json's healthcheckTimeout in step.
 */
function waitForPort(port, name, timeoutMs = 280000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`${name} never listened on ${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 500);
        }
      });
    };
    attempt();
  });
}

say("supervisor", `starting ${SERVICES.map((s) => s.name).join(", ")} + gateway`);

// `node server.js` with NODE_ENV=production is EXACTLY what each service's
// `npm run start:prod` script runs. It is spawned directly rather than through
// npm because npm inserts a shell between this process and the service, and
// that shell does not forward SIGTERM - a container stop would then kill npm
// and leave the service running until the runtime SIGKILLed it. If start:prod
// ever changes, change it here too; they are two spellings of one decision.
for (const svc of SERVICES) {
  if (!svc.databaseUri) {
    say(
      "supervisor",
      `FATAL: no database URI for ${svc.name}. Set MONGO_URL (plus DB_PREFIX, ` +
        `default "cryptodex") or ${svc.name.toUpperCase()}_DATABASE_URI.`
    );
    process.exit(1);
  }
  // Log the target WITHOUT credentials - a mongo URI carries a password.
  // Greedy up to the LAST '@' (`[^/]*` not `[^@]*`) so a password that itself
  // contains '@' - legal, if unencoded - is still fully masked rather than
  // leaving everything after its first '@' in the log.
  say("supervisor", `${svc.name} -> db ${svc.databaseUri.replace(/(\/\/)[^/]*@/, "$1***@")}`);
  start(svc.name, "node", ["server.js"], {
    cwd: svc.dir,
    env: {
      NODE_ENV: "production",
      PORT: String(svc.port),
      DATABASE_URI: svc.databaseUri,
      GRPC_URL: svc.grpcUrl,
    },
  });
}

const ready = await Promise.all(
  SERVICES.map((s) =>
    waitForPort(s.port, s.name).then(
      () => {
        say("supervisor", `${s.name} listening on ${s.port}`);
        return true;
      },
      (err) => {
        say("supervisor", `FATAL: ${err.message}`);
        return false;
      }
    )
  )
);

if (!ready.every(Boolean)) {
  killAll("SIGTERM");
  setTimeout(() => process.exit(1), 2000);
} else {
  // Only now is it honest to answer Railway's healthcheck.
  start("gateway", "node", ["deploy/gateway.mjs"], { cwd: ROOT });
  say("supervisor", "all four processes up");
}

/**
 * A container stop is SIGTERM followed by SIGKILL a few seconds later. Leave as
 * soon as the children are actually gone rather than sitting out a fixed timer:
 * a supervisor that always takes 8 seconds to exit turns every redeploy into an
 * 8-second outage, and risks being SIGKILLed mid-flush instead of exiting
 * cleanly. The timer stays as a ceiling for a child that will not go.
 */
const shutdown = (sig) => {
  say("supervisor", `${sig} received - stopping children`);
  killAll(sig);
  const poll = setInterval(() => {
    if (children.every((c) => !c.alive)) {
      clearInterval(poll);
      say("supervisor", "all children stopped - exiting 0");
      process.exit(0);
    }
  }, 200);
  setTimeout(() => {
    clearInterval(poll);
    const stuck = children.filter((c) => c.alive).map((c) => c.name);
    say("supervisor", `exiting after timeout; still running: ${stuck.join(", ") || "none"}`);
    killAll("SIGKILL");
    process.exit(0);
  }, 8000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
