// ============================================================
// JorgeChat Server v2 — jorgepompacarrera.net
// Now with persistent accounts, display names, and no
// message history sent on join (you only see what happens
// after you load the page).
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');
const bcrypt = require('bcryptjs'); // for hashing passwords securely

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e8,
});

// ============================================================
// PERSISTENT ACCOUNT STORAGE
// ============================================================
// Accounts are saved to a JSON file on disk so they survive
// server restarts. Each account has:
//   username: unique login name (lowercase for comparison)
//   displayName: what shows in chat (can have caps/style)
//   passwordHash: bcrypt hash of their password
//   color: their assigned chat color
//   token: a session token so they stay logged in
//
// On Railway, the filesystem persists between deploys as long
// as you don't wipe the volume. If it does reset, users just
// re-register — no big deal for a meme chat.

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

// Make sure the data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Load existing accounts from disk, or start fresh
let accounts = {};
if (fs.existsSync(ACCOUNTS_FILE)) {
  try {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    console.log(`Loaded ${Object.keys(accounts).length} accounts`);
  } catch (e) {
    console.error('Failed to load accounts, starting fresh:', e.message);
    accounts = {};
  }
}

// Save accounts to disk — called after any account change
function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  } catch (e) {
    console.error('Failed to save accounts:', e.message);
  }
}

// ============================================================
// FILE UPLOAD SETUP
// ============================================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================================
// EXPRESS MIDDLEWARE & ROUTES
// ============================================================
app.use(express.json()); // parse JSON request bodies (for login/register)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const mimeType = mime.lookup(req.file.originalname) || 'application/octet-stream';
  let fileType = 'file';
  if (mimeType.startsWith('image/')) fileType = 'image';
  if (mimeType.startsWith('video/')) fileType = 'video';
  if (mimeType.startsWith('audio/')) fileType = 'audio';

  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    mimeType,
    fileType,
  });
});

// ----------------------------------------------------------
// REGISTER — create a new account
// ----------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, displayName, password } = req.body;

  // Validate input
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'All fields required' });
  }

  // Username rules: 3-24 chars, alphanumeric + underscores only
  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3 || cleanUsername.length > 24) {
    return res.status(400).json({ error: 'Username must be 3-24 characters' });
  }
  if (!/^[a-z0-9_]+$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });
  }

  // Display name: 1-24 chars, anything goes
  const cleanDisplay = displayName.trim().substring(0, 24);
  if (!cleanDisplay) {
    return res.status(400).json({ error: 'Display name required' });
  }

  // Password: at least 3 chars (it's a meme chat, not a bank)
  if (password.length < 3) {
    return res.status(400).json({ error: 'Password must be at least 3 characters' });
  }

  // Check if username already exists
  if (accounts[cleanUsername]) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  // Hash the password — bcrypt automatically generates a salt
  // The "10" is the cost factor (how many rounds of hashing).
  // Higher = slower but more secure. 10 is fine for this.
  const passwordHash = await bcrypt.hash(password, 10);

  // Generate a session token — a random string the client stores
  // in localStorage to stay logged in without re-entering password
  const token = uuidv4();

  // Pick a color for this user
  const color = USER_COLORS[Object.keys(accounts).length % USER_COLORS.length];

  // Save the account
  accounts[cleanUsername] = {
    username: cleanUsername,
    displayName: cleanDisplay,
    passwordHash,
    color,
    token,
  };
  saveAccounts();

  console.log(`[+] New account: ${cleanUsername} (${cleanDisplay})`);

  res.json({
    username: cleanUsername,
    displayName: cleanDisplay,
    color,
    token,
  });
});

// ----------------------------------------------------------
// LOGIN — authenticate with username + password
// ----------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  const account = accounts[cleanUsername];

  if (!account) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // bcrypt.compare() checks the plaintext password against the
  // stored hash. It handles the salt extraction automatically.
  const valid = await bcrypt.compare(password, account.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Generate a new token on each login for security
  account.token = uuidv4();
  saveAccounts();

  console.log(`[+] Login: ${cleanUsername}`);

  res.json({
    username: account.username,
    displayName: account.displayName,
    color: account.color,
    token: account.token,
  });
});

// ----------------------------------------------------------
// TOKEN AUTH — auto-login with a stored token
// ----------------------------------------------------------
app.post('/api/auth', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(401).json({ error: 'No token' });

  // Find the account with this token
  const account = Object.values(accounts).find(a => a.token === token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });

  res.json({
    username: account.username,
    displayName: account.displayName,
    color: account.color,
    token: account.token,
  });
});

