'use strict';

/**
 * bot-runner.js
 * Entry point for GitHub Actions.
 * - Starts the Express web server
 * - Starts the Baileys WhatsApp bot
 * - Generates QR code as PNG and pushes it to the repo (→ GitHub Pages)
 * - Updates status.json in the repo when connection state changes
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const QRCode = require('qrcode');

// ── Server ────────────────────────────────────────────────────────────────────
const { startServer, storeMessage, setSocket } = require('./server');

// ── Baileys ──────────────────────────────────────────────────────────────────
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

// ── Git helper ────────────────────────────────────────────────────────────────
function gitPush(files, message) {
  try {
    execSync('git config user.email "bot@github.com"', { stdio: 'pipe' });
    execSync('git config user.name "WhatsApp Bot"', { stdio: 'pipe' });
    for (const f of files) {
      execSync(`git add ${f}`, { stdio: 'pipe' });
    }
    execSync(`git commit -m "${message} [skip ci]"`, { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log(`[git] Pushed: ${message}`);
  } catch (e) {
    console.error('[git] Push failed (may be no changes):', e.message);
  }
}

// ── Update status.json ────────────────────────────────────────────────────────
function writeStatus(connected, tunnelUrl) {
  // Read existing status.json for tunnel URL if not provided
  let url = tunnelUrl;
  if (!url) {
    try {
      const existing = JSON.parse(fs.readFileSync('status.json', 'utf8'));
      url = existing.url || null;
    } catch (_) {}
  }
  const payload = JSON.stringify({ url, ts: Math.floor(Date.now() / 1000), connected }, null, 2);
  fs.writeFileSync('status.json', payload);
  console.log('[status] Updated status.json:', payload);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Start web server
  await startServer();
  console.log('[runner] Web server started');

  // 2. Start bot
  await startBot();
}

async function startBot() {
  const AUTH_DIR = path.join(process.cwd(), 'auth_info');
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log('[runner] Starting Baileys v' + version.join('.'));

  const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
  });

  // Share socket with server module so it can send messages
  setSocket(sock);

  // ── QR Code ────────────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[runner] QR code received — generating PNG and pushing to repo…');
      try {
        // Save QR as PNG at repo root (served by GitHub Pages)
        await QRCode.toFile('qr.png', qr, {
          width: 400,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
        console.log('[runner] qr.png saved');

        // Update status.json to show waiting-for-scan state
        writeStatus(false);

        // Push both files to repo
        gitPush(['qr.png', 'status.json'], 'chore: update QR code for GitHub Pages scan');
      } catch (err) {
        console.error('[runner] Failed to push QR:', err.message);
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('[runner] Connection closed. Reason:', reason);

      // Clean up QR
      try { fs.unlinkSync('qr.png'); } catch (_) {}
      writeStatus(false);
      gitPush(['status.json'], 'chore: connection closed');

      if (reason !== DisconnectReason.loggedOut) {
        console.log('[runner] Reconnecting in 5s…');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('[runner] Logged out — clearing auth');
        try { fs.rmSync('auth_info', { recursive: true }); } catch (_) {}
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('[runner] ✅ Connected to WhatsApp!');
      try { fs.unlinkSync('qr.png'); } catch (_) {}
      writeStatus(true);
      gitPush(['status.json'], 'chore: bot connected');
    }
  });

  // ── Save creds ─────────────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Messages ───────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid || '';
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '[Media/Other]';

      const fromMe = msg.key.fromMe;
      storeMessage(jid, {
        id: msg.key.id,
        fromMe,
        text,
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName || '',
      });

      // Auto-reply to non-self messages (optional echo — disable if not wanted)
      if (!fromMe && type === 'notify') {
        console.log(`[msg] From ${jid}: ${text}`);
      }
    }
  });
}

main().catch((err) => {
  console.error('[runner] Fatal error:', err);
  process.exit(1);
});
