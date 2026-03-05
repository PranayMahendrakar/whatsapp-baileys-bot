'use strict';
/**
 * bot-runner.js - QR Code method
 * Pushes status.json to bot-data branch using git worktree to avoid
 * branch switching issues. Pages is NOT triggered since bot-data branch
 * is not configured as Pages source.
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

// ── Write status.json to bot-data branch via worktree ───────────────────────
const WORKTREE_DIR = path.join(process.cwd(), '.bot-data-wt');

function setupWorktree() {
  try {
    execSync('git config user.email "bot@github.com"', { stdio: 'pipe' });
    execSync('git config user.name "WhatsApp Bot"',    { stdio: 'pipe' });

    // Check if bot-data branch exists remotely
    let branchExists = false;
    try {
      const out = execSync('git ls-remote --heads origin bot-data', { stdio: 'pipe' }).toString();
      branchExists = out.includes('bot-data');
    } catch(_) {}

    if (!branchExists) {
      // Create bot-data as orphan branch via temporary worktree approach
      console.log('[git] Creating bot-data branch...');
      execSync('git fetch origin main', { stdio: 'pipe' });
      execSync('git branch bot-data origin/main', { stdio: 'pipe' });
      execSync('git push origin bot-data', { stdio: 'pipe' });
    }

    // Add worktree for bot-data branch
    if (fs.existsSync(WORKTREE_DIR)) {
      try { execSync('git worktree remove --force ' + WORKTREE_DIR, { stdio: 'pipe' }); } catch(_) {}
    }
    execSync('git fetch origin bot-data:bot-data 2>/dev/null || git fetch origin bot-data', { stdio: 'pipe' });
    execSync('git worktree add ' + WORKTREE_DIR + ' bot-data', { stdio: 'pipe' });
    console.log('[git] bot-data worktree ready');
    return true;
  } catch(e) {
    console.error('[git] Worktree setup failed:', e.message.slice(0, 120));
    return false;
  }
}

let worktreeReady = false;

function pushStatusToBotData(statusJson) {
  // Ensure worktree is set up
  if (!worktreeReady) {
    worktreeReady = setupWorktree();
  }

  if (worktreeReady && fs.existsSync(WORKTREE_DIR)) {
    try {
      // Write directly into the worktree directory
      fs.writeFileSync(path.join(WORKTREE_DIR, 'status.json'), statusJson);
      execSync('git -C ' + WORKTREE_DIR + ' add status.json', { stdio: 'pipe' });
      try {
        execSync('git -C ' + WORKTREE_DIR + ' commit -m "chore: status update [skip ci]"', { stdio: 'pipe' });
        execSync('git -C ' + WORKTREE_DIR + ' push origin bot-data', { stdio: 'pipe' });
        console.log('[git] Pushed status to bot-data');
      } catch(_) {
        console.log('[git] Nothing changed in status.json');
      }
      return;
    } catch(e) {
      console.error('[git] Worktree push failed:', e.message.slice(0, 120));
    }
  }

  // Fallback: write to main branch (will trigger Pages but at least it works)
  try {
    fs.writeFileSync('status.json', statusJson);
    execSync('git add status.json', { stdio: 'pipe' });
    try {
      execSync('git commit -m "chore: status update [skip ci]"', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log('[git] Fallback: pushed to main');
    } catch(_) {}
  } catch(e) {
    console.error('[git] Fallback push failed:', e.message.slice(0, 80));
  }
}

function getTunnelUrl() {
  // Try reading from worktree first, then local
  const wtFile = path.join(WORKTREE_DIR, 'status.json');
  const localFile = 'status.json';
  for (const f of [wtFile, localFile]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).url || null; } catch(_) {}
  }
  return null;
}

function writeStatus(data) {
  const url = getTunnelUrl();
  const payload = { url, ts: Math.floor(Date.now() / 1000), ...data };
  const jsonStr = JSON.stringify(payload, null, 2);
  const qrLen = data.qr ? Math.round(data.qr.length / 1024) + 'KB' : 'none';
  console.log('[status] connected=' + data.connected + ' qr=' + qrLen);
  pushStatusToBotData(jsonStr);
}

// ── Main ─────────────────────────────────────────────────────────────────────
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
      } catch (err) {
        console.error('[runner] QR generation failed:', err.message);
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('[runner] Connection closed, reason:', reason);
      writeStatus({ connected: false, qr: null, error: null });

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
