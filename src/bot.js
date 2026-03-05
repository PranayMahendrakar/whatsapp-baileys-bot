// src/bot.js - WhatsApp Baileys Bot integrated with Web UI
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, isJidBroadcast, getContentType } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { setSocket, storeMessage } from './server.js';

const AUTH_FOLDER = './auth_info';
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

function extractText(message) {
  if (!message) return '';
  const type = getContentType(message);
  if (!type) return '';
  const msg = message[type];
  if (type === 'conversation') return msg || '';
  if (type === 'extendedTextMessage') return msg?.text || '';
  if (type === 'imageMessage') return msg?.caption || '[Image]';
  if (type === 'videoMessage') return msg?.caption || '[Video]';
  if (type === 'audioMessage') return '[Voice message]';
  if (type === 'documentMessage') return '[Document: ' + (msg?.fileName || 'file') + ']';
  if (type === 'stickerMessage') return '[Sticker]';
  return '[' + type + ']';
}

async function handleMessage(sock, msg) {
  const { key, message, pushName } = msg;
  if (!message || isJidBroadcast(key.remoteJid)) return;
  const text = extractText(message);
  const from = key.remoteJid;
  const isGroup = from.endsWith('@g.us');
  const phone = (key.participant || from).split('@')[0].replace(/[^0-9]/g, '');
  const name = pushName || phone;
  storeMessage({ jid: from, id: key.id, name: isGroup ? name + ' (group)' : name, phone, text: text || '', fromMe: false, timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now() });
  console.log('[' + (isGroup ? 'Group' : 'DM') + '] ' + name + ': ' + text);
  const lower = text.toLowerCase().trim();
  let reply = null;
  if (lower === '!ping') reply = 'Pong! Bot is alive.';
  else if (lower === '!help') reply = 'Commands: !ping !help !info !time !echo <text>';
  else if (lower === '!info') reply = 'Baileys Bot v2 | Educational | PranayMahendrakar';
  else if (lower === '!time') reply = 'Time: ' + new Date().toLocaleString();
  else if (lower.startsWith('!echo ')) reply = text.slice(6).trim();
  if (reply) {
    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    storeMessage({ jid: from, id: key.id + '_r', name: 'Bot', phone: null, text: reply, fromMe: true, timestamp: Date.now() });
  }
}

async function connectToWhatsApp(sock, saveCreds) {
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const { default: qrcode } = await import('qrcode-terminal');
      qrcode.generate(qr, { small: true });
      console.log('Scan QR with WhatsApp');
    }
    if (connection === 'close') {
      setSocket(null);
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.badSession || reason === DisconnectReason.loggedOut) { console.log('Session invalid.'); process.exit(1); }
      console.log('Reconnecting in 3s...');
      setTimeout(() => startBot(), 3000);
    }
    if (connection === 'open') {
      setSocket(sock);
      console.log('Connected! User: ' + sock.user?.name + ' | ' + sock.user?.id);
    }
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) { if (!msg.key.fromMe) await handleMessage(sock, msg); }
  });
}

export async function startBot() {
  if (!existsSync(AUTH_FOLDER)) await mkdir(AUTH_FOLDER, { recursive: true });
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const sock = makeWASocket({ version, logger, auth: state, printQRInTerminal: false, browser: ['WhatsApp Bot', 'Chrome', '120.0.0'], markOnlineOnConnect: false });
  await connectToWhatsApp(sock, saveCreds);
  return sock;
}
