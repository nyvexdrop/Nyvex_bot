// =========================================================
// NYVEX DROP - Bot de WhatsApp con IA (Gemini gratis)
// Usa: WhatsApp Cloud API (Meta, gratis) + Gemini API (gratis)
// Catálogo y fotos desde productos.json e img/ (misma info que la página web)
// Pedidos: registra compras, guarda comprobantes, avisa al dueño y da estatus al cliente
// =========================================================
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// CORS: la tienda web (servida aquí o en otro dominio) puede usar la API
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nyvex-verify-2026";
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || "";
// Número del dueño al que se le avisa cuando hay un pedido/compra
const OWNER_PHONE = process.env.OWNER_PHONE || BOT_PHONE_NUMBER || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
// Modelos de respaldo: cada uno tiene su propia cuota gratis (~20 peticiones/día).
// El gestor automático (estadoModelos) recuerda cuáles responden, bloquea los agotados
// y prioriza los que funcionan, sin tocar nada manualmente.
const MODELOS_GEMINI = [
  GEMINI_MODEL,
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-omni-flash-preview",
].filter((m, i, arr) => m && arr.indexOf(m) === i);

// ---------- GESTOR AUTOMÁTICO DE MODELOS ----------
// Cada modelo que falle (cuota agotada / error) se bloquea temporalmente,
// y los que responden bien se guardan para intentarlos primero.
const estadoModelos = {};

function modeloBloqueado(m) {
  const e = estadoModelos[m];
  return e && e.bloqueadoHasta && Date.now() < e.bloqueadoHasta;
}

function bloquearModelo(m, ms) {
  const e = estadoModelos[m] || {};
  e.bloqueadoHasta = Date.now() + ms;
  e.fallos = (e.fallos || 0) + 1;
  estadoModelos[m] = e;
  console.log(`🔒 ${m} bloqueado por ${Math.round(ms / 1000)}s (fallos: ${e.fallos})`);
}

function marcarOk(m) {
  const e = estadoModelos[m] || {};
  e.bloqueadoHasta = 0;
  e.ultimoOk = Date.now();
  e.fallos = 0;
  estadoModelos[m] = e;
}

// Prioriza: primero los desbloqueados, y entre ellos los que respondieron más reciente
function ordenarModelos() {
  return MODELOS_GEMINI.slice().sort((a, b) => {
    const bloqueados = (modeloBloqueado(a) ? 1 : 0) - (modeloBloqueado(b) ? 1 : 0);
    if (bloqueados !== 0) return bloqueados;
    const ea = estadoModelos[a] || {};
    const eb = estadoModelos[b] || {};
    return (eb.ultimoOk || 0) - (ea.ultimoOk || 0);
  });
}
const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");

// ---------- CATÁLOGO (una sola fuente: productos.json) ----------
const PRODUCTOS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "productos.json"), "utf8")
);

// ---------- PEDIDOS (historial de ventas / intereses) ----------
// Base de datos en línea (Neon/Postgres): guarda TODO de forma permanente.
// Si no hay DATABASE_URL (pruebas locales, por ejemplo), se usa pedidos.json.
const { Pool } = require("pg");
const webpush = require("web-push");
const PEDIDOS_PATH = path.join(__dirname, "pedidos.json");
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;
if (pool) pool.on("error", (e) => console.error("⚠️ Error en conexión BD:", e.message));
let PEDIDOS = [];
try {
  PEDIDOS = JSON.parse(fs.readFileSync(PEDIDOS_PATH, "utf8"));
} catch (e) {
  PEDIDOS = [];
}

// ---------- RECIBOS (comprobantes de pago) ----------
const RECIBOS_DIR = path.join(__dirname, "recibos");
if (!fs.existsSync(RECIBOS_DIR)) fs.mkdirSync(RECIBOS_DIR, { recursive: true });
// Comprobantes también guardados en la BD para que no se pierdan al reiniciar
const RECIBOS_MEM = {};

// Servir fotos de productos y la tienda web (public/)
app.use("/img", express.static(path.join(__dirname, "img")));
app.use(express.static(path.join(__dirname, "public")));

// Comprobantes: se sirven desde la memoria (cargada de la BD) o del disco local
app.get("/recibos/:archivo", (req, res) => {
  const archivo = req.params.archivo;
  if (RECIBOS_MEM[archivo]) {
    const buf = Buffer.from(RECIBOS_MEM[archivo], "base64");
    const ext = (archivo.split(".").pop() || "").toLowerCase();
    const tipos = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    res.setHeader("Content-Type", tipos[ext] || "application/octet-stream");
    return res.send(buf);
  }
  res.sendFile(path.join(RECIBOS_DIR, archivo), (err) => {
    if (err) res.status(404).end();
  });
});

// Convierte una fila de la BD en un pedido
function pedidoDesdeFila(fila) {
  return {
    id: fila.id,
    fecha: fila.fecha,
    numero: fila.numero || "",
    nombre: fila.nombre || "Sin nombre",
    perfil: fila.perfil || "",
    productos: fila.productos || [],
    talla: fila.talla || "",
    texto: fila.texto || "",
    recibo: fila.recibo || null,
    recibo_b64: fila.recibo_b64 || null,
    estado: fila.estado || "pendiente",
  };
}

// Pedido sin datos internos (para mandar por la API)
function pedidoPublico(p) {
  return {
    id: p.id,
    fecha: p.fecha,
    numero: p.numero,
    nombre: p.nombre,
    perfil: p.perfil || "",
    productos: p.productos,
    talla: p.talla,
    texto: p.texto,
    recibo: p.recibo,
    estado: p.estado,
  };
}

