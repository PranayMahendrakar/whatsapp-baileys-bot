// src/bot.js - Main WhatsApp Bot using Baileys
// Educational project - Read & Reply to WhatsApp messages

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
  isJidBroadcast,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';

// ─── Configuration ──────────────────────────────────────────────────────────
const AUTH_FOLDER = './auth_info';
const STORE_FILE  = './store.json';
const LOG_LEVEL   = process.env.LOG_LEVEL || 'silent'; // 'silent' | 'info' | 'debug'

// ─── Logger ─────────────────────────────────────────────────────────────────
const logger = pino({ level: LOG_LEVEL });

// ─── In-memory message store ─────────────────────────────────────────────────
const store = makeInMemoryStore({ logger });
store.readFromFile(STORE_FILE);
setInterval(() => store.writeToFile(STORE_FILE), 10_000);

// ─── Message Handler ─────────────────────────────────────────────────────────
async function handleMessage(sock, msg) {
  const { key, message } = msg;

  // Ignore broadcast / status messages
  if (!message || isJidBroadcast(key.remoteJid)) return;

  // Extract plain text from different message types
  const text =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    '';

  if (!text) return;

  const from     = key.remoteJid;
  const isGroup  = from.endsWith('@g.us');
  const sender   = key.participant || from;
  const msgLower = text.toLowerCase().trim();

  console.log(`\n📨 New message from ${sender}`);
  console.log(`   Chat : ${isGroup ? 'Group' : 'Private'} (${from})`);
  console.log(`   Text : ${text}`);

  // ─── Auto-reply logic ──────────────────────────────────────────────────────
  let reply = null;

  if (msgLower === '!ping') {
    reply = '🏓 Pong! Bot is alive and running.';
  } else if (msgLower === '!help') {
    reply = [
      '🤖 *WhatsApp Baileys Bot - Help Menu*',
      '',
      '!ping    - Check if bot is alive',
      '!help    - Show this help message',
      '!info    - Show bot information',
      '!echo <msg> - Echo your message back',
      '!time    - Show current server time',
    ].join('\n');
  } else if (msgLower === '!info') {
    reply = [
      '🤖 *Bot Information*',
      'Library: @whiskeysockets/baileys',
      'Purpose: Educational WhatsApp automation',
      'Author: PranayMahendrakar',
    ].join('\n');
  } else if (msgLower === '!time') {
    reply = `🕐 Server time: ${new Date().toLocaleString()}`;
  } else if (msgLower.startsWith('!echo ')) {
    const echoText = text.slice(6).trim();
    reply = `🔁 ${echoText}`;
  }

  if (reply) {
    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    console.log(`   ✅ Reply sent: ${reply.substring(0, 60)}...`);
  }
}

// ─── Connection Handler ───────────────────────────────────────────────────────
async function connectToWhatsApp(sock, saveCreds) {
  store.bind(sock.ev);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp:');
      // qrcode-terminal prints QR to console
      const { default: qrcode } = await import('qrcode-terminal');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('\n🔌 Connection closed. Reason:', reason);

      if (reason === DisconnectReason.badSession) {
        console.log('❌ Bad session. Delete auth_info folder and restart.');
        process.exit(1);
      } else if (
        reason === DisconnectReason.connectionClosed ||
        reason === DisconnectReason.connectionLost ||
        reason === DisconnectReason.timedOut
      ) {
        console.log('🔄 Reconnecting...');
        await startBot();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log('🚪 Logged out. Delete auth_info folder and restart.');
        process.exit(1);
      } else {
        console.log('🔄 Unknown disconnect reason, reconnecting...');
        await startBot();
      }
    }

    if (connection === 'open') {
      console.log('\n✅ Connected to WhatsApp!');
      console.log(`👤 User: ${sock.user?.name || 'Unknown'}`);
      console.log(`📞 Number: ${sock.user?.id}`);
      console.log('🎯 Bot is ready. Send !help to see commands.\n');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        await handleMessage(sock, msg);
      }
    }
  });
}

// ─── Start Bot ────────────────────────────────────────────────────────────────
export async function startBot() {
  // Ensure auth folder exists
  if (!existsSync(AUTH_FOLDER)) {
    await mkdir(AUTH_FOLDER, { recursive: true });
  }

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys version: ${version.join('.')} (latest: ${isLatest})`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false, // We handle QR ourselves
    browser: ['WhatsApp Bot', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
  });

  await connectToWhatsApp(sock, saveCreds);
  return sock;
}
