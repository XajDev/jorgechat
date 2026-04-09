// ============================================================
// JorgeChat Server v3 — jorgepompacarrera.net
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e8,
});

// ============================================================
// DATA PERSISTENCE — JSON files in /data
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(filename, fallback) {
  const filepath = path.join(DATA_DIR, filename);
  if (fs.existsSync(filepath)) {
    try { return JSON.parse(fs.readFileSync(filepath, 'utf-8')); }
    catch (e) { console.error('Load fail ' + filename, e.message); }
  }
  return fallback;
}
function saveJSON(filename, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save fail ' + filename, e.message); }
}

// All persistent stores
let accounts = loadJSON('accounts.json', {});
let dmStore = loadJSON('dms.json', {});       // "user1::user2" -> [messages]
let roomStore = loadJSON('rooms.json', {});   // roomId -> {name,creator,private,members:[],messages:[],invited:[]}
let friendStore = loadJSON('friends.json', {}); // username -> [friend usernames]
let friendRequests = loadJSON('friend_requests.json', {}); // username -> [{from,timestamp}]

function saveAccounts() { saveJSON('accounts.json', accounts); }
function saveDMs() { saveJSON('dms.json', dmStore); }
function saveRooms() { saveJSON('rooms.json', roomStore); }
function saveFriends() { saveJSON('friends.json', friendStore); }
function saveFriendRequests() { saveJSON('friend_requests.json', friendRequests); }

function findByToken(token) {
  if (!token) return null;
  const vals = Object.values(accounts);
  for (let i = 0; i < vals.length; i++) {
    if (vals[i].token === token) return vals[i];
  }
  return null;
}

function getDmKey(u1, u2) { return [u1, u2].sort().join('::'); }

const USER_COLORS = [
  '#CC0000','#0000CC','#009900','#CC6600','#9900CC',
  '#006666','#CC0066','#336699','#669933','#993366',
  '#666600','#006633','#330066','#663300','#003366',
  '#990000','#000099','#009966','#996600','#660099',
];

// ============================================================
// FILE UPLOADS
// ============================================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const pfpDir = path.join(uploadDir, 'pfp');
if (!fs.existsSync(pfpDir)) fs.mkdirSync(pfpDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + '-' + file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const pfpStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, pfpDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    // We'll rename after auth check
    cb(null, 'temp_' + uuidv4() + ext);
  },
});
const pfpUpload = multer({
  storage: pfpStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  },
});

// ============================================================
// EXPRESS ROUTES
// ============================================================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// --- File upload ---
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const mimeType = mime.lookup(req.file.originalname) || 'application/octet-stream';
  let fileType = 'file';
  if (mimeType.startsWith('image/')) fileType = 'image';
  if (mimeType.startsWith('video/')) fileType = 'video';
  if (mimeType.startsWith('audio/')) fileType = 'audio';
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    url: '/uploads/' + req.file.filename,
    size: req.file.size, mimeType, fileType,
  });
});

// --- Profile picture upload ---
app.post('/api/upload-pfp', pfpUpload.single('pfp'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const token = req.body.token;
  const account = findByToken(token);
  if (!account) {
    // Delete the temp file
    fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: 'Invalid token' });
  }
  // Remove old pfp if exists
  const oldPfp = account.pfp;
  if (oldPfp) {
    const oldPath = path.join(pfpDir, path.basename(oldPfp));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  // Rename temp file to username-based name
  const ext = path.extname(req.file.originalname) || '.png';
  const newName = account.username + '_' + Date.now() + ext;
  const newPath = path.join(pfpDir, newName);
  fs.renameSync(req.file.path, newPath);

  account.pfp = '/uploads/pfp/' + newName;
  saveAccounts();
  res.json({ pfp: account.pfp });
});

// --- Register ---
app.post('/api/register', async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !password || !displayName) return res.status(400).json({ error: 'All fields required' });

  const clean = username.trim().toLowerCase();
  if (clean.length < 3 || clean.length > 24) return res.status(400).json({ error: 'Username: 3-24 chars' });
  if (!/^[a-z0-9_]+$/.test(clean)) return res.status(400).json({ error: 'Username: letters, numbers, _ only' });

  const cleanDisplay = displayName.trim().substring(0, 24);
  if (!cleanDisplay) return res.status(400).json({ error: 'Display name required' });
  if (password.length < 3) return res.status(400).json({ error: 'Password: 3+ chars' });
  if (accounts[clean]) return res.status(400).json({ error: 'Username taken' });

  const passwordHash = await bcrypt.hash(password, 10);
  const token = uuidv4();
  const color = USER_COLORS[Object.keys(accounts).length % USER_COLORS.length];

  accounts[clean] = {
    username: clean,
    displayName: cleanDisplay,
    passwordHash, color, token,
    bio: '',
    pfp: null,
    tags: [],           // e.g. ['unavailable']
    lastDisplayChange: 0, // timestamp of last display name change
    createdAt: Date.now(),
  };
  friendStore[clean] = [];
  friendRequests[clean] = [];
  saveAccounts(); saveFriends(); saveFriendRequests();

  res.json({ username: clean, displayName: cleanDisplay, color, token });
});

// --- Login ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Both fields required' });
  const clean = username.trim().toLowerCase();
  const account = accounts[clean];
  if (!account) return res.status(401).json({ error: 'Invalid username or password' });
  const valid = await bcrypt.compare(password, account.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
  account.token = uuidv4();
  saveAccounts();
  res.json({
    username: account.username, displayName: account.displayName,
    color: account.color, token: account.token,
    bio: account.bio, pfp: account.pfp, tags: account.tags,
  });
});

// --- Token auth ---
app.post('/api/auth', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  res.json({
    username: account.username, displayName: account.displayName,
    color: account.color, token: account.token,
    bio: account.bio, pfp: account.pfp, tags: account.tags,
  });
});

// --- Update display name (30min cooldown) ---
app.post('/api/update-display', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  const cleanDisplay = (req.body.displayName || '').trim().substring(0, 24);
  if (!cleanDisplay) return res.status(400).json({ error: 'Display name required' });

  // 30 minute cooldown check
  const now = Date.now();
  const cooldown = 30 * 60 * 1000; // 30 minutes in ms
  if (account.lastDisplayChange && (now - account.lastDisplayChange) < cooldown) {
    const remaining = Math.ceil((cooldown - (now - account.lastDisplayChange)) / 60000);
    return res.status(400).json({ error: 'Wait ' + remaining + ' min before changing again' });
  }

  account.displayName = cleanDisplay;
  account.lastDisplayChange = now;
  saveAccounts();

  // Notify all connected sockets about the name change
  io.emit('user-updated', {
    username: account.username,
    displayName: cleanDisplay,
  });

  res.json({ displayName: cleanDisplay });
});

// --- Update bio ---
app.post('/api/update-bio', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  account.bio = (req.body.bio || '').substring(0, 500);
  saveAccounts();
  res.json({ bio: account.bio });
});

// --- Update tags ---
app.post('/api/update-tags', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  // Only allow specific tag values
  const allowed = ['unavailable', 'busy', 'away', 'dnd'];
  const tags = (req.body.tags || []).filter(t => allowed.includes(t));
  account.tags = tags;
  saveAccounts();
  io.emit('user-updated', { username: account.username, tags });
  res.json({ tags });
});

// --- Update name color ---
app.post('/api/update-color', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  const color = (req.body.color || '').trim();
  // Validate it's a hex color
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Invalid color (use #RRGGBB)' });
  account.color = color;
  saveAccounts();
  io.emit('user-updated', { username: account.username, color });
  res.json({ color });
});

