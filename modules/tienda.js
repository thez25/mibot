// ============================================================
//  modules/tienda.js — Sistema Tienda completo (prefijo /)
//  Sin /addgid: el bot detecta automáticamente el grupo
//  del admin buscando en qué tiendas activas tiene permisos.
// ============================================================

import bcrypt from "bcryptjs";
import {
  Tienda, Admin, Owner, Usuario, Stock,
  Codigo, Historial, Precio, saveLog,
} from "./db.js";

// ============================================================
//  HELPERS
// ============================================================
const nick = (jid) => jid.split("@")[0];

async function sendPrivate(sock, uid, text) {
  try { await sock.sendMessage(uid, { text }); } catch {}
}

async function isOwner(uid) {
  return !!(await Owner.findOne({ uid }));
}

// Admin de tienda: owner global siempre es admin de todo
async function isAdmin(gid, uid) {
  if (await isOwner(uid)) return true;
  return !!(await Admin.findOne({ gid, uid }));
}

async function tiendaActiva(gid) {
  return !!(await Tienda.findOne({ gid, activa: true }));
}

async function getOrCreateUsuario(gid, uid) {
  let u = await Usuario.findOne({ gid, uid });
  if (!u) u = await Usuario.create({ gid, uid });
  return u;
}

// Busca en qué grupos activos tiene permisos de admin este usuario.
// Si tiene uno solo, lo usa automáticamente.
// Si tiene varios, los devuelve para que el usuario elija.
async function getAdminGroups(uid) {
  if (await isOwner(uid)) {
    // Owner: todas las tiendas activas
    const tiendas = await Tienda.find({ activa: true });
    return tiendas.map(t => t.gid);
  }
  const admins = await Admin.find({ uid });
  const gids   = admins.map(a => a.gid);
  // Filtrar solo las que tienen tienda activa
  const activas = await Tienda.find({ gid: { $in: gids }, activa: true });
  return activas.map(t => t.gid);
}

// ============================================================
//  ESTADO DE SESIÓN PRIVADA
//  Guarda en memoria a qué grupo va dirigida la sesión del admin
//  cuando escribe desde privado.
//  Se asigna automáticamente si solo tiene 1 grupo.
//  Si tiene varios, se le pide que elija con /grupo N.
// ============================================================
const pendingStock    = new Map(); // uid → { producto, gid }
const privateSession  = new Map(); // uid → gid actualmente seleccionado
const ownerPendingKeys = new Map(); // clave → expira

// Resuelve el gid activo para un admin en privado.
// Siempre verifica que la tienda cacheada siga activa.
// Retorna gid (string) o null si hay ambigüedad o sin permisos.
async function resolvePrivateGid(sock, from, sender) {
  // Si ya tiene sesión, verificar que la tienda siga activa
  const cached = privateSession.get(sender);
  if (cached && typeof cached === "string") {
    if (await tiendaActiva(cached)) return cached;
    // La tienda ya no está activa, limpiar sesión y recalcular
    privateSession.delete(sender);
  }

  const grupos = await getAdminGroups(sender); // ya filtra solo activas

  if (!grupos.length) {
    await sock.sendMessage(from, { text: "❌ No eres admin de ninguna tienda activa." });
    return null;
  }

  if (grupos.length === 1) {
    privateSession.set(sender, grupos[0]);
    return grupos[0];
  }

  // Más de uno: pedir que elija
  const tiendas = await Tienda.find({ gid: { $in: grupos }, activa: true });
  const lista   = tiendas.map((t, i) => `${i + 1}. ${t.nombre}`).join("\n");
  await sock.sendMessage(from, {
    text: `🏪 Eres admin de varias tiendas activas. Elige con:\n/grupo N\n\n${lista}`,
  });
  privateSession.set(sender, { pending: tiendas.map(t => t.gid) });
  return null;
}

