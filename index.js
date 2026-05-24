// ============================================================
//  DRX Monster Bot — index.js (ESM)
//  npm i @whiskeysockets/baileys pino node-cron qrcode qrcode-terminal
// ============================================================

import fs   from "fs";
import http from "http";
import cron from "node-cron";
import pino from "pino";
import QRCode    from "qrcode";           // genera imagen PNG
import qrTerminal from "qrcode-terminal"; // fallback en consola
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";

// ============================================================
//  ⚙️  CONFIGURACIÓN — edita sólo esta sección
// ============================================================
const CONFIG = {
  prefix:           ".",         // Prefijo de comandos
  secret:           "bot-v5",   // Palabra secreta para acceso privado
  dbFile:           "./database.json",
  brand:            "> DRAXYO", // Firma al final de cada mensaje

  // Moderación
  warnsToKick:      3,          // Warns antes de expulsión

  // Puntos
  pointsPerWin:     10,         // Puntos por ganar un juego
  pointsToReset:    100,        // Puntos acumulados que reinician el ranking

  // Anti-spam privado
  privateCooldownMs: 30_000,   // 30 segundos entre mensajes privados (chats privados)

  // Servidor HTTP (Railway / Render necesitan un puerto abierto)
  httpPort:         process.env.PORT || 3000,
};
// ============================================================

// ============================================================
//  🌐  SERVIDOR HTTP — QR en navegador + keep-alive
// ============================================================
let lastQRData = ""; // Guarda el último QR recibido

const server = http.createServer(async (req, res) => {
  // GET /qr  → imagen PNG escaneable desde el celular
  if (req.url === "/qr") {
    if (!lastQRData) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>⏳ El QR aún no está listo</h2>
          <p>Espera unos segundos y recarga la página.</p>
          <script>setTimeout(()=>location.reload(), 3000)</script>
        </body></html>
      `);
      return;
    }
    try {
      const png = await QRCode.toBuffer(lastQRData);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    } catch {
      res.writeHead(500);
      res.end("Error generando QR");
    }
    return;
  }

  // GET /  → página de estado
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee">
      <h1>🤖 DRX Monster Bot</h1>
      <p>Bot activo ✅</p>
      <a href="/qr" style="color:#4fc3f7">
        <button style="padding:12px 24px;font-size:16px;cursor:pointer;border-radius:8px">
          📷 Ver QR para vincular WhatsApp
        </button>
      </a>
    </body></html>
  `);
});

server.listen(CONFIG.httpPort, () => {
  console.log(`🌐 Servidor HTTP en puerto ${CONFIG.httpPort}`);
  console.log(`📷 Abre /qr en el navegador para escanear el QR`);
});

// ============================================================
//  🗄️  BASE DE DATOS
// ============================================================
const DB_DEFAULTS = {
  allowedUsers: {},
  customCmds:   {},
  games:        {},
  schedules:    {},
  warns:        {},
  points:       {},
  troll:        {},
  welcomeMsgs:  {},
};

function loadDB() {
  if (!fs.existsSync(CONFIG.dbFile)) {
    fs.writeFileSync(CONFIG.dbFile, JSON.stringify(DB_DEFAULTS, null, 2));
    return structuredClone(DB_DEFAULTS);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG.dbFile, "utf-8"));
  for (const key of Object.keys(DB_DEFAULTS)) raw[key] ??= DB_DEFAULTS[key];
  fs.writeFileSync(CONFIG.dbFile, JSON.stringify(raw, null, 2));
  return raw;
}

let db = loadDB();

function saveDB() {
  fs.writeFileSync(CONFIG.dbFile, JSON.stringify(db, null, 2));
}

function ensureGroup(gid) {
  db.customCmds[gid]  ??= {};
  db.schedules[gid]   ??= {};
  db.games[gid]       ??= { active: false, type: null };
  db.warns[gid]       ??= {};
  db.points[gid]      ??= {};
  db.troll[gid]       ??= { enabled: true };
  db.welcomeMsgs[gid] ??= null;
}

// ============================================================
//  🔧  HELPERS GENERALES
// ============================================================
const isGroup = (jid) => jid?.endsWith("@g.us");

function withBrand(text) {
  const t = String(text || "").trim();
  if (!t || t.includes(CONFIG.brand)) return t;
  return `${t}\n\n${CONFIG.brand}`;
}