// --- Get user profile ---
app.get('/api/profile/:username', (req, res) => {
  const account = accounts[req.params.username];
  if (!account) return res.status(404).json({ error: 'User not found' });
  res.json({
    username: account.username,
    displayName: account.displayName,
    color: account.color,
    bio: account.bio,
    pfp: account.pfp,
    tags: account.tags,
    createdAt: account.createdAt,
  });
});

// --- Friend requests ---
app.post('/api/friend-request', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  const target = (req.body.username || '').trim().toLowerCase();
  if (!accounts[target]) return res.status(404).json({ error: 'User not found' });
  if (target === account.username) return res.status(400).json({ error: 'Cannot friend yourself' });

  // Check if already friends
  if (friendStore[account.username] && friendStore[account.username].includes(target)) {
    return res.status(400).json({ error: 'Already friends' });
  }
  // Check if request already pending
  if (!friendRequests[target]) friendRequests[target] = [];
  const already = friendRequests[target].some(r => r.from === account.username);
  if (already) return res.status(400).json({ error: 'Request already sent' });

  friendRequests[target].push({ from: account.username, timestamp: Date.now() });
  saveFriendRequests();

  // Notify target if online
  const targetSocket = findSocketByUsername(target);
  if (targetSocket) {
    targetSocket.emit('friend-request', { from: account.username, fromDisplay: account.displayName });
    targetSocket.emit('notification', { type: 'friend-request', from: account.displayName });
  }

  res.json({ ok: true });
});

app.post('/api/friend-accept', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  const from = (req.body.from || '').trim().toLowerCase();

  if (!friendRequests[account.username]) return res.status(400).json({ error: 'No request found' });
  const idx = friendRequests[account.username].findIndex(r => r.from === from);
  if (idx === -1) return res.status(400).json({ error: 'No request from that user' });

  // Remove request
  friendRequests[account.username].splice(idx, 1);

  // Add both as friends
  if (!friendStore[account.username]) friendStore[account.username] = [];
  if (!friendStore[from]) friendStore[from] = [];
  if (!friendStore[account.username].includes(from)) friendStore[account.username].push(from);
  if (!friendStore[from].includes(account.username)) friendStore[from].push(account.username);

  saveFriendRequests(); saveFriends();

  // Notify the requester if online
  const fromSocket = findSocketByUsername(from);
  if (fromSocket) {
    fromSocket.emit('friend-accepted', { username: account.username, displayName: account.displayName });
    fromSocket.emit('notification', { type: 'friend-accepted', from: account.displayName });
  }

  res.json({ ok: true });
});

app.post('/api/friend-reject', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  const from = (req.body.from || '').trim().toLowerCase();

  if (!friendRequests[account.username]) return res.status(400).json({ error: 'No requests' });
  friendRequests[account.username] = friendRequests[account.username].filter(r => r.from !== from);
  saveFriendRequests();
  res.json({ ok: true });
});

app.post('/api/friend-remove', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });
  const target = (req.body.username || '').trim().toLowerCase();

  if (friendStore[account.username]) {
    friendStore[account.username] = friendStore[account.username].filter(f => f !== target);
  }
  if (friendStore[target]) {
    friendStore[target] = friendStore[target].filter(f => f !== account.username);
  }
  saveFriends();
  res.json({ ok: true });
});

app.post('/api/friends', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });

  const friends = (friendStore[account.username] || []).map(f => {
    const acc = accounts[f];
    if (!acc) return null;
    return {
      username: acc.username,
      displayName: acc.displayName,
      color: acc.color,
      pfp: acc.pfp,
      tags: acc.tags,
      online: isUserOnline(f),
    };
  }).filter(Boolean);

  const requests = (friendRequests[account.username] || []).map(r => {
    const acc = accounts[r.from];
    return { from: r.from, fromDisplay: acc ? acc.displayName : r.from, timestamp: r.timestamp };
  });

  res.json({ friends, requests });
});