// ----------------------------------------------------------
// UPDATE DISPLAY NAME
// ----------------------------------------------------------
app.post('/api/update-display', (req, res) => {
  const { token, displayName } = req.body;
  if (!token || !displayName) return res.status(400).json({ error: 'Missing fields' });

  const account = Object.values(accounts).find(a => a.token === token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });

  const cleanDisplay = displayName.trim().substring(0, 24);
  if (!cleanDisplay) return res.status(400).json({ error: 'Display name required' });

  account.displayName = cleanDisplay;
  saveAccounts();

  res.json({ displayName: cleanDisplay });
});

// ============================================================
// IN-MEMORY CHAT STATE
// ============================================================
// Messages are NOT persisted — this is intentional.
// When you load the page, you start fresh. No history.

const onlineSockets = new Map();  // socket.id -> { username, displayName, color }
const rooms = new Map();          // roomId -> { name, creator, members: Set, messages: [] }
const dmConversations = new Map();

const USER_COLORS = [
  '#CC0000', '#0000CC', '#009900', '#CC6600', '#9900CC',
  '#006666', '#CC0066', '#336699', '#669933', '#993366',
  '#666600', '#006633', '#330066', '#663300', '#003366',
  '#990000', '#000099', '#009966', '#996600', '#660099',
];

// ============================================================
// HELPERS
// ============================================================
function getDmKey(user1, user2) {
  return [user1, user2].sort().join('::');
}

// Returns online users with their display names
function getOnlineUsers() {
  return Array.from(onlineSockets.values()).map(u => ({
    username: u.username,
    displayName: u.displayName,
  }));
}