async function sendText(sock, jid, text, extra = {}) {
  return sock.sendMessage(jid, { text: withBrand(text), ...extra });
}

function nowHHMM() {
  const d  = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseTimeToHHMM(input) {
  const m = (input || "").trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
  if (!m) return null;

  let hh   = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3];

  if (mm < 0 || mm > 59) return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === "am") { if (hh === 12) hh = 0; }
    else             { if (hh !== 12) hh += 12; }
  } else {
    if (hh < 0 || hh > 23) return null;
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

async function setGroupAnnounce(sock, gid, close) {
  await sock.groupSettingUpdate(gid, close ? "announcement" : "not_announcement");
}

// ============================================================
//  🔗  ANTI-LINK
//  Los correos electrónicos (algo@dominio.com) NO se bloquean.
//  Solo se bloquean URLs reales y dominios sueltos.
// ============================================================
function looksLikeLink(text) {
  const t = String(text || "").toLowerCase();

  const urlPatterns = [
    /https?:\/\//,
    /www\./,
    /wa\.me\//,
    /t\.me\//,
    /chat\.whatsapp\.com\//,
    /bit\.ly/,
    /tinyurl/,
  ];
  if (urlPatterns.some((re) => re.test(t))) return true;

  // Quitamos correos del texto antes de buscar dominios
  const sinCorreos = t.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g, "");

  const domainPatterns = [
    /(?<![^\s@])[\w-]+\.com(?!\w)/,
    /(?<![^\s@])[\w-]+\.net(?!\w)/,
    /(?<![^\s@])[\w-]+\.org(?!\w)/,
    /(?<![^\s@])[\w-]+\.gg(?!\w)/,
    /(?<![^\s@])[\w-]+\.io(?!\w)/,
  ];
  return domainPatterns.some((re) => re.test(sinCorreos));
}

// ============================================================
//  ⚠️  WARNS
// ============================================================
function addWarn(gid, uid) {
  ensureGroup(gid);
  db.warns[gid][uid] = (db.warns[gid][uid] || 0) + 1;
  saveDB();
  return db.warns[gid][uid];
}

function setWarn(gid, uid, val) {
  ensureGroup(gid);
  db.warns[gid][uid] = Math.max(0, Number(val) || 0);
  saveDB();
  return db.warns[gid][uid];
}

// ============================================================
//  🏆  PUNTOS
// ============================================================
function getPoints(gid, uid) { ensureGroup(gid); return db.points[gid][uid] || 0; }
function resetAllPoints(gid) { ensureGroup(gid); db.points[gid] = {}; saveDB(); }

function addPoints(gid, uid, n) {
  ensureGroup(gid);
  db.points[gid][uid] = (db.points[gid][uid] || 0) + n;
  saveDB();
  return db.points[gid][uid];
}

function topPoints(gid, limit = 10) {
  ensureGroup(gid);
  return Object.entries(db.points[gid] || {})
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, limit);
}

// ============================================================
//  🎉  BIENVENIDA
// ============================================================
const WELCOME_PHRASES = [
  "Bienvenid@, aquí se viene a dominar 😈",
  "Llegaste al lugar correcto. Pórtate o te portamos 😎",
  "Nuevo en el lobby… ¿traes nivel o puro cuento? 🔥",
  "Pasa, pero con respeto, aquí manda el cotorreo con orden 👊",
  "Bienvenid@, no te asustes si el bot te mira feo 🤖",
];

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getWelcomeMessage(gid, userJid, total) {
  ensureGroup(gid);
  const custom = db.welcomeMsgs[gid];
  const nick   = userJid.split("@")[0];

  if (custom?.trim()) {
    return custom
      .replace(/{user}/gi,    `@${nick}`)
      .replace(/{members}/gi, String(total))
      .replace(/{prefix}/gi,  CONFIG.prefix);
  }

  return `╔══════════════════════╗
   🥷  *BIENVENID@*  🥷
╚══════════════════════╝

👤 @${nick}
✨ ${randomFrom(WELCOME_PHRASES)}

👥 *Miembros:* ${total}

📌 *Reglas rápidas*
• Cero links / cero spam
• Respeto o pa' fuera 😈

⚡ *Juegos*
• ${CONFIG.prefix}adivina 20
• ${CONFIG.prefix}ruleta
• ${CONFIG.prefix}ppt piedra

🏆 *Ranking*
• ${CONFIG.prefix}top
• ${CONFIG.prefix}puntos`;
}

