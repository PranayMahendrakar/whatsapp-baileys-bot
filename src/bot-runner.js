'use strict';
/**
 * bot-runner.js - QR Code method
 * Embeds QR as base64 in status.json so GitHub Pages can display it.
 */
const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');
const QRCode = require('qrcode');

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
const pino    = require('pino');

function gitPush(files, message) {
  try {
    execSync('git config user.email "bot@github.com"', { stdio: 'pipe' });
    execSync('git config user.name "WhatsApp Bot"',    { stdio: 'pipe' });
    for (const f of files) execSync('git add ' + f, { stdio: 'pipe' });
    execSync('git commit -m "' + message + ' [skip ci]"', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('[git] Pushed:', message);
  } catch (e) {
    console.log('[git] Nothing to push:', e.message.slice(0, 80));
  }
}

function getTunnelUrl() {
  try { return JSON.parse(fs.readFileSync('status.json', 'utf8')).url || null; }
  catch (_) { return null; }
}

function writeStatus(data) {
  const url = getTunnelUrl();
  const payload = { url, ts: Math.floor(Date.now() / 1000), ...data };
  fs.writeFileSync('status.json', JSON.stringify(payload, null, 2));
  const qrLen = data.qr ? Math.round(data.qr.length / 1024) + 'KB' : 'none';
  console.log('[status] connected=' + data.connected + ' qr=' + qrLen);
}

async function main() {
  await startServer();
  console.log('[runner] Web server started on port 3000');
  await startBot();
}

async function startBot() {
  const AUTH_DIR = path.join(process.cwd(), 'auth_info');
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
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
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
  });

  setSocket(sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[runner] QR received - generating base64...');
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          width: 512, margin: 4,
          errorCorrectionLevel: 'M',
          color: { dark: '#000000', light: '#ffffff' },
        });
        writeStatus({ connected: false, qr: qrDataUrl, error: null });
        gitPush(['status.json'], 'chore: refresh QR code');
      } catch (err) {
        console.error('[runner] QR generation failed:', err.message);
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('[runner] Connection closed, reason:', reason);
      writeStatus({ connected: false, qr: null, error: null });
      gitPush(['status.json'], 'chore: connection closed');

      if (reason !== DisconnectReason.loggedOut) {
        console.log('[runner] Reconnecting in 5s...');
        setTimeout(startBot, 5000);
      } else {
        console.log('[runner] Logged out - clearing auth');
        try { fs.rmSync('auth_info', { recursive: true }); } catch (_) {}
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('[runner] WhatsApp connected!');
      writeStatus({ connected: true, qr: null, error: null });
      gitPush(['status.json'], 'chore: bot connected');
    }
  });

  sock.ev.on('creds.update', saveCreds);

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
      storeMessage(jid, {
        id:        msg.key.id,
        fromMe,
        text,
        timestamp: msg.messageTimestamp,
        pushName:  msg.pushName || '',
      });
      if (!fromMe && type === 'notify') {
        console.log('[msg] ' + jid + ': ' + text);
      }
    }
  });
}

main().catch(err => {
  console.error('[runner] Fatal:', err);
  process.exit(1);
});