// Conecta a la base de datos, crea las tablas y carga/migra los pedidos
async function conectarBaseDeDatos() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      fecha TEXT,
      numero TEXT,
      nombre TEXT,
      productos JSONB,
      talla TEXT,
      texto TEXT,
      recibo TEXT,
      recibo_b64 TEXT,
      estado TEXT
    )`);
    await pool.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS perfil TEXT");
    await pool.query(`CREATE TABLE IF NOT EXISTS settings (
      clave TEXT PRIMARY KEY,
      valor TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      datos JSONB
    )`);
    await configurarPush();
    const res = await pool.query("SELECT * FROM pedidos");
    if (res.rows.length > 0) {
      PEDIDOS = res.rows.map(pedidoDesdeFila);
      for (const p of PEDIDOS) {
        if (p.recibo && p.recibo_b64) {
          RECIBOS_MEM[p.recibo.replace("recibos/", "")] = p.recibo_b64;
        }
      }
      console.log("📦 Pedidos cargados desde la base de datos:", PEDIDOS.length);
    } else if (PEDIDOS.length > 0) {
      await guardarPedidos(); // primera vez: migra pedidos.json a la BD
      console.log("📤 Pedidos migrados a la base de datos:", PEDIDOS.length);
    }
  } catch (e) {
    console.error("⚠️ No se pudo conectar a la BD (se seguirá usando pedidos.json):", e.message);
  }
}

async function guardarPedidos() {
  if (pool) {
    try {
      for (const p of PEDIDOS) {
        await pool.query(
          `INSERT INTO pedidos (id, fecha, numero, nombre, perfil, productos, talla, texto, recibo, recibo_b64, estado)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             fecha=EXCLUDED.fecha, numero=EXCLUDED.numero, nombre=EXCLUDED.nombre,
             perfil=EXCLUDED.perfil, productos=EXCLUDED.productos, talla=EXCLUDED.talla,
             texto=EXCLUDED.texto, recibo=EXCLUDED.recibo, recibo_b64=EXCLUDED.recibo_b64,
             estado=EXCLUDED.estado`,
          [p.id, p.fecha, p.numero || "", p.nombre || "Sin nombre", p.perfil || "", JSON.stringify(p.productos || []), p.talla || "", p.texto || "", p.recibo || null, p.recibo_b64 || null, p.estado || "pendiente"]
        );
      }
    } catch (e) {
      console.error("⚠️ Error guardando en la BD:", e.message);
    }
  }
  try {
    fs.writeFileSync(PEDIDOS_PATH, JSON.stringify(PEDIDOS, null, 2));
  } catch (e) {
    console.error("Error guardando pedidos.json:", e.message);
  }
}

// ---------- NOTIFICACIONES PUSH (para el celular del dueño) ----------
// Las llaves VAPID se generan una vez y se guardan en la BD, así el celular
// las reconoce aunque Render se reinicie. No hay que configurar nada manual.
let VAPID_PUBLIC = null;
let VAPID_PRIVATE = null;

async function configurarPush() {
  if (!pool) return;
  try {
    let [priv, pub] = await Promise.all([
      pool.query("SELECT valor FROM settings WHERE clave = $1", ["vapid_private"]),
      pool.query("SELECT valor FROM settings WHERE clave = $1", ["vapid_public"]),
    ]);
    if (!priv.rows[0] || !pub.rows[0]) {
      const keys = webpush.generateVAPIDKeys();
      VAPID_PRIVATE = keys.privateKey;
      VAPID_PUBLIC = keys.publicKey;
      await pool.query(
        `INSERT INTO settings (clave, valor) VALUES ($1,$2)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
        ["vapid_private", VAPID_PRIVATE]
      );
      await pool.query(
        `INSERT INTO settings (clave, valor) VALUES ($1,$2)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
        ["vapid_public", VAPID_PUBLIC]
      );
    } else {
      VAPID_PRIVATE = priv.rows[0].valor;
      VAPID_PUBLIC = pub.rows[0].valor;
    }
    webpush.setVapidDetails("mailto:owner@nyvexdrop.mx", VAPID_PUBLIC, VAPID_PRIVATE);
    console.log("🔔 Push listo (llaves VAPID cargadas)");
  } catch (e) {
    console.error("⚠️ No se pudo configurar push:", e.message);
  }
}

// Manda una notificación al celular del dueño (y a cualquier dispositivo donde
// tenga el admin instalado). Las suscripciones viejas se limpian solas.
async function enviarPush(titulo, cuerpo) {
  if (!pool || !VAPID_PUBLIC) return;
  try {
    const res = await pool.query("SELECT * FROM push_subs");
    for (const fila of res.rows) {
      try {
        await webpush.sendNotification(
          fila.datos,
          JSON.stringify({
            title: titulo,
            body: cuerpo,
            icon: "/img/logo.jpeg",
            badge: "/img/logo.jpeg",
          })
        );
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await pool.query("DELETE FROM push_subs WHERE endpoint = $1", [fila.endpoint]).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error("Error enviando push:", e.message);
  }
}

function formatoPrecio(n) {
  return "$" + Number(n).toLocaleString("es-MX");
}

// Precio "antes" de la oferta: el catálogo se publica 15% más caro y se descuenta
function precioAntes(precio) {
  return Math.round((precio / 0.85) / 5) * 5;
}

const CATALOGO_DESCRIPCIONES = PRODUCTOS.map((p, i) => {
  const tallas = p.tallas ? ` Tallas: ${p.tallas}.` : "";
  const tipo = p.tipo === "replica" ? " RÉPLICA." : "";
  return `${i + 1}. ${p.nombre} - ${formatoPrecio(p.precio)} (antes ${formatoPrecio(precioAntes(p.precio))}).${tipo} ${p.descripcion}${tallas}`;
}).join("\n");

const RESUMEN_CATEGORIAS = PRODUCTOS.reduce((acc, p) => {
  (acc[p.categoria] = acc[p.categoria] || []).push(p);
  return acc;
}, {});

const CATALOGO_TEXTO = Object.entries(RESUMEN_CATEGORIAS)
  .map(([cat, prods]) => {
    const emoji = prods[0].emoji || "🛍️";
    return `${emoji} ${cat}: ${prods.map((p) => `${p.nombre}${p.tipo === "replica" ? " (R)" : ""} ${formatoPrecio(p.precio)}`).join(", ")}`;
  })
  .join("\n");

// ---------- CONOCIMIENTO DE NYVEX DROP (entrenamiento de ventas) ----------
const INSTRUCCIONES = `
Eres el asistente de ventas virtual de "Nyvex Drop" (@nyvex_drop), tienda de sudaderas, audífonos, accesorios, celulares y perfumes. Respondes por WhatsApp en ESPAÑOL de México, breve (máximo 4 líneas), con un tono amable, natural, cercano y paciente. Tu objetivo es dar una atención al cliente FLUIDA y PROFESIONAL sin presionar al cliente con el pago.

MANTÉN EL HILO DE LA CONVERSACIÓN:
- Ya tienes el historial del chat. Si el cliente ya te dijo qué quiere, NO vuelvas a saludarlo ni le preguntes qué busca otra vez: continúa con su pedido.
- Solo saluda al inicio de una conversación nueva o si el cliente saluda.

TU OBJETIVO: GENERAR VENTAS. Guía al cliente desde la duda hasta cerrar el pedido, siempre con un cierre suave ("¿te confirmo tu pedido? 😊"), sin presionar ni insistir con el pago. Nunca discutas y siempre cuida al cliente.

FOTOS:
- Cuando el cliente pregunte por un producto, el sistema le envía automáticamente la FOTO del producto. Menciónale algo como "te envío la foto 😉" y luego dale los datos.

OFERTAS (estrategia de precios):
- El precio final SIEMPRE es el que dice el catálogo.
- Cada producto tiene un precio "antes" (publicado más caro) y hoy está con descuento. Puedes mencionar el "antes" para convencer: ej. "antes $229, hoy solo $190 con 15% de descuento 😉".
- No inventes otro "antes" ni otro descuento: usa los que vienen en el catálogo.

RÉPLICAS (audífonos):
- Los audífonos del catálogo actual están marcados con R = RÉPLICA. Son réplicas de excelente calidad con las funciones descritas (cancelación de ruido, GPS, interfaz iOS, etc.).
- Si el cliente pregunta "¿son originales?", sé HONESTO: "Son réplicas de muy buena calidad, no originales. Los originales llegarán pronto (los marcamos con O) pero con un precio más alto 😊". NUNCA digas que son originales.

PAGOS SEGÚN LA ZONA (regla clave: no presiones ni repitas la CLABE):
- NUNCA repitas la CLABE ni pidas el comprobante de pago en cada mensaje. Solo proporciona la CLABE cuando el cliente confirme EXPLÍCITAMENTE que pagará por transferencia.
- CLABE para transferencia/depósito: 638180010134011001.

ZONA A (entrega personal en municipios cercanos: Tecalco, Atlautla, Ozumba, Tepetlixpa):
- Opción 1: Pago 100% por transferencia.
- Opción 2 (contraentrega): el cliente anticipa el 50% por transferencia para apartar el producto y llevarlo al punto acordado; el 50% restante se paga en efectivo (o transferencia) al entregarle el producto en mano.

ZONA B (Ameca y demás municipios lejanos o envíos):
- Solo pago del 100% por transferencia bancaria previa al envío.

ENTREGAS:
- El precio YA INCLUYE el envío a la zona de entrega (envío local).
- Si el cliente es de OTRA zona, dile que un asesor le confirma el costo del envío.
- Instagram: @nyvex_drop.

FLUJO DE CONVERSACIÓN RECOMENDADO:
1. Saluda y confirma disponibilidad y talla del producto.
2. Pregunta la ubicación del cliente si aún no la ha mencionado.
3. Según su ubicación:
   - Si es ZONA A: ofrécele las dos opciones (pago 100% transferencia O anticipo del 50% para entrega en persona y liquidar el resto al recibir).
   - Si es ZONA B: indícale amablemente que para su zona el pedido se procesa previo pago del 100% por transferencia.
4. Espera a que el cliente elija el método de pago ANTES de enviar los datos bancarios.
5. Cuando el cliente quiera pagar, pídele su NOMBRE ("¿Me confirmas tu nombre para tu pedido? 😊") y confirma el producto.
6. Cliente manda comprobante o dice que ya pagó: "¡Gracias! 🙏 Analizaremos los datos de tu compra y te confirmamos en un momento." (NUNCA le digas que ya está confirmado: el asesor verifica el pago primero).
7. Si el cliente duda por el precio: recuérdale la oferta (precio "antes" vs hoy) y que el precio ya incluye envío.
8. Si pide un producto que NO está en el catálogo: "¡Claro! Lo podemos conseguir, solo tarda un poco más. Un asesor te dice el tiempo y el precio 😊" y derívalo.
9. Si pregunta por su pedido/paquete/estatus: "Un asesor te confirma el estatus al momento 😊" (el sistema avisa al equipo).
10. Si pregunta algo que no sabes o no es venta (garantías, pagos en línea): deriva al asesor.

CATÁLOGO COMPLETO (precio de venta final, NO inventar precios ni productos):
${CATALOGO_DESCRIPCIONES}

RESUMEN RÁPIDO POR CATEGORÍAS:
${CATALOGO_TEXTO}

REGLAS:
- NUNCA inventes productos, precios, tallas ni características.
- Precios SIEMPRE con $ y con la cifra exacta del catálogo (ej. $190, no $190.00).
- Respuestas cortas: máximo 4 líneas. Usa viñetas si hace falta.
- Si el cliente manda saludos, salúdalo y pregúntale qué le interesa.
- Si preguntan "¿qué venden?" o "enséñame TODOS los productos" o "catálogo": usa SOLO el RESUMEN RÁPIDO por categorías con precios (sin descripciones largas) y termina ofreciendo: "¿Te mando fotos de alguna categoría? Sudaderas, audífonos, accesorios, celulares o perfumes 😊". No empieces la respuesta con "draft" ni "borrador".
- Si el cliente pregunta por una CATEGORÍA (audífonos, sudaderas, accesorios, celulares o perfumes), lista TODOS los productos de esa categoría con su precio, uno por renglón. El sistema además les manda la foto de cada uno.
- Escribe en texto plano y limpio: usa viñetas con "-" y *asteriscos* solo para resaltar palabras. No uses encabezados ni símbolos raros.
`;

// ---------- DETECTOR DE PRODUCTO EN EL MENSAJE (para mandar la foto) ----------
function normalizar(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CLAVES_PRODUCTO = [
  { nombre: "AirPods Max", palabras: ["airpods max", "diadema"] },
  { nombre: "AirPods Pro 3 Traducción Real", palabras: ["pro 3", "traduccion", "traductor"] },
  { nombre: "AirPods 2 Pro con Cancelación", palabras: ["airpods 2", "2 pro", "pro 2"] },
  { nombre: "AirPods 4", palabras: ["airpods 4"] },
  { nombre: "Auriculares Inalámbricos Pro", palabras: ["inalambricos pro", "inalambrico pro", "inalambricos", "inalambrico", "auriculares pro", "auricular pro", "audifonos pro", "audifono pro", "earbuds"] },
  { nombre: "Capucha Dragón para Hombre", palabras: ["capucha dragon", "dragon"] },
  { nombre: "Camiseta Flow para Hombre", palabras: ["camiseta flow", "flow"] },
  { nombre: "Sudadera Katana Japonesa para Hombre", palabras: ["katana", "japonesa"] },
  { nombre: "Sudadera Gringa para Hombre", palabras: ["sudadera gringa", "gringa"] },
  { nombre: "Cable C a Lightning (1m)", palabras: ["cable"] },
  { nombre: "Batería MagSafe 5000 mAh", palabras: ["magsafe 5000", "bateria 5000"] },
  { nombre: "Batería MagSafe 10,000 mAh", palabras: ["magsafe 10000", "bateria 10000"] },
  { nombre: "iPhone 14", palabras: ["iphone"] },
  { nombre: "Rasasi Hawas Ice for Him", palabras: ["rasasi", "hawas", "perfume"] },
];

function buscarProductos(mensaje) {
  const m = normalizar(mensaje);
  if (m.length < 4) return [];

  // 1) Coincidencia específica → una sola foto
  for (const clave of CLAVES_PRODUCTO) {
    if (clave.palabras.some((p) => m.includes(p))) {
      const prod = PRODUCTOS.find((p) => p.nombre === clave.nombre);
      return prod ? [prod] : [];
    }
  }

  // 2) Categorías genéricas → fotos de todo lo que aplique
  const resultados = [];

  if (/\b(sudadera|sudaderas|capucha|capuchas|camiseta|camisetas)\b/.test(m)) {
    resultados.push(...PRODUCTOS.filter((p) => p.categoria === "sudaderas"));
  }
  if (/\b(airpods|audifono|audifonos|auricular|auriculares|bluetooth)\b/.test(m)) {
    resultados.push(...PRODUCTOS.filter((p) => p.categoria === "audifonos"));
  }
  if (/\b(magsafe|bateria|baterias)\b/.test(m)) {
    resultados.push(...PRODUCTOS.filter((p) => p.categoria === "accesorios" && p.nombre.includes("MagSafe")));
  }
  if (/\b(celular|celulares|telefono)\b/.test(m) && !/\biphone\b/.test(m)) {
    const cel = PRODUCTOS.find((p) => p.categoria === "celulares");
    if (cel) resultados.push(cel);
  }
  if (/\b(perfume|perfumes|fragancia|fragancias)\b/.test(m) && !/\b(rasasi|hawas)\b/.test(m)) {
    const perf = PRODUCTOS.find((p) => p.categoria === "perfumes");
    if (perf) resultados.push(perf);
  }

  return resultados.filter(
    (p, i, arr) => arr.findIndex((x) => x.nombre === p.nombre) === i
  );
}

// ---------- MEMORIA DE CONVERSACIÓN POR CLIENTE ----------
const chats = new Map();
function getChat(numero) {
  if (!chats.has(numero)) {
    chats.set(numero, { historial: [], pedidoId: null });
  }
  return chats.get(numero);
}

function agregarHistorial(numero, rol, texto) {
  const chat = getChat(numero);
  chat.historial.push({ role: rol, text: texto });
  if (chat.historial.length > 16) {
    chat.historial = chat.historial.slice(-16);
  }
}

// ---------- PEDIDOS ----------
function pedidoActivo(numero) {
  return PEDIDOS.find((p) => p.numero === numero && p.estado === "pendiente") || null;
}

function pedidosDe(numero) {
  return PEDIDOS.filter((p) => p.numero === numero).sort(
    (a, b) => new Date(b.fecha) - new Date(a.fecha)
  );
}

function crearPedido(numero, nombre, productos, texto, perfil) {
  const pedido = {
    id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    fecha: new Date().toISOString(),
    numero: numero || "",
    nombre: nombre || "Sin nombre",
    perfil: perfil || "",
    productos: (productos || []).map((p) => `${p.nombre} - ${formatoPrecio(p.precio)}`),
    talla: "",
    texto: texto || "",
    recibo: null,
    recibo_b64: null,
    estado: "pendiente", // pendiente | confirmado | enviando | entregado
  };
  PEDIDOS.push(pedido);
  guardarPedidos();
  return pedido;
}

function extraerNombre(texto) {
  const m = normalizar(texto);
  const basura = new Set(["de", "del", "el", "la", "las", "los", "un", "una", "unos", "unas", "tu", "tus", "su", "sus", "me", "mi", "lo", "que", "y", "por", "para", "con", "cliente", "amigo", "a", "al", "desde", "es"]);
  let captura = "";
  let n = m.match(/mi nombre es\s+([a-z]+(?:\s+[a-z]+)?)/);
  if (n) captura = n[1];
  else {
    n = m.match(/me llamo\s+([a-z]+(?:\s+[a-z]+)?)/);
    if (n) captura = n[1];
    else {
      n = m.match(/soy\s+([a-z]+)/);
      if (n) captura = n[1];
    }
  }
  if (!captura) return "";
  const partes = captura.split(/\s+/).filter((w) => !basura.has(w));
  const limpio = partes.slice(0, 2).join(" ");
  if (!limpio || limpio.length < 2) return "";
  return limpio;
}

const REGEX_COMPRA = /compr|pedir|pedido|pagar|pago|pague|pagaste|deposit|transfer|comprobante|me lo llevo|apart|clabe|efectivo|tarjeta|me interesa|lo quiero/;
const REGEX_ESTATUS = /como va|mi paquete|mi pedido|estatus|seguimiento|cuando llega|cuanto falta|en que va|ya llego/;

// ---------- DESCARGA DE MEDIA (comprobante) DE META ----------
async function descargarMedia(mediaId) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const data = await res.json();
    if (!data.url) {
      console.error("Media sin URL:", JSON.stringify(data));
      return null;
    }
    const imgRes = await fetch(data.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const ext =
      (data.mime_type || "").includes("png") ? "png" :
      (data.mime_type || "").includes("webp") ? "webp" :
      (data.mime_type || "").includes("jpeg") || (data.mime_type || "").includes("jpg") ? "jpg" : "bin";
    return { buffer, ext };
  } catch (e) {
    console.error("Error descargando media:", e.message);
    return null;
  }
}

// ---------- NOTIFICACIONES AL DUEÑO ----------
async function notificarOwner(mensaje) {
  if (!OWNER_PHONE) {
    console.log("⚠️ OWNER_PHONE no configurado, no se pudo avisar al dueño");
  } else {
    try {
      await enviarWhatsApp(OWNER_PHONE, mensaje);
    } catch (e) {
      console.error("Error avisando al dueño:", e.message);
    }
  }
  // Notificación push al celular (si tiene el admin instalado como app)
  const simple = mensaje.replace(/\*+/g, "").replace(/\n+/g, " ").slice(0, 120);
  enviarPush("🔔 Aviso del bot", simple);
}

function mensajeEstadoCliente(pedido) {
  const map = {
    confirmado: `✅ ¡Tu pago fue confirmado, *${pedido.nombre || "cliente"}*! Tu pedido *${pedido.id}* está en preparación para el envío 🚚 Un asesor coordina la entrega. ¡Gracias por tu compra! 😊`,
    enviando: `📦 *${pedido.id}* ¡Tu pedido va en camino! 🚚 Un asesor te pasa los detalles de la entrega.`,
    entregado: `🎉 *${pedido.id}* ¡Tu pedido ya fue entregado! Gracias por tu compra en Nyvex Drop 🙌`,
  };
  return map[pedido.estado];
}

// Mensajes de rechazo de comprobante (falso / no coincide / borroso)
const MENSAJES_RECHAZO = {
  falso: (p) => `Hola *${p.nombre || "cliente"}* 😕 Revisamos tu comprobante y no pudimos validarlo. ¿Puedes reenviarlo, por favor? Si tienes dudas, un asesor te ayuda por aquí a confirmar tu pedido *${p.id}*.`,
  no_coincide: (p) => `Hola *${p.nombre || "cliente"}* 😕 El comprobante que enviaste no coincide con los datos de tu pedido *${p.id}*. ¿Nos reenvías el comprobante correcto, por favor?`,
  borroso: (p) => `Hola *${p.nombre || "cliente"}* 🙏 Tu comprobante se ve borroso y no lo alcanzamos a leer bien. ¿Puedes subirlo de nuevo con mejor calidad? Así confirmamos tu pedido al momento.`,
};
function mensajeRechazoCliente(pedido, motivo) {
  return MENSAJES_RECHAZO[motivo] ? MENSAJES_RECHAZO[motivo](pedido) : "";
}

// ---------- COMANDOS DEL DUEÑO ----------
// "confirmar ABC123", "enviando ABC123", "entregado ABC123" (el ID es opcional si solo hay uno pendiente)
// Rechazo de comprobante: "falso ABC123", "no coincide ABC123", "borroso ABC123" → le avisan al cliente y le piden reenviarlo
async function procesoComandoOwner(texto) {
  const m = normalizar(texto);
  let accion = null;
  let rechazo = null;
  if (/confirm|listo|si cayo|ya cayo|pago recibido/.test(m)) accion = "confirmado";
  else if (/enviando|en camino|salio/.test(m)) accion = "enviando";
  else if (/entregad/.test(m)) accion = "entregado";
  else if (/falso|falsa|no valido|no es valido|falsificad/.test(m)) rechazo = "falso";
  else if (/no coincide|no cuadra|no corresponde|no es el suyo/.test(m)) rechazo = "no_coincide";
  else if (/borroso|borrosa|no se lee|ilegible|mala calidad|no alcanzo/.test(m)) rechazo = "borroso";
  if (!accion && !rechazo) return null;

  const idMatch = m.match(/\b([a-z0-9]{6})\b/);
  let pedido = idMatch ? PEDIDOS.find((p) => p.id.toLowerCase() === idMatch[1]) : null;
  if (!pedido) {
    pedido = PEDIDOS.filter((p) => p.estado === "pendiente").sort(
      (a, b) => new Date(b.fecha) - new Date(a.fecha)
    )[0];
  }
  if (!pedido) return "No hay pedidos pendientes para actualizar.";

  if (rechazo) {
    await enviarWhatsApp(pedido.numero, mensajeRechazoCliente(pedido, rechazo));
    const motivo = rechazo === "falso" ? "falso" : rechazo === "no_coincide" ? "que no coincide" : "borroso";
    return `⚠️ Le avisaste a *${pedido.nombre || "cliente"}* que su comprobante (*${pedido.id}*) se ve *${motivo}* y le pediste reenviarlo.`;
  }

  pedido.estado = accion;
  guardarPedidos();
  const msg = mensajeEstadoCliente(pedido);
  await enviarWhatsApp(pedido.numero, msg);
  return `✅ Pedido *${pedido.id}* → *${accion}*. Cliente notificado.`;
}

// ---------- VERIFICACIÓN DEL WEBHOOK (Meta lo llama al configurar) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------- MENSAJES QUE LLEGAN ----------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const body = req.body;
    if (!body.entry) return;

    const baseUrl = SITE_URL || `https://${req.get("host")}`;

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;

        // Nombre del cliente que manda Meta (si lo da)
        const nombreCliente =
          value.contacts && value.contacts[0] && value.contacts[0].profile
            ? value.contacts[0].profile.name
            : "";

        // No contestar mensajes que envía el propio negocio
        for (const msg of value.messages || []) {
          const emisor = msg.from;
          console.log("💬 Mensaje de", emisor, "tipo:", msg.type);

          if (BOT_PHONE_NUMBER && emisor === BOT_PHONE_NUMBER) {
            console.log("🚫 Ignorado (número del negocio)");
            continue;
          }

          let textoUsuario = "";
          if (msg.type === "text") {
            textoUsuario = msg.text.body;
          } else if (msg.type === "interactive") {
            const datos = msg.interactive;
            if (datos.type === "button_reply") textoUsuario = datos.button_reply.title;
            else if (datos.type === "list_reply") textoUsuario = datos.list_reply.title;
          } else if (msg.type === "image") {
            textoUsuario = "[cliente envió una imagen]";
          } else if (msg.type === "document") {
            textoUsuario = "[cliente envió un documento]";
          } else {
            textoUsuario = "[cliente envió otro archivo]";
          }

          const chat = getChat(emisor);
          agregarHistorial(emisor, "user", textoUsuario);

          // ---- Comandos del DUEÑO (confirmar/enviando/entregado) ----
          if (OWNER_PHONE && emisor === OWNER_PHONE && msg.type === "text") {
            const resultado = await procesoComandoOwner(textoUsuario);
            if (resultado) {
              await enviarWhatsApp(emisor, resultado);
              agregarHistorial(emisor, "model", resultado);
              continue;
            }
          }

          const mNorm = normalizar(textoUsuario);

          // Si el cliente dice su nombre, guardarlo en el chat y en el pedido abierto
          const nombreEnMensaje = extraerNombre(textoUsuario);
          if (nombreEnMensaje) {
            chat.nombreCliente = nombreEnMensaje[0].toUpperCase() + nombreEnMensaje.slice(1);
            const abierto = pedidoActivo(emisor);
            if (abierto && abierto.nombre !== chat.nombreCliente) {
              abierto.nombre = chat.nombreCliente;
              guardarPedidos();
            }
          }

          // ---- Consulta de estatus del paquete ----
          if (REGEX_ESTATUS.test(mNorm) && !REGEX_COMPRA.test(mNorm)) {
            const pedidos = pedidosDe(emisor);
            if (pedidos.length > 0) {
              const p = pedidos[0];
              const estadoMap = {
                pendiente: "⏳ Analizando pago",
                confirmado: "✅ Confirmado (preparando envío)",
                enviando: "📦 En camino",
                entregado: "🎉 Entregado",
              };
              await notificarOwner(
                `📦 *${p.nombre || "Cliente"}* (${p.numero}) pregunta por su pedido *${p.id}*\nEstado actual: ${estadoMap[p.estado] || p.estado}\nProducto: ${(p.productos || []).join(", ") || "-"}\n➡️ Responde: *"confirmar ${p.id}"*, *"enviando ${p.id}"* o *"entregado ${p.id}"* o dime cuánto falta.`
              );
              const reply = "Un asesor te confirma el estatus de tu pedido al momento 😊";
              await enviarWhatsApp(emisor, reply);
              agregarHistorial(emisor, "model", reply);
              continue;
            }
          }

          // ---- Foto del producto si el mensaje lo menciona ----
          const productos = buscarProductos(textoUsuario);
          for (const prod of productos) {
            const urlImagen = `${baseUrl}/img/${encodeURIComponent(prod.imagen.replace(/^img\//, ""))}`;
            const caption = `${prod.nombre}${prod.tipo === "replica" ? " (R)" : ""} - ${formatoPrecio(prod.precio)}`;
            await enviarWhatsAppImagen(emisor, urlImagen, caption);
          }

          // ---- Detectar intención de compra o comprobante ----
          const esCompra = REGEX_COMPRA.test(mNorm) && msg.type === "text";
          const esComprobante = msg.type === "image" || msg.type === "document" || msg.type === "video";

          if (esCompra || esComprobante) {
            let pedido = pedidoActivo(emisor);
            if (!pedido) {
              pedido = crearPedido(emisor, chat.nombreCliente || "", productos, textoUsuario, nombreCliente);
              chat.pedidoId = pedido.id;
              const clienteRef = pedido.nombre === "Sin nombre" && pedido.perfil ? `${pedido.nombre} (perfil: ${pedido.perfil})` : pedido.nombre;
              await notificarOwner(
                `🛒 *NUEVO PEDIDO / INTERÉS*\n👤 Cliente: ${clienteRef}\n📱 Número: ${pedido.numero}\n📦 Producto: ${(pedido.productos || []).join(", ") || "por confirmar"}\n💬 Mensaje: ${pedido.texto}\n🕒 ${new Date().toLocaleString("es-MX")}\n➡️ Cuando te caiga el pago responde: *"confirmar ${pedido.id}"*`
              );
            } else {
              // actualizar el pedido abierto
              if (productos.length > 0 && pedido.productos.length === 0) {
                pedido.productos = productos.map((p) => `${p.nombre} - ${formatoPrecio(p.precio)}`);
              }
              if (!pedido.nombre || pedido.nombre === "Sin nombre") {
                pedido.nombre = chat.nombreCliente || "Sin nombre";
              }
              if (!pedido.perfil && nombreCliente) {
                pedido.perfil = nombreCliente;
              }
              pedido.texto = textoUsuario;
              guardarPedidos();
            }

            // Nombre del cliente si lo dice en el mensaje (siempre gana sobre el nombre del perfil)
            const nombreDetectado = extraerNombre(textoUsuario);
            if (nombreDetectado) {
              pedido.nombre = nombreDetectado[0].toUpperCase() + nombreDetectado.slice(1);
              guardarPedidos();
            }

            // Comprobante (foto/doc) → descargarlo y adjuntarlo al pedido
            if (esComprobante && (msg.image || msg.document)) {
              const mediaId = (msg.image && msg.image.id) || (msg.document && msg.document.id);
              if (mediaId) {
                const media = await descargarMedia(mediaId);
                if (media) {
                  const archivo = `${pedido.id}.${media.ext}`;
                  fs.writeFileSync(path.join(RECIBOS_DIR, archivo), media.buffer);
                  pedido.recibo = `recibos/${archivo}`;
                  pedido.recibo_b64 = media.buffer.toString("base64");
                  RECIBOS_MEM[archivo] = pedido.recibo_b64;
                  guardarPedidos();
                  await notificarOwner(
                    `📎 *COMPROBANTE RECIBIDO*\nPedido: *${pedido.id}* — Cliente: ${pedido.nombre} (${pedido.numero})\nProducto: ${(pedido.productos || []).join(", ") || "-"}\n📷 Foto: ${baseUrl}/${pedido.recibo}\n📋 Pedidos: ${baseUrl}/pedidos\n➡️ Verifica el pago y responde: *"confirmar ${pedido.id}"*`
                  );
                  const reply = "¡Gracias! 🙏 Analizaremos los datos de tu compra y te confirmamos en un momento.";
                  await enviarWhatsApp(emisor, reply);
                  agregarHistorial(emisor, "model", reply);
                  continue;
                }
              }
            }
          }

          // ---- Respuesta de Gemini con historial ----
          const respuesta = await generarRespuesta(emisor, textoUsuario);
          await enviarWhatsApp(emisor, respuesta);
          agregarHistorial(emisor, "model", respuesta);
        }
      }
    }
  } catch (error) {
    console.error("Error en webhook:", error.message);
  }
});

