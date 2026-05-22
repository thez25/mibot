// index.js (ESM) - DRX Monster Edition (STABLE)
// npm i @whiskeysockets/baileys pino node-cron qrcode-terminal

import fs from "fs";
import cron from "node-cron";
import pino from "pino";
import qrcode from "qrcode-terminal";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";
const TROLL_ALWAYS_ON = true;
const TROLL_CHANCE_BASE = 0.2;
const TROLL_COOLDOWN_MS = 15000;

// ====== CONFIG ======
const PREFIX = ".";
const SECRET = "bot-v5";
const DB_FILE = "./database.json";
const BRAND = "> DRAXYO";

// Moderación
const WARNS_TO_KICK = 3;

// Puntos
const POINTS_PER_WIN = 10;
const POINTS_TO_RESET = 100;

// Anti-spam interno
const seenMsgIds = new Set(); // dedupe
const privateCooldown = new Map(); // anti-spam privados
const PRIVATE_COOLDOWN_MS = 30_000; // 30s

// ====== DB ======
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const fresh = {
      allowedUsers: {},
      customCmds: {},
      games: {},
      schedules: {},
      warns: {},
      points: {},
      troll: {},
      welcomeMsgs: {},
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }

  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));

  // MIGRACIÓN segura
  raw.allowedUsers ??= {};
  raw.customCmds ??= {};
  raw.games ??= {};
  raw.schedules ??= {};
  raw.warns ??= {};
  raw.points ??= {};
  raw.troll ??= {};
  raw.welcomeMsgs ??= {};
  fs.writeFileSync(DB_FILE, JSON.stringify(raw, null, 2));
  return raw;
}
let db = loadDB();

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ====== HELPERS ======
const isGroup = (jid) => jid?.endsWith("@g.us");

function ensureGroupContainers(groupJid) {
  db.customCmds[groupJid] ??= {};
  db.schedules[groupJid] ??= {};
  db.games[groupJid] ??= { active: false, type: null };
  db.warns[groupJid] ??= {};
  db.points[groupJid] ??= {};
  db.troll[groupJid] ??= { enabled: TROLL_ALWAYS_ON };
  db.welcomeMsgs[groupJid] ??= null;
}

function withBrand(text) {
  const t = String(text || "").trim();
  if (!t) return t;
  if (t.endsWith(BRAND) || t.includes(`\n${BRAND}`)) return t;
  return `${t}\n\n${BRAND}`;
}
async function sendText(sock, jid, text, extra = {}) {
  return sock.sendMessage(jid, { text: withBrand(text), ...extra });
}

