'use strict';
// src/server.js - Express Web UI API Server (CommonJS)
// Provides REST endpoints so the chat UI can read/send WhatsApp messages

const express = require('express');
const cors = require('cors');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── In-memory store ───────────────────────────────────────────────────────────
// conversations: Map<jid, { id, name, phone, lastMessage, lastTimestamp, unread, messages[] }>
const conversations = new Map();

// ── Socket ref (set by bot-runner) ────────────────────────────────────────────
let _sockRef = null;

function setSocket(sock) { _sockRef = sock; }

function storeMessage(jid, { id, fromMe, text, timestamp, pushName }) {
  if (!conversations.has(jid)) {
    const phone = jid.split('@')[0];
    const name = pushName || phone;
    conversations.set(jid, {
      jid,
      name,
      phone,
      lastMessage: '',
      lastTimestamp: 0,
      unread: 0,
      messages: [],
    });
  }
  const convo = conversations.get(jid);
  convo.name = pushName || convo.name;
  convo.lastMessage = text;
  convo.lastTimestamp = timestamp ? Number(timestamp) : Math.floor(Date.now() / 1000);
  if (!fromMe) convo.unread = (convo.unread || 0) + 1;
  convo.messages.push({ id, text, fromMe, timestamp: convo.lastTimestamp, pushName: pushName || '' });
  if (convo.messages.length > 200) convo.messages.shift();
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// Serve static UI files from public/ directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    connected: _sockRef !== null,
    chats: conversations.size,
    uptime: process.uptime(),
  });
});

// GET /api/chats
app.get('/api/chats', (req, res) => {
  const list = Array.from(conversations.values()).map(c => ({
    jid: c.jid,
    name: c.name,
    phone: c.phone,
    lastMessage: c.lastMessage,
    lastTimestamp: c.lastTimestamp,
    unread: c.unread || 0,
  }));
  // Sort by lastTimestamp descending
  list.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  res.json(list);
});

// GET /api/chats/:jid/messages
app.get('/api/chats/:jid/messages', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const convo = conversations.get(jid);
  if (!convo) return res.json([]);
  // Reset unread
  convo.unread = 0;
  res.json(convo.messages.slice(-100)); // Last 100 messages
});

// POST /api/chats/:jid/send
app.post('/api/chats/:jid/send', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  if (!_sockRef) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    await _sockRef.sendMessage(jid, { text: text.trim() });
    // Also store in our local map immediately
    storeMessage(jid, {
      id: 'sent_' + Date.now(),
      fromMe: true,
      text: text.trim(),
      timestamp: Math.floor(Date.now() / 1000),
      pushName: '',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[server] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
      resolve();
    }).on('error', reject);
  });
}

module.exports = { startServer, storeMessage, setSocket, conversations };
