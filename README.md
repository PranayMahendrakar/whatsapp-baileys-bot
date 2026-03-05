# 🤖 WhatsApp Baileys Bot

> **Educational project** for automating WhatsApp using the [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) library.  
> Read incoming messages and auto-reply — all via Node.js.

---

## 📁 Project Structure

```
whatsapp-baileys-bot/
├── .github/
│   └── workflows/
│       └── bot.yml          # GitHub Actions workflow
├── src/
│   └── bot.js               # Core Baileys connection & message handler
├── index.js                 # Entry point
├── package.json             # Dependencies & scripts
├── .gitignore               # Node / auth_info ignored
└── README.md
```

---

## ✨ Features

- ✅ Connects to WhatsApp via QR code (multi-device)  
- ✅ Reads all incoming private & group messages  
- ✅ Auto-replies with a command system  
- ✅ Persists session (no re-scan needed after first login)  
- ✅ GitHub Actions support (runs the bot in the cloud)  
- ✅ Reconnects automatically on disconnect  

---

## 🤖 Bot Commands

| Command | Response |
|---------|----------|
| `!ping` | Pong! — confirms bot is alive |
| `!help` | Shows all available commands |
| `!info` | Bot information |
| `!time` | Current server time |
| `!echo <text>` | Echoes your message back |

---

## 🚀 Local Setup (First Time — QR Scan Required)

### Prerequisites
- Node.js >= 18
- npm

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/PranayMahendrakar/whatsapp-baileys-bot.git
cd whatsapp-baileys-bot

# 2. Install dependencies
npm install

# 3. Start the bot (QR code will appear in terminal)
npm start
```

Scan the QR code with **WhatsApp → Linked Devices → Link a Device**.  
After scanning, an `auth_info/` folder is created with your session.

---

## ☁️ GitHub Actions Setup

The bot can run **continuously in the cloud** using GitHub Actions.

### Step 1 — First scan locally

Run `npm start` locally, scan QR, then package your session:

```bash
tar -czf auth_info.tar.gz -C auth_info/ .
base64 auth_info.tar.gz | tr -d '\n'
```

### Step 2 — Add the secret to GitHub

1. Go to your repo → **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `WHATSAPP_AUTH_DATA`
4. Value: paste the base64 string from Step 1
5. Save

### Step 3 — Trigger the workflow

Go to **Actions → WhatsApp Baileys Bot → Run workflow**.

The bot will restore your session, connect to WhatsApp, and start processing messages!

---

## 🔁 Re-authentication

If your session expires:
1. Delete the old `WHATSAPP_AUTH_DATA` secret
2. Run locally again to get a fresh QR
3. Re-package and upload the new session

---

## ⚠️ Disclaimer

This project is for **educational purposes only**.  
Using bots on WhatsApp may violate [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service).  
Use responsibly and only on accounts you own.

---

## 📄 License

MIT — © PranayMahendrakar
