// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const cors = require('cors');
const cron = require('node-cron');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// =====================
// ===== CORS Setup =====
// =====================
const allowedFrontendUrls = (process.env.FRONTEND_URLS || 'http://localhost:3000,https://www.syncrolly.com')
  .split(',')
  .map(url => url.trim());

// Ensure CORS is defined before any routes or middleware
app.use(cors({
  origin: allowedFrontendUrls, // Allow specific frontend URLs
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], // Ensure OPTIONS is included
  allowedHeaders: ['Content-Type', 'Authorization'], // Specify allowed headers
  credentials: true, // Allow credentials if needed
}));

// Preflight handling (applicable for DELETE and POST requests)
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', allowedFrontendUrls.join(',')); // Allow specified origins
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); // Allowed methods
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Allowed headers
  res.header('Access-Control-Allow-Credentials', 'true'); // Allow credentials if needed
  res.sendStatus(200); // Respond OK to preflight
});

// =========================
// ===== Middleware Setup =====
// =========================
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// =========================
// ===== MongoDB Setup =====
// =========================
const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

let roomsCollection;
let uploadsCollection;
let activeUsersCollection;

// Ensure 'uploads' directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Set up file storage using multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const allowedExtensions = [
  '.jpeg', '.jpg', '.png', '.pdf', '.txt', '.html', '.js', '.css', '.zip', '.rar', '.py', '.php', '.7z'
];

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    console.log('File extension:', ext); // Log the file extension for debugging

    if (allowedExtensions.includes(ext)) {
      cb(null, true); // File extension is allowed
    } else {
      cb(new Error('Invalid file type. Only images, PDFs, text files, HTML, JS, CSS, Python, PHP, ZIP, RAR, 7z files are allowed.'));
    }
  },
});

// ============================
// ===== Socket.IO Setup =====
// ============================
const socketUserMap = new Map(); // Map to store socket.id => { userId, roomId }