// ---------- INTELIGENCIA (Gemini gratis) ----------
async function generarRespuesta(numero, mensaje, intento) {
  intento = intento || 1;
  const chat = getChat(numero);
  const contents = [];
  for (const turno of chat.historial.slice(-14)) {
    contents.push({ role: turno.role, parts: [{ text: turno.text }] });
  }
  contents.push({ role: "user", parts: [{ text: mensaje }] });

  let huboCuota = false;

  for (const modelo of ordenarModelos()) {
    if (modeloBloqueado(modelo)) continue;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_KEY}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: INSTRUCCIONES }] },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 900
          }
        })
      });

      const data = await res.json();
      const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (texto) {
        marcarOk(modelo);
        return texto.trim();
      }

      if (data?.error) {
        console.error(`Error Gemini (${modelo}):`, data.error.message);
        if (res.status === 429) {
          const detalle = data.error.details || [];
          const retry = detalle.find((d) => d.retryDelay)?.retryDelay || "30s";
          const seg = Math.min(parseInt(retry) || 30, 120);
          bloquearModelo(modelo, seg * 1000);
          huboCuota = true;
        } else {
          // Error raro: bloquear 5 minutos y seguir con otro modelo
          bloquearModelo(modelo, 5 * 60 * 1000);
        }
      }
    } catch (error) {
      console.error(`Error en Gemini (${modelo}):`, error.message);
      bloquearModelo(modelo, 60 * 1000);
    }
  }

  // Si todo estaba agotado, esperar unos segundos y reintentar (máx. 2 rondas)
  if (huboCuota && intento < 2) {
    await new Promise((r) => setTimeout(r, 4000));
    return generarRespuesta(numero, mensaje, intento + 1);
  }

  return "Disculpa, por el momento no puedo responder 😕 Escríbenos por Instagram 📸 *@nyvex_drop* 👋";
}

