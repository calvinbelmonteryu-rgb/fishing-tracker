#!/bin/bash
# Wait for network to be available
sleep 10

cd "/Users/calvinbelmonte-ryu/Documents/claude code/Fishing Tracker"

# Start server in background, fetch counts, then stop it
node server.js &
SERVER_PID=$!

# Wait for server to be ready
sleep 3

# Fetch counts (this triggers parsing + DB storage)
curl -s http://localhost:3000/api/fishcounts > /dev/null 2>&1

# Stop the server
kill $SERVER_PID 2>/dev/null