// ============================================================
//  📣  TODOS
// ============================================================
const TODOS_HEADERS = [
  "✨ *LISTA DRAXYO* ✨",
  "🔥 *LLAMADO GENERAL* 🔥",
  "🚨 *ATENCIÓN GRUPO* 🚨",
  "⚡ *TODOS PRESENTES* ⚡",
];

// ============================================================
//  📦  MEDIA: reenviar mensaje citado
// ============================================================
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function resendQuotedMedia(sock, jid, quoted, caption = "") {
  if (!quoted) return false;

  if (quoted.imageMessage) {
    const buf = await streamToBuffer(await downloadContentFromMessage(quoted.imageMessage, "image"));
    await sock.sendMessage(jid, { image: buf, caption: withBrand(caption) });
    return true;
  }
  if (quoted.videoMessage) {
    const buf = await streamToBuffer(await downloadContentFromMessage(quoted.videoMessage, "video"));
    await sock.sendMessage(jid, { video: buf, caption: withBrand(caption) });
    return true;
  }
  const qt = quoted.conversation || quoted.extendedTextMessage?.text;
  if (qt) { await sendText(sock, jid, qt); return true; }

  return false;
}

// ============================================================
//  ⏰  CRON: abrir / cerrar grupo automáticamente
// ============================================================
cron.schedule("* * * * *", async () => {
  try {
    if (!global.sock) return;
    const hhmm = nowHHMM();
    for (const [gid, sch] of Object.entries(db.schedules)) {
      if (!sch) continue;
      if (sch.open  === hhmm) {
        await setGroupAnnounce(global.sock, gid, false);
        await sendText(global.sock, gid, `✅ Grupo *abierto* automáticamente (${hhmm}).`);
      }
      if (sch.close === hhmm) {
        await setGroupAnnounce(global.sock, gid, true);
        await sendText(global.sock, gid, `🔒 Grupo *cerrado* automáticamente (${hhmm}).`);
      }
    }
  } catch {}
});

// ============================================================
//  🎮  JUEGOS
// ============================================================

async function handleGuessNumber(sock, gid, uid, body) {
  const g = db.games[gid];
  if (!g?.active || g.type !== "guess") return false;

  const guess = parseInt(String(body).trim(), 10);
  if (!Number.isFinite(guess)) return false;

  if (guess < g.min || guess > g.max) {
    await sendText(sock, gid, `⛔ Debe ser entre *${g.min}* y *${g.max}*.`);
    return true;
  }

  g.tries[uid] = (g.tries[uid] || 0) + 1;

  if (guess === g.number) {
    const tries   = g.tries[uid];
    db.games[gid] = { active: false, type: null };
    saveDB();
    const newPts  = addPoints(gid, uid, CONFIG.pointsPerWin);
    await sendText(
      sock, gid,
      `🏆 @${uid.split("@")[0]} *GANÓ!* 🎉\nEl número era *${g.number}*.\nIntentos: *${tries}*\n+${CONFIG.pointsPerWin} pts (Total: ${newPts})`,
      { mentions: [uid] }
    );
    await checkChampion(sock, gid, uid, newPts);
    return true;
  }

  await sendText(sock, gid, `${guess < g.number ? "📈 Más alto" : "📉 Más bajo"} 😈`);
  saveDB();
  return true;
}

async function playRuleta(sock, gid, uid) {
  if (Math.random() < 1 / 6) {
    await sendText(sock, gid, `💥🔫 @${uid.split("@")[0]} *BANG!* Te tocó… adiós.`, { mentions: [uid] });
    try { await sock.groupParticipantsUpdate(gid, [uid], "remove"); }
    catch { await sendText(sock, gid, "⛔ No pude expulsar (¿soy admin?)."); }
    return;
  }
  const newPts = addPoints(gid, uid, CONFIG.pointsPerWin);
  await sendText(
    sock, gid,
    `😮‍💨🔫 @${uid.split("@")[0]} *sobrevivió*.\n+${CONFIG.pointsPerWin} pts (Total: ${newPts})`,
    { mentions: [uid] }
  );
  await checkChampion(sock, gid, uid, newPts);
}

const RPS_OPTS = ["piedra", "papel", "tijera"];
function rpsWinner(a, b) {
  if (a === b) return 0;
  if ((a === "piedra" && b === "tijera") ||
      (a === "tijera"  && b === "papel")  ||
      (a === "papel"   && b === "piedra")) return 1;
  return -1;
}