// --- Get DM conversations list ---
app.post('/api/dm-list', (req, res) => {
  const account = findByToken(req.body.token);
  if (!account) return res.status(401).json({ error: 'Invalid token' });

  // Find all DM keys that include this user
  const convos = [];
  Object.keys(dmStore).forEach(key => {
    const parts = key.split('::');
    if (parts.includes(account.username)) {
      const otherUser = parts[0] === account.username ? parts[1] : parts[0];
      const msgs = dmStore[key];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const otherAccount = accounts[otherUser];
      convos.push({
        username: otherUser,
        displayName: otherAccount ? otherAccount.displayName : otherUser,
        color: otherAccount ? otherAccount.color : '#000000',
        lastMessage: lastMsg ? (lastMsg.text || '[file]') : '',
        lastTimestamp: lastMsg ? lastMsg.timestamp : 0,
      });
    }
  });

  // Sort by most recent
  convos.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  res.json({ conversations: convos });
});

// ============================================================
// SOCKET STATE
// ============================================================
const onlineSockets = new Map(); // socketId -> {username, displayName, color, tags}

function getOnlineUsers() {
  const seen = new Set();
  const result = [];
  onlineSockets.forEach(u => {
    if (!seen.has(u.username)) {
      seen.add(u.username);
      result.push({ username: u.username, displayName: u.displayName, color: u.color, tags: u.tags || [] });
    }
  });
  return result;
}

function isUserOnline(username) {
  let found = false;
  onlineSockets.forEach(u => { if (u.username === username) found = true; });
  return found;
}

function findSocketByUsername(username) {
  for (const [sid, u] of onlineSockets) {
    if (u.username === username) return io.sockets.sockets.get(sid);
  }
  return null;
}

function getPublicRoomsList() {
  const list = [];
  Object.keys(roomStore).forEach(id => {
    const r = roomStore[id];
    if (!r.private) {
      list.push({ id, name: r.name, memberCount: r.members.length });
    }
  });
  return list;
}

function getUserRoomsList(username) {
  // Public rooms + private rooms user is a member or invited to
  const list = [];
  Object.keys(roomStore).forEach(id => {
    const r = roomStore[id];
    if (!r.private || r.members.includes(username) || r.invited.includes(username) || r.creator === username) {
      list.push({
        id, name: r.name, memberCount: r.members.length,
        private: r.private || false,
        isMember: r.members.includes(username),
      });
    }
  });
  return list;
}

