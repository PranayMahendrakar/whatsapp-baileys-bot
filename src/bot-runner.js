'use strict';
/**
 * bot-runner.js — PAIRING CODE method (reliable for headless/remote bots)
 * The pairing code request must happen AFTER connection is open but BEFORE
 * the socket disconnects due to timeout — so we request it on 'connecting'
 * state using a proven pattern.
 */

const path   = require('path');
const fs     = require('fs');
const { execSync } = require('child_process');

const { startServer, storeMessage, setSocket } = require('./server');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino   = require('pino');

// ── Git helper ────────────────────────────────────────────────────────────────
function gitPush(files, message) {
  try {
    execSync('git config user.email "bot@github.com"', { stdio: 'pipe' });
    execSync('git config user.name "WhatsApp Bot"',    { stdio: 'pipe' });
    for (const f of files) execSync(`git add ${f}`, { stdio: 'pipe' });
    execSync(`git commit -m "${message} [skip ci]"`,  { stdio: 'pipe' });
    execSync('git push',                               { stdio: 'pipe' });
    console.log('[git] Pushed:', message);
  } catch (e) {
    console.log('[git] Nothing to push:', e.message.slice(0, 60));
  }
}

function getTunnelUrl() {
  try { return JSON.parse(fs.readFileSync('status.json','utf8')).url || null; }
  catch (_) { return null; }
}

function writeStatus(data) {
  const url = getTunnelUrl();
  const payload = { url, ts: Math.floor(Date.now()/1000), ...data };
  fs.writeFileSync('status.json', JSON.stringify(payload, null, 2));
  console.log('[status]', JSON.stringify(payload).slice(0, 150));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await startServer();
  console.log('[runner] Web server started on port 3000');
  await startBot();
}

async function startBot() {
  const AUTH_DIR = path.join(process.cwd(), 'auth_info');
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  console.log('[runner] Baileys v' + version.join('.'));

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  setSocket(sock);

  // ── Request pairing code right after socket is created ────────────────────
  // The correct pattern: request it BEFORE connection.update fires 'close',
  // using a small delay to let Baileys initialise the handshake.
  if (!sock.authState.creds.registered) {
    const phone = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
    if (!phone) {
      console.error('[runner] ❌ PHONE_NUMBER secret not set!');
      writeStatus({ connected: false, pairingCode: null, error: 'PHONE_NUMBER secret not set. Add it in GitHub Settings → Secrets.' });
      gitPush(['status.json'], 'chore: error phone number missing');
      process.exit(1);
    }

    // Wait a moment for socket handshake, then request
    await new Promise(res => setTimeout(res, 3000));

    try {
      console.log('[runner] Requesting pairing code for +' + phone + '…');
      const code = await sock.requestPairingCode(phone);
      const formatted = code.match(/.{1,4}/g).join('-');
      console.log('[runner] ✅ Pairing code:', formatted);
      writeStatus({ connected: false, pairingCode: formatted, error: null });
      gitPush(['status.json'], 'chore: pairing code ready');
    } catch (err) {
      console.error('[runner] Pairing code request failed:', err.message);
      writeStatus({ connected: false, pairingCode: null, error: 'Pairing code failed: ' + err.message });
      gitPush(['status.json'], 'chore: pairing code failed');
      // Retry after 5s
      setTimeout(startBot, 5000);
      return;
    }
  }

  // ── Connection events ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('[runner] Connection closed, reason:', reason);
      writeStatus({ connected: false, pairingCode: null, error: null });
      gitPush(['status.json'], 'chore: connection closed');

      if (reason !== DisconnectReason.loggedOut) {
        console.log('[runner] Reconnecting in 5s…');
        setTimeout(startBot, 5000);
      } else {
        console.log('[runner] Logged out');
        try { fs.rmSync('auth_info', { recursive: true }); } catch (_) {}
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('[runner] ✅ WhatsApp connected!');
      writeStatus({ connected: true, pairingCode: null, error: null });
      gitPush(['status.json'], 'chore: bot connected');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Messages ────────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid  = msg.key.remoteJid || '';
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '[Media/Other]';
      const fromMe = msg.key.fromMe;
      storeMessage(jid, { id: msg.key.id, fromMe, text,
        timestamp: msg.messageTimestamp, pushName: msg.pushName || '' });
      if (!fromMe && type === 'notify') console.log(`[msg] ${jid}: ${text}`);
    }
  });
}

main().catch(err => { console.error('[runner] Fatal:', err); process.exit(1); });
