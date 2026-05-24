// ============================================================
//  DRX Monster Bot — index.js (ESM)
//  npm i @whiskeysockets/baileys pino node-cron qrcode
//      qrcode-terminal mongoose bcryptjs
// ============================================================

import fs          from "fs";
import http        from "http";
import cron        from "node-cron";
import pino        from "pino";
import QRCode      from "qrcode";
import qrTerminal  from "qrcode-terminal";
import {
  makeWASocket, useMultiFileAuthState,
  DisconnectReason, fetchLatestBaileysVersion,
  jidNormalizedUser, downloadContentFromMessage,
} from "@whiskeysockets/baileys";

import { connectDB }                            from "./modules/db.js";
import { handleTienda, handlePendingStock }     from "./modules/tienda.js";

// ============================================================
//  ⚙️  CONFIGURACIÓN
// ============================================================
const CONFIG = {
  prefix:            ".",
  shopPrefix:        "/",
  secret:            "bot-v5",
  dbFile:            "./database.json",
  brand:             "> DRAXYO",
  warnsToKick:       3,
  pointsPerWin:      10,
  pointsToReset:     100,
  privateCooldownMs: 30_000,
  httpPort:          process.env.PORT || 3000,
};

// ============================================================
//  🌐  SERVIDOR HTTP — QR en navegador
// ============================================================
let lastQRData = "";

http.createServer(async (req, res) => {
  if (req.url === "/qr") {
    if (lastQRData) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>⏳ QR aún no listo</h2><p>Espera unos segundos...</p>
        <script>setTimeout(()=>location.reload(),3000)</script></body></html>`);
      return;
    }
    try {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(await QRCode.toBuffer(lastQRData));
    } catch { res.writeHead(500); res.end("Error generando QR"); }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee">
    <h1>🤖 DRX Monster Bot</h1><p>Bot activo ✅</p>
    <a href="/qr"><button style="padding:12px 24px;font-size:16px;border-radius:8px;cursor:pointer">
    📷 Ver QR WhatsApp</button></a></body></html>`);
}).listen(CONFIG.httpPort, () => {
  console.log(`🌐 HTTP en puerto ${CONFIG.httpPort} — /qr para escanear`);
});

// ============================================================
//  🗄️  BASE DE DATOS JSON (sistema grupal)
// ============================================================
const DB_DEFAULTS = {
  allowedUsers:{}, customCmds:{}, games:{}, schedules:{},
  warns:{}, points:{}, troll:{}, welcomeMsgs:{},
};