// ---------- ENVIAR MENSAJE POR WHATSAPP ----------
async function enviarWhatsApp(para, texto) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: para,
      type: "text",
      text: { body: texto }
    })
  });

  const respuesta = await res.text();
  console.log("📤 Respuesta de WhatsApp API:", res.status, respuesta.slice(0, 300));
  if (res.status !== 200) {
    throw new Error(`WhatsApp API respondió ${res.status}: ${respuesta.slice(0, 200)}`);
  }
}

// ---------- ENVIAR FOTO DEL PRODUCTO ----------
async function enviarWhatsAppImagen(para, urlImagen, caption) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: para,
      type: "image",
      image: { link: urlImagen, caption }
    })
  });

  const respuesta = await res.text();
  console.log("🖼️ Respuesta imagen:", res.status, respuesta.slice(0, 200));
}

// ---------- RUTA PRINCIPAL (para revisar que esté vivo) ----------
app.get("/", (req, res) => {
  res.send("🤖 Nyvex Drop Bot activo");
});

// ---------- ENDPOINT PARA VER EL CATÁLOGO (prueba) ----------
app.get("/catalogo", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`Catálogo Nyvex Drop:\n${CATALOGO_TEXTO}`);
});

// La tienda web carga el catálogo desde aquí (una sola fuente: productos.json)
app.get("/productos.json", (req, res) => {
  res.json(PRODUCTOS);
});

