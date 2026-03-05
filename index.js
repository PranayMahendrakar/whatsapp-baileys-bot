// index.js - Entry point: starts Web UI server + WhatsApp bot
import { startServer } from './src/server.js';
import { startBot }    from './src/bot.js';

console.log('WhatsApp Baileys Bot + Web UI');
console.log('Educational project - PranayMahendrakar');
console.log('');

startServer()
  .then(() => startBot())
  .catch(err => { console.error('Fatal:', err); process.exit(1); });