// ============================================================
// SOCKET.IO
// ============================================================
io.on('connection', (socket) => {

  // --- JOIN ---
  socket.on('join', (data) => {
    if (!data || !data.token) return;
    const account = findByToken(data.token);
    if (!account) {
      socket.emit('join-error', 'Invalid session. Please log in again.');
      return;
    }

    // Allow multiple tabs/devices (don't block duplicate logins)
    onlineSockets.set(socket.id, {
      username: account.username,
      displayName: account.displayName,
      color: account.color,
      tags: account.tags || [],
    });

    socket.join('public');

    // Join all rooms user is a member of
    Object.keys(roomStore).forEach(roomId => {
      if (roomStore[roomId].members.includes(account.username)) {
        socket.join(roomId);
      }
    });

    // No public message history — fresh start
    socket.emit('joined', {
      username: account.username,
      displayName: account.displayName,
      color: account.color,
      bio: account.bio,
      pfp: account.pfp,
      tags: account.tags || [],
      messages: [],
      onlineUsers: getOnlineUsers(),
      rooms: getUserRoomsList(account.username),
      friendRequests: (friendRequests[account.username] || []).length,
    });

    socket.broadcast.emit('user-joined', {
      username: account.username,
      displayName: account.displayName,
      color: account.color,
      tags: account.tags || [],
    });
    io.emit('online-users', getOnlineUsers());

    const sysMsg = {
      id: uuidv4(), type: 'system',
      text: account.displayName + ' has entered the chat',
      timestamp: Date.now(),
    };
    io.to('public').emit('public-message', sysMsg);
  });

  // --- PUBLIC MESSAGES ---
  socket.on('public-message', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;
    const msg = {
      id: uuidv4(), type: 'message',
      username: user.username, displayName: user.displayName,
      color: user.color,
      text: data.text || '', file: data.file || null,
      timestamp: Date.now(),
    };
    io.to('public').emit('public-message', msg);
  });

  // --- DMs (persistent) ---
  socket.on('dm', (data) => {
    const sender = onlineSockets.get(socket.id);
    if (!sender) return;
    const targetUsername = (data.to || '').toLowerCase();
    if (!accounts[targetUsername]) {
      socket.emit('dm-error', 'User not found');
      return;
    }

    const dmKey = getDmKey(sender.username, targetUsername);
    if (!dmStore[dmKey]) dmStore[dmKey] = [];

    const targetAccount = accounts[targetUsername];
    const msg = {
      id: uuidv4(), type: 'dm',
      from: sender.username, fromDisplay: sender.displayName, fromColor: sender.color,
      to: targetUsername, toDisplay: targetAccount.displayName,
      text: data.text || '', file: data.file || null,
      timestamp: Date.now(),
    };

    dmStore[dmKey].push(msg);
    // Cap at 500 messages per conversation
    if (dmStore[dmKey].length > 500) dmStore[dmKey] = dmStore[dmKey].slice(-500);
    saveDMs();

    // Send to sender
    socket.emit('dm', msg);
    // Send to all sockets of the recipient
    onlineSockets.forEach((u, sid) => {
      if (u.username === targetUsername && sid !== socket.id) {
        const targetSock = io.sockets.sockets.get(sid);
        if (targetSock) {
          targetSock.emit('dm', msg);
          targetSock.emit('notification', { type: 'dm', from: sender.displayName, fromUsername: sender.username });
        }
      }
    });
  });

  // --- DM history (persistent) ---
  socket.on('dm-history', (targetUsername) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;
    const dmKey = getDmKey(user.username, targetUsername);
    const messages = dmStore[dmKey] || [];
    socket.emit('dm-history', { with: targetUsername, messages: messages.slice(-100) });
  });

  // --- ROOMS ---
  socket.on('create-room', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;

    const roomName = (data.name || '').trim().substring(0, 32);
    if (!roomName) return;
    const isPrivate = data.private || false;

    const roomId = uuidv4().substring(0, 8);
    roomStore[roomId] = {
      name: roomName,
      creator: user.username,
      private: isPrivate,
      members: [user.username],
      invited: [],
      messages: [],
    };
    saveRooms();

    socket.join(roomId);
    socket.emit('room-created', { id: roomId, name: roomName, private: isPrivate });

    // Broadcast updated room list to all users
    onlineSockets.forEach((u, sid) => {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('rooms-list', getUserRoomsList(u.username));
    });
  });

  socket.on('join-room', (roomId) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;
    const room = roomStore[roomId];
    if (!room) { socket.emit('room-error', 'Room not found'); return; }

    // Private room check — must be invited or already a member
    if (room.private && !room.members.includes(user.username) && !room.invited.includes(user.username) && room.creator !== user.username) {
      socket.emit('room-error', 'You need an invite to join this room');
      return;
    }

    if (!room.members.includes(user.username)) room.members.push(user.username);
    // Remove from invited list since they've joined
    room.invited = room.invited.filter(u => u !== user.username);
    saveRooms();

    socket.join(roomId);

    // Send room history (persistent for rooms)
    socket.emit('room-joined', {
      id: roomId, name: room.name,
      messages: room.messages.slice(-100),
      members: room.members,
      private: room.private,
      creator: room.creator,
    });

    const sysMsg = {
      id: uuidv4(), type: 'system',
      text: user.displayName + ' joined the room',
      timestamp: Date.now(),
    };
    room.messages.push(sysMsg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    saveRooms();
    io.to(roomId).emit('room-message', { roomId, message: sysMsg });

    onlineSockets.forEach((u, sid) => {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('rooms-list', getUserRoomsList(u.username));
    });
  });

  socket.on('room-message', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;
    const room = roomStore[data.roomId];
    if (!room || !room.members.includes(user.username)) return;

    const msg = {
      id: uuidv4(), type: 'message',
      username: user.username, displayName: user.displayName,
      color: user.color,
      text: data.text || '', file: data.file || null,
      timestamp: Date.now(),
    };

    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    saveRooms();

    io.to(data.roomId).emit('room-message', { roomId: data.roomId, message: msg });

    // Notify offline room members
    room.members.forEach(memberUsername => {
      if (memberUsername !== user.username) {
        const memberSocket = findSocketByUsername(memberUsername);
        if (memberSocket) {
          // They might not be viewing this room, send notification
          memberSocket.emit('notification', { type: 'room', roomId: data.roomId, roomName: room.name, from: user.displayName });
        }
      }
    });
  });

  socket.on('leave-room', (roomId) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;
    const room = roomStore[roomId];
    if (!room) return;

    room.members = room.members.filter(m => m !== user.username);
    socket.leave(roomId);

    if (room.members.length === 0) {
      delete roomStore[roomId];
    } else {
      const sysMsg = {
        id: uuidv4(), type: 'system',
        text: user.displayName + ' left the room',
        timestamp: Date.now(),
      };
      room.messages.push(sysMsg);
      io.to(roomId).emit('room-message', { roomId, message: sysMsg });
    }
    saveRooms();

    onlineSockets.forEach((u, sid) => {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('rooms-list', getUserRoomsList(u.username));
    });
  });

  // --- Invite to private room ---
  socket.on('invite-to-room', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;
    const room = roomStore[data.roomId];
    if (!room) return;

    // Only members can invite
    if (!room.members.includes(user.username)) return;

    const targetUsername = (data.username || '').trim().toLowerCase();
    if (!accounts[targetUsername]) {
      socket.emit('room-error', 'User not found');
      return;
    }
    if (room.members.includes(targetUsername)) {
      socket.emit('room-error', 'Already a member');
      return;
    }
    if (room.invited.includes(targetUsername)) {
      socket.emit('room-error', 'Already invited');
      return;
    }

    room.invited.push(targetUsername);
    saveRooms();

    // Notify the invited user
    const targetSocket = findSocketByUsername(targetUsername);
    if (targetSocket) {
      targetSocket.emit('room-invite', { roomId: data.roomId, roomName: room.name, from: user.displayName });
      targetSocket.emit('notification', { type: 'room-invite', roomName: room.name, from: user.displayName });
      targetSocket.emit('rooms-list', getUserRoomsList(targetUsername));
    }

    socket.emit('invite-sent', { username: targetUsername, roomId: data.roomId });
  });

  // --- TYPING ---
  socket.on('typing', (data) => {
    const user = onlineSockets.get(socket.id);
    if (!user) return;
    if (data.room === 'public') {
      socket.broadcast.to('public').emit('typing', { displayName: user.displayName, room: 'public' });
    } else if (data.room) {
      socket.broadcast.to(data.room).emit('typing', { displayName: user.displayName, room: data.room });
    } else if (data.to) {
      onlineSockets.forEach((u, sid) => {
        if (u.username === data.to && sid !== socket.id) {
          const s = io.sockets.sockets.get(sid);
          if (s) s.emit('typing', { displayName: user.displayName, dm: true });
        }
      });
    }
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const user = onlineSockets.get(socket.id);
    if (user) {
      onlineSockets.delete(socket.id);

      // Only broadcast leave if user has no other connected sockets
      if (!isUserOnline(user.username)) {
        const sysMsg = {
          id: uuidv4(), type: 'system',
          text: user.displayName + ' has left the chat',
          timestamp: Date.now(),
        };
        io.to('public').emit('public-message', sysMsg);
        io.emit('online-users', getOnlineUsers());
      }
    }
  });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('JorgeChat v3 on port ' + PORT));
