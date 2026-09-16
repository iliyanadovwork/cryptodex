#!/bin/bash

# Cryptodex Crypto Exchange - Startup Script
# This script starts all backend APIs and frontend services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# THE REPOSITORY ROOT, FOUND RATHER THAN ASSUMED.
#
# This line used to read
#
#     PROJECT_DIR="/Users/illy/Cryptodex/code/CRYPTODEXFINAL"
#
# which is one developer's home directory. On any other machine - or the same
# machine with the repo checked out anywhere else - every path built from it was
# wrong, so the script started nothing, warned that Redis was persisting to the
# wrong directory, and failed with `cd: no such file or directory`. A clone
# could not be started by the one command the documentation gave for starting
# it.
#
# `${BASH_SOURCE[0]}` is this file, whatever it was invoked as; `cd -P` resolves
# it through symlinks. So the script works from any cwd, under any checkout
# path, on any machine:  ./start-all.sh  |  bash /path/to/start-all.sh  |
# ~/somewhere/start-all.sh
#
# Override PROJECT_DIR in the environment only if you know why you are doing it.
PROJECT_DIR="${PROJECT_DIR:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

if [ ! -d "$PROJECT_DIR/cryptodex-spotapi" ]; then
    echo "start-all.sh: '$PROJECT_DIR' does not look like the Cryptodex repository root"
    echo "  (expected to find cryptodex-spotapi/ inside it)"
    exit 1
fi

# --- Log rotation -----------------------------------------------------------
# Service logs are piped through ops/logcap.pl, which caps each log at
# LOG_MAX_BYTES and keeps LOG_KEEP rotated generations. Without this the logs
# grow without bound (spot-api ~9 MB/hr => ~215 MB/day).
# Disk use is now bounded at LOG_MAX_BYTES * (LOG_KEEP + 1) per service.
# Override via environment, e.g. LOG_MAX_BYTES=$((64*1024*1024)) ./start-all.sh
# Set CRYPTODEX_LOG_ROTATE=0 to fall back to plain unrotated redirects.
LOGCAP="$PROJECT_DIR/ops/logcap.pl"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-25165824}"     # 24 MiB
LOG_KEEP="${LOG_KEEP:-2}"                      # => 72 MiB ceiling per service
CRYPTODEX_LOG_ROTATE="${CRYPTODEX_LOG_ROTATE:-1}"

if [ "$CRYPTODEX_LOG_ROTATE" = "1" ] && [ ! -x "$LOGCAP" ]; then
    echo -e "${YELLOW}Warning: $LOGCAP missing/not executable - logs will NOT be rotated${NC}"
    CRYPTODEX_LOG_ROTATE=0
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Cryptodex Exchange - Starting All${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

BOOT_START=$(date +%s)

# Function to check if a service is LISTENING on a port.
# NOTE: must filter on -sTCP:LISTEN. A bare `lsof -ti:PORT` also matches
# *client* sockets connected to that port - e.g. the user's browser tabs open
# on localhost:3000 - and killing those pids would kill the browser.
is_running() {
    [ -n "$(lsof -ti:"$1" -sTCP:LISTEN 2>/dev/null)" ]
}

# Function to kill only the process LISTENING on a port (never clients).
kill_port() {
    local port=$1
    local pids
    pids=$(lsof -ti:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo -e "${YELLOW}Killing listener on port $port (pids: $(echo $pids | tr '\n' ' '))...${NC}"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
}

# Wait until a port has a listener, or time out. Returns 1 on timeout.
wait_for_port() {
    local port=$1 timeout=${2:-60} waited=0
    while [ $waited -lt $timeout ]; do
        if is_running "$port"; then return 0; fi
        sleep 1
        waited=$((waited + 1))
    done
    return 1
}

# Launch one service, optionally through the rotating log sink.
# Usage: start_service <label> <dir> <logfile> [npm_command]
# npm_command defaults to "start"; the frontend needs "run dev" (its `start`
# script is `next start`, which serves a production build and has no HMR).
start_service() {
    local label=$1 dir=$2 log=$3
    local cmd=${4:-start}
    cd "$dir"
    if [ "$CRYPTODEX_LOG_ROTATE" = "1" ]; then
        # The pipeline runs inside its own shell so npm's stdout+stderr flow
        # into logcap.pl, which owns (and rotates) the file. When npm exits,
        # logcap sees EOF and exits too - no orphaned sink processes.
        nohup /bin/sh -c "npm $cmd 2>&1 | '$LOGCAP' --rotate-on-start '$log' $LOG_MAX_BYTES $LOG_KEEP" \
            > /dev/null 2>&1 &
    else
        nohup npm $cmd > "$log" 2>&1 &
    fi
    echo "  PID: $!"
}

# 1. Check/Start MongoDB
echo -e "${BLUE}[1/7] Checking MongoDB...${NC}"
if pgrep -x mongod > /dev/null; then
    echo -e "${GREEN}MongoDB is already running${NC}"
else
    echo -e "${YELLOW}Starting MongoDB...${NC}"
    # NOTE: the manual fallback must point at the real data directory.
    brew services start mongodb-community > /dev/null 2>&1 \
        || mongod --fork --logpath /tmp/mongodb.log --dbpath "$PROJECT_DIR/mongodb-data-27017/" 2>/dev/null \
        || true
fi

# Block until Mongo actually answers. Starting the APIs before Mongo is ready
# is a real boot race: they connect on startup and hydrate caches immediately.
echo -e "${YELLOW}Waiting for MongoDB to accept connections...${NC}"
mongo_ready=0
for i in $(seq 1 60); do
    if mongosh --quiet --eval 'db.runCommand({ping:1}).ok' > /dev/null 2>&1; then
        mongo_ready=1; break
    fi
    sleep 1
done
if [ $mongo_ready -eq 1 ]; then
    echo -e "${GREEN}MongoDB is ready${NC}"
else
    echo -e "${RED}MongoDB did NOT become ready - aborting so we do not boot a broken stack${NC}"
    exit 1
fi
echo ""

# 2. Check/Start Redis
echo -e "${BLUE}[2/7] Checking Redis...${NC}"
if redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}Redis is already running${NC}"
else
    echo -e "${YELLOW}Starting Redis...${NC}"
    # IMPORTANT: Redis must be started from the repo root. Its persistence dir
    # is relative to its working directory, and the user's saved dataset lives
    # at $PROJECT_DIR/dump.rdb. Starting it from anywhere else silently boots
    # an EMPTY Redis and looks like total data loss.
    cd "$PROJECT_DIR"
    brew services start redis > /dev/null 2>&1 \
        || (cd "$PROJECT_DIR" && redis-server --dir "$PROJECT_DIR" --daemonize yes 2>/dev/null) \
        || true
fi

echo -e "${YELLOW}Waiting for Redis to accept connections...${NC}"
redis_ready=0
for i in $(seq 1 60); do
    if redis-cli ping > /dev/null 2>&1; then redis_ready=1; break; fi
    sleep 1
done
if [ $redis_ready -eq 1 ]; then
    echo -e "${GREEN}Redis is ready${NC}"
else
    echo -e "${RED}Redis did NOT become ready - aborting so we do not boot a broken stack${NC}"
    exit 1
fi

# Verify Redis is persisting where the saved dataset actually is.
#
# THE CONDITION IS NOW "IS THERE A SAVED DATASET HERE TO MISS", not a bare
# string compare against the repo root. `dump.rdb` is gitignored, so a fresh
# clone does not have one - and the old unconditional compare greeted every
# first-time run with a red WARNING about data that has never existed, on a
# stack that was about to boot perfectly. A first impression of "your data may
# be gone" on a clean checkout is worse than no check at all, and it trains the
# reader to ignore the one warning that matters.
REDIS_DIR=$(redis-cli config get dir 2>/dev/null | tail -1)
if [ -f "$PROJECT_DIR/dump.rdb" ] && [ "$REDIS_DIR" != "$PROJECT_DIR" ]; then
    echo -e "${RED}WARNING: there is a saved dump.rdb at $PROJECT_DIR, but Redis is${NC}"
    echo -e "${RED}         persisting to '$REDIS_DIR'. That dataset is NOT loaded.${NC}"
    echo -e "${RED}         Investigate before trading - the venue will look empty.${NC}"
elif [ -f "$PROJECT_DIR/dump.rdb" ]; then
    echo -e "${GREEN}Redis persistence dir OK ($REDIS_DIR) - repo dump.rdb is the live dataset${NC}"
else
    echo -e "${GREEN}Redis is up (persisting to $REDIS_DIR; no repo-root dump.rdb to load)${NC}"
fi
echo ""

# 3. Clear ports
echo -e "${BLUE}[3/7] Clearing ports...${NC}"
for port in 2567 2568 3002 3000; do
    kill_port $port
done
echo -e "${GREEN}All ports cleared${NC}"
echo ""

# 4. Start Backend APIs
echo -e "${BLUE}[4/7] Starting Backend APIs...${NC}"

echo -e "${YELLOW}Starting User API on port 2567...${NC}"
start_service "User API" "$PROJECT_DIR/cryptodex-userapi" /tmp/user-api.log

echo -e "${YELLOW}Starting Wallet API on port 3002...${NC}"
start_service "Wallet API" "$PROJECT_DIR/cryptodex-walletapi" /tmp/wallet-api.log

echo -e "${YELLOW}Starting Spot API on port 2568...${NC}"
start_service "Spot API" "$PROJECT_DIR/cryptodex-spotapi" /tmp/spot-api.log

echo ""
echo -e "${GREEN}All backend APIs started in background${NC}"
echo ""

# 5. Wait for APIs to be ready (poll instead of a blind sleep)
echo -e "${BLUE}[5/7] Waiting for APIs to initialize...${NC}"
for entry in "User API:2567" "Wallet API:3002" "Spot API:2568"; do
    name="${entry%:*}"; port="${entry##*:}"
    if wait_for_port "$port" 90; then
        echo -e "${GREEN}  ready: $name ($port)${NC}"
    else
        echo -e "${RED}  TIMEOUT: $name ($port) never started listening - check its log${NC}"
    fi
done
echo ""

# 6. Start Frontend
echo -e "${BLUE}[6/7] Starting Frontend...${NC}"
echo -e "${YELLOW}Starting Frontend on port 3000...${NC}"
start_service "Frontend" "$PROJECT_DIR/cryptodex-frontend" /tmp/frontend.log "run dev"
if wait_for_port 3000 120; then
    echo -e "${GREEN}  ready: Frontend (3000)${NC}"
else
    echo -e "${RED}  TIMEOUT: Frontend (3000) never started listening - check /tmp/frontend.log${NC}"
fi
echo ""

# 7. Show status
echo -e "${BLUE}[7/7] Service Status${NC}"
echo -e "${BLUE}========================================${NC}"

check_service() {
    local name=$1
    local port=$2
    if is_running $port; then
        echo -e "${GREEN}✓ [$name] Running on port $port${NC}"
    else
        echo -e "${RED}✗ [$name] Failed to start on port $port${NC}"
    fi
}

check_service "Frontend" 3000
check_service "User API" 2567
check_service "Spot API" 2568
check_service "Wallet API" 3002

echo ""
# The count is not hardcoded: this venue lists one market today and the check
# should not have to be edited to stay true. What matters at boot is that the
# pair cache hydrated AT ALL - an empty spotPairdata means loadPairsToRedis did
# not run or found no pairs, and nothing can trade.
echo -e "${BLUE}Pair cache hydration (expect at least 1):${NC}"
for cache in spotPairdata; do
    n=$(redis-cli hlen "cryptodex_$cache" 2>/dev/null || echo 0)
    if [ "$n" -ge 1 ] 2>/dev/null; then
        echo -e "${GREEN}  ✓ $cache = $n${NC}"
    else
        echo -e "${RED}  ✗ $cache = $n (empty - no pair can trade)${NC}"
    fi
done

BOOT_END=$(date +%s)
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}All services started! (boot took $((BOOT_END - BOOT_START))s)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}Frontend:${NC}     http://localhost:3000"
echo -e "${GREEN}User API:${NC}     http://localhost:2567"
echo -e "${GREEN}Spot API:${NC}     http://localhost:2568"
echo -e "${GREEN}Wallet API:${NC}   http://localhost:3002"
echo ""
echo -e "${YELLOW}Log files:${NC}"
echo -e "  Frontend:   tail -f /tmp/frontend.log"
echo -e "  User API:   tail -f /tmp/user-api.log"
echo -e "  Spot API:   tail -f /tmp/spot-api.log"
echo -e "  Wallet API: tail -f /tmp/wallet-api.log"
if [ "$CRYPTODEX_LOG_ROTATE" = "1" ]; then
    echo ""
    echo -e "${YELLOW}Logs are capped at $((LOG_MAX_BYTES / 1048576)) MiB with $LOG_KEEP rotated generations"
    echo -e "  (previous run retained as <log>.1). Older history: <log>.1, <log>.2 ...${NC}"
fi
echo ""
echo -e "${YELLOW}To stop all services, run: ./stop-all.sh${NC}"
echo ""
