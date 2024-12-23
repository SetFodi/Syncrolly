// yjs-server.js

const http = require('http');
const WebSocket = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils.js');
const { LeveldbPersistence } = require('y-leveldb');
const dotenv = require('dotenv');
const url = require('url');
const Y = require('yjs');
const path = require('path');
const fs = require('fs');

dotenv.config();

// Define the port for the Yjs WebSocket server
const PORT = process.env.YJS_PORT || 1234;

// Define the persistence directory
const persistenceDir = path.join(__dirname, 'yjs-docs');

// Create the directory if it doesn't exist
if (!fs.existsSync(persistenceDir)) {
  fs.mkdirSync(persistenceDir);
}

// Initialize LevelDB Persistence
const persistence = new LeveldbPersistence(persistenceDir); // Ensure this directory exists and is writable

// Create an HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Yjs WebSocket Server');
});

// Initialize the WebSocket server instance
const wss = new WebSocket.Server({ server });

// Object to track active rooms and their client counts (optional)
const roomData = {};

// Function to broadcast room data to all connected clients (optional)
function broadcastRoomData() {
  const activeRooms = Object.entries(roomData).map(([roomName, clients]) => ({
    roomName: roomName || 'Unnamed Room',
    clients,
  }));
  const message = JSON.stringify({ type: 'room_data', data: activeRooms });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });

  console.log('Active Rooms:', activeRooms);
}

// Handle WebSocket connections
wss.on('connection', (conn, req) => {
  const parsedUrl = url.parse(req.url, true);
  const roomName = parsedUrl.pathname.slice(1).split('?')[0] || 'Unnamed Room';
  console.log(`Yjs Client connected to room: ${roomName}`);

  // Initialize room data if not present (optional)
  if (!roomData[roomName]) {
    roomData[roomName] = 0;
  }
  roomData[roomName]++;

  // Broadcast updated room data (optional)
  broadcastRoomData();

  // Keep connection alive with pings
  const keepAliveInterval = setInterval(() => {
    if (conn.readyState === WebSocket.OPEN) {
      conn.ping();
    } else {
      clearInterval(keepAliveInterval);
    }
  }, 25000); // Ping every 25 seconds

  conn.on('pong', () => {
    console.log(`Pong received from client in room: ${roomName}`);
  });

  // Handle disconnection
  conn.on('close', () => {
    console.log(`Client disconnected from room: ${roomName}`);
    if (roomData[roomName]) {
      roomData[roomName]--;
      if (roomData[roomName] <= 0) {
        delete roomData[roomName];
      }
    }

    // Broadcast updated room data (optional)
    broadcastRoomData();
    clearInterval(keepAliveInterval);
  });

  // Setup Yjs WebSocket connection with LevelDB Persistence
  setupWSConnection(conn, req, {
    docName: roomName,
    persistence,
    gc: true, // garbage collect
  });

  // After setupWSConnection, get the Yjs document and attach an observer (optional)
  persistence.getYDoc(roomName).then((ydoc) => {
    ydoc.on('update', (update, origin) => {
      console.log(`Document for room ${roomName} updated`);
      // Implement any additional logic if needed
    });
  }).catch(err => {
    console.error(`Error getting YDoc for room ${roomName}:`, err);
  });
});

// Start the Yjs WebSocket server
server.listen(PORT, () => {
  console.log(`Yjs WebSocket server running on ws://localhost:${PORT}`);
});