// ============================================================
// SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ----------------------------------------------------------
  // JOIN — authenticated user enters chat
  // The client sends their token; we verify it server-side.
  // ----------------------------------------------------------
  socket.on('join', (data) => {
    if (!data || !data.token) return;

    // Find account by token
    const account = Object.values(accounts).find(a => a.token === data.token);
    if (!account) {
      socket.emit('join-error', 'Invalid session. Please log in again.');
      return;
    }

    // Check if this account is already connected from another tab/device
    const alreadyOnline = Array.from(onlineSockets.values()).some(
      u => u.username === account.username
    );
    if (alreadyOnline) {
      socket.emit('join-error', 'You are already connected in another window');
      return;
    }

    // Register this socket
    onlineSockets.set(socket.id, {
      username: account.username,
      displayName: account.displayName,
      color: account.color,
    });

    socket.join('public');

    // Tell the client they're in — NO message history sent.
    // They only see messages that arrive AFTER this point.
    socket.emit('joined', {
      username: account.username,
      displayName: account.displayName,
      color: account.color,
      messages: [], // empty! no history!
      onlineUsers: getOnlineUsers(),
      rooms: Array.from(rooms.entries()).map(([id, r]) => ({
        id, name: r.name, memberCount: r.members.size,
      })),
    });

    socket.broadcast.emit('user-joined', {
      username: account.username,
      displayName: account.displayName,
      color: account.color,
    });
    io.emit('online-users', getOnlineUsers());

    // System message — uses display name so people see who joined
    const sysMsg = {
      id: uuidv4(),
      type: 'system',
      text: `${account.displayName} has entered the chat`,
      timestamp: Date.now(),
    };
    io.to('public').emit('public-message', sysMsg);
  });

  // ----------------------------------------------------------
  // PUBLIC MESSAGES
  // ----------------------------------------------------------
  socket.on('public-message', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;

    const msg = {
      id: uuidv4(),
      type: 'message',
      username: user.username,
      displayName: user.displayName,
      color: user.color,
      text: data.text || '',
      file: data.file || null,
      timestamp: Date.now(),
    };

    // We still broadcast to everyone, just don't store history
    io.to('public').emit('public-message', msg);
  });

  // ----------------------------------------------------------
  // DIRECT MESSAGES
  // ----------------------------------------------------------
  socket.on('dm', (data) => {
    const sender = onlineSockets.get(socket.id);
    if (!sender) return;

    // Find recipient by username (not display name)
    const recipientEntry = Array.from(onlineSockets.entries()).find(
      ([, u]) => u.username === data.to
    );
    if (!recipientEntry) {
      socket.emit('dm-error', 'User not found or offline');
      return;
    }

    const [recipientSocketId, recipient] = recipientEntry;

    const msg = {
      id: uuidv4(),
      type: 'dm',
      from: sender.username,
      fromDisplay: sender.displayName,
      fromColor: sender.color,
      to: recipient.username,
      toDisplay: recipient.displayName,
      text: data.text || '',
      file: data.file || null,
      timestamp: Date.now(),
    };

    // DMs also not persisted — only live delivery
    socket.emit('dm', msg);
    io.to(recipientSocketId).emit('dm', msg);
  });

  // DM history — returns empty since we don't store anymore
  socket.on('dm-history', (targetUsername) => {
    socket.emit('dm-history', {
      with: targetUsername,
      messages: [],
    });
  });

  // ----------------------------------------------------------
  // ROOMS
  // ----------------------------------------------------------
  socket.on('create-room', (roomName) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;

    roomName = roomName.trim().substring(0, 32);
    if (!roomName) return;

    const roomId = uuidv4().substring(0, 8);
    rooms.set(roomId, {
      name: roomName,
      creator: user.username,
      members: new Set([user.username]),
      messages: [],
    });

    socket.join(roomId);
    socket.emit('room-created', { id: roomId, name: roomName });

    io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
      id, name: r.name, memberCount: r.members.size,
    })));
  });

  socket.on('join-room', (roomId) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room-error', 'Room not found');
      return;
    }

    room.members.add(user.username);
    socket.join(roomId);

    // Send empty history — only see new messages
    socket.emit('room-joined', {
      id: roomId,
      name: room.name,
      messages: [],
      members: Array.from(room.members),
    });

    const sysMsg = {
      id: uuidv4(),
      type: 'system',
      text: `${user.displayName} joined the room`,
      timestamp: Date.now(),
    };
    io.to(roomId).emit('room-message', { roomId, message: sysMsg });

    io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
      id, name: r.name, memberCount: r.members.size,
    })));
  });

  socket.on('room-message', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;

    const room = rooms.get(data.roomId);
    if (!room || !room.members.has(user.username)) return;

    const msg = {
      id: uuidv4(),
      type: 'message',
      username: user.username,
      displayName: user.displayName,
      color: user.color,
      text: data.text || '',
      file: data.file || null,
      timestamp: Date.now(),
    };

    io.to(data.roomId).emit('room-message', { roomId: data.roomId, message: msg });
  });

  socket.on('leave-room', (roomId) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.members.delete(user.username);
    socket.leave(roomId);

    if (room.members.size === 0) {
      rooms.delete(roomId);
    } else {
      const sysMsg = {
        id: uuidv4(),
        type: 'system',
        text: `${user.displayName} left the room`,
        timestamp: Date.now(),
      };
      io.to(roomId).emit('room-message', { roomId, message: sysMsg });
    }

    io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
      id, name: r.name, memberCount: r.members.size,
    })));
  });

  // ----------------------------------------------------------
  // TYPING
  // ----------------------------------------------------------
  socket.on('typing', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;

    if (data.room === 'public') {
      socket.broadcast.to('public').emit('typing', { displayName: user.displayName, room: 'public' });
    } else if (data.room) {
      socket.broadcast.to(data.room).emit('typing', { displayName: user.displayName, room: data.room });
    } else if (data.to) {
      const recipientEntry = Array.from(onlineSockets.entries()).find(([, u]) => u.username === data.to);
      if (recipientEntry) {
        io.to(recipientEntry[0]).emit('typing', { displayName: user.displayName, dm: true });
      }
    }
  });

  // ----------------------------------------------------------
  // DISCONNECT
  // ----------------------------------------------------------
  socket.on('disconnect', () => {
    const user = onlineSockets.get(socket.id);
    if (user) {
      console.log(`[-] ${user.displayName} (${user.username}) disconnected`);

      rooms.forEach((room, roomId) => {
        room.members.delete(user.username);
        if (room.members.size === 0) rooms.delete(roomId);
      });

      onlineSockets.delete(socket.id);

      const sysMsg = {
        id: uuidv4(),
        type: 'system',
        text: `${user.displayName} has left the chat`,
        timestamp: Date.now(),
      };
      io.to('public').emit('public-message', sysMsg);
      io.emit('online-users', getOnlineUsers());
      io.emit('rooms-list', Array.from(rooms.entries()).map(([id, r]) => ({
        id, name: r.name, memberCount: r.members.size,
      })));
    }
  });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`JorgeChat v2 running on port ${PORT}`);
});
