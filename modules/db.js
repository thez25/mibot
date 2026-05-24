// ============================================================
//  modules/db.js — Modelos MongoDB para el sistema tienda
//  npm i mongoose
// ============================================================

import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/drxbot";

export async function connectDB() {
  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB conectado.");
}

// ── Tienda por grupo ─────────────────────────────────────────
const TiendaSchema = new mongoose.Schema({
  gid:      { type: String, required: true, unique: true }, // JID del grupo
  nombre:   { type: String, default: "Tienda" },
  activa:   { type: Boolean, default: true },
  creadaEn: { type: Date, default: Date.now },
});
export const Tienda = mongoose.model("Tienda", TiendaSchema);

// ── Admins de tienda (por grupo) ─────────────────────────────
const AdminSchema = new mongoose.Schema({
  gid: { type: String, required: true },
  uid: { type: String, required: true }, // JID del admin
});
AdminSchema.index({ gid: 1, uid: 1 }, { unique: true });
export const Admin = mongoose.model("Admin", AdminSchema);

// ── Owner global ─────────────────────────────────────────────
const OwnerSchema = new mongoose.Schema({
  uid:       { type: String, required: true, unique: true },
  clave:     { type: String, required: true }, // clave hasheada
  creadoEn:  { type: Date, default: Date.now },
});
export const Owner = mongoose.model("Owner", OwnerSchema);

// ── Usuarios / saldo ─────────────────────────────────────────
const UsuarioSchema = new mongoose.Schema({
  gid:    { type: String, required: true },
  uid:    { type: String, required: true },
  saldo:  { type: Number, default: 0 },
  compras: { type: Number, default: 0 },
});
UsuarioSchema.index({ gid: 1, uid: 1 }, { unique: true });
export const Usuario = mongoose.model("Usuario", UsuarioSchema);

// ── Stock ────────────────────────────────────────────────────
const StockSchema = new mongoose.Schema({
  gid:       { type: String, required: true },
  producto:  { type: String, required: true }, // ej: "netflix"
  datos:     { type: String, required: true }, // "correo: x\nclave: y\nperfil: 1"
  reservado: { type: Boolean, default: false }, // reservado para drop
  dropCodigo:{ type: String, default: null },
  creadoEn:  { type: Date, default: Date.now },
});
export const Stock = mongoose.model("Stock", StockSchema);

// ── Cupones y drops ──────────────────────────────────────────
const CodigoSchema = new mongoose.Schema({
  gid:      { type: String, required: true },
  codigo:   { type: String, required: true },
  tipo:     { type: String, enum: ["cupon", "drop"], required: true },
  valor:    { type: Number, default: 0 },       // para cupones: saldo que da
  producto: { type: String, default: null },     // para drops: producto reservado
  stockId:  { type: mongoose.Schema.Types.ObjectId, default: null }, // item reservado
  usado:    { type: Boolean, default: false },
  usadoPor: { type: String, default: null },
  expira:   { type: Date, default: null },
  creadoEn: { type: Date, default: Date.now },
});
CodigoSchema.index({ gid: 1, codigo: 1 }, { unique: true });
export const Codigo = mongoose.model("Codigo", CodigoSchema);

// ── Historial de compras ─────────────────────────────────────
const HistorialSchema = new mongoose.Schema({
  gid:      { type: String, required: true },
  uid:      { type: String, required: true },
  producto: { type: String, required: true },
  datos:    { type: String, required: true },
  precio:   { type: Number, required: true },
  fecha:    { type: Date, default: Date.now },
});
export const Historial = mongoose.model("Historial", HistorialSchema);

// ── Precios de productos ─────────────────────────────────────
const PrecioSchema = new mongoose.Schema({
  gid:      { type: String, required: true },
  producto: { type: String, required: true },
  precio:   { type: Number, required: true },
});
PrecioSchema.index({ gid: 1, producto: 1 }, { unique: true });
export const Precio = mongoose.model("Precio", PrecioSchema);

// ── Logs ─────────────────────────────────────────────────────
const LogSchema = new mongoose.Schema({
  gid:    { type: String, default: null },
  uid:    { type: String, default: null },
  accion: { type: String, required: true },
  detalle:{ type: String, default: "" },
  fecha:  { type: Date, default: Date.now },
});
export const Log = mongoose.model("Log", LogSchema);

// Helper para guardar logs fácilmente
export async function saveLog(gid, uid, accion, detalle = "") {
  try { await Log.create({ gid, uid, accion, detalle }); } catch {}
}
