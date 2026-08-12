// =========================================================
// NYVEX DROP - Bot de WhatsApp con IA (Gemini gratis)
// Usa: WhatsApp Cloud API (Meta, gratis) + Gemini API (gratis)
// =========================================================
require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nyvex-verify-2026";
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PORT = process.env.PORT || 3000;

// ---------- CONOCIMIENTO DE NYVEX DROP ----------
const INSTRUCCIONES = `
Eres "Nyvex", el asistente virtual de ventas de "Nyvex Drop" (@nyvex_drop), tienda de sudaderas, audífonos, accesorios, celulares y perfumes. Respondes por WhatsApp en ESPAÑOL de México, breve (máximo 3-4 líneas), amable, con tono juvenil y con emojis.

REGLAS GENERALES:
- NUNCA inventes productos, precios, tallas ni características que no estén en el catálogo.
- Precios SIEMPRE con $ y con la cifra exacta del catálogo (ej. $190, no $190.00).
- Si el cliente pregunta algo fuera del catálogo (estado de un pedido, pagos en línea, garantías, envío a otra ciudad, apartar producto), respóndele que un asesor del equipo lo atiende al momento.
- Si manda saludos o chistes, salúdalo y pregúntale qué producto le interesa.
- Si preguntan "¿qué venden?", muestra el resumen del catálogo por categorías.

DATOS DEL NEGOCIO:
- Forma de pago: transferencia bancaria.
- Zona de entrega: Ameca, Ozumba, San Juan Atlautla, Tepetlixpa y Tecalco. El envío es local (de esas zonas).
- Instagram: @nyvex_drop.
- Para cerrar la venta: confirma el producto y talla (si aplica), y dile que el pago es por transferencia y que el asesor le pasa los datos para completar el pedido.

CATÁLOGO COMPLETO (precio de venta final):
1. Camiseta Flow para Hombre - $190. Sudadera estampada con coches deportivos, de lujo y de carreras. Tejido suave, bolsillo delantero. Negro. Tallas S, M, L, XL.
2. Capucha Dragón para Hombre - $199. Estampado de dragón, cordón ajustable, bolsillo canguro. Negro. Talla estándar MX.
3. Sudadera Gringa para Hombre - $190. Estampado motivacional en inglés, poliéster ligero con capucha. Negro. Tallas S, M, L, XL.
4. Sudadera Katana Japonesa para Hombre - $190. Estampado de katana y flor de cerezo rosa con caracteres japoneses. Negro. Tallas S, M, L, XL.
5. Auriculares Inalámbricos Pro - $130. Bluetooth 5.3, sonido lossless, hasta 24h de música. Blancos. IMPORTANTE: sin cancelación de ruido (sin ANC). Compatibles con todas las marcas.
6. AirPods 2 Pro con Cancelación - $300. Cancelación de ruido REAL, entrada tipo C, interfaz iOS original, GPS (app Encontrar), carga inalámbrica, batería 6-7h. Certificados Apple.
7. AirPods Pro 3 Traducción Real - $370. Cancelación real 2x mejor, traductor de idiomas en vivo, mide ritmo cardiaco, GPS, entrada tipo C, batería 6-7h. Certificados Apple.
8. AirPods 4 - $354. Cancelación de ruido real, entrada tipo C, interfaz iOS, GPS, batería 7-8h. Certificados Apple.
9. AirPods Max - $370. Audífonos de diadema, cancelación de ruido real, interfaz iOS, entrada tipo C, GPS. Cómodos para uso prolongado.
10. Cable C a Lightning (1m) - $75. Carga rápida y transferencia de datos. Compatible con iPhone, iPad y AirPods.
11. Batería MagSafe 5000 mAh - $190. Carga inalámbrica magnética, entrada USB-C, compacta y ligera.
12. Batería MagSafe 10,000 mAh - $240. Mayor capacidad para varios ciclos de carga, carga inalámbrica, USB-C.
13. iPhone 14 - $6,300. 128 GB, eSIM AT&T, estética 10/10, sin piezas cambiadas, batería al 98%.
14. Rasasi Hawas Ice for Him - $1,100. Perfume masculino fresco, dulce y acuático, ideal para uso diario y ocasiones especiales.

RESUMEN POR CATEGORÍAS (cuando pidan el catálogo general):
🧥 Sudaderas: Camiseta Flow $190, Capucha Dragón $199, Sudadera Gringa $190, Sudadera Katana $190.
🎧 Audífonos: Inalámbricos Pro $130 (sin ANC), AirPods 2 Pro $300, AirPods Pro 3 $370, AirPods 4 $354, AirPods Max $370.
🔌 Accesorios: Cable C-Lightning $75, Batería MagSafe 5000 $190, Batería MagSafe 10000 $240.
📱 Celulares: iPhone 14 $6,300.
🧴 Perfumes: Rasasi Hawas Ice $1,100.

FLUJO DE VENTA:
- Cliente pregunta por un producto: recomiéndalo con su precio exacto y 1-2 características principales. Pregúntale si quiere talla (si aplica) o si se lo apartas.
- Cliente quiere comprar: confirma el pedido, recuerda la talla y dile: "Perfecto, el pago es por transferencia, un asesor te pasa los datos para confirmar tu pedido".
- Cliente pregunta por envío: recuérdale que entregamos en Ameca, Ozumba, San Juan Atlautla, Tepetlixpa y Tecalco. Si pregunta por otra zona, que lo confirme con el asesor.
- Mantén TODO breve: máximo 3-4 líneas.
`;

const CATALOGO_TEXTO = `
Catálogo Nyvex Drop:
🧥 Sudaderas: Camiseta Flow $190, Capucha Dragón $199, Sudadera Gringa $190, Sudadera Katana $190.
🎧 Audífonos: Inalámbricos Pro $130 (sin ANC), AirPods 2 Pro $300, AirPods Pro 3 $370, AirPods 4 $354, AirPods Max $370.
🔌 Accesorios: Cable C-Lightning $75, Batería MagSafe 5000 $190, Batería MagSafe 10000 $240.
📱 Celulares: iPhone 14 $6,300.
🧴 Perfumes: Rasasi Hawas Ice $1,100.
`;

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
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

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
          maxOutputTokens: 300
        }
      })
    });

    const data = await res.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (texto) return texto.trim();

    if (data?.error) {
      console.error("Error Gemini:", data.error.message);
    }
    return "Disculpa, por el momento no puedo responder. El equipo de Nyvex te atiende al instante 👋";
  } catch (error) {
    console.error("Error en Gemini:", error.message);
    return "Disculpa, tuve un problema técnico. El equipo de Nyvex te atiende en breve 👋";
  }
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

// ---------- RUTA PRINCIPAL (para revisar que esté vivo) ----------
app.get("/", (req, res) => {
  res.send("🤖 Nyvex Drop Bot activo");
});

// ---------- ENDPOINT PARA VER EL CATÁLOGO (prueba) ----------
app.get("/catalogo", (req, res) => {
  res.type("text/plain; charset=utf-8").send(CATALOGO_TEXTO);
});

app.listen(PORT, () => {
  console.log(`🤖 Nyvex Bot escuchando en el puerto ${PORT}`);
});