async function playRPS(sock, gid, uid, choice) {
  const user = String(choice || "").toLowerCase();
  if (!RPS_OPTS.includes(user)) {
    await sendText(sock, gid, `Uso: ${CONFIG.prefix}ppt piedra | papel | tijera`);
    return;
  }
  const bot = randomFrom(RPS_OPTS);
  const res = rpsWinner(user, bot);

  if (res === 0) { await sendText(sock, gid, `🤝 Empate.\nTú: *${user}* | Bot: *${bot}*`); return; }
  if (res < 0)   { await sendText(sock, gid, `❌ Perdiste.\nTú: *${user}* | Bot: *${bot}*`); return; }

  const newPts = addPoints(gid, uid, CONFIG.pointsPerWin);
  await sendText(
    sock, gid,
    `✅ Ganaste 😈\nTú: *${user}* | Bot: *${bot}*\n+${CONFIG.pointsPerWin} pts (Total: ${newPts})`,
    { mentions: [uid] }
  );
  await checkChampion(sock, gid, uid, newPts);
}

async function checkChampion(sock, gid, uid, pts) {
  if (pts < CONFIG.pointsToReset) return;
  resetAllPoints(gid);
  await sendText(
    sock, gid,
    `🔥 *CAMPEÓN/A* @${uid.split("@")[0]} llegó a *${CONFIG.pointsToReset}* puntos.\n💥 Ranking reiniciado para todos.`,
    { mentions: [uid] }
  );
}