// ---------- DIAGNÓSTICO DE CONFIGURACIÓN (no muestra valores secretos) ----------
app.get("/config", (req, res) => {
  res.json({
    gemini: !!GEMINI_KEY,
    whatsapp_token: !!WHATSAPP_TOKEN,
    phone_number_id: !!PHONE_NUMBER_ID,
    owner_phone: !!OWNER_PHONE,
    bot_phone_number: !!BOT_PHONE_NUMBER,
    site_url: !!SITE_URL,
    modelo: GEMINI_MODEL,
    productos: PRODUCTOS.length,
    pedidos: PEDIDOS.length,
  });
});

// ---------- ESTADO DE LOS MODELOS (gestor automático) ----------
app.get("/modelos", (req, res) => {
  const ahora = Date.now();
  res.json(
    MODELOS_GEMINI.map((m) => {
      const e = estadoModelos[m] || {};
      const restante = e.bloqueadoHasta ? Math.max(0, Math.round((e.bloqueadoHasta - ahora) / 1000)) : 0;
      return {
        modelo: m,
        estado: modeloBloqueado(m) ? `bloqueado (${restante}s)` : "disponible",
        ultimo_ok: e.ultimoOk ? new Date(e.ultimoOk).toLocaleTimeString("es-MX") : null,
        fallos: e.fallos || 0,
      };
    })
  );
});

