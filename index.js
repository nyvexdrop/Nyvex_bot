// =========================================================
// NYVEX DROP - Bot de WhatsApp con IA (Gemini gratis)
// Usa: WhatsApp Cloud API (Meta, gratis) + Gemini API (gratis)
// Catálogo y fotos desde productos.json e img/ (misma info que la página web)
// =========================================================
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nyvex-verify-2026";
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
// Modelos de respaldo: si el principal falla (cambio de modelos de Google), usa otro
const MODELOS_GEMINI = [
  GEMINI_MODEL,
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
];
const PORT = process.env.PORT || 3000;

// ---------- CATÁLOGO (una sola fuente: productos.json) ----------
const PRODUCTOS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "productos.json"), "utf8")
);

// Servir las fotos de los productos (https://<url>/img/xxx.png)
app.use("/img", express.static(path.join(__dirname, "img")));

const CATALOGO_DESCRIPCIONES = PRODUCTOS.map((p, i) => {
  const tallas = p.tallas ? ` Tallas: ${p.tallas}.` : "";
  return `${i + 1}. ${p.nombre} - $${p.precio}. ${p.descripcion}${tallas}`;
}).join("\n");

const RESUMEN_CATEGORIAS = PRODUCTOS.reduce((acc, p) => {
  (acc[p.categoria] = acc[p.categoria] || []).push(p);
  return acc;
}, {});

const CATALOGO_TEXTO = Object.entries(RESUMEN_CATEGORIAS)
  .map(([cat, prods]) => {
    const emoji = prods[0].emoji || "🛍️";
    return `${emoji} ${cat}: ${prods.map((p) => `${p.nombre} $${p.precio}`).join(", ")}`;
  })
  .join("\n");

// ---------- CONOCIMIENTO DE NYVEX DROP (entrenamiento de ventas) ----------
const INSTRUCCIONES = `
Eres "Nyvex", el asistente virtual de ventas de "Nyvex Drop" (@nyvex_drop), tienda de sudaderas, audífonos, accesorios, celulares y perfumes. Respondes por WhatsApp en ESPAÑOL de México, breve (máximo 4 líneas), amable, cercano, con tono juvenil y con emojis.

TU OBJETIVO: GENERAR VENTAS. Guía al cliente desde la duda hasta cerrar el pedido y el pago. Nunca discutas y siempre cuida al cliente.

FOTOS:
- Cuando el cliente pregunte por un producto, el sistema le envía automáticamente la FOTO del producto. Menciónale algo como "te envío la foto 😉" y luego dale los datos.

PAGOS:
- Forma de pago: transferencia o depósito bancario.
- CLABE para depositar: 638180010134011001.
- Cuando el cliente quiera pagar, dale la CLABE y pídele su comprobante para confirmar el pedido.

ENTREGAS:
- Zona de entrega: Ameca, Ozumba, San Juan Atlautla, Tepetlixpa y Tecalco (envío local).
- Si pregunta por otra zona o quiere apartar un producto, dile que un asesor del equipo le confirma la entrega.
- Instagram: @nyvex_drop.

FLUJO DE VENTA:
1. Cliente pregunta por un producto: recomiéndalo con su precio exacto y 1-2 características principales. Pregunta la talla si aplica (S, M, L, XL o estándar).
2. Cliente quiere comprar: confirma producto y talla, y dile: "El pago es por transferencia. La CLABE para depositar es 638180010134011001. Envíame tu comprobante y confirmo tu pedido 😊".
3. Cliente manda comprobante: dile que su pedido queda confirmado y que un asesor coordina la entrega.
4. Si pregunta algo que no está en el catálogo (estado de pedido, garantías, pagos en línea): deriva al asesor.

CATÁLOGO COMPLETO (precio de venta final, NO inventar precios ni productos):
${CATALOGO_DESCRIPCIONES}

RESUMEN RÁPIDO POR CATEGORÍAS:
${CATALOGO_TEXTO}

REGLAS:
- NUNCA inventes productos, precios, tallas ni características.
- Precios SIEMPRE con $ y con la cifra exacta del catálogo (ej. $190, no $190.00).
- Respuestas cortas: máximo 4 líneas. Usa viñetas si hace falta.
- Si el cliente manda saludos, salúdalo y pregúntale qué le interesa.
- Si preguntan "¿qué venden?", muestra el resumen por categorías.
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
  { nombre: "Auriculares Inalámbricos Pro", palabras: ["inalambricos pro", "inalambrico pro", "auriculares pro", "auricular pro", "audifonos pro", "audifono pro", "earbuds", "auriculares", "audifonos"] },
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
    const def = PRODUCTOS.find((p) => p.nombre.includes("2 Pro"));
    if (def) resultados.push(def);
  }
  if (/\b(magsafe|bateria|baterias)\b/.test(m)) {
    resultados.push(...PRODUCTOS.filter((p) => p.categoria === "accesorios" && p.nombre.includes("MagSafe")));
  }
  if (/\b(celular|celulares|telefono|iphone)\b/.test(m) && !/\biphone\b/.test(m)) {
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

    console.log("📥 Webhook recibido de Meta:", JSON.stringify(body).slice(0, 500));

    const baseUrl = process.env.SITE_URL || `https://${req.get("host")}`;

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;

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
          } else {
            textoUsuario = "[el cliente envió una imagen o archivo]";
          }

          // Foto del producto si el mensaje lo menciona
          const productos = buscarProductos(textoUsuario);
          for (const prod of productos) {
            const urlImagen = `${baseUrl}/img/${encodeURIComponent(prod.imagen.replace(/^img\//, ""))}`;
            const caption = `${prod.nombre} - $${prod.precio}`;
            await enviarWhatsAppImagen(emisor, urlImagen, caption);
          }

          const respuesta = await generarRespuesta(textoUsuario);
          await enviarWhatsApp(emisor, respuesta);
        }
      }
    }
  } catch (error) {
    console.error("Error en webhook:", error.message);
  }
});

// ---------- INTELIGENCIA (Gemini gratis) ----------
async function generarRespuesta(mensaje) {
  for (const modelo of MODELOS_GEMINI) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_KEY}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: INSTRUCCIONES }] },
          contents: [
            { role: "user", parts: [{ text: mensaje }] }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 400
          }
        })
      });

      const data = await res.json();
      const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (texto) return texto.trim();

      if (data?.error) {
        console.error(`Error Gemini (${modelo}):`, data.error.message);
      }
    } catch (error) {
      console.error(`Error en Gemini (${modelo}):`, error.message);
    }
  }
  return "Disculpa, por el momento no puedo responder. El equipo de Nyvex te atiende al instante 👋";
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

app.listen(PORT, () => {
  console.log(`🤖 Nyvex Bot escuchando en el puerto ${PORT}`);
});
