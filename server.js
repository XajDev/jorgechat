// ============================================================
// JorgeChat Server — jorgepompacarrera.net
// Express + Socket.IO real-time chat with file uploads
// ============================================================
// Socket.IO automatically tries WebSocket first, then falls
// back to HTTP long-polling if the network blocks WebSockets.
// This means it works even on school/work networks that
// aggressively filter traffic. No config needed from the user.
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');        // middleware for handling file uploads
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid'); // generates unique IDs for files & messages
const mime = require('mime-types');       // detects file types from extensions

const app = express();
const server = http.createServer(app);

// Socket.IO server config — the "transports" array defines the
// priority order. It tries WebSocket first (fast, bidirectional),
// then falls back to polling (works through almost any firewall).
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  // Max payload size for socket messages (not file uploads —
  // those go through the HTTP upload endpoint)
  maxHttpBufferSize: 1e8, // 100MB
});

// ============================================================
// FILE UPLOAD SETUP
// ============================================================
// Multer saves uploaded files to the /uploads folder on disk.
// We rename each file with a UUID to avoid name collisions
// (two people uploading "image.png" won't overwrite each other).

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // UUID prefix ensures uniqueness, original name preserved for display
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max per file
});

// ============================================================
// SERVE STATIC FILES
// ============================================================
// The "public" folder holds our frontend (HTML/CSS/JS).
// Express serves these automatically when someone visits the site.

app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files so the frontend can display/play them
app.use('/uploads', express.static(uploadDir));

// ============================================================
// FILE UPLOAD ENDPOINT
// ============================================================
// POST /upload — accepts a file, saves it, returns metadata
// so the frontend can display a preview in the chat.

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Figure out what kind of file this is for preview purposes
  const mimeType = mime.lookup(req.file.originalname) || 'application/octet-stream';
  let fileType = 'file'; // default: generic download link
  if (mimeType.startsWith('image/'))  fileType = 'image';
  if (mimeType.startsWith('video/'))  fileType = 'video';
  if (mimeType.startsWith('audio/'))  fileType = 'audio';

  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    mimeType,
    fileType,
  });
});

// ============================================================
// IN-MEMORY DATA STORES
// ============================================================
// These hold all our chat state. On a free/cheap server this
// means chat history resets on restart — that's fine for now.
// A database (SQLite, Postgres) would make it persistent later.

const users = new Map();          // socket.id -> { username, color }
const publicMessages = [];        // array of message objects
const rooms = new Map();          // roomId -> { name, creator, members: Set, messages: [] }
const dmConversations = new Map();// "user1::user2" (sorted) -> { messages: [] }

// Predefined colors for usernames — cycles through them
const USER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F0B27A', '#82E0AA', '#F1948A', '#AED6F1', '#D7BDE2',
  '#A3E4D7', '#FAD7A0', '#A9CCE3', '#D5F5E3', '#FADBD8',
];
let colorIndex = 0;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Creates a consistent key for DM conversations between two users.
// By sorting alphabetically, "alice::bob" and "bob::alice" map
// to the same conversation — no duplicates.
function getDmKey(user1, user2) {
  return [user1, user2].sort().join('::');
}

// Returns a list of all connected usernames (for the user list sidebar)
function getOnlineUsers() {
  return Array.from(users.values()).map(u => u.username);
}

// ============================================================
// SOCKET.IO CONNECTION HANDLER
// ============================================================
// This fires every time a new client connects. Each connected
// user gets their own socket object that we attach listeners to.