async function startServer() {
  try {
    // Connect to MongoDB
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db('syncrolly');
    roomsCollection = db.collection('rooms');
    uploadsCollection = db.collection('uploads');
    activeUsersCollection = db.collection('activeUsers'); // Initialize activeUsersCollection

    // Initialize HTTP server
    const server = http.createServer(app);

    // Initialize Socket.IO with Express server
    const io = new Server(server, {
      cors: {
        origin: allowedFrontendUrls,
        methods: ['GET', 'POST'],
      },
    });

    // =======================
    // ===== File Routes =====
    // =======================

    // File Upload Route
    app.post('/upload/:roomId', upload.single('file'), async (req, res) => {
      try {
        const { roomId } = req.params;
        const { userId } = req.body;
        const file = req.file;

        if (!file) {
          return res.status(400).json({ error: 'No file uploaded.' });
        }

        console.log(`File uploaded: ${file.originalname}`);
        const fileUrl = `${process.env.BACKEND_URL || 'http://localhost:4000'}/uploads/${file.filename}`;
        console.log(`File URL: ${fileUrl}`);

        const room = await roomsCollection.findOne({ roomId });
        if (!room) {
          return res.status(404).json({ error: 'Room not found.' });
        }

        const userName = room.users[userId];
        if (!userName) {
          return res.status(400).json({ error: 'Invalid user ID.' });
        }

        // Check if file already exists in the database
        const existingFile = await uploadsCollection.findOne({ roomId, fileUrl });
        if (existingFile) {
          return res.status(400).json({ error: 'This file has already been uploaded.' });
        }

        const newFile = {
          roomId,
          fileName: file.originalname,
          fileUrl,
          uploadedBy: userName,
          uploadedAt: new Date(),
        };

        await uploadsCollection.insertOne(newFile);

        // Emit event to notify the room about the new file
        io.to(roomId).emit('new_file', newFile);

        console.log('New file uploaded:', newFile);
        console.log(`Uploading to: ${fileUrl}`);

        res.status(200).json(newFile);
      } catch (error) {
        console.error('Error in file upload:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
      }
    });

    // File Deletion Route
    app.delete('/delete_file/:roomId/:fileId', async (req, res) => {
      try {
        const { roomId, fileId } = req.params;

        if (!ObjectId.isValid(fileId)) {
          res.setHeader('Access-Control-Allow-Origin', allowedFrontendUrls.join(','));
          return res.status(400).json({ error: 'Invalid file ID format.' });
        }

        const fileToDelete = await uploadsCollection.findOne({ roomId, _id: new ObjectId(fileId) });

        if (!fileToDelete) {
          res.setHeader('Access-Control-Allow-Origin', allowedFrontendUrls.join(','));
          return res.status(404).json({ error: 'File not found.' });
        }

        const deleteResult = await uploadsCollection.deleteOne({ _id: new ObjectId(fileId) });
        const filePath = path.join(uploadsDir, path.basename(fileToDelete.fileUrl));

        fs.unlink(filePath, (err) => {
          if (err) {
            console.error('Failed to delete file from filesystem:', err);
          } else {
            console.log('File deleted from filesystem:', filePath);
          }
        });

        res.setHeader('Access-Control-Allow-Origin', allowedFrontendUrls.join(','));
        res.status(200).json({
          success: true,
          message: 'File deleted successfully',
          deletedCount: deleteResult.deletedCount,
        });
      } catch (error) {
        console.error('Error in file deletion:', error);

        res.setHeader('Access-Control-Allow-Origin', allowedFrontendUrls.join(','));
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
      }
    });

    // ========================
    // ===== Socket.IO Events =====
    // ========================
    io.on('connection', async (socket) => {
      console.log(`User connected: ${socket.id}`);

      // Add the connected user to MongoDB
      await activeUsersCollection.insertOne({ socketId: socket.id, connectedAt: new Date() });

      // Emit the total connected users count to all clients
      const totalConnectedUsers = await activeUsersCollection.countDocuments();
      io.emit('status_update', { totalConnectedUsers });

      // Handle room joining
      socket.on('join_room', async ({ roomId, userName, userId, isCreator }, callback) => {
        try {
          let room = await roomsCollection.findOne({ roomId });

          if (!room) {
            if (isCreator) {
              room = {
                roomId,
                text: '',
                messages: [],
                users: {}, // User list stored here
                theme: 'light',
                lastActivity: new Date(),
                creatorId: userId,
                isEditable: true,
                editorMode: 'code',
              };
              await roomsCollection.insertOne(room);
              console.log(`Room ${roomId} created by ${userName}`);
            } else {
              return callback({ error: 'Room does not exist.' });
            }
          }

          // Add user to the room's user list
          room.users[userId] = userName;
          await roomsCollection.updateOne(
            { roomId },
            { $set: { users: room.users, lastActivity: new Date() } }
          );

          // Map socket.id to userId and roomId
          socketUserMap.set(socket.id, { userId, roomId });

          const files = await uploadsCollection.find({ roomId }).toArray();
          socket.join(roomId);

          // Emit updated user list to all clients
          io.emit('room_users', { roomId, users: room.users });

          // Send the current room details including the user list
          callback({
            success: true,
            messages: room.messages,
            theme: room.theme,
            files,
            users: room.users,
            isCreator: room.creatorId === userId,
            isEditable: room.isEditable,
            editorMode: room.editorMode,
          });

          console.log(`${userName} (${userId}) joined room ${roomId}`);
        } catch (error) {
          console.error('Error in join_room:', error);
          callback({ error: 'Internal Server Error' });
        }
      });

      // Handle toggle_editability
      socket.on('toggle_editability', async ({ roomId, userId }, callback) => {
        try {
          const room = await roomsCollection.findOne({ roomId });
          if (!room) {
            return callback({ error: 'Room not found.' });
          }

          if (room.creatorId !== userId) {
            return callback({ error: 'Only the room creator can toggle the editability.' });
          }

          const newEditableState = !room.isEditable;
          await roomsCollection.updateOne(
            { roomId },
            { $set: { isEditable: newEditableState } }
          );

          io.emit('editable_state_changed', { roomId, isEditable: newEditableState });

          if (callback) {
            callback({ success: true, isEditable: newEditableState });
          }
        } catch (error) {
          console.error('Error in toggle_editability:', error);
          if (callback) {
            callback({ error: 'Internal Server Error' });
          }
        }
      });

      // Handle toggle_editor_mode
      socket.on('toggle_editor_mode', async ({ roomId, userId }, callback) => {
        try {
          const room = await roomsCollection.findOne({ roomId });
          if (!room) {
            return callback({ error: 'Room not found.' });
          }

          if (room.creatorId !== userId) {
            return callback({ error: 'Only the room creator can toggle the editor mode.' });
          }

          const newEditorMode = room.editorMode === 'code' ? 'text' : 'code';
          await roomsCollection.updateOne(
            { roomId },
            { $set: { editorMode: newEditorMode, lastActivity: new Date() } }
          );

          io.emit('editor_mode_changed', { roomId, editorMode: newEditorMode });

          console.log(`Room ${roomId} editor mode changed to ${newEditorMode} by user ${userId}`);

          if (callback) {
            callback({ success: true, editorMode: newEditorMode });
          }
        } catch (error) {
          console.error('Error in toggle_editor_mode:', error);
          if (callback) {
            callback({ error: 'Internal Server Error' });
          }
        }
      });

      // Handle chat messages
      socket.on('send_message', async ({ roomId, userId, message }) => {
        try {
          const room = await roomsCollection.findOne({ roomId });
          if (!room) return;

          const userName = room.users[userId];
          if (!userName) return;

          const fullMessage = { userName, text: message };
          room.messages.push(fullMessage);

          await roomsCollection.updateOne(
            { roomId },
            { $set: { messages: room.messages, lastActivity: new Date() } }
          );

          io.to(roomId).emit('receive_message', fullMessage);
        } catch (error) {
          console.error('Error in send_message:', error);
        }
      });

      // Handle typing indicators
      socket.on('typing_start', ({ roomId, userId, userName }) => {
        socket.to(roomId).emit('user_typing', { userId, userName });
      });

      socket.on('typing_stop', ({ roomId, userId }) => {
        socket.to(roomId).emit('user_stopped_typing', { userId });
      });

      // Handle theme changes
      socket.on('change_theme', async ({ roomId, theme }) => {
        try {
          await roomsCollection.updateOne(
            { roomId },
            { $set: { theme, lastActivity: new Date() } }
          );

          io.to(roomId).emit('theme_changed', theme);
        } catch (error) {
          console.error('Error in change_theme:', error);
        }
      });

      // When a user disconnects
      socket.on('disconnect', async () => {
        console.log(`User disconnected: ${socket.id}`);

        // Remove the user from MongoDB
        await activeUsersCollection.deleteOne({ socketId: socket.id });

        // Get user info from socketUserMap
        const userInfo = socketUserMap.get(socket.id);
        if (userInfo) {
          const { roomId, userId } = userInfo;

          // Remove user from the room's user list
          const room = await roomsCollection.findOne({ roomId });
          if (room && room.users[userId]) {
            delete room.users[userId];
            await roomsCollection.updateOne(
              { roomId },
              { $set: { users: room.users, lastActivity: new Date() } }
            );

            // Emit updated user list to all clients
            io.emit('room_users', { roomId, users: room.users });
          }

          // Remove from socketUserMap
          socketUserMap.delete(socket.id);
        }

        // Emit the updated user count
        const totalConnectedUsers = await activeUsersCollection.countDocuments();
        io.emit('status_update', { totalConnectedUsers });
      });
    });

    // ================================
    // ===== Scheduled Cleanup Task =====
    // ================================
    cron.schedule('0 * * * *', async () => { // Runs every hour at minute 0
      try {
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - 72 * 60 * 60 * 1000); // 72 hours ago

        console.log(`Running scheduled task to delete inactive rooms. Current time: ${now}`);

        // Find rooms with lastActivity older than 72 hours
        const inactiveRooms = await roomsCollection.find({ lastActivity: { $lt: cutoffTime } }).toArray();

        if (inactiveRooms.length === 0) {
          console.log('No inactive rooms found.');
          return;
        }

        console.log(`Found ${inactiveRooms.length} inactive room(s). Deleting...`);

        for (const room of inactiveRooms) {
          const { roomId } = room;

          // Find all files associated with this room
          const associatedFiles = await uploadsCollection.find({ roomId }).toArray();

          // Delete files from the filesystem
          for (const file of associatedFiles) {
            const filename = path.basename(file.fileUrl);
            const filePath = path.join(uploadsDir, filename);

            fs.unlink(filePath, (err) => {
              if (err) {
                console.error(`Failed to delete file ${filename} from filesystem:`, err);
              } else {
                console.log(`Deleted file ${filename} from filesystem.`);
              }
            });
          }

          // Delete files from the uploads collection
          const deleteFilesResult = await uploadsCollection.deleteMany({ roomId });
          console.log(`Deleted ${deleteFilesResult.deletedCount} file(s) from uploads collection for room ${roomId}.`);

          // Delete the room from the rooms collection
          const deleteRoomResult = await roomsCollection.deleteOne({ roomId });
          if (deleteRoomResult.deletedCount === 1) {
            console.log(`Successfully deleted room ${roomId} from rooms collection.`);
          } else {
            console.warn(`Failed to delete room ${roomId} from rooms collection.`);
          }

          // Notify connected clients that the room has been deleted
          io.to(roomId).emit('room_deleted', { message: 'This room has been deleted due to inactivity.' });
        }

      } catch (error) {
        console.error('Error during scheduled room deletion:', error);
      }
    });

    // ======================
    // ===== Start Server =====
    // ======================
    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

startServer(); // Start the backend Express server
