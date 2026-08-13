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
const PEDIDOS_PATH = path.join(__dirname, "pedidos.json");
let PEDIDOS = [];
try {
  PEDIDOS = JSON.parse(fs.readFileSync(PEDIDOS_PATH, "utf8"));
} catch (e) {
  PEDIDOS = [];
}

// ---------- RECIBOS (comprobantes de pago) ----------
const RECIBOS_DIR = path.join(__dirname, "recibos");
if (!fs.existsSync(RECIBOS_DIR)) fs.mkdirSync(RECIBOS_DIR, { recursive: true });

// Servir fotos de productos, comprobantes y la tienda web (public/)
app.use("/img", express.static(path.join(__dirname, "img")));
app.use("/recibos", express.static(RECIBOS_DIR));
app.use(express.static(path.join(__dirname, "public")));

function guardarPedidos() {
  try {
    fs.writeFileSync(PEDIDOS_PATH, JSON.stringify(PEDIDOS, null, 2));
  } catch (e) {
    console.error("Error guardando pedidos:", e.message);
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
Eres "Nyvex", el asistente virtual de ventas de "Nyvex Drop" (@nyvex_drop), tienda de sudaderas, audífonos, accesorios, celulares y perfumes. Respondes por WhatsApp en ESPAÑOL de México, breve (máximo 4 líneas), amable, cercano, con tono juvenil y con emojis.

MANTÉN EL HILO DE LA CONVERSACIÓN:
- Ya tienes el historial del chat. Si el cliente ya te dijo qué quiere, NO vuelvas a saludarlo ni le preguntes qué busca otra vez: continúa con su pedido.
- Solo saluda al inicio de una conversación nueva o si el cliente saluda.

TU OBJETIVO: GENERAR VENTAS. Guía al cliente desde la duda hasta cerrar el pedido y el pago. Estilo INFORMATIVO con cierre suave: recomienda con datos y luego empuja amablemente ("¿te confirmo tu pedido? 😊"). Nunca discutas y siempre cuida al cliente.

FOTOS:
- Cuando el cliente pregunte por un producto, el sistema le envía automáticamente la FOTO del producto. Menciónale algo como "te envío la foto 😉" y luego dale los datos.

OFERTAS (estrategia de precios):
- El precio final SIEMPRE es el que dice el catálogo.
- Cada producto tiene un precio "antes" (publicado más caro) y hoy está con descuento. Puedes mencionar el "antes" para convencer: ej. "antes $229, hoy solo $190 con 15% de descuento 😉".
- No inventes otro "antes" ni otro descuento: usa los que vienen en el catálogo.

RÉPLICAS (audífonos):
- Los audífonos del catálogo actual están marcados con R = RÉPLICA. Son réplicas de excelente calidad con las funciones descritas (cancelación de ruido, GPS, interfaz iOS, etc.).
- Si el cliente pregunta "¿son originales?", sé HONESTO: "Son réplicas de muy buena calidad, no originales. Los originales llegarán pronto (los marcamos con O) pero con un precio más alto 😊". NUNCA digas que son originales.

PAGOS:
- Forma de pago: transferencia o depósito bancario.
- CLABE para depositar: 638180010134011001.
- NO se manejan apartados: el pago es COMPLETO.
- Cuando el cliente quiera pagar, pregúntale su NOMBRE ("¿Me confirmas tu nombre para tu pedido? 😊"), confirma el producto, y dile: "El pago es por transferencia. La CLABE para depositar es 638180010134011001. Envíame tu comprobante por aquí."

COMPROBANTE:
- Cuando el cliente te envíe un comprobante o te diga que ya pagó, respóndele: "¡Gracias! 🙏 Analizaremos los datos de tu compra y te confirmamos en un momento."
- NO le digas que su pedido ya está confirmado: el asesor debe verificar el pago primero.

ENTREGAS:
- El precio YA INCLUYE el envío a la zona de entrega: Ameca, Ozumba, San Juan Atlautla, Tepetlixpa y Tecalco (envío local).
- Si el cliente es de OTRA zona, dile que un asesor le confirma el costo del envío.
- Instagram: @nyvex_drop.

FLUJO DE VENTA:
1. Cliente pregunta por un producto: recomiéndalo con su precio exacto y 1-2 características. Pregunta la talla si aplica (S, M, L, XL o estándar) y su nombre.
2. Cliente quiere comprar: confirma producto y talla, pide su NOMBRE y da la CLABE. Pídele el comprobante.
3. Cliente manda comprobante o dice que ya pagó: dile que analizarán los datos de la compra y que un asesor confirma el pago y coordina la entrega.
4. Si el cliente duda por el precio: recuérdale la oferta (precio "antes" vs hoy) y que el precio ya incluye envío.
5. Si pide un producto que NO está en el catálogo: dile "¡Claro! Lo podemos conseguir, solo tarda un poco más. Un asesor te dice el tiempo y el precio 😊" y derívalo.
6. Si pregunta por su pedido/paquete/estatus: dile "Un asesor te confirma el estatus al momento 😊" (el sistema avisa al equipo).
7. Si pregunta algo que no sabes o no es venta (garantías, pagos en línea): deriva al asesor.

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

function crearPedido(numero, nombre, productos, texto) {
  const pedido = {
    id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    fecha: new Date().toISOString(),
    numero: numero || "",
    nombre: nombre || "Sin nombre",
    productos: (productos || []).map((p) => `${p.nombre} - ${formatoPrecio(p.precio)}`),
    talla: "",
    texto: texto || "",
    recibo: null,
    estado: "pendiente", // pendiente | confirmado | enviando | entregado
  };
  PEDIDOS.push(pedido);
  guardarPedidos();
  return pedido;
}

function extraerNombre(texto) {
  const m = normalizar(texto);
  let n = m.match(/mi nombre es\s+([a-záéíóúñ\s]+)/);
  if (n) return n[1].trim().split(/\s+/).slice(0, 2).join(" ");
  n = m.match(/me llamo\s+([a-záéíóúñ\s]+)/);
  if (n) return n[1].trim().split(/\s+/).slice(0, 2).join(" ");
  n = m.match(/soy\s+([a-záéíóúñ]+)/);
  if (n) return n[1].trim();
  return "";
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
    return;
  }
  try {
    await enviarWhatsApp(OWNER_PHONE, mensaje);
  } catch (e) {
    console.error("Error avisando al dueño:", e.message);
  }
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
              pedido = crearPedido(emisor, nombreCliente, productos, textoUsuario);
              chat.pedidoId = pedido.id;
              await notificarOwner(
                `🛒 *NUEVO PEDIDO / INTERÉS*\n👤 Cliente: ${pedido.nombre}\n📱 Número: ${pedido.numero}\n📦 Producto: ${(pedido.productos || []).join(", ") || "por confirmar"}\n💬 Mensaje: ${pedido.texto}\n🕒 ${new Date().toLocaleString("es-MX")}\n➡️ Cuando te caiga el pago responde: *"confirmar ${pedido.id}"*`
              );
            } else {
              // actualizar el pedido abierto
              if (productos.length > 0 && pedido.productos.length === 0) {
                pedido.productos = productos.map((p) => `${p.nombre} - ${formatoPrecio(p.precio)}`);
              }
              if (!pedido.nombre || pedido.nombre === "Sin nombre") {
                pedido.nombre = nombreCliente || pedido.nombre;
              }
              pedido.texto = textoUsuario;
              guardarPedidos();
            }

            // Nombre del cliente si lo dice en el mensaje
            const nombreDetectado = extraerNombre(textoUsuario);
            if (nombreDetectado && (!pedido.nombre || pedido.nombre === "Sin nombre")) {
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
.b-falso{background:#8a2b2b}.b-no{background:#5f3b00}.b-borroso{background:#4a4a4a}
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
  return '<div class="botones">'+accs.map(function(a){
    return '<button class="'+a[2]+'" onclick="accion(\\''+p.id+'\\',\\''+a[0]+'\\')">'+a[1]+'</button>';
  }).join("")+'</div>';
}

function card(p){
  var est=ESTADOS[p.estado]||["❓ "+p.estado,"b-pendiente"];
  var prods=(p.productos||[]).map(function(x){return "<li>"+x+"</li>";}).join("");
  var recibo=p.recibo?'<a class="recibo" href="/'+p.recibo+'" target="_blank"><img src="/'+p.recibo+'" alt="comprobante"><span>Ver comprobante</span></a>':"";
  var num=p.numero?'<b>📱 '+p.numero+'</b> <a href="https://wa.me/'+p.numero+'" style="color:#7fb2ff">(abrir chat)</a>':"<b>📱 sin número</b>";
  return '<div class="pedido'+(p.nuevo?" nuevo":"")+'">'+
    '<div class="phead"><span class="pid">'+p.id+'</span><span class="badge '+est[1]+'">'+est[0]+'</span></div>'+
    '<div class="info"><b>'+p.nombre+'</b> · '+num+'<br>🗓 '+fmtFecha(p.fecha)+(p.talla?" · 👕 "+p.talla:"")+'</div>'+
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

document.getElementById("recargar").addEventListener("click",function(e){e.preventDefault();cargar();});
cargar();
setInterval(cargar,15000);
</script>
<script>if("Notification" in window && Notification.permission==="default"){Notification.requestPermission();}
if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){});}</script>
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
});`);
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

  res.json({ ok: true, pedido });
});

// Lista de pedidos para la app admin
app.get("/api/admin/pedidos", (req, res) => {
  if (!esAdmin(req)) return res.status(401).json({ ok: false, error: "No autorizado" });
  res.json(PEDIDOS.slice().reverse());
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
<p>El historial se guarda en pedidos.json; al reiniciar Render recarga lo que haya en disco.</p>
<table>
<thead><tr><th>Fecha</th><th>ID</th><th>Cliente</th><th>Número</th><th>Producto</th><th>Mensaje</th><th>Comprobante</th><th>Estado</th></tr></thead>
<tbody>${filas || "<tr><td colspan='8'>Sin pedidos aún</td></tr>"}</tbody>
</table>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`🤖 Nyvex Bot escuchando en el puerto ${PORT}`);
});