// ---------- ADMIN (app móvil para administrar pedidos) ----------
// Protegida con contraseña: /admin?pass=... (usa ADMIN_PASSWORD o el token de verificación)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "kromastore";

function esAdmin(req) {
  return req.query.pass === ADMIN_PASSWORD;
}

const ADMIN_LOGIN_HTML = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nyvex Admin</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login{max-width:320px;width:100%;padding:2rem;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px}
h1{font-size:1.4rem;margin:0 0 1rem;text-align:center}
input{width:100%;padding:.8rem;margin-bottom:1rem;background:#0a0a0a;border:1px solid #2a2a2a;color:#fff;border-radius:10px;font-size:1rem;box-sizing:border-box}
button{width:100%;padding:.9rem;background:#fff;color:#0a0a0a;border:none;border-radius:999px;font-weight:700;font-size:1rem}
</style></head><body>
<div class="login">
<h1>🔐 Nyvex Admin</h1>
<input type="password" id="pass" placeholder="Contraseña">
<button onclick="go()">Entrar</button>
</div>
<script>
function go(){var p=document.getElementById("pass").value;if(p)location.href="/admin?pass="+encodeURIComponent(p);}
document.getElementById("pass").addEventListener("keydown",function(e){if(e.key==="Enter")go();});
</script>
</body></html>`;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Nyvex Admin</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0a0a0a">
<style>
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;margin:0;padding:0 12px 24px}
.topbar{position:sticky;top:0;background:#0a0a0a;padding:14px 4px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2a2a2a;z-index:10}
.topbar h1{font-size:1.15rem;margin:0}
.topbar a{color:#9a9a9a;font-size:.8rem;text-decoration:none}
.pedido{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:14px;padding:14px;margin-top:12px}
.pedido.nuevo{border-color:#ffd54f}
.phead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.pid{font-weight:800;letter-spacing:2px;font-size:1.05rem}
.badge{font-size:.7rem;font-weight:700;padding:4px 9px;border-radius:999px;white-space:nowrap}
.b-pendiente{background:#4a3a08;color:#ffd54f}.b-confirmado{background:#0f3d1a;color:#7dff9e}
.b-enviando{background:#0b2a52;color:#7fb2ff}.b-entregado{background:#33114f;color:#d9a7ff}
.info{color:#9a9a9a;font-size:.82rem;margin-top:8px}
.info b{color:#fff}
.prods{margin:8px 0 0 0;padding-left:18px;font-size:.9rem}
.recibo{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.recibo img{width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #2a2a2a}
.recibo span{color:#7fb2ff;font-size:.8rem}
.texto{background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;padding:8px;font-size:.8rem;color:#cfcfcf;margin-top:8px;white-space:pre-wrap;word-break:break-word}
.botones{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:10px}
.botones button{border:none;border-radius:9px;padding:11px 4px;font-size:.78rem;font-weight:700;color:#fff;cursor:pointer;line-height:1.2}
.b-confirmar{background:#2e7d32}.b-enviar{background:#1565c0}.b-entregar{background:#6a1b9a}
.b-falso{background:#8a2b2b}.b-no{background:#5f3b00}.b-borroso{background:#4a4a4a}.b-borrar{background:#c62828}
.aviso{text-align:center;color:#9a9a9a;margin-top:14px;font-size:.8rem}
.vacio{text-align:center;color:#9a9a9a;margin-top:3rem}
</style></head><body>
<div class="topbar">
<h1>🛒 Nyvex Admin</h1>
<div><a href="#" id="recargar">🔄 Actualizar</a> · <a href="/">🌐 Tienda</a></div>
</div>
<div id="lista"><p class="vacio">Cargando…</p></div>
<p class="aviso">Se actualiza solo cada 15 segundos. Un toque en un botón avisa al cliente por WhatsApp.</p>
<script>
var PASS = ${JSON.stringify(ADMIN_PASSWORD)};
var ESTADOS = {pendiente:["⏳ Analizando pago","b-pendiente"],confirmado:["✅ Confirmado","b-confirmado"],enviando:["📦 En camino","b-enviando"],entregado:["🎉 Entregado","b-entregado"]};
var ultimoTotal = 0;

function beep(){try{var c=new (window.AudioContext||window.webkitAudioContext)();var o=c.createOscillator();var g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.value=880;g.gain.value=0.08;o.start();setTimeout(function(){o.stop();c.close();},350);}catch(e){}}

function notificar(nombre,id){
  if("Notification" in window && Notification.permission==="granted"){
    try{new Notification("🛒 Nuevo pedido "+id,{body:nombre||"Llego un pedido",icon:"/img/logo.jpeg"});}catch(e){}
  }
  if(navigator.vibrate){try{navigator.vibrate([250,120,250]);}catch(e){}}
}

function fmtFecha(iso){var d=new Date(iso);return d.toLocaleString("es-MX",{dateStyle:"short",timeStyle:"short"});}

function botones(p){
  var accs=[["confirmar","✅<br>Confirmar","b-confirmar"],["enviando","📦<br>Enviando","b-enviar"],["entregado","🎉<br>Entregado","b-entregar"],["falso","🚫<br>Falso","b-falso"],["no_coincide","↔️<br>No coincide","b-no"],["borroso","🌫️<br>Borroso","b-borroso"]];
  var html='<div class="botones">'+accs.map(function(a){
    return '<button class="'+a[2]+'" onclick="accion(\\''+p.id+'\\',\\''+a[0]+'\\')">'+a[1]+'</button>';
  }).join("");
  if(p.estado==="entregado"){
    html+='<button class="b-borrar" onclick="eliminar(\\''+p.id+'\\')">🗑️<br>Borrar</button>';
  }
  return html+'</div>';
}

function card(p){
  var est=ESTADOS[p.estado]||["❓ "+p.estado,"b-pendiente"];
  var prods=(p.productos||[]).map(function(x){return "<li>"+x+"</li>";}).join("");
  var recibo=p.recibo?'<a class="recibo" href="/'+p.recibo+'" target="_blank"><img src="/'+p.recibo+'" alt="comprobante"><span>Ver comprobante</span></a>':"";
  var num=p.numero?'<b>📱 '+p.numero+'</b> <a href="https://wa.me/'+p.numero+'" style="color:#7fb2ff">(abrir chat)</a>':"<b>📱 sin número</b>";
  var perfilH=(p.perfil && p.nombre==="Sin nombre")?' <span style="color:#888">(perfil: '+p.perfil.replace(/</g,"&lt;")+')</span>':"";
  return '<div class="pedido'+(p.nuevo?" nuevo":"")+'">'+
    '<div class="phead"><span class="pid">'+p.id+'</span><span class="badge '+est[1]+'">'+est[0]+'</span></div>'+
    '<div class="info"><b>'+p.nombre+'</b>'+perfilH+' · '+num+'<br>🗓 '+fmtFecha(p.fecha)+(p.talla?" · 👕 "+p.talla:"")+'</div>'+
    (prods?'<ul class="prods">'+prods+'</ul>':"")+
    recibo+
    (p.texto?'<div class="texto">'+p.texto.replace(/</g,"&lt;")+'</div>':"")+
    botones(p)+'</div>';
}

function cargar(){
  fetch("/api/admin/pedidos?pass="+PASS).then(function(r){return r.json();}).then(function(data){
    if(!Array.isArray(data)){document.getElementById("lista").innerHTML='<p class="vacio">Sin acceso. <a href="/admin">Volver a entrar</a></p>';return;}
    if(ultimoTotal>0 && data.length>ultimoTotal){
      beep();
      if(data.length>0) notificar(data[0].nombre, data[0].id);
    }
    ultimoTotal=data.length;
    document.getElementById("lista").innerHTML = data.length
      ? data.map(card).join("")
      : '<p class="vacio">Sin pedidos todavía</p>';
  }).catch(function(){
    document.getElementById("lista").innerHTML='<p class="vacio">Sin conexión. Reintentando…</p>';
  });
}

function accion(id,acc){
  fetch("/api/admin/accion?pass="+PASS,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id,accion:acc})})
    .then(function(r){return r.json();})
    .then(function(data){cargar();if(!data.ok)alert(data.error||"Error");})
    .catch(function(){alert("Sin conexión");});
}

function eliminar(id){
  if(!confirm("¿Borrar este pedido entregado del historial?"))return;
  fetch("/api/admin/eliminar?pass="+PASS,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})})
    .then(function(r){return r.json();})
    .then(function(data){if(data.ok){cargar();}else{alert(data.error||"Error");}})
    .catch(function(){alert("Sin conexión");});
}

document.getElementById("recargar").addEventListener("click",function(e){e.preventDefault();cargar();});
cargar();
setInterval(cargar,15000);
</script>
<script>
function urlBase64ToUint8Array(base64String){
  var padding="=".repeat((4-base64String.length%4)%4);
  var base64=(base64String+padding).replace(/-/g,"+").replace(/_/g,"/");
  var raw=window.atob(base64);
  var arr=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i);
  return arr;
}
function registrarPush(){
  if(!("Notification" in window)||!("PushManager" in window))return;
  if(Notification.permission!=="granted")return;
  if(!navigator.serviceWorker)return;
  navigator.serviceWorker.ready.then(function(reg){
    return fetch("/api/push/public-key").then(function(r){return r.json();}).then(function(d){
      if(!d.publicKey)return;
      return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(d.publicKey)});
    });
  }).then(function(sub){
    if(!sub)return;
    return fetch("/api/admin/push/subscribe?pass="+PASS,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({subscription:sub})});
  }).catch(function(e){console.log("push:",e.message);});
}
if("Notification" in window){
  if(Notification.permission==="default"){
    Notification.requestPermission().then(function(p){if(p==="granted")registrarPush();});
  } else if(Notification.permission==="granted"){
    registrarPush();
  }
}
if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){});}
</script>
</body></html>`;

app.get("/admin", (req, res) => {
  if (!esAdmin(req)) return res.send(ADMIN_LOGIN_HTML);
  res.send(ADMIN_HTML);
});

// PWA: se puede instalar como app en el celular (Agregar a pantalla de inicio)
app.get("/manifest.json", (req, res) => {
  res.json({
    name: "Nyvex Admin",
    short_name: "Nyvex",
    start_url: "/admin",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [{ src: "/img/logo.jpeg", sizes: "512x512", type: "image/jpeg" }],
  });
});

app.get("/sw.js", (req, res) => {
  res.type("application/javascript").send(`const CACHE = "nyvex-admin-v1";
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(clients.claim()); });
self.addEventListener("fetch", function(e){
  var url = new URL(e.request.url);
  if (url.pathname.indexOf("/api/") === 0 || url.pathname.indexOf("/admin") === 0 || url.pathname.indexOf("/pedidos") === 0 || url.pathname.indexOf("/recibos/") === 0) return;
  e.respondWith(fetch(e.request).catch(function(){ return caches.match(e.request); }));
});
self.addEventListener("push", function(e){
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}
  e.waitUntil(self.registration.showNotification(data.title || "Nyvex Admin", {
    body: data.body || "",
    icon: data.icon || "/img/logo.jpeg",
    badge: data.badge || "/img/logo.jpeg",
    tag: "pedido",
    vibrate: [250,120,250],
    data: { url: "/admin" }
  }));
});
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf("/admin") > -1) return list[i].focus();
    }
    return clients.openWindow(e.notification.data.url || "/admin");
  }));
});`);
});

// Llave pública para que el admin (celular) se pueda registrar a las notificaciones
app.get("/api/push/public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || null });
});

// Guarda la suscripción del celular del dueño
app.post("/api/admin/push/subscribe", async (req, res) => {
  if (!esAdmin(req)) return res.status(401).json({ ok: false, error: "No autorizado" });
  const sub = (req.body || {}).subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: "Suscripción inválida" });
  try {
    await pool.query(
      `INSERT INTO push_subs (endpoint, datos) VALUES ($1, $2)
       ON CONFLICT (endpoint) DO UPDATE SET datos = EXCLUDED.datos`,
      [sub.endpoint, JSON.stringify(sub)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Error guardando suscripción push:", e.message);
    res.status(500).json({ ok: false, error: "No se pudo guardar" });
  }
});

// Acción desde la app admin (confirmar / enviando / entregado / falso / no coincide / borroso)
app.post("/api/admin/accion", async (req, res) => {
  if (!esAdmin(req)) return res.status(401).json({ ok: false, error: "No autorizado" });
  const { id, accion } = req.body || {};
  const pedido = PEDIDOS.find((p) => (p.id || "").toUpperCase() === String(id || "").toUpperCase());
  if (!pedido) return res.json({ ok: false, error: "Pedido no encontrado" });

  const estados = { confirmar: "confirmado", enviando: "enviando", entregado: "entregado" };
  const rechazos = { falso: "falso", no_coincide: "no_coincide", borroso: "borroso" };

  if (estados[accion]) {
    pedido.estado = estados[accion];
    guardarPedidos();
    const msg = mensajeEstadoCliente(pedido);
    if (msg && pedido.numero) {
      await enviarWhatsApp(pedido.numero, msg).catch(() => {});
    }
  } else if (rechazos[accion]) {
    const msg = mensajeRechazoCliente(pedido, rechazos[accion]);
    if (msg && pedido.numero) {
      await enviarWhatsApp(pedido.numero, msg).catch(() => {});
    }
  } else {
    return res.json({ ok: false, error: "Acción inválida" });
  }

  res.json({ ok: true, pedido: pedidoPublico(pedido) });
});

// Eliminar un pedido entregado (para limpiar el historial)
app.post("/api/admin/eliminar", async (req, res) => {
  if (!esAdmin(req)) return res.status(401).json({ ok: false, error: "No autorizado" });
  const id = String((req.body || {}).id || "").toUpperCase();
  const idx = PEDIDOS.findIndex((p) => (p.id || "").toUpperCase() === id);
  if (idx === -1) return res.json({ ok: false, error: "Pedido no encontrado" });
  const p = PEDIDOS[idx];
  if (p.estado !== "entregado") {
    return res.json({ ok: false, error: "Solo se pueden borrar pedidos entregados" });
  }
  if (p.recibo) {
    delete RECIBOS_MEM[p.recibo.replace("recibos/", "")];
  }
  if (pool) {
    try {
      await pool.query("DELETE FROM pedidos WHERE id = $1", [p.id]);
    } catch (e) {
      console.error("Error borrando en la BD:", e.message);
    }
  }
  PEDIDOS.splice(idx, 1);
  try {
    fs.writeFileSync(PEDIDOS_PATH, JSON.stringify(PEDIDOS, null, 2));
  } catch (e) {
    console.error("Error guardando pedidos.json:", e.message);
  }
  res.json({ ok: true });
});

// Lista de pedidos para la app admin
app.get("/api/admin/pedidos", (req, res) => {
  if (!esAdmin(req)) return res.status(401).json({ ok: false, error: "No autorizado" });
  res.json(PEDIDOS.slice().reverse().map(pedidoPublico));
});

// ---------- API PARA LA TIENDA WEB ----------
app.post("/api/pedido", async (req, res) => {
  try {
    const { nombre, numero, producto, talla } = req.body || {};
    const num = (numero || "").replace(/[^0-9]/g, "").slice(-10);
    const prod = PRODUCTOS.find((p) => p.nombre === (producto || ""));
    const pedido = {
      id: Math.random().toString(36).slice(2, 8).toUpperCase(),
      fecha: new Date().toISOString(),
      numero: num ? "52" + num : "",
      nombre: (nombre || "Sin nombre").trim().slice(0, 60),
      productos: prod ? [`${prod.nombre} - ${formatoPrecio(prod.precio)}`] : [(producto || "").trim()],
      talla: talla || "",
      texto: "🛒 Pedido desde la página web",
      recibo: null,
      recibo_b64: null,
      estado: "pendiente",
      origen: "web",
    };
    PEDIDOS.push(pedido);
    guardarPedidos();
    await notificarOwner(
      `🛒 *PEDIDO DESDE LA WEB*\n👤 Cliente: ${pedido.nombre}\n📱 Número: ${pedido.numero || "no compartido"}\n📦 Producto: ${pedido.productos.join(", ")}\n👕 Talla: ${pedido.talla || "Estándar"}\n🕒 ${new Date().toLocaleString("es-MX")}\n➡️ Cuando caiga el pago responde: *"confirmar ${pedido.id}"*`
    );
    res.json({
      ok: true,
      id: pedido.id,
      nombre: pedido.nombre,
      productos: pedido.productos,
      total: prod ? formatoPrecio(prod.precio) : "",
    });
  } catch (e) {
    console.error("Error en /api/pedido:", e.message);
    res.status(500).json({ ok: false, error: "No se pudo registrar el pedido" });
  }
});

// Consulta de pedidos desde la web (por teléfono o por ID)
app.get("/api/pedidos", (req, res) => {
  const numero = (req.query.numero || "").replace(/[^0-9]/g, "");
  const id = (req.query.id || "").toUpperCase();
  let lista = PEDIDOS;
  if (id) {
    lista = lista.filter((p) => (p.id || "").toUpperCase() === id);
  } else if (numero) {
    lista = lista.filter((p) => (p.numero || "").replace(/[^0-9]/g, "").includes(numero));
  }
  res.json(
    lista
      .slice()
      .reverse()
      .map((p) => ({
        id: p.id,
        fecha: p.fecha,
        nombre: p.nombre,
        productos: p.productos,
        talla: p.talla,
        estado: p.estado,
        recibo: p.recibo || null,
      }))
  );
});

// ---------- ENDPOINT PARA RECHAZAR COMPROBANTE DESDE LA PÁGINA ----------
app.get("/pedidos/rechazar", (req, res) => {
  const id = (req.query.id || "").toUpperCase();
  const motivo = req.query.motivo;
  const pedido = PEDIDOS.find((p) => (p.id || "").toUpperCase() === id);
  if (pedido && ["falso", "no_coincide", "borroso"].includes(motivo) && pedido.numero) {
    const msg = mensajeRechazoCliente(pedido, motivo);
    if (msg) {
      enviarWhatsApp(pedido.numero, msg).catch(() => {});
    }
  }
  res.redirect("/pedidos");
});

// ---------- ENDPOINT PARA CAMBIAR ESTADO DESDE LA PÁGINA ----------
app.get("/pedidos/set", (req, res) => {
  const id = (req.query.id || "").toUpperCase();
  const estado = req.query.estado;
  const pedido = PEDIDOS.find((p) => p.id.toUpperCase() === id);
  if (pedido && ["pendiente", "confirmado", "enviando", "entregado"].includes(estado)) {
    pedido.estado = estado;
    guardarPedidos();
    const msg = mensajeEstadoCliente(pedido);
    if (msg) {
      enviarWhatsApp(pedido.numero, msg).catch(() => {});
    }
  }
  res.redirect("/pedidos");
});

// ---------- ENDPOINT PARA VER LOS PEDIDOS ----------
app.get("/pedidos", (req, res) => {
  const estadoLabel = {
    pendiente: "⏳ Analizando pago",
    confirmado: "✅ Confirmado",
    enviando: "📦 En camino",
    entregado: "🎉 Entregado",
  };

  const filas = PEDIDOS.slice()
    .reverse()
    .map((p) => {
      const reciboHtml = p.recibo
        ? `<a href="/${p.recibo}" target="_blank"><img src="/${p.recibo}" style="max-width:90px;border-radius:6px" alt="comprobante"></a>`
        : "—";
      const botones = ["confirmado", "enviando", "entregado"]
        .map(
          (e) =>
            `<a href="/pedidos/set?id=${p.id}&estado=${e}" style="display:inline-block;margin:2px;padding:4px 8px;border:1px solid #2a2a2a;border-radius:6px;font-size:12px;text-decoration:none;color:#fff">${estadoLabel[e]}</a>`
        )
        .join(" ");
      const rechazos = ["falso", "no_coincide", "borroso"]
        .map((r) => {
          const etiqueta = r === "falso" ? "🚫 Falso" : r === "no_coincide" ? "↔️ No coincide" : "🌫️ Borroso";
          return `<a href="/pedidos/rechazar?id=${p.id}&motivo=${r}" style="display:inline-block;margin:2px;padding:4px 8px;border:1px solid #a33;border-radius:6px;font-size:12px;text-decoration:none;color:#f88">${etiqueta}</a>`;
        })
        .join(" ");
      return `<tr>
        <td>${new Date(p.fecha).toLocaleString("es-MX")}</td>
        <td>${(p.id || "").replace(/</g, "&lt;")}</td>
        <td>${(p.nombre || "").replace(/</g, "&lt;")}</td>
        <td>${(p.numero || "").replace(/</g, "&lt;")}</td>
        <td>${(p.productos || []).join("<br>").replace(/</g, "&lt;")}</td>
        <td>${(p.texto || "").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</td>
        <td>${reciboHtml}</td>
        <td style="white-space:nowrap">${estadoLabel[p.estado] || p.estado}<br>${botones}<br>${rechazos}</td>
      </tr>`;
    })
    .join("");

  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pedidos Nyvex</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;padding:20px}
h1{color:#fff}table{width:100%;border-collapse:collapse;margin-top:15px}
th,td{border:1px solid #2a2a2a;padding:10px;text-align:left;font-size:13px;vertical-align:top}
th{background:#1a1a1a}td{background:#111}
</style></head><body>
<h1>🛒 Pedidos e intereses de Nyvex Drop</h1>
<p>✅ El historial se guarda en una base de datos en línea (Neon), no se pierde al reiniciar.</p>
<table>
<thead><tr><th>Fecha</th><th>ID</th><th>Cliente</th><th>Número</th><th>Producto</th><th>Mensaje</th><th>Comprobante</th><th>Estado</th></tr></thead>
<tbody>${filas || "<tr><td colspan='8'>Sin pedidos aún</td></tr>"}</tbody>
</table>
</body></html>`);
});

conectarBaseDeDatos().then(() => {
  app.listen(PORT, () => {
    console.log(`🤖 Nyvex Bot escuchando en el puerto ${PORT}`);
  });
});