// ============================================================
//  🚀  INICIO DEL BOT
// ============================================================
const seenMsgIds      = new Set();
const privateCooldown = new Map();

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }) });
  global.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  // ── Conexión ───────────────────────────────────────────────
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQRData = qr; // guardamos para servir por HTTP
      qrTerminal.generate(qr, { small: true }); // también en consola por si acaso
      console.log(`📷 QR listo → abre https://tu-app.railway.app/qr en el navegador`);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) start();
    } else if (connection === "open") {
      lastQRData = ""; // limpiamos el QR una vez conectado
      console.log("✅ Bot conectado.");
    }
  });

  // ── Bienvenida a nuevos miembros ───────────────────────────
  sock.ev.on("group-participants.update", async (ev) => {
    try {
      if (ev.action !== "add") return;
      const gid   = ev.id;
      ensureGroup(gid);
      const meta  = await sock.groupMetadata(gid);
      const total = meta.participants?.length || 0;

      for (const p of ev.participants) {
        const user = jidNormalizedUser(p);
        await sendText(sock, gid, getWelcomeMessage(gid, user, total), { mentions: [user] });
      }
    } catch {}
  });

  // ── Mensajes ───────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message) return;
    if (msg.key?.fromMe) return;
    if (msg.key?.remoteJid === "status@broadcast") return;

    // Deduplicar
    const msgId = msg.key?.id;
    if (msgId) {
      if (seenMsgIds.has(msgId)) return;
      seenMsgIds.add(msgId);
      setTimeout(() => seenMsgIds.delete(msgId), 5 * 60 * 1000);
    }

    const from   = msg.key.remoteJid;
    const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
    const body   = (
      msg.message.conversation              ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption     ||
      msg.message.videoMessage?.caption     || ""
    ).trim();

    if (!body) return;

    // ── Mensajes privados ────────────────────────────────────
    if (!isGroup(from)) {
      if (body === CONFIG.secret) {
        db.allowedUsers[sender] = true;
        saveDB();
        await sendText(sock, from, "✅ Acceso activado.");
        return;
      }
      if (!db.allowedUsers[sender]) {
        const last = privateCooldown.get(sender) || 0;
        const now  = Date.now();
        if (now - last > CONFIG.privateCooldownMs) {
          privateCooldown.set(sender, now);
          await sendText(sock, from, "🔒 Manda la palabra secreta para activar acceso.");
        }
        return;
      }
      await sendText(sock, from, "✅ Acceso OK. (El bot se usa principalmente en grupos.)");
      return;
    }

    // ── Mensajes en grupo ────────────────────────────────────
    const gid = from;
    ensureGroup(gid);

    let meta    = null;
    let isAdmin = false;
    try {
      meta    = await sock.groupMetadata(gid);
      const p = meta.participants.find((p) => p.id === sender);
      isAdmin = p?.admin === "admin" || p?.admin === "superadmin";
    } catch {}

    // Anti-link (solo no-admins)
    if (!isAdmin && looksLikeLink(body)) {
      const w = addWarn(gid, sender);
      await sendText(
        sock, gid,
        `🚫 *Anti-link*\n@${sender.split("@")[0]} advertencia *${w}/${CONFIG.warnsToKick}*.\nSi llegas a ${CONFIG.warnsToKick} → expulsión.`,
        { mentions: [sender] }
      );
      if (w >= CONFIG.warnsToKick) {
        try {
          await sock.groupParticipantsUpdate(gid, [sender], "remove");
          await sendText(sock, gid, `🥾 Expulsado por *${CONFIG.warnsToKick}* advertencias.`, { mentions: [sender] });
        } catch { await sendText(sock, gid, "⛔ No pude expulsar (¿soy admin?)."); }
      }
      return;
    }

    // Juego activo: capturar número sin prefijo
    if (db.games[gid]?.active && !body.startsWith(CONFIG.prefix)) {
      await handleGuessNumber(sock, gid, sender, body);
      return;
    }

    if (!body.startsWith(CONFIG.prefix)) return;

    const [rawCmd, ...rest] = body.slice(CONFIG.prefix.length).split(" ");
    const cmd  = rawCmd.toLowerCase();
    const args = rest.join(" ").trim();

    // Comandos personalizados (cualquier miembro)
    if (db.customCmds[gid]?.[cmd]) {
      await sendText(sock, gid, db.customCmds[gid][cmd]);
      return;
    }

    // Comandos públicos
    const PUBLIC_CMDS = new Set(["help","juego","adivina","stopjuego","ruleta","ppt","top","puntos"]);
    if (!isAdmin && !PUBLIC_CMDS.has(cmd)) return;

    // ── Comandos públicos ────────────────────────────────────

    if (cmd === "help") {
      const p = CONFIG.prefix;
      await sendText(sock, gid,
`🤖 *Comandos disponibles*

🎮 *Juegos (todos)*
• ${p}adivina 20 — adivina el número
• ${p}stopjuego  — detener juego actual
• ${p}ruleta     — ruleta rusa
• ${p}ppt piedra|papel|tijera

🏆 *Puntos (todos)*
• ${p}top          — top 10
• ${p}puntos       — tus puntos (o @mención)

👑 *Solo admins*
• ${p}n texto           — anuncio anónimo
• ${p}n (reply img/vid) — reenviar sin autor
• ${p}todos             — mencionar a todos
• ${p}kick @user        — expulsar (o reply)
• ${p}abrir / ${p}cerrar
• ${p}abrir 9:00am / ${p}cerrar 22:00
• ${p}horario
• ${p}warn / ${p}warns / ${p}unwarn / ${p}resetwarns @user
• ${p}resetpuntos
• ${p}newbienvenida texto
• ${p}resetbienvenida
• ${p}set nombre texto
• ${p}del nombre`
      );
      return;
    }

    if (cmd === "juego") {
      const p = CONFIG.prefix;
      await sendText(sock, gid,
        `🎮 *Juegos disponibles:*\n• ${p}adivina 20\n• ${p}ruleta\n• ${p}ppt piedra|papel|tijera`
      );
      return;
    }

    if (cmd === "adivina") {
      const max = parseInt(rest[0] || "20", 10);
      if (!Number.isFinite(max) || max < 2 || max > 500) {
        await sendText(sock, gid, "⛔ Rango inválido. Ej: .adivina 20 (máx 500)");
        return;
      }
      const number = Math.floor(Math.random() * max) + 1;
      db.games[gid] = { active: true, type: "guess", number, tries: {}, min: 1, max };
      saveDB();
      await sendText(sock, gid, `🎲 *Adivina el número* iniciado!\nRango: *1 - ${max}*\nManden números 😈`);
      return;
    }

    if (cmd === "stopjuego") {
      db.games[gid] = { active: false, type: null };
      saveDB();
      await sendText(sock, gid, "🛑 Juego detenido.");
      return;
    }

    if (cmd === "ruleta") { await playRuleta(sock, gid, sender); return; }
    if (cmd === "ppt")    { await playRPS(sock, gid, sender, rest[0]); return; }

    if (cmd === "puntos") {
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const target    = mentioned ? jidNormalizedUser(mentioned) : sender;
      const pts       = getPoints(gid, target);
      await sendText(sock, gid, `🏆 Puntos de @${target.split("@")[0]}: *${pts}*`, { mentions: [target] });
      return;
    }

    if (cmd === "top") {
      const top = topPoints(gid, 10);
      if (!top.length) { await sendText(sock, gid, "🏆 Aún no hay puntos. ¡Jueguen algo! 😈"); return; }
      const lines = top.map(([uid, pts], i) => `${i + 1}. @${uid.split("@")[0]} — *${pts}*`);
      await sendText(sock, gid, `🏆 *TOP 10*\n\n${lines.join("\n")}`, { mentions: top.map(([uid]) => uid) });
      return;
    }

    // ── Comandos de admin ────────────────────────────────────

    const ctx          = msg.message?.extendedTextMessage?.contextInfo;
    const quoted       = ctx?.quotedMessage || null;
    const quotedSender = ctx?.participant   || null;
    const mentionedJid = ctx?.mentionedJid?.[0] || null;

    if (cmd === "n") {
      if (quoted) {
        const ok = await resendQuotedMedia(sock, gid, quoted, args);
        if (!ok) await sendText(sock, gid, "⛔ Solo puedo reenviar texto, imagen o video.");
        return;
      }
      if (!args) {
        await sendText(sock, gid, `Uso: ${CONFIG.prefix}n texto\nO responde a una imagen/video con ${CONFIG.prefix}n`);
        return;
      }
      await sendText(sock, gid, args);
      return;
    }

    if (cmd === "kick") {
      const target = mentionedJid
        ? jidNormalizedUser(mentionedJid)
        : quotedSender ? jidNormalizedUser(quotedSender) : null;
      if (!target) {
        await sendText(sock, gid, `Uso: ${CONFIG.prefix}kick @usuario\nO responde al mensaje y pon ${CONFIG.prefix}kick`);
        return;
      }
      try {
        await sock.groupParticipantsUpdate(gid, [target], "remove");
        await sendText(sock, gid, `🥾 @${target.split("@")[0]} expulsado.`, { mentions: [target] });
      } catch { await sendText(sock, gid, "⛔ No pude expulsar (¿soy admin?)."); }
      return;
    }

    if (cmd === "todos") {
      const participants = meta?.participants || [];
      const mentions     = participants.map((p) => p.id);
      const header       = randomFrom(TODOS_HEADERS);
      const list         = participants.map((p, i) => `• ${i + 1}. @${p.id.split("@")[0]}`).join("\n");
      await sendText(sock, gid, `${header}\n\n${list}\n\n📌 *Fin de lista*`, { mentions });
      return;
    }

    if (cmd === "abrir") {
      if (args) {
        const t = parseTimeToHHMM(args);
        if (!t) { await sendText(sock, gid, "⛔ Hora inválida. Ej: .abrir 9:00am o .abrir 21:30"); return; }
        db.schedules[gid].open = t;
        saveDB();
        await sendText(sock, gid, `✅ Programado: abrir diario a las *${t}*.`);
        return;
      }
      try {
        await setGroupAnnounce(sock, gid, false);
        await sendText(sock, gid, "✅ Grupo abierto.");
      } catch { await sendText(sock, gid, "⛔ No pude abrir (¿soy admin?)."); }
      return;
    }

    if (cmd === "cerrar") {
      if (args) {
        const t = parseTimeToHHMM(args);
        if (!t) { await sendText(sock, gid, "⛔ Hora inválida. Ej: .cerrar 10:00pm o .cerrar 22:00"); return; }
        db.schedules[gid].close = t;
        saveDB();
        await sendText(sock, gid, `✅ Programado: cerrar diario a las *${t}*.`);
        return;
      }
      try {
        await setGroupAnnounce(sock, gid, true);
        await sendText(sock, gid, "🔒 Grupo cerrado.");
      } catch { await sendText(sock, gid, "⛔ No pude cerrar (¿soy admin?)."); }
      return;
    }

    if (cmd === "horario") {
      const sch = db.schedules[gid] || {};
      await sendText(sock, gid, `⏰ Abrir: ${sch.open || "No programado"} | Cerrar: ${sch.close || "No programado"}`);
      return;
    }

    if (cmd === "newbienvenida") {
      if (!args) {
        await sendText(sock, gid,
          `Uso: ${CONFIG.prefix}newbienvenida texto\n\nVariables:\n{user} = usuario\n{members} = total miembros\n{prefix} = prefijo`
        );
        return;
      }
      db.welcomeMsgs[gid] = args;
      saveDB();
      await sendText(sock, gid, "✅ Bienvenida actualizada.");
      return;
    }

    if (cmd === "resetbienvenida") {
      db.welcomeMsgs[gid] = null;
      saveDB();
      await sendText(sock, gid, "✅ Bienvenida restaurada a la original.");
      return;
    }

    if (cmd === "set") {
      const name  = (rest[0] || "").toLowerCase();
      const value = rest.slice(1).join(" ").trim();
      if (!name || !value) {
        await sendText(sock, gid, `Uso: ${CONFIG.prefix}set reglas No spam\nLuego: ${CONFIG.prefix}reglas`);
        return;
      }
      const RESERVED = new Set([
        "help","juego","adivina","stopjuego","ruleta","ppt","top","puntos",
        "n","todos","kick","abrir","cerrar","horario","set","del",
        "warn","warns","unwarn","resetwarns","resetpuntos",
        "newbienvenida","resetbienvenida",
      ]);
      if (RESERVED.has(name)) { await sendText(sock, gid, "⛔ Ese nombre está reservado."); return; }
      db.customCmds[gid][name] = value;
      saveDB();
      await sendText(sock, gid, `✅ Nuevo comando: *${CONFIG.prefix}${name}*`);
      return;
    }

    if (cmd === "del") {
      const name = (rest[0] || "").toLowerCase();
      if (!name)                       { await sendText(sock, gid, `Uso: ${CONFIG.prefix}del nombre`); return; }
      if (!db.customCmds[gid]?.[name]) { await sendText(sock, gid, "⛔ Ese comando no existe."); return; }
      delete db.customCmds[gid][name];
      saveDB();
      await sendText(sock, gid, `🗑️ Borrado: *${CONFIG.prefix}${name}*`);
      return;
    }

    // -- Warns --
    const warnTarget = mentionedJid ? jidNormalizedUser(mentionedJid) : null;

    if (cmd === "warn") {
      if (!warnTarget) { await sendText(sock, gid, `Uso: ${CONFIG.prefix}warn @usuario`); return; }
      const w = addWarn(gid, warnTarget);
      await sendText(sock, gid, `⚠️ @${warnTarget.split("@")[0]} warn *${w}/${CONFIG.warnsToKick}*`, { mentions: [warnTarget] });
      if (w >= CONFIG.warnsToKick) {
        try {
          await sock.groupParticipantsUpdate(gid, [warnTarget], "remove");
          await sendText(sock, gid, `🥾 Expulsado por *${CONFIG.warnsToKick}* warns.`, { mentions: [warnTarget] });
        } catch { await sendText(sock, gid, "⛔ No pude expulsar (¿soy admin?)."); }
      }
      return;
    }

    if (cmd === "unwarn") {
      if (!warnTarget) { await sendText(sock, gid, `Uso: ${CONFIG.prefix}unwarn @usuario`); return; }
      const current = db.warns[gid]?.[warnTarget] || 0;
      const w       = setWarn(gid, warnTarget, current - 1);
      await sendText(sock, gid, `✅ @${warnTarget.split("@")[0]} ahora tiene *${w}* warns.`, { mentions: [warnTarget] });
      return;
    }

    if (cmd === "warns") {
      if (!warnTarget) { await sendText(sock, gid, `Uso: ${CONFIG.prefix}warns @usuario`); return; }
      const w = db.warns[gid]?.[warnTarget] || 0;
      await sendText(sock, gid, `📌 @${warnTarget.split("@")[0]} tiene *${w}/${CONFIG.warnsToKick}* warns.`, { mentions: [warnTarget] });
      return;
    }

    if (cmd === "resetwarns") {
      if (!warnTarget) { await sendText(sock, gid, `Uso: ${CONFIG.prefix}resetwarns @usuario`); return; }
      setWarn(gid, warnTarget, 0);
      await sendText(sock, gid, `🧼 Warns reseteados para @${warnTarget.split("@")[0]}.`, { mentions: [warnTarget] });
      return;
    }

    if (cmd === "resetpuntos") {
      resetAllPoints(gid);
      await sendText(sock, gid, "💥 Ranking reseteado para todos.");
      return;
    }

    // Comando desconocido (solo admins llegan aquí)
    await sendText(sock, gid, `🤔 No conozco ese comando. Usa ${CONFIG.prefix}help`);
  });
}

start();
