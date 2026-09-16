#!/bin/bash

# Cryptodex Crypto Exchange - Stop Script
# This script stops all backend APIs and frontend services

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Cryptodex Exchange - Stopping All${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Function to kill the process LISTENING on a port.
# NOTE: must filter on -sTCP:LISTEN. A bare `lsof -ti:PORT` also matches
# *client* sockets connected to that port - the user's browser tabs pointed at
# localhost:3000 show up there - and kill -9 on those pids kills the browser.
kill_port() {
    local port=$1
    local name=$2
    local pids
    pids=$(lsof -ti:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo -e "${YELLOW}Stopping $name (port $port, pids: $(echo $pids | tr '\n' ' '))...${NC}"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        echo -e "${GREEN}Stopped $name${NC}"
    else
        echo -e "${YELLOW}$name (port $port) was not running${NC}"
    fi
}

# Kill all services
kill_port 3000 "Frontend"
kill_port 2567 "User API"
kill_port 2568 "Spot API"
kill_port 3002 "Wallet API"

# Also kill any remaining node processes from the project directories.
# These patterns must match the ACTUAL directory names on disk, and are
# anchored to node|npm|sh so they cannot match an editor or unrelated shell.
echo ""
echo -e "${YELLOW}Cleaning up any remaining node processes...${NC}"
for pat in \
    "cryptodex-userapi" \
    "cryptodex-walletapi" \
    "cryptodex-spotapi" \
    "cryptodex-frontend" ; do
    # Restrict to node/npm/sh processes so we never match an editor, a shell
    # that merely mentions the path, or this script's own command line.
    pkill -f "^(/[^ ]*/)?(node|npm|sh|/bin/sh) .*${pat}" 2>/dev/null || true
done

# Stop any orphaned log-rotation sinks (ops/logcap.pl). They normally exit on
# their own when the producer closes the pipe; this is belt-and-braces.
pkill -f "ops/logcap.pl" 2>/dev/null || true

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}All services stopped!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}Note: MongoDB and Redis are intentionally left running.${NC}"
echo -e "${YELLOW}To start services again, run: ./start-all.sh${NC}"
echo ""