// ============================================================
//  ENTRADA PRINCIPAL
// ============================================================
export async function handleTienda(sock, msg, from, sender, body) {
  const isGrp = from.endsWith("@g.us");
  const gid   = isGrp ? from : null;

  const [rawCmd, ...rest] = body.slice(1).split(" ");
  const cmd  = rawCmd.toLowerCase();
  const args = rest.join(" ").trim();

  // ── OWNER ─────────────────────────────────────────────────

  if (cmd === "owner") {
    const clave = args.trim();
    const existe = await Owner.findOne({});

    // Primer owner (clave YI)
    if (!existe && clave === "YI") {
      const hash = await bcrypt.hash("YI", 10);
      await Owner.create({ uid: sender, clave: hash });
      await saveLog(null, sender, "OWNER_CREADO");
      await sock.sendMessage(from, { text: "👑 *Owner registrado exitosamente.*\nEres el owner global del bot." });
      return;
    }

    // Owner adicional con clave temporal
    const exp = ownerPendingKeys.get(clave);
    if (exp && exp > Date.now()) {
      ownerPendingKeys.delete(clave);
      const hash = await bcrypt.hash(clave, 10);
      try {
        await Owner.create({ uid: sender, clave: hash });
        await saveLog(null, sender, "OWNER_CREADO_ADICIONAL");
        await sock.sendMessage(from, { text: "👑 Registrado como owner exitosamente." });
      } catch {
        await sock.sendMessage(from, { text: "⚠️ Tu número ya estaba registrado como owner." });
      }
      return;
    }

    await sock.sendMessage(from, { text: "❌ Clave incorrecta o expirada." });
    return;
  }

  if (cmd === "1owner") {
    if (!(await isOwner(sender))) {
      await sock.sendMessage(from, { text: "❌ Solo el owner puede usar este comando." }); return;
    }
    const nuevaClave = args.trim();
    if (!nuevaClave) {
      await sock.sendMessage(from, { text: "Uso: /1owner CLAVE\nLa persona usa /owner CLAVE para registrarse como owner." }); return;
    }
    ownerPendingKeys.set(nuevaClave, Date.now() + 5 * 60 * 1000);
    await sock.sendMessage(from, { text: `✅ Clave generada: *${nuevaClave}*\nVálida 5 minutos.` });
    return;
  }

  // ── ACTIVAR TIENDA ─────────────────────────────────────────
  if (cmd === "activar" && args.toLowerCase().startsWith("tienda")) {
    if (!isGrp) { await sock.sendMessage(from, { text: "❌ Úsalo en el grupo." }); return; }
    if (!(await isOwner(sender))) {
      await sock.sendMessage(from, { text: "❌ Solo el owner global puede activar tiendas." }); return;
    }
    const nombreTienda = args.replace(/^tienda\s*/i, "").trim() || "Tienda";
    const existe = await Tienda.findOne({ gid });
    if (existe) {
      await sock.sendMessage(from, { text: `⚠️ Ya existe una tienda en este grupo (${existe.activa ? "activa" : "inactiva"}).` }); return;
    }
    await Tienda.create({ gid, nombre: nombreTienda });
    await saveLog(gid, sender, "TIENDA_ACTIVADA", nombreTienda);
    await sock.sendMessage(from, { text: `🛒 *Tienda "${nombreTienda}" activada.*\n\nUsa /menu para ver comandos.` });
    return;
  }

  // ── PRIVADO: selección de grupo ───────────────────────────
  if (!isGrp && cmd === "grupo") {
    const session = privateSession.get(sender);
    if (!session?.pending) {
      await sock.sendMessage(from, { text: "No tienes ninguna selección pendiente." }); return;
    }
    const n = parseInt(args, 10) - 1;
    if (isNaN(n) || n < 0 || n >= session.pending.length) {
      await sock.sendMessage(from, { text: `Elige un número entre 1 y ${session.pending.length}.` }); return;
    }
    const elegido = session.pending[n];
    privateSession.set(sender, elegido);
    const t = await Tienda.findOne({ gid: elegido });
    await sock.sendMessage(from, { text: `✅ Tienda activa: *${t?.nombre || elegido}*` });
    return;
  }

  // ── PRIVADO: comandos de admin ────────────────────────────
  if (!isGrp) {
    await handlePrivateAdmin(sock, msg, from, sender, cmd, args);
    return;
  }

  // ── GRUPO: verificar tienda activa ────────────────────────
  if (!(await tiendaActiva(gid))) {
    await sock.sendMessage(from, { text: "❌ La tienda no está activada en este grupo.\nEl owner usa: /activar tienda NombreTienda" });
    return;
  }

  // ── MENÚ ──────────────────────────────────────────────────
  if (cmd === "menu" || cmd === "help") {
    const adm = await isAdmin(gid, sender);
    let txt = `🛒 *MENÚ TIENDA*\n\n👤 *Todos*\n• /stock — productos disponibles\n• /comprar producto\n• /saldo — ver tu saldo\n• /codigo XXXX — canjear cupón/drop\n• /historial — tus compras`;
    if (adm) {
      txt += `\n\n👑 *Admins*\n• /admin @user — dar permisos\n• /kick numero — quitar permisos\n• /user — lista admins\n• /saldo @user 20 — dar saldo\n• /precio producto 15 — fijar precio\n• /cupon 10 CODIGO — crear cupón\n• /stockver producto — ver items\n• /stockdel producto ID — borrar item\n\n📲 *Desde privado (admin)*\n• /add producto → luego envía los datos\n• /drop CODIGO producto\n• /grupo N → elegir tienda si tienes varias`;
    }
    await sock.sendMessage(from, { text: txt });
    return;
  }

  // ── STOCK ─────────────────────────────────────────────────
  if (cmd === "stock" && !args) {
    const items = await Stock.aggregate([
      { $match: { gid, reservado: false } },
      { $group: { _id: "$producto", cantidad: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    if (!items.length) { await sock.sendMessage(from, { text: "📦 Sin stock disponible actualmente." }); return; }
    const pm = Object.fromEntries((await Precio.find({ gid })).map(p => [p.producto, p.precio]));
    const lines = items.map(i => `• *${i._id}* — ${i.cantidad} ud${pm[i._id] ? ` — $${pm[i._id]}` : ""}`);
    await sock.sendMessage(from, { text: `📦 *STOCK DISPONIBLE*\n\n${lines.join("\n")}` });
    return;
  }

  if (cmd === "stockver") {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const producto = args.trim().toLowerCase();
    if (!producto) { await sock.sendMessage(from, { text: "Uso: /stockver producto" }); return; }
    const items = await Stock.find({ gid, producto, reservado: false });
    if (!items.length) { await sock.sendMessage(from, { text: `📦 Sin stock de *${producto}*.` }); return; }
    await sock.sendMessage(from, { text: `📦 *${producto.toUpperCase()}* (${items.length})\n\n${items.map((i,n)=>`${n+1}. [${i._id}]\n${i.datos}`).join("\n─────\n")}` });
    return;
  }

  if (cmd === "stockdel") {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const [producto, id] = args.split(" ");
    if (!producto || !id) { await sock.sendMessage(from, { text: "Uso: /stockdel producto ID" }); return; }
    const del = await Stock.findOneAndDelete({ _id: id, gid, producto });
    if (!del) { await sock.sendMessage(from, { text: "❌ Item no encontrado." }); return; }
    await saveLog(gid, sender, "STOCK_DEL", `${producto} ${id}`);
    await sock.sendMessage(from, { text: `🗑️ Item de *${producto}* eliminado.` });
    return;
  }

  // ── SALDO ─────────────────────────────────────────────────
  if (cmd === "saldo" && !args) {
    const u = await getOrCreateUsuario(gid, sender);
    await sock.sendMessage(from, { text: `💰 Tu saldo: *$${u.saldo}*` });
    return;
  }

  if (cmd === "saldo" && args) {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const ctx       = msg.message?.extendedTextMessage?.contextInfo;
    const mentioned = ctx?.mentionedJid?.[0];
    const parts     = args.split(" ");
    let target, amount;
    if (mentioned) {
      target = mentioned;
      amount = parseFloat(parts[parts.length - 1]);
    } else {
      target = `${parts[0].replace(/\D/g,"")}@s.whatsapp.net`;
      amount = parseFloat(parts[1]);
    }
    if (!target || isNaN(amount) || amount <= 0) {
      await sock.sendMessage(from, { text: "Uso: /saldo @usuario 20\no: /saldo numero 20" }); return;
    }
    const u = await getOrCreateUsuario(gid, target);
    u.saldo += amount; await u.save();
    await saveLog(gid, sender, "SALDO_ADD", `${nick(target)} +$${amount}`);
    await sock.sendMessage(from, { text: `💰 +$${amount} a @${nick(target)}. Saldo: *$${u.saldo}*`, mentions: [target] });
    return;
  }

  // ── PRECIO ────────────────────────────────────────────────
  if (cmd === "precio") {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const [producto, precioStr] = args.split(" ");
    const precio = parseFloat(precioStr);
    if (!producto || isNaN(precio)) { await sock.sendMessage(from, { text: "Uso: /precio netflix 15" }); return; }
    await Precio.findOneAndUpdate({ gid, producto }, { precio }, { upsert: true });
    await saveLog(gid, sender, "PRECIO_SET", `${producto}=$${precio}`);
    await sock.sendMessage(from, { text: `✅ Precio de *${producto}*: *$${precio}*` });
    return;
  }

  // ── COMPRAR ───────────────────────────────────────────────
  if (cmd === "comprar") {
    const producto = args.trim().toLowerCase();
    if (!producto) { await sock.sendMessage(from, { text: "Uso: /comprar netflix" }); return; }
    const precioDoc = await Precio.findOne({ gid, producto });
    if (!precioDoc) { await sock.sendMessage(from, { text: `❌ Sin precio para *${producto}*. Pide a un admin que lo configure.` }); return; }
    const u = await getOrCreateUsuario(gid, sender);
    if (u.saldo < precioDoc.precio) { await sock.sendMessage(from, { text: `❌ Saldo insuficiente. Necesitas *$${precioDoc.precio}* | Tienes *$${u.saldo}*` }); return; }
    const item = await Stock.findOne({ gid, producto, reservado: false });
    if (!item) { await sock.sendMessage(from, { text: `❌ Sin stock de *${producto}* ahora mismo.` }); return; }
    u.saldo -= precioDoc.precio; u.compras += 1; await u.save();
    await Historial.create({ gid, uid: sender, producto, datos: item.datos, precio: precioDoc.precio });
    await Stock.deleteOne({ _id: item._id });
    await saveLog(gid, sender, "COMPRA", `${producto} $${precioDoc.precio}`);
    await sock.sendMessage(from, { text: `✅ @${nick(sender)} compró *${producto}*. Saldo restante: *$${u.saldo}*\n📩 Datos enviados por privado.`, mentions: [sender] });
    await sendPrivate(sock, sender, `🛒 *Tu compra: ${producto}*\n\n${item.datos}\n\n> DRAXYO`);
    return;
  }

  // ── CUPÓN ─────────────────────────────────────────────────
  if (cmd === "cupon") {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const parts  = args.split(" ");
    const valor  = parseFloat(parts[0]);
    const codigo = (parts[1] || "").toUpperCase();
    const dias   = parseInt(parts[2] || "0", 10);
    if (isNaN(valor) || !codigo) { await sock.sendMessage(from, { text: "Uso: /cupon 10 SKIBS\no con expiración: /cupon 10 SKIBS 3" }); return; }
    const expira = dias > 0 ? new Date(Date.now() + dias * 86400000) : null;
    try {
      await Codigo.create({ gid, codigo, tipo: "cupon", valor, expira });
    } catch { await sock.sendMessage(from, { text: "❌ Ese código ya existe en este grupo." }); return; }
    await saveLog(gid, sender, "CUPON_CREADO", `${codigo} $${valor}`);
    await sock.sendMessage(from, { text: `🎁 *CUPÓN DISPONIBLE*\n\nCódigo: *${codigo}*\nPremio: *$${valor}*${expira ? `\nExpira: ${expira.toLocaleDateString()}` : ""}\n\nCanjea con: /codigo ${codigo}` });
    return;
  }

  // ── CANJEAR CÓDIGO ────────────────────────────────────────
  if (cmd === "codigo") {
    const codigo = args.trim().toUpperCase();
    if (!codigo) { await sock.sendMessage(from, { text: "Uso: /codigo XXXX" }); return; }
    const cod = await Codigo.findOne({ gid, codigo });
    if (!cod) { await sock.sendMessage(from, { text: "❌ Código inválido o no pertenece a este grupo." }); return; }
    if (cod.usado) { await sock.sendMessage(from, { text: "❌ Este código ya fue canjeado." }); return; }
    if (cod.expira && cod.expira < new Date()) { await sock.sendMessage(from, { text: "❌ Este código expiró." }); return; }
    cod.usado = true; cod.usadoPor = sender; await cod.save();
    if (cod.tipo === "cupon") {
      const u = await getOrCreateUsuario(gid, sender); u.saldo += cod.valor; await u.save();
      await saveLog(gid, sender, "CUPON_CANJEADO", `${codigo} +$${cod.valor}`);
      await sock.sendMessage(from, { text: `✅ @${nick(sender)} canjeó *${codigo}*.\n+$${cod.valor} | Saldo: *$${u.saldo}*`, mentions: [sender] });
      return;
    }
    if (cod.tipo === "drop") {
      const item = await Stock.findOne({ _id: cod.stockId });
      if (!item) { await sock.sendMessage(from, { text: "❌ El premio ya no está disponible." }); return; }
      await Stock.deleteOne({ _id: item._id });
      await Historial.create({ gid, uid: sender, producto: item.producto, datos: item.datos, precio: 0 });
      await saveLog(gid, sender, "DROP_CANJEADO", `${codigo} ${item.producto}`);
      await sock.sendMessage(from, { text: `🎁 @${nick(sender)} ganó el DROP *${codigo}*!\n📩 Premio enviado por privado.`, mentions: [sender] });
      await sendPrivate(sock, sender, `🎁 *Ganaste el Drop: ${item.producto}*\n\n${item.datos}\n\n> DRAXYO`);
      return;
    }
    return;
  }

  // ── HISTORIAL ─────────────────────────────────────────────
  if (cmd === "historial") {
    const hist = await Historial.find({ gid, uid: sender }).sort({ fecha: -1 }).limit(10);
    if (!hist.length) { await sock.sendMessage(from, { text: "📋 Sin compras registradas." }); return; }
    await sock.sendMessage(from, { text: `📋 *Historial (últimas 10)*\n\n${hist.map((h,i)=>`${i+1}. *${h.producto}* — $${h.precio} — ${h.fecha.toLocaleDateString()}`).join("\n")}` });
    return;
  }

  // ── GESTIÓN ADMINS ────────────────────────────────────────
  if (cmd === "admin") {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!mentioned) { await sock.sendMessage(from, { text: "Uso: /admin @usuario" }); return; }
    try {
      await Admin.create({ gid, uid: mentioned });
      await saveLog(gid, sender, "ADMIN_ADD", nick(mentioned));
      await sock.sendMessage(from, { text: `✅ @${nick(mentioned)} es admin de la tienda.`, mentions: [mentioned] });
    } catch { await sock.sendMessage(from, { text: "⚠️ Ese usuario ya es admin." }); }
    return;
  }

  if (cmd === "kick") {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const uid = `${args.replace(/\D/g,"")}@s.whatsapp.net`;
    const del = await Admin.findOneAndDelete({ gid, uid });
    if (!del) { await sock.sendMessage(from, { text: "❌ Ese número no es admin de la tienda." }); return; }
    await saveLog(gid, sender, "ADMIN_KICK", uid);
    await sock.sendMessage(from, { text: `✅ Permisos removidos.` });
    return;
  }

  if (cmd === "user") {
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ Solo admins." }); return; }
    const admins = await Admin.find({ gid });
    if (!admins.length) { await sock.sendMessage(from, { text: "📋 Sin admins en esta tienda." }); return; }
    await sock.sendMessage(from, { text: `👑 *Admins de la tienda*\n\n${admins.map((a,i)=>`${i+1}. ${nick(a.uid)}`).join("\n")}` });
    return;
  }

  await sock.sendMessage(from, { text: "❓ Comando desconocido. Usa /menu" });
}

// ============================================================
//  PRIVADO: agregar stock y crear drops
//  El grupo se detecta automáticamente por membresía de admin.
// ============================================================
async function handlePrivateAdmin(sock, msg, from, sender, cmd, args) {

  // /add producto — inicia captura de datos de stock
  if (cmd === "add") {
    const producto = args.trim().toLowerCase();
    if (!producto) {
      await sock.sendMessage(from, { text: "Uso:\n/add netflix\n\nLuego en el *siguiente mensaje* envía los datos:\ncorreo: xxx@gmail.com\nclave: miClave123\nperfil: 1" });
      return;
    }
    // Resolución automática del grupo
    const gid = await resolvePrivateGid(sock, from, sender);
    if (!gid) return; // le pidió que elija con /grupo N

    if (!(await isAdmin(gid, sender))) {
      await sock.sendMessage(from, { text: "❌ No eres admin de esa tienda." }); return;
    }
    pendingStock.set(sender, { producto, gid });
    await sock.sendMessage(from, { text: `📦 Listo. Envía los datos de *${producto}* en el siguiente mensaje.` });
    return;
  }

  // /cupon 10 CODIGO [dias] — crear cupón desde privado
  if (cmd === "cupon") {
    const parts  = args.split(" ");
    const valor  = parseFloat(parts[0]);
    const codigo = (parts[1] || "").toUpperCase();
    const dias   = parseInt(parts[2] || "0", 10);
    if (isNaN(valor) || !codigo) {
      await sock.sendMessage(from, { text: "Uso: /cupon 10 SKIBS\nCon expiración: /cupon 10 SKIBS 3" }); return;
    }
    const gid = await resolvePrivateGid(sock, from, sender);
    if (!gid) return;
    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ No eres admin de esa tienda." }); return; }
    const expira = dias > 0 ? new Date(Date.now() + dias * 86400000) : null;
    try {
      await Codigo.create({ gid, codigo, tipo: "cupon", valor, expira });
    } catch { await sock.sendMessage(from, { text: "❌ Ese código ya existe en ese grupo." }); return; }
    await saveLog(gid, sender, "CUPON_CREADO", `${codigo} $${valor}`);
    await sock.sendMessage(from, { text: `✅ Cupón *${codigo}* creado. Anunciando en el grupo...` });
    // Anuncio SOLO en el grupo del admin (tienda activa)
    await sock.sendMessage(gid, {
      text: `🎁 *CUPÓN DISPONIBLE*\n\nCódigo: *${codigo}*\nPremio: *$${valor}*${expira ? `\nExpira: ${expira.toLocaleDateString()}` : ""}\n\nCanjea con: /codigo ${codigo}\n\n> DRAXYO`,
    });
    return;
  }

  // /drop CODIGO producto — crea drop desde privado
  if (cmd === "drop") {
    const [codigo, ...prodParts] = args.split(" ");
    const producto = prodParts.join(" ").toLowerCase().trim();
    if (!codigo || !producto) { await sock.sendMessage(from, { text: "Uso: /drop FREEVIP netflix" }); return; }

    const gid = await resolvePrivateGid(sock, from, sender);
    if (!gid) return;

    if (!(await isAdmin(gid, sender))) { await sock.sendMessage(from, { text: "❌ No eres admin de esa tienda." }); return; }

    const item = await Stock.findOne({ gid, producto, reservado: false });
    if (!item) { await sock.sendMessage(from, { text: `❌ Sin stock de *${producto}*.` }); return; }

    item.reservado = true; item.dropCodigo = codigo.toUpperCase(); await item.save();

    try {
      await Codigo.create({ gid, codigo: codigo.toUpperCase(), tipo: "drop", producto, stockId: item._id });
    } catch {
      item.reservado = false; item.dropCodigo = null; await item.save();
      await sock.sendMessage(from, { text: "❌ Ese código ya existe en el grupo." }); return;
    }

    await saveLog(gid, sender, "DROP_CREADO", `${codigo} ${producto}`);
    await sock.sendMessage(from, { text: `✅ Drop *${codigo.toUpperCase()}* creado para *${producto}*.` });
    // Anuncio en el grupo SIN revelar el producto
    await sock.sendMessage(gid, { text: `🎁 *DROP SORPRESA*\n\n¡Hay un premio esperándote!\n\n/codigo ${codigo.toUpperCase()}\n\nEl primero en canjearlo gana. 😈\n\n> DRAXYO` });
    return;
  }

  // /grupo N — elegir tienda activa si hay varias
  if (cmd === "grupo") {
    const session = privateSession.get(sender);
    if (!session?.pending) { await sock.sendMessage(from, { text: "No tienes selección pendiente." }); return; }
    const n = parseInt(args, 10) - 1;
    if (isNaN(n) || n < 0 || n >= session.pending.length) {
      await sock.sendMessage(from, { text: `Elige un número entre 1 y ${session.pending.length}.` }); return;
    }
    const elegido = session.pending[n];
    privateSession.set(sender, elegido);
    const t = await Tienda.findOne({ gid: elegido });
    await sock.sendMessage(from, { text: `✅ Tienda activa: *${t?.nombre || elegido}*\nAhora puedes usar /add y /drop.` });
    return;
  }

  await sock.sendMessage(from, { text: "❓ Usa /add producto o /drop CODIGO producto desde privado.\nSi tienes varias tiendas, usa /grupo N para elegir." });
}

// ============================================================
//  HANDLER DATOS SIN PREFIJO (datos de stock pendiente)
// ============================================================
export async function handlePendingStock(sock, from, sender, body) {
  const state = pendingStock.get(sender);
  if (!state) return false;

  const { producto, gid } = state;

  if (!(await isAdmin(gid, sender))) {
    await sock.sendMessage(from, { text: "❌ Sin permisos." });
    pendingStock.delete(sender);
    return true;
  }

  await Stock.create({ gid, producto, datos: body.trim() });
  await saveLog(gid, sender, "STOCK_ADD", producto);
  pendingStock.delete(sender);
  await sock.sendMessage(from, { text: `✅ Stock de *${producto}* agregado.` });
  return true;
}
