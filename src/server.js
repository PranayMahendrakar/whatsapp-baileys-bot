// src/server.js - Express Web UI API Server
// Provides REST + SSE endpoints so the chat UI can read/send WhatsApp messages

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── In-memory store ──────────────────────────────────────────────────────────
// conversations: Map<jid, { id, name, phone, lastMsg, unread, messages[] }>
export const conversations = new Map();
// SSE clients for real-time push
const sseClients = new Set();

// ─── Helpers exposed to bot.js ────────────────────────────────────────────────
let _sockRef = null;
export function setSocket(sock) { _sockRef = sock; }

export function storeMessage({ jid, id, name, phone, text, fromMe, timestamp }) {
  if (!conversations.has(jid)) {
    conversations.set(jid, { id: jid, name: name || phone, phone, unread: 0, messages: [] });
  }
  const convo = conversations.get(jid);
  convo.name    = name || convo.name || phone;
  convo.phone   = phone || convo.phone;
  convo.lastMsg = text;
  convo.lastTs  = timestamp;
  if (!fromMe) convo.unread = (convo.unread || 0) + 1;
  convo.messages.push({ id, text, fromMe, timestamp, status: fromMe ? 'sent' : 'received' });
  // Keep last 200 messages per chat
  if (convo.messages.length > 200) convo.messages.shift();
  broadcastSSE({ type: 'message', jid, message: { id, text, fromMe, timestamp } });
}

export function markRead(jid) {
  if (conversations.has(jid)) conversations.get(jid).unread = 0;
}

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}

`;
  sseClients.forEach(res => { try { res.write(payload); } catch(_) {} });
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (the chat UI)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── GET /api/chats - list all conversations ───────────────────────────────────
app.get('/api/chats', (_req, res) => {
  const list = Array.from(conversations.values())
    .map(c => ({
      id:      c.id,
      name:    c.name,
      phone:   c.phone,
      lastMsg: c.lastMsg || '',
      lastTs:  c.lastTs  || 0,
      unread:  c.unread  || 0,
    }))
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  res.json(list);
});

// ── GET /api/chats/:jid/messages - get messages for a chat ───────────────────
app.get('/api/chats/:jid/messages', (req, res) => {
  const jid  = decodeURIComponent(req.params.jid);
  const convo = conversations.get(jid);
  if (!convo) return res.json([]);
  markRead(jid);
  broadcastSSE({ type: 'read', jid });
  res.json(convo.messages);
});

// ── POST /api/chats/:jid/send - send a message ────────────────────────────────
app.post('/api/chats/:jid/send', async (req, res) => {
  const jid  = decodeURIComponent(req.params.jid);
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  if (!_sockRef) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const sent = await _sockRef.sendMessage(jid, { text: text.trim() });
    const ts   = Date.now();
    storeMessage({ jid, id: sent.key.id, name: null, phone: null, text: text.trim(), fromMe: true, timestamp: ts });
    res.json({ ok: true, id: sent.key.id });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/status - connection status ──────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({ connected: !!_sockRef, ts: Date.now() });
});

// ── GET /api/events - SSE stream for real-time updates ───────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}

`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
export function startServer() {
  return new Promise(resolve => {
    app.listen(PORT, () => {
      console.log(`\n🌐 Web UI running at http://localhost:${PORT}`);
      resolve();
    });
  });
}