function loadDB() {
  if (!fs.existsSync(CONFIG.dbFile)) {
    fs.writeFileSync(CONFIG.dbFile, JSON.stringify(DB_DEFAULTS, null, 2));
    return structuredClone(DB_DEFAULTS);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG.dbFile, "utf-8"));
  for (const k of Object.keys(DB_DEFAULTS)) raw[k] ??= DB_DEFAULTS[k];
  return raw;
}
let db = loadDB();
function saveDB() { fs.writeFileSync(CONFIG.dbFile, JSON.stringify(db, null, 2)); }

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
//  🔧  HELPERS
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
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function parseTimeToHHMM(input) {
  const m = (input||"").trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
  if (!m) return null;
  let hh = parseInt(m[1],10); const mm = parseInt(m[2],10); const ap = m[3];
  if (mm<0||mm>59) return null;
  if (ap) {
    if (hh<1||hh>12) return null;
    if (ap==="am"){ if(hh===12)hh=0; } else { if(hh!==12)hh+=12; }
  } else { if(hh<0||hh>23) return null; }
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
}
async function setGroupAnnounce(sock, gid, close) {
  await sock.groupSettingUpdate(gid, close ? "announcement" : "not_announcement");
}
function randomFrom(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

// ── Anti-link ────────────────────────────────────────────────
function looksLikeLink(text) {
  const t = String(text||"").toLowerCase();
  if ([/https?:\/\//,/www\./,/wa\.me\//,/t\.me\//,/chat\.whatsapp\.com\//,/bit\.ly/,/tinyurl/]
    .some(re=>re.test(t))) return true;
  const s = t.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g,"");
  return [/(?<![^\s@])[\w-]+\.com(?!\w)/,/(?<![^\s@])[\w-]+\.net(?!\w)/,
          /(?<![^\s@])[\w-]+\.org(?!\w)/,/(?<![^\s@])[\w-]+\.gg(?!\w)/,
          /(?<![^\s@])[\w-]+\.io(?!\w)/].some(re=>re.test(s));
}

// ── Warns ────────────────────────────────────────────────────
function addWarn(gid,uid){ ensureGroup(gid); db.warns[gid][uid]=(db.warns[gid][uid]||0)+1; saveDB(); return db.warns[gid][uid]; }
function setWarn(gid,uid,val){ ensureGroup(gid); db.warns[gid][uid]=Math.max(0,Number(val)||0); saveDB(); return db.warns[gid][uid]; }

// ── Puntos ───────────────────────────────────────────────────
function getPoints(gid,uid){ ensureGroup(gid); return db.points[gid][uid]||0; }
function resetAllPoints(gid){ ensureGroup(gid); db.points[gid]={}; saveDB(); }
function addPoints(gid,uid,n){ ensureGroup(gid); db.points[gid][uid]=(db.points[gid][uid]||0)+n; saveDB(); return db.points[gid][uid]; }
function topPoints(gid,limit=10){ ensureGroup(gid); return Object.entries(db.points[gid]||{}).sort((a,b)=>(b[1]||0)-(a[1]||0)).slice(0,limit); }

// ── Bienvenida ───────────────────────────────────────────────
const WELCOME_PHRASES = [
  "Bienvenid@, aquí se viene a dominar 😈",
  "Llegaste al lugar correcto. Pórtate o te portamos 😎",
  "Nuevo en el lobby… ¿traes nivel o puro cuento? 🔥",
  "Pasa, pero con respeto, aquí manda el cotorreo con orden 👊",
  "Bienvenid@, no te asustes si el bot te mira feo 🤖",
];
function getWelcomeMessage(gid,userJid,total){
  ensureGroup(gid);
  const custom=db.welcomeMsgs[gid], nick=userJid.split("@")[0];
  if(custom?.trim()) return custom.replace(/{user}/gi,`@${nick}`).replace(/{members}/gi,String(total)).replace(/{prefix}/gi,CONFIG.prefix);
  return `╔══════════════════════╗\n   🥷  *BIENVENID@*  🥷\n╚══════════════════════╝\n\n👤 @${nick}\n✨ ${randomFrom(WELCOME_PHRASES)}\n\n👥 *Miembros:* ${total}\n\n📌 *Reglas rápidas*\n• Cero links / cero spam\n• Respeto o pa' fuera 😈\n\n⚡ *Juegos*\n• ${CONFIG.prefix}adivina 20\n• ${CONFIG.prefix}ruleta\n• ${CONFIG.prefix}ppt piedra\n\n🏆 *Ranking*\n• ${CONFIG.prefix}top\n• ${CONFIG.prefix}puntos\n\n🛒 *Tienda*\n• /menu`;
}

const TODOS_HEADERS = ["✨ *LISTA DRAXYO* ✨","🔥 *LLAMADO GENERAL* 🔥","🚨 *ATENCIÓN GRUPO* 🚨","⚡ *TODOS PRESENTES* ⚡"];

// ── Media ────────────────────────────────────────────────────
async function streamToBuffer(stream){ const c=[]; for await(const ch of stream)c.push(ch); return Buffer.concat(c); }
async function resendQuotedMedia(sock,jid,quoted,caption=""){
  if(!quoted) return false;
  if(quoted.imageMessage){ const b=await streamToBuffer(await downloadContentFromMessage(quoted.imageMessage,"image")); await sock.sendMessage(jid,{image:b,caption:withBrand(caption)}); return true; }
  if(quoted.videoMessage){ const b=await streamToBuffer(await downloadContentFromMessage(quoted.videoMessage,"video")); await sock.sendMessage(jid,{video:b,caption:withBrand(caption)}); return true; }
  const qt=quoted.conversation||quoted.extendedTextMessage?.text;
  if(qt){ await sendText(sock,jid,qt); return true; }
  return false;
}

// ── Cron horarios ────────────────────────────────────────────
cron.schedule("* * * * *", async()=>{
  try{
    if(!global.sock) return;
    const hhmm=nowHHMM();
    for(const [gid,sch] of Object.entries(db.schedules)){
      if(!sch) continue;
      if(sch.open===hhmm){ await setGroupAnnounce(global.sock,gid,false); await sendText(global.sock,gid,`✅ Grupo *abierto* automáticamente (${hhmm}).`); }
      if(sch.close===hhmm){ await setGroupAnnounce(global.sock,gid,true); await sendText(global.sock,gid,`🔒 Grupo *cerrado* automáticamente (${hhmm}).`); }
    }
  }catch{}
});

// ── Juegos ───────────────────────────────────────────────────
async function handleGuessNumber(sock,gid,uid,body){
  const g=db.games[gid]; if(!g?.active||g.type!=="guess") return false;
  const guess=parseInt(String(body).trim(),10); if(!Number.isFinite(guess)) return false;
  if(guess<g.min||guess>g.max){ await sendText(sock,gid,`⛔ Debe ser entre *${g.min}* y *${g.max}*.`); return true; }
  g.tries[uid]=(g.tries[uid]||0)+1;
  if(guess===g.number){
    const tries=g.tries[uid]; db.games[gid]={active:false,type:null}; saveDB();
    const pts=addPoints(gid,uid,CONFIG.pointsPerWin);
    await sendText(sock,gid,`🏆 @${uid.split("@")[0]} *GANÓ!* 🎉\nNúmero: *${g.number}* | Intentos: *${tries}*\n+${CONFIG.pointsPerWin} pts (Total: ${pts})`,{mentions:[uid]});
    await checkChampion(sock,gid,uid,pts); return true;
  }
  await sendText(sock,gid,`${guess<g.number?"📈 Más alto":"📉 Más bajo"} 😈`); saveDB(); return true;
}
async function playRuleta(sock,gid,uid){
  if(Math.random()<1/6){ await sendText(sock,gid,`💥🔫 @${uid.split("@")[0]} *BANG!* Adiós.`,{mentions:[uid]}); try{await sock.groupParticipantsUpdate(gid,[uid],"remove");}catch{await sendText(sock,gid,"⛔ No pude expulsar.");} return; }
  const pts=addPoints(gid,uid,CONFIG.pointsPerWin); await sendText(sock,gid,`😮‍💨🔫 @${uid.split("@")[0]} *sobrevivió*.\n+${CONFIG.pointsPerWin} pts (Total: ${pts})`,{mentions:[uid]}); await checkChampion(sock,gid,uid,pts);
}
const RPS_OPTS=["piedra","papel","tijera"];
function rpsWinner(a,b){ if(a===b)return 0; if((a==="piedra"&&b==="tijera")||(a==="tijera"&&b==="papel")||(a==="papel"&&b==="piedra"))return 1; return -1; }
async function playRPS(sock,gid,uid,choice){
  const user=String(choice||"").toLowerCase(); if(!RPS_OPTS.includes(user)){await sendText(sock,gid,`Uso: ${CONFIG.prefix}ppt piedra | papel | tijera`); return;}
  const bot=randomFrom(RPS_OPTS),res=rpsWinner(user,bot);
  if(res===0){await sendText(sock,gid,`🤝 Empate. Tú: *${user}* | Bot: *${bot}*`); return;}
  if(res<0){await sendText(sock,gid,`❌ Perdiste. Tú: *${user}* | Bot: *${bot}*`); return;}
  const pts=addPoints(gid,uid,CONFIG.pointsPerWin); await sendText(sock,gid,`✅ Ganaste 😈 Tú: *${user}* | Bot: *${bot}*\n+${CONFIG.pointsPerWin} pts (Total: ${pts})`,{mentions:[uid]}); await checkChampion(sock,gid,uid,pts);
}
async function checkChampion(sock,gid,uid,pts){
  if(pts<CONFIG.pointsToReset) return;
  resetAllPoints(gid);
  await sendText(sock,gid,`🔥 *CAMPEÓN/A* @${uid.split("@")[0]} llegó a *${CONFIG.pointsToReset}* puntos.\n💥 Ranking reiniciado.`,{mentions:[uid]});
}

// ============================================================
//  🚀  INICIO
// ============================================================
const seenMsgIds      = new Set();
const privateCooldown = new Map();

async function start() {
  await connectDB();

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version }          = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }) });
  global.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) { lastQRData = qr; qrTerminal.generate(qr, { small: true }); console.log("📷 QR listo → abre /qr en el navegador"); }
    if (connection === "close") { if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) start(); }
    else if (connection === "open") { lastQRData = ""; console.log("✅ Bot conectado."); }
  });

  sock.ev.on("group-participants.update", async (ev) => {
    try {
      if (ev.action !== "add") return;
      const gid = ev.id; ensureGroup(gid);
      const meta = await sock.groupMetadata(gid);
      for (const p of ev.participants) {
        const user = jidNormalizedUser(p);
        await sendText(sock, gid, getWelcomeMessage(gid, user, meta.participants?.length||0), { mentions: [user] });
      }
    } catch {}
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message||msg.key?.fromMe||msg.key?.remoteJid==="status@broadcast") return;

    const msgId = msg.key?.id;
    if (msgId) { if (seenMsgIds.has(msgId)) return; seenMsgIds.add(msgId); setTimeout(()=>seenMsgIds.delete(msgId), 5*60*1000); }

    const from   = msg.key.remoteJid;
    const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
    const body   = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "").trim();

    if (!body) return;

    // ══════════════════════════════════════════════════════
    //  ROUTER: / → tienda  |  . → grupal
    // ══════════════════════════════════════════════════════
    if (body.startsWith(CONFIG.shopPrefix)) {
      await handleTienda(sock, msg, from, sender, body);
      return;
    }

    // ── Privados ──────────────────────────────────────────
    if (!isGroup(from)) {
      // Stock pendiente (admin envía datos después de /add)
      const handled = await handlePendingStock(sock, from, sender, body);
      if (handled) return;

      if (body === CONFIG.secret) { db.allowedUsers[sender]=true; saveDB(); await sendText(sock,from,"✅ Acceso activado."); return; }
      if (!db.allowedUsers[sender]) {
        const last=privateCooldown.get(sender)||0, now=Date.now();
        if (now-last>CONFIG.privateCooldownMs) { privateCooldown.set(sender,now); await sendText(sock,from,"🔒 Manda la palabra secreta para activar acceso."); }
        return;
      }
      await sendText(sock,from,"✅ Acceso OK. (El bot se usa principalmente en grupos.)");
      return;
    }

    // ── Grupo ─────────────────────────────────────────────
    const gid = from;
    ensureGroup(gid);

    let meta=null, isAdmin=false;
    try { meta=await sock.groupMetadata(gid); const p=meta.participants.find(p=>p.id===sender); isAdmin=p?.admin==="admin"||p?.admin==="superadmin"; } catch {}

    // Anti-link
    if (!isAdmin && looksLikeLink(body)) {
      const w=addWarn(gid,sender);
      await sendText(sock,gid,`🚫 *Anti-link*\n@${sender.split("@")[0]} advertencia *${w}/${CONFIG.warnsToKick}*.`,{mentions:[sender]});
      if (w>=CONFIG.warnsToKick) { try{await sock.groupParticipantsUpdate(gid,[sender],"remove"); await sendText(sock,gid,`🥾 Expulsado por ${CONFIG.warnsToKick} advertencias.`,{mentions:[sender]});}catch{await sendText(sock,gid,"⛔ No pude expulsar.");} }
      return;
    }

    // Juego activo
    if (db.games[gid]?.active && !body.startsWith(CONFIG.prefix)) { await handleGuessNumber(sock,gid,sender,body); return; }
    if (!body.startsWith(CONFIG.prefix)) return;

    const [rawCmd,...rest] = body.slice(CONFIG.prefix.length).split(" ");
    const cmd  = rawCmd.toLowerCase();
    const args = rest.join(" ").trim();

    // Comandos custom
    if (db.customCmds[gid]?.[cmd]) { await sendText(sock,gid,db.customCmds[gid][cmd]); return; }

    const PUBLIC_CMDS = new Set(["help","juego","adivina","stopjuego","ruleta","ppt","top","puntos"]);
    if (!isAdmin && !PUBLIC_CMDS.has(cmd)) return;

    // ── Comandos públicos ──────────────────────────────────
    if (cmd === "help") {
      const p=CONFIG.prefix;
      await sendText(sock,gid,`🤖 *Comandos Bot Grupal*\n\n🎮 *Juegos*\n• ${p}adivina 20\n• ${p}stopjuego\n• ${p}ruleta\n• ${p}ppt piedra|papel|tijera\n\n🏆 *Puntos*\n• ${p}top\n• ${p}puntos\n\n👑 *Admins*\n• ${p}n texto | (reply)\n• ${p}todos\n• ${p}kick @user\n• ${p}abrir / ${p}cerrar\n• ${p}abrir 9:00am / ${p}cerrar 22:00\n• ${p}horario\n• ${p}warn / ${p}warns / ${p}unwarn / ${p}resetwarns @user\n• ${p}resetpuntos\n• ${p}newbienvenida texto\n• ${p}resetbienvenida\n• ${p}set nombre texto\n• ${p}del nombre\n\n🛒 *Tienda* → /menu`);
      return;
    }
    if (cmd==="juego"){ const p=CONFIG.prefix; await sendText(sock,gid,`🎮 *Juegos:*\n• ${p}adivina 20\n• ${p}ruleta\n• ${p}ppt piedra|papel|tijera`); return; }
    if (cmd==="adivina"){
      const max=parseInt(rest[0]||"20",10);
      if(!Number.isFinite(max)||max<2||max>500){await sendText(sock,gid,"⛔ Rango inválido. Ej: .adivina 20"); return;}
      db.games[gid]={active:true,type:"guess",number:Math.floor(Math.random()*max)+1,tries:{},min:1,max}; saveDB();
      await sendText(sock,gid,`🎲 *Adivina el número*\nRango: *1 - ${max}* 😈`); return;
    }
    if (cmd==="stopjuego"){ db.games[gid]={active:false,type:null}; saveDB(); await sendText(sock,gid,"🛑 Juego detenido."); return; }
    if (cmd==="ruleta"){ await playRuleta(sock,gid,sender); return; }
    if (cmd==="ppt"){ await playRPS(sock,gid,sender,rest[0]); return; }
    if (cmd==="puntos"){
      const mentioned=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const target=mentioned?jidNormalizedUser(mentioned):sender;
      await sendText(sock,gid,`🏆 Puntos de @${target.split("@")[0]}: *${getPoints(gid,target)}*`,{mentions:[target]}); return;
    }
    if (cmd==="top"){
      const top=topPoints(gid,10);
      if(!top.length){await sendText(sock,gid,"🏆 Aún no hay puntos. ¡Jueguen algo! 😈"); return;}
      await sendText(sock,gid,`🏆 *TOP 10*\n\n${top.map(([uid,pts],i)=>`${i+1}. @${uid.split("@")[0]} — *${pts}*`).join("\n")}`,{mentions:top.map(([uid])=>uid)}); return;
    }

    // ── Comandos admin ─────────────────────────────────────
    const ctx=msg.message?.extendedTextMessage?.contextInfo;
    const quoted=ctx?.quotedMessage||null, quotedSender=ctx?.participant||null, mentionedJid=ctx?.mentionedJid?.[0]||null;

    if (cmd==="n"){
      if(quoted){const ok=await resendQuotedMedia(sock,gid,quoted,args); if(!ok)await sendText(sock,gid,"⛔ Solo texto, imagen o video."); return;}
      if(!args){await sendText(sock,gid,`Uso: ${CONFIG.prefix}n texto`); return;}
      await sendText(sock,gid,args); return;
    }
    if (cmd==="kick"){
      const target=mentionedJid?jidNormalizedUser(mentionedJid):quotedSender?jidNormalizedUser(quotedSender):null;
      if(!target){await sendText(sock,gid,`Uso: ${CONFIG.prefix}kick @usuario`); return;}
      try{await sock.groupParticipantsUpdate(gid,[target],"remove"); await sendText(sock,gid,`🥾 @${target.split("@")[0]} expulsado.`,{mentions:[target]});}catch{await sendText(sock,gid,"⛔ No pude expulsar.");}
      return;
    }
    if (cmd==="todos"){
      const participants=meta?.participants||[], mentions=participants.map(p=>p.id);
      await sendText(sock,gid,`${randomFrom(TODOS_HEADERS)}\n\n${participants.map((p,i)=>`• ${i+1}. @${p.id.split("@")[0]}`).join("\n")}\n\n📌 *Fin de lista*`,{mentions}); return;
    }
    if (cmd==="abrir"){
      if(args){const t=parseTimeToHHMM(args); if(!t){await sendText(sock,gid,"⛔ Hora inválida. Ej: .abrir 9:00am"); return;} db.schedules[gid].open=t; saveDB(); await sendText(sock,gid,`✅ Programado: abrir a las *${t}*.`); return;}
      try{await setGroupAnnounce(sock,gid,false); await sendText(sock,gid,"✅ Grupo abierto.");}catch{await sendText(sock,gid,"⛔ No pude abrir."); } return;
    }
    if (cmd==="cerrar"){
      if(args){const t=parseTimeToHHMM(args); if(!t){await sendText(sock,gid,"⛔ Hora inválida. Ej: .cerrar 22:00"); return;} db.schedules[gid].close=t; saveDB(); await sendText(sock,gid,`✅ Programado: cerrar a las *${t}*.`); return;}
      try{await setGroupAnnounce(sock,gid,true); await sendText(sock,gid,"🔒 Grupo cerrado.");}catch{await sendText(sock,gid,"⛔ No pude cerrar."); } return;
    }
    if (cmd==="horario"){const sch=db.schedules[gid]||{}; await sendText(sock,gid,`⏰ Abrir: ${sch.open||"No programado"} | Cerrar: ${sch.close||"No programado"}`); return;}
    if (cmd==="newbienvenida"){
      if(!args){await sendText(sock,gid,`Uso: ${CONFIG.prefix}newbienvenida texto\nVariables: {user} {members} {prefix}`); return;}
      db.welcomeMsgs[gid]=args; saveDB(); await sendText(sock,gid,"✅ Bienvenida actualizada."); return;
    }
    if (cmd==="resetbienvenida"){db.welcomeMsgs[gid]=null; saveDB(); await sendText(sock,gid,"✅ Bienvenida restaurada."); return;}
    if (cmd==="set"){
      const name=(rest[0]||"").toLowerCase(), value=rest.slice(1).join(" ").trim();
      if(!name||!value){await sendText(sock,gid,`Uso: ${CONFIG.prefix}set reglas No spam`); return;}
      const RESERVED=new Set(["help","juego","adivina","stopjuego","ruleta","ppt","top","puntos","n","todos","kick","abrir","cerrar","horario","set","del","warn","warns","unwarn","resetwarns","resetpuntos","newbienvenida","resetbienvenida"]);
      if(RESERVED.has(name)){await sendText(sock,gid,"⛔ Nombre reservado."); return;}
      db.customCmds[gid][name]=value; saveDB(); await sendText(sock,gid,`✅ Comando: *${CONFIG.prefix}${name}*`); return;
    }
    if (cmd==="del"){
      const name=(rest[0]||"").toLowerCase();
      if(!name){await sendText(sock,gid,`Uso: ${CONFIG.prefix}del nombre`); return;}
      if(!db.customCmds[gid]?.[name]){await sendText(sock,gid,"⛔ Ese comando no existe."); return;}
      delete db.customCmds[gid][name]; saveDB(); await sendText(sock,gid,`🗑️ Borrado: *${CONFIG.prefix}${name}*`); return;
    }

    const warnTarget=mentionedJid?jidNormalizedUser(mentionedJid):null;
    if (cmd==="warn"){
      if(!warnTarget){await sendText(sock,gid,`Uso: ${CONFIG.prefix}warn @usuario`); return;}
      const w=addWarn(gid,warnTarget); await sendText(sock,gid,`⚠️ @${warnTarget.split("@")[0]} warn *${w}/${CONFIG.warnsToKick}*`,{mentions:[warnTarget]});
      if(w>=CONFIG.warnsToKick){try{await sock.groupParticipantsUpdate(gid,[warnTarget],"remove"); await sendText(sock,gid,`🥾 Expulsado.`,{mentions:[warnTarget]});}catch{await sendText(sock,gid,"⛔ No pude expulsar.");}}
      return;
    }
    if (cmd==="unwarn"){if(!warnTarget){await sendText(sock,gid,`Uso: ${CONFIG.prefix}unwarn @usuario`); return;} const w=setWarn(gid,warnTarget,(db.warns[gid]?.[warnTarget]||0)-1); await sendText(sock,gid,`✅ @${warnTarget.split("@")[0]} ahora tiene *${w}* warns.`,{mentions:[warnTarget]}); return;}
    if (cmd==="warns"){if(!warnTarget){await sendText(sock,gid,`Uso: ${CONFIG.prefix}warns @usuario`); return;} await sendText(sock,gid,`📌 @${warnTarget.split("@")[0]} tiene *${db.warns[gid]?.[warnTarget]||0}/${CONFIG.warnsToKick}* warns.`,{mentions:[warnTarget]}); return;}
    if (cmd==="resetwarns"){if(!warnTarget){await sendText(sock,gid,`Uso: ${CONFIG.prefix}resetwarns @usuario`); return;} setWarn(gid,warnTarget,0); await sendText(sock,gid,`🧼 Warns reseteados para @${warnTarget.split("@")[0]}.`,{mentions:[warnTarget]}); return;}
    if (cmd==="resetpuntos"){resetAllPoints(gid); await sendText(sock,gid,"💥 Ranking reseteado."); return;}

    await sendText(sock,gid,`🤔 Comando desconocido. Usa ${CONFIG.prefix}help`);
  });
}

start();