io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ----------------------------------------------------------
  // JOIN — user picks a username and enters the chat
  // ----------------------------------------------------------
  socket.on('join', (username) => {
    // Clean up the username — strip whitespace, limit length
    username = username.trim().substring(0, 24);
    if (!username) return;

    // Check if this username is already taken by someone online
    const taken = Array.from(users.values()).some(
      u => u.username.toLowerCase() === username.toLowerCase()
    );
    if (taken) {
      socket.emit('join-error', 'That username is already taken');
      return;
    }

    // Assign a color from our palette and cycle the index
    const color = USER_COLORS[colorIndex % USER_COLORS.length];
    colorIndex++;

    // Store this user's info, keyed by their socket ID
    users.set(socket.id, { username, color });

    // Join the "public" room automatically
    socket.join('public');

    // Tell THIS user they're in (sends back their info + history)
    socket.emit('joined', {
      username,
      color,
      // Send the last 100 public messages so they have context
      messages: publicMessages.slice(-100),
      onlineUsers: getOnlineUsers(),
      rooms: Array.from(rooms.entries()).map(([id, r]) => ({
        id, name: r.name, memberCount: r.members.size,
      })),
    });

    // Tell EVERYONE ELSE this user joined
    socket.broadcast.emit('user-joined', { username, color });
    // Update the user list for everyone
    io.emit('online-users', getOnlineUsers());

    // System message in public chat
    const sysMsg = {
      id: uuidv4(),
      type: 'system',
      text: `${username} has entered the chat`,
      timestamp: Date.now(),
    };
    publicMessages.push(sysMsg);
    io.to('public').emit('public-message', sysMsg);
  });

  // ----------------------------------------------------------
  // PUBLIC MESSAGES — sent to the main lobby
  // ----------------------------------------------------------
  socket.on('public-message', (data) => {
    const user = users.get(socket.id);
    if (!user) return; // ignore messages from unregistered sockets

    const msg = {
      id: uuidv4(),
      type: 'message',
      username: user.username,
      color: user.color,
      text: data.text || '',
      file: data.file || null, // file metadata if they attached one
      timestamp: Date.now(),
    };

    publicMessages.push(msg);
    // Cap stored messages at 500 to avoid memory bloat
    if (publicMessages.length > 500) publicMessages.shift();

    // Broadcast to everyone in the public room
    io.to('public').emit('public-message', msg);
  });

  // ----------------------------------------------------------
  // DIRECT MESSAGES — private 1-on-1 conversations
  // ----------------------------------------------------------
  socket.on('dm', (data) => {
    const sender = users.get(socket.id);
    if (!sender) return;

    // Find the recipient's socket by their username
    const recipientEntry = Array.from(users.entries()).find(
      ([, u]) => u.username === data.to
    );
    if (!recipientEntry) {
      socket.emit('dm-error', 'User not found or offline');
      return;
    }

    const [recipientSocketId, recipient] = recipientEntry;
    const dmKey = getDmKey(sender.username, recipient.username);

    // Create the conversation if it doesn't exist yet
    if (!dmConversations.has(dmKey)) {
      dmConversations.set(dmKey, { messages: [] });
    }

    const msg = {
      id: uuidv4(),
      type: 'dm',
      from: sender.username,
      fromColor: sender.color,
      to: recipient.username,
      text: data.text || '',
      file: data.file || null,
      timestamp: Date.now(),
    };

    const convo = dmConversations.get(dmKey);
    convo.messages.push(msg);
    if (convo.messages.length > 200) convo.messages.shift();

    // Send to both sender and recipient
    socket.emit('dm', msg);
    io.to(recipientSocketId).emit('dm', msg);
  });

  // Request DM history with a specific user
  socket.on('dm-history', (targetUsername) => {
    const user = users.get(socket.id);
    if (!user) return;

    const dmKey = getDmKey(user.username, targetUsername);
    const convo = dmConversations.get(dmKey);
    socket.emit('dm-history', {
      with: targetUsername,
      messages: convo ? convo.messages.slice(-100) : [],
    });
  });

  // ----------------------------------------------------------
  // PRIVATE ROOMS — create, join, leave, message
  // ----------------------------------------------------------

  // Create a new room
  socket.on('create-room', (roomName) => {
    const user = users.get(socket.id);
    if (!user) return;

    roomName = roomName.trim().substring(0, 32);
    if (!roomName) return;

    const roomId = uuidv4().substring(0, 8); // short ID for convenience
    rooms.set(roomId, {
      name: roomName,
      creator: user.username,
      members: new Set([user.username]),
      messages: [],
    });

    // Socket.IO "rooms" are separate from our data model rooms,
    // but we use the same ID to keep things simple. socket.join()
    // subscribes this socket to receive broadcasts for that room.
    socket.join(roomId);

    // Tell the creator the room was made
    socket.emit('room-created', { id: roomId, name: roomName });

    // Tell everyone about the new room
    io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
      id, name: r.name, memberCount: r.members.size,
    })));
  });

  // Join an existing room
  socket.on('join-room', (roomId) => {
    const user = users.get(socket.id);
    if (!user) return;

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room-error', 'Room not found');
      return;
    }

    room.members.add(user.username);
    socket.join(roomId);

    // Send room history to the joining user
    socket.emit('room-joined', {
      id: roomId,
      name: room.name,
      messages: room.messages.slice(-100),
      members: Array.from(room.members),
    });

    // Notify room members
    const sysMsg = {
      id: uuidv4(),
      type: 'system',
      text: `${user.username} joined the room`,
      timestamp: Date.now(),
    };
    room.messages.push(sysMsg);
    io.to(roomId).emit('room-message', { roomId, message: sysMsg });

    // Update room list for everyone
    io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
      id, name: r.name, memberCount: r.members.size,
    })));
  });

  // Send a message to a room
  socket.on('room-message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const room = rooms.get(data.roomId);
    if (!room || !room.members.has(user.username)) return;

    const msg = {
      id: uuidv4(),
      type: 'message',
      username: user.username,
      color: user.color,
      text: data.text || '',
      file: data.file || null,
      timestamp: Date.now(),
    };

    room.messages.push(msg);
    if (room.messages.length > 500) room.messages.shift();

    io.to(data.roomId).emit('room-message', { roomId: data.roomId, message: msg });
  });

  // Leave a room
  socket.on('leave-room', (roomId) => {
    const user = users.get(socket.id);
    if (!user) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.members.delete(user.username);
    socket.leave(roomId);

    // If room is empty, delete it
    if (room.members.size === 0) {
      rooms.delete(roomId);
    } else {
      const sysMsg = {
        id: uuidv4(),
        type: 'system',
        text: `${user.username} left the room`,
        timestamp: Date.now(),
      };
      room.messages.push(sysMsg);
      io.to(roomId).emit('room-message', { roomId, message: sysMsg });
    }

    io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
      id, name: r.name, memberCount: r.members.size,
    })));
  });

  // ----------------------------------------------------------
  // TYPING INDICATORS
  // ----------------------------------------------------------
  socket.on('typing', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    if (data.room === 'public') {
      socket.broadcast.to('public').emit('typing', {
        username: user.username, room: 'public'
      });
    } else if (data.room) {
      socket.broadcast.to(data.room).emit('typing', {
        username: user.username, room: data.room
      });
    } else if (data.to) {
      // DM typing indicator — find recipient socket
      const recipientEntry = Array.from(users.entries()).find(
        ([, u]) => u.username === data.to
      );
      if (recipientEntry) {
        io.to(recipientEntry[0]).emit('typing', {
          username: user.username, dm: true
        });
      }
    }
  });

  // ----------------------------------------------------------
  // DISCONNECT — clean up when a user leaves
  // ----------------------------------------------------------
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`[-] ${user.username} disconnected`);

      // Remove from all rooms
      rooms.forEach((room, roomId) => {
        room.members.delete(user.username);
        if (room.members.size === 0) {
          rooms.delete(roomId);
        }
      });

      // Remove from users map
      users.delete(socket.id);

      // Notify everyone
      const sysMsg = {
        id: uuidv4(),
        type: 'system',
        text: `${user.username} has left the chat`,
        timestamp: Date.now(),
      };
      publicMessages.push(sysMsg);
      io.to('public').emit('public-message', sysMsg);
      io.emit('online-users', getOnlineUsers());
      io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
        id, name: r.name, memberCount: r.members.size,
      })));
    }
  });
});

// ============================================================
// START SERVER
// ============================================================
// Railway sets the PORT env variable automatically.
// Locally, defaults to 3000.

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`JorgeChat running on port ${PORT}`);
});
