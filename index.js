// index.js - WhatsApp Bot Entry Point
// Educational project using @whiskeysockets/baileys

import { startBot } from './src/bot.js';

console.log('🚀 Starting WhatsApp Bot...');
console.log('📚 Educational WhatsApp Automation Bot');
console.log('⚠️  For educational purposes only');
console.log('');

startBot().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