function nowHHMM() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function parseTimeToHHMM(input) {
  const s = (input || "").trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
  if (!m) return null;

  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3];

  if (mm < 0 || mm > 59) return null;

  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === "am") {
      if (hh === 12) hh = 0;
    } else {
      if (hh !== 12) hh += 12;
    }
  } else {
    if (hh < 0 || hh > 23) return null;
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function welcomePhrase() {
  const phrases = [
    "Bienvenid@, aquí se viene a dominar 😈",
    "Llegaste al lugar correcto. Pórtate o te portamos 😎",
    "Nuevo en el lobby… ¿traes nivel o puro cuento? 🔥",
    "Pasa, pero con respeto, aquí manda el cotorreo con orden 👊",
    "Bienvenid@, no te asustes si el bot te mira feo 🤖",
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function getWelcomeMessage(groupJid, user, total) {
  ensureGroupContainers(groupJid);

  const custom = db.welcomeMsgs[groupJid];

  if (custom && custom.trim()) {
    return custom
      .replace(/{user}/gi, `@${user.split("@")[0]}`)
      .replace(/{members}/gi, String(total))
      .replace(/{prefix}/gi, PREFIX);
  }

  return `╔══════════════════════╗
   🥷  *BIENVENID@*  🥷
╚══════════════════════╝

👤 @${user.split("@")[0]}
✨ ${welcomePhrase()}

👥 *Miembros:* ${total}

📌 *Reglas rápidas*
• Cero links / cero spam
• Respeto o pa’ fuera 😈

⚡ *Juegos*
• ${PREFIX}adivina 20
• ${PREFIX}ruleta
• ${PREFIX}ppt piedra

🏆 *Ranking*
• ${PREFIX}top
• ${PREFIX}puntos`;
}

function prettyTodosHeader() {
  const designs = [
    "✨ *LISTA DRAXYO* ✨",
    "🔥 *LLAMADO GENERAL* 🔥",
    "🚨 *ATENCIÓN GRUPO* 🚨",
    "⚡ *TODOS PRESENTES* ⚡",
  ];
  return designs[Math.floor(Math.random() * designs.length)];
}

function isAllowedPrivateUser(userJid) {
  return db.allowedUsers[userJid] === true;
}

async function setGroupAnnounce(sock, groupJid, close) {
  await sock.groupSettingUpdate(groupJid, close ? "announcement" : "not_announcement");
}

function looksLikeLink(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("http://") ||
    t.includes("https://") ||
    t.includes("www.") ||
    t.includes("wa.me/") ||
    t.includes("t.me/") ||
    t.includes(".com") ||
    t.includes(".net") ||
    t.includes(".org") ||
    t.includes(".gg") ||
    t.includes(".io") ||
    t.includes("bit.ly") ||
    t.includes("tinyurl") ||
    t.includes("chat.whatsapp.com/")
  );
}

function addWarn(groupJid, userJid) {
  ensureGroupContainers(groupJid);
  db.warns[groupJid][userJid] = (db.warns[groupJid][userJid] || 0) + 1;
  saveDB();
  return db.warns[groupJid][userJid];
}
function setWarn(groupJid, userJid, val) {
  ensureGroupContainers(groupJid);
  db.warns[groupJid][userJid] = Math.max(0, Number(val) || 0);
  saveDB();
  return db.warns[groupJid][userJid];
}

function getPoints(groupJid, userJid) {
  ensureGroupContainers(groupJid);
  return db.points[groupJid][userJid] || 0;
}
function addPoints(groupJid, userJid, amount) {
  ensureGroupContainers(groupJid);
  db.points[groupJid][userJid] = (db.points[groupJid][userJid] || 0) + amount;
  saveDB();
  return db.points[groupJid][userJid];
}
function resetAllPoints(groupJid) {
  ensureGroupContainers(groupJid);
  db.points[groupJid] = {};
  saveDB();
}
function topPoints(groupJid, limit = 10) {
  ensureGroupContainers(groupJid);
  const entries = Object.entries(db.points[groupJid] || {});
  entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
  return entries.slice(0, limit);
}

// ====== MEDIA HELPERS (para .n con reply) ======
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function resendQuotedMedia(sock, jid, quoted, caption = "") {
  if (!quoted) return false;

  if (quoted.imageMessage) {
    const stream = await downloadContentFromMessage(quoted.imageMessage, "image");
    const buffer = await streamToBuffer(stream);
    await sock.sendMessage(jid, { image: buffer, caption: withBrand(caption || "") });
    return true;
  }

  if (quoted.videoMessage) {
    const stream = await downloadContentFromMessage(quoted.videoMessage, "video");
    const buffer = await streamToBuffer(stream);
    await sock.sendMessage(jid, { video: buffer, caption: withBrand(caption || "") });
    return true;
  }

  if (quoted.conversation || quoted.extendedTextMessage?.text) {
    const qt = quoted.conversation || quoted.extendedTextMessage?.text || "";
    await sendText(sock, jid, qt);
    return true;
  }

  return false;
}

// ====== CRON: horarios ======
cron.schedule("* * * * *", async () => {
  try {
    if (!global.sock) return;
    const hhmm = nowHHMM();

    for (const groupJid of Object.keys(db.schedules)) {
      const sch = db.schedules[groupJid];
      if (!sch) continue;

      if (sch.open === hhmm) {
        await setGroupAnnounce(global.sock, groupJid, false);
        await sendText(global.sock, groupJid, `✅ Grupo *abierto* automáticamente (${hhmm}).`);
      }
      if (sch.close === hhmm) {
        await setGroupAnnounce(global.sock, groupJid, true);
        await sendText(global.sock, groupJid, `🔒 Grupo *cerrado* automáticamente (${hhmm}).`);
      }
    }
  } catch {}
});

// ====== GAMES ======
async function handleGuessNumber(sock, groupJid, senderJid, body) {
  const g = db.games[groupJid];
  if (!g?.active || g.type !== "guess") return false;

  const guess = parseInt(String(body).trim(), 10);
  if (!Number.isFinite(guess)) return false;

  if (guess < g.min || guess > g.max) {
    await sendText(sock, groupJid, `⛔ Debe ser entre *${g.min}* y *${g.max}*.`);
    return true;
  }

  g.tries[senderJid] = (g.tries[senderJid] || 0) + 1;

  if (guess === g.number) {
    const tries = g.tries[senderJid];
    db.games[groupJid] = { active: false, type: null };
    saveDB();

    const newPts = addPoints(groupJid, senderJid, POINTS_PER_WIN);
    await sendText(
      sock,
      groupJid,
      `🏆 @${senderJid.split("@")[0]} *GANÓ!* 🎉\nEl número era *${g.number}*.\nIntentos: *${tries}*\n+${POINTS_PER_WIN} puntos (Total: ${newPts})`,
      { mentions: [senderJid] }
    );

    if (newPts >= POINTS_TO_RESET) {
      resetAllPoints(groupJid);
      await sendText(
        sock,
        groupJid,
        `🔥 *CAMPEÓN/A* @${senderJid.split("@")[0]} llegó a *${POINTS_TO_RESET}* puntos.\n💥 Ranking reiniciado para todos.`,
        { mentions: [senderJid] }
      );
    }
    return true;
  }

  const hint = guess < g.number ? "📈 Más alto" : "📉 Más bajo";
  await sendText(sock, groupJid, `${hint} 😈`);
  saveDB();
  return true;
}

async function playRuleta(sock, groupJid, senderJid) {
  const death = Math.random() < 1 / 6;
  if (death) {
    await sendText(sock, groupJid, `💥🔫 @${senderJid.split("@")[0]} *BANG!* Te tocó… adiós.`, {
      mentions: [senderJid],
    });
    try {
      await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
    } catch {
      await sendText(sock, groupJid, "⛔ No pude expulsar (¿soy admin?).");
    }
    return;
  }

  const newPts = addPoints(groupJid, senderJid, POINTS_PER_WIN);
  await sendText(sock, groupJid, `😮‍💨🔫 @${senderJid.split("@")[0]} *sobrevivió*.\n+${POINTS_PER_WIN} puntos (Total: ${newPts})`, {
    mentions: [senderJid],
  });

  if (newPts >= POINTS_TO_RESET) {
    resetAllPoints(groupJid);
    await sendText(
      sock,
      groupJid,
      `🔥 *CAMPEÓN/A* @${senderJid.split("@")[0]} llegó a *${POINTS_TO_RESET}* puntos.\n💥 Ranking reiniciado para todos.`,
      { mentions: [senderJid] }
    );
  }
}

function rpsWinner(a, b) {
  if (a === b) return 0;
  if (a === "piedra" && b === "tijera") return 1;
  if (a === "tijera" && b === "papel") return 1;
  if (a === "papel" && b === "piedra") return 1;
  return -1;
}
async function playRPS(sock, groupJid, senderJid, choice) {
  const opts = ["piedra", "papel", "tijera"];
  const user = String(choice || "").toLowerCase();
  if (!opts.includes(user)) {
    await sendText(sock, groupJid, `Uso: ${PREFIX}ppt piedra | papel | tijera`);
    return;
  }
  const bot = opts[Math.floor(Math.random() * opts.length)];
  const res = rpsWinner(user, bot);

  if (res === 0) {
    await sendText(sock, groupJid, `🤝 Empate.\nTú: *${user}* | Bot: *${bot}*`);
    return;
  }
  if (res === -1) {
    await sendText(sock, groupJid, `❌ Perdiste.\nTú: *${user}* | Bot: *${bot}*`);
    return;
  }

  const newPts = addPoints(groupJid, senderJid, POINTS_PER_WIN);
  await sendText(sock, groupJid, `✅ Ganaste 😈\nTú: *${user}* | Bot: *${bot}*\n+${POINTS_PER_WIN} puntos (Total: ${newPts})`, {
    mentions: [senderJid],
  });

  if (newPts >= POINTS_TO_RESET) {
    resetAllPoints(groupJid);
    await sendText(
      sock,
      groupJid,
      `🔥 *CAMPEÓN/A* @${senderJid.split("@")[0]} llegó a *${POINTS_TO_RESET}* puntos.\n💥 Ranking reiniciado para todos.`,
      { mentions: [senderJid] }
    );
  }
}

// ====== MAIN ======
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

  global.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Escanea este QR (WhatsApp -> Dispositivos vinculados):");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) start();
    } else if (connection === "open") {
      console.log("✅ Bot conectado.");
    }
  });

  // Bienvenida
  sock.ev.on("group-participants.update", async (ev) => {
    try {
      const groupJid = ev.id;
      ensureGroupContainers(groupJid);

      if (ev.action === "add") {
        const meta = await sock.groupMetadata(groupJid);
        const total = meta.participants?.length || 0;

        for (const p of ev.participants) {
          const user = jidNormalizedUser(p);
          const msg = getWelcomeMessage(groupJid, user, total);
          await sendText(sock, groupJid, msg, { mentions: [user] });
        }
      }
    } catch {}
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message) return;

    // ====== HARD LOCKS ======
    if (msg.key?.fromMe) return;
    if (msg.key?.remoteJid === "status@broadcast") return;

    const id = msg.key?.id;
    if (id) {
      if (seenMsgIds.has(id)) return;
      seenMsgIds.add(id);
      setTimeout(() => seenMsgIds.delete(id), 5 * 60 * 1000);
    }
    // ========================

    const from = msg.key.remoteJid;
    const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      "";

    const body = (text || "").trim();
    if (!body) return;

    const group = isGroup(from);

    // ===== PRIVADO (cooldown) =====
    if (!group) {
      if (body === SECRET) {
        db.allowedUsers[sender] = true;
        saveDB();
        await sendText(sock, from, "✅ Acceso activado.");
        return;
      }
      if (!isAllowedPrivateUser(sender)) {
        const last = privateCooldown.get(sender) || 0;
        const now = Date.now();
        if (now - last > PRIVATE_COOLDOWN_MS) {
          privateCooldown.set(sender, now);
          await sendText(sock, from, "🔒 Manda la palabra secreta para activar acceso.");
        }
        return;
      }
      await sendText(sock, from, "✅ Acceso OK. (El bot se usa principalmente en grupos.)");
      return;
    }

    // ===== GRUPO =====
    ensureGroupContainers(from);

    // metadata / admin check
    let meta;
    let isAdmin = false;
    try {
      meta = await sock.groupMetadata(from);
      const part = meta.participants.find((p) => p.id === sender);
      isAdmin = part?.admin === "admin" || part?.admin === "superadmin";
    } catch {}

    const isCommand = body.startsWith(PREFIX);
    const gameActive = !!db.games[from]?.active;

    // Anti-link SOLO miembros (no admins)
    if (!isAdmin && looksLikeLink(body)) {
      const w = addWarn(from, sender);

      await sendText(
        sock,
        from,
        `🚫 *Anti-link*\n@${sender.split("@")[0]} advertencia *${w}/${WARNS_TO_KICK}*.\nSi llegas a ${WARNS_TO_KICK} → expulsión.`,
        { mentions: [sender] }
      );

      if (w >= WARNS_TO_KICK) {
        try {
          await sock.groupParticipantsUpdate(from, [sender], "remove");
          await sendText(sock, from, `🥾 Expulsado por acumular *${WARNS_TO_KICK}* advertencias.`, {
            mentions: [sender],
          });
        } catch {
          await sendText(sock, from, "⛔ No pude expulsar (¿soy admin?).");
        }
      }
      return;
    }

    // parse cmd
    const [cmdRaw, ...rest] = body.slice(PREFIX.length).split(" ");
    const cmd = (cmdRaw || "").toLowerCase();
    const args = rest.join(" ").trim();

    // Custom cmds (TODOS los pueden usar)
    if (db.customCmds[from]?.[cmd]) {
      await sendText(sock, from, db.customCmds[from][cmd]);
      return;
    }

    // Comandos públicos (miembros + admins)
    const PUBLIC_COMMANDS = new Set(["help", "juego", "adivina", "stopjuego", "ruleta", "ppt", "top", "puntos"]);

    if (!isAdmin && !PUBLIC_COMMANDS.has(cmd)) {
      return; // miembros no pueden otros
    }

    // ===== PUBLIC =====
    if (cmd === "help") {
      await sendText(
        sock,
        from,
`🤖 *Comandos*
🎮 *Juegos (todos)*
• ${PREFIX}adivina 20
• ${PREFIX}stopjuego
• ${PREFIX}ruleta
• ${PREFIX}ppt piedra|papel|tijera

🏆 *Puntos (todos)*
• ${PREFIX}top
• ${PREFIX}puntos (@user opcional)

👑 *Admins*
• ${PREFIX}n (texto o reply a imagen/video)
• ${PREFIX}todos
• ${PREFIX}kick @user (o reply)
• ${PREFIX}abrir / ${PREFIX}cerrar
• ${PREFIX}abrir 9:00am / ${PREFIX}cerrar 10:00pm
• ${PREFIX}horario
• ${PREFIX}newbienvenida texto
• ${PREFIX}resetbienvenida
• ${PREFIX}set nombre texto
• ${PREFIX}del nombre
• ${PREFIX}warn / ${PREFIX}warns / ${PREFIX}unwarn / ${PREFIX}resetwarns
• ${PREFIX}resetpuntos`
      );
      return;
    }

    if (cmd === "juego") {
      await sendText(sock, from, `🎮 Juegos: ${PREFIX}adivina 20 | ${PREFIX}ruleta | ${PREFIX}ppt piedra|papel|tijera`);
      return;
    }

    if (cmd === "adivina") {
      const max = parseInt(rest[0] || "20", 10);
      const min = 1;
      if (!Number.isFinite(max) || max < 2 || max > 500) {
        await sendText(sock, from, "⛔ Rango inválido. Usa: .adivina 20 (máx 500)");
        return;
      }
      const number = Math.floor(Math.random() * max) + min;
      db.games[from] = { active: true, type: "guess", number, tries: {}, min, max };
      saveDB();
      await sendText(sock, from, `🎲 *Adivina el número* iniciado!\nRango: *${min}..${max}*\nManden números 😈`);
      return;
    }

    if (cmd === "stopjuego") {
      db.games[from] = { active: false, type: null };
      saveDB();
      await sendText(sock, from, "🛑 Juego detenido.");
      return;
    }

    if (cmd === "ruleta") {
      await playRuleta(sock, from, sender);
      return;
    }

    if (cmd === "ppt") {
      await playRPS(sock, from, sender, rest[0]);
      return;
    }

    if (cmd === "puntos") {
      let target = sender;
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (mentioned) target = jidNormalizedUser(mentioned);

      const pts = getPoints(from, target);
      await sendText(sock, from, `🏆 Puntos de @${target.split("@")[0]}: *${pts}*`, { mentions: [target] });
      return;
    }

    if (cmd === "top") {
      const top = topPoints(from, 10);
      if (!top.length) {
        await sendText(sock, from, "🏆 Aún no hay puntos. Jueguen algo 😈");
        return;
      }
      const lines = top.map(([jid, pts], i) => `${i + 1}. @${jid.split("@")[0]} — *${pts}*`);
      await sendText(sock, from, `🏆 *TOP 10*\n\n${lines.join("\n")}`, { mentions: top.map(([jid]) => jid) });
      return;
    }

    // ===== ADMIN =====
    // quotedMessage para .n y .kick
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage || null;

    if (cmd === "n") {
      if (quoted) {
        const ok = await resendQuotedMedia(sock, from, quoted, args);
        if (!ok) {
          await sendText(sock, from, "⛔ Ese tipo de mensaje no lo puedo reenviar con .n (solo texto/imagen/video).");
        }
        return;
      }

      if (!args) {
        await sendText(sock, from, `Uso: ${PREFIX}n texto\nO responde a una imagen/video y escribe ${PREFIX}n (opcional caption)`);
        return;
      }
      await sendText(sock, from, args);
      return;
    }

    if (cmd === "kick") {
      let target = null;

      const mentioned = ctx?.mentionedJid?.[0];
      const quotedSender = ctx?.participant;

      if (mentioned) target = jidNormalizedUser(mentioned);
      else if (quotedSender) target = jidNormalizedUser(quotedSender);

      if (!target) {
        await sendText(sock, from, `Uso: ${PREFIX}kick @usuario\nO responde al mensaje del usuario y pon ${PREFIX}kick`);
        return;
      }

      try {
        await sock.groupParticipantsUpdate(from, [target], "remove");
        await sendText(sock, from, `🥾 @${target.split("@")[0]} expulsado.`, { mentions: [target] });
      } catch {
        await sendText(sock, from, "⛔ No pude expulsar (¿soy admin?).");
      }
      return;
    }

    if (cmd === "todos") {
      const participants = meta?.participants || [];
      const mentions = participants.map((p) => p.id);
      const header = prettyTodosHeader();
      const list = participants.map((p, i) => `• ${i + 1}. @${p.id.split("@")[0]}`).join("\n");
      await sendText(sock, from, `${header}\n\n${list}\n\n📌 *Fin de lista*`, { mentions });
      return;
    }

    if (cmd === "abrir") {
      if (args) {
        const t = parseTimeToHHMM(args);
        if (!t) return sendText(sock, from, "⛔ Hora inválida. Ej: .abrir 9:00am o .abrir 21:30");
        db.schedules[from].open = t;
        saveDB();
        await sendText(sock, from, `✅ Programado: abrir diario a las *${t}*.`);
        return;
      }
      try {
        await setGroupAnnounce(sock, from, false);
        await sendText(sock, from, "✅ Grupo abierto.");
      } catch {
        await sendText(sock, from, "⛔ No pude abrir (¿soy admin?).");
      }
      return;
    }

    if (cmd === "cerrar") {
      if (args) {
        const t = parseTimeToHHMM(args);
        if (!t) return sendText(sock, from, "⛔ Hora inválida. Ej: .cerrar 10:00pm o .cerrar 22:00");
        db.schedules[from].close = t;
        saveDB();
        await sendText(sock, from, `✅ Programado: cerrar diario a las *${t}*.`);
        return;
      }
      try {
        await setGroupAnnounce(sock, from, true);
        await sendText(sock, from, "🔒 Grupo cerrado.");
      } catch {
        await sendText(sock, from, "⛔ No pude cerrar (¿soy admin?).");
      }
      return;
    }

    if (cmd === "horario") {
      const sch = db.schedules[from] || {};
      await sendText(sock, from, `⏰ Abrir: ${sch.open || "No"} | Cerrar: ${sch.close || "No"}`);
      return;
    }

    if (cmd === "newbienvenida") {
      if (!args) {
        await sendText(
          sock,
          from,
          `Uso: ${PREFIX}newbienvenida texto\n\nVariables:\n{user} = usuario\n{members} = total miembros\n{prefix} = prefijo`
        );
        return;
      }

      db.welcomeMsgs[from] = args;
      saveDB();

      await sendText(sock, from, "✅ Bienvenida actualizada.");
      return;
    }

    if (cmd === "resetbienvenida") {
      db.welcomeMsgs[from] = null;
      saveDB();
      await sendText(sock, from, "✅ Bienvenida restaurada a la original.");
      return;
    }

    if (cmd === "set") {
      const name = (rest[0] || "").toLowerCase();
      const value = rest.slice(1).join(" ").trim();
      if (!name || !value) {
        await sendText(sock, from, `Uso: ${PREFIX}set reglas No spam\nLuego: ${PREFIX}reglas`);
        return;
      }

      const reserved = new Set([
        "help","juego","adivina","stopjuego","ruleta","ppt","top","puntos",
        "n","todos","kick","abrir","cerrar","horario","set","del",
        "warn","warns","unwarn","resetwarns","resetpuntos",
        "newbienvenida","resetbienvenida"
      ]);
      if (reserved.has(name)) {
        await sendText(sock, from, "⛔ Ese nombre está reservado.");
        return;
      }

      db.customCmds[from][name] = value;
      saveDB();
      await sendText(sock, from, `✅ Listo. Nuevo comando: *${PREFIX}${name}*`);
      return;
    }

    if (cmd === "del") {
      const name = (rest[0] || "").toLowerCase();
      if (!name) return sendText(sock, from, `Uso: ${PREFIX}del nombre`);
      if (!db.customCmds[from]?.[name]) return sendText(sock, from, "⛔ Ese comando no existe.");
      delete db.customCmds[from][name];
      saveDB();
      await sendText(sock, from, `🗑️ Borrado: *${PREFIX}${name}*`);
      return;
    }

    const mentioned = ctx?.mentionedJid?.[0];
    const target = mentioned ? jidNormalizedUser(mentioned) : null;

    if (cmd === "warn") {
      if (!target) return sendText(sock, from, `Uso: ${PREFIX}warn @usuario`);
      const w = addWarn(from, target);
      await sendText(sock, from, `⚠️ @${target.split("@")[0]} warn *${w}/${WARNS_TO_KICK}*`, { mentions: [target] });

      if (w >= WARNS_TO_KICK) {
        try {
          await sock.groupParticipantsUpdate(from, [target], "remove");
          await sendText(sock, from, `🥾 Expulsado por *${WARNS_TO_KICK}* warns.`, { mentions: [target] });
        } catch {
          await sendText(sock, from, "⛔ No pude expulsar (¿soy admin?).");
        }
      }
      return;
    }

    if (cmd === "unwarn") {
      if (!target) return sendText(sock, from, `Uso: ${PREFIX}unwarn @usuario`);
      const current = db.warns[from]?.[target] || 0;
      const w = setWarn(from, target, current - 1);
      await sendText(sock, from, `✅ @${target.split("@")[0]} ahora tiene *${w}* warns.`, { mentions: [target] });
      return;
    }

    if (cmd === "warns") {
      if (!target) return sendText(sock, from, `Uso: ${PREFIX}warns @usuario`);
      const w = db.warns[from]?.[target] || 0;
      await sendText(sock, from, `📌 @${target.split("@")[0]} tiene *${w}/${WARNS_TO_KICK}* warns.`, { mentions: [target] });
      return;
    }

    if (cmd === "resetwarns") {
      if (!target) return sendText(sock, from, `Uso: ${PREFIX}resetwarns @usuario`);
      setWarn(from, target, 0);
      await sendText(sock, from, `🧼 Warns reseteados para @${target.split("@")[0]}.`, { mentions: [target] });
      return;
    }

    if (cmd === "resetpuntos") {
      resetAllPoints(from);
      await sendText(sock, from, "💥 Ranking reseteado para todos.");
      return;
    }

if (isCommand) {
  await sendText(sock, from, `🤔 No conozco ese comando. Usa ${PREFIX}help`);
}
  });
}

start();