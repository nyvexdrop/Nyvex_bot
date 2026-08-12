# PROMPT PARA EL ASISTENTE DE NYVEX DROP
Copia y pega TODO este texto en una nueva conversación de IA (opencode) cuando necesites mantenimiento del bot.

---

## QUIÉN SOY
Soy el dueño de "Nyvex Drop" (@nyvex_drop), tienda de sudaderas, audífonos, accesorios, celulares y perfumes en México. Tengo un bot de WhatsApp con IA que genera ventas por mí; yo solo confirmo pedidos y hago entregas.

## EL BOT (lee estos archivos primero, en este orden)
- `C:\Users\jisus\Desktop\nyvex-bot\index.js` → TODO el código del bot (Express + webhook de WhatsApp Cloud API + Gemini). Ahí vive:
  - `INSTRUCCIONES` = el "entrenamiento" de ventas (tone, catálogo, flujo, CLABE).
  - `CLAVES_PRODUCTO` = palabras clave para detectar qué producto menciona el cliente y mandarle su foto.
  - `buscarProductos()` = detecta el producto/categoría en el mensaje.
  - `enviarWhatsApp()` y `enviarWhatsAppImagen()` = envían texto y fotos.
- `C:\Users\jisus\Desktop\nyvex-bot\productos.json` = ÚNICA fuente del catálogo. El bot lo carga al arrancar y lo mete al prompt de Gemini automáticamente. Si cambias algo aquí, cambia en el bot; NO editar el catálogo dentro de `INSTRUCCIONES` a mano (se genera solo).
- `C:\Users\jisus\Desktop\nyvex-bot\img\` = fotos de los productos (una por producto, mismas que en mi página web).
- `C:\Users\jisus\Desktop\nyvex-bot\.env` = llaves (GEMINI_API_KEY, WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, BOT_PHONE_NUMBER, GEMINI_MODEL). NO lo subas a GitHub ni lo muestres.
- Mi página web (solo para consultar info): `C:\Users\jisus\Desktop\Nyvex_drop` (index.html, productos.json, img/, js/, css/).

## DÓNDE ESTÁ DESPLEGADO
- GitHub: https://github.com/nyvexdrop/Nyvex_bot (rama `main`).
- Render (servicio en línea): https://nyvex-bot.onrender.com — se redespliega SOLO cada vez que hago push a `main` (~2 min). El webhook de Meta apunta a `https://nyvex-bot.onrender.com/webhook`.
- La credencial de GitHub ya está guardada en mi PC, así que el asistente PUEDE hacer push por mí (no necesita pedirme login).
- Número del negocio (el bot ignora mensajes que vienen de aquí): 525534897969. Mi teléfono de prueba: 525542786413.

## CÓMO SUBIR CAMBIOS (el asistente los hace por mí)
```
cd /c/Users/jisus/Desktop/nyvex-bot
git add -A
git commit -m "mensaje descriptivo"
git push --force origin main
```
Después avisarme que espere ~2 min y que Render se actualiza solo.

## MANTENIMIENTO (cuando yo le mande un print o diga "hay un problema")
1. Leer `index.js`, `productos.json` y la configuración para entender el estado.
2. Si me llega un print/captura: interpretar qué pasó (error en log de Render, mensaje de cliente, etc.).
3. Causas típicas y su arreglo:
   - "No responde": revisar que Render esté despierto, que Meta tenga suscrito el campo `messages`, o los logs.
   - Modelo de Gemini caído: hay respaldo automático en `MODELOS_GEMINI`; si Google lo cambia, actualizar esa lista y `GEMINI_MODEL`.
   - No llega la foto: revisar que la imagen exista en `img/` y que el nombre en `productos.json` coincida.
   - Detecta mal el producto: ajustar `CLAVES_PRODUCTO` (las más específicas van PRIMERO).
4. Después de tocar código: `git push --force origin main` y avisarme para probar.

## AGREGAR / CAMBIAR UN PRODUCTO (así me lo pide el usuario: nombre, descripción, precio y/o foto)
1. Guardar la imagen nueva en `C:\Users\jisus\Desktop\nyvex-bot\img\` con nombre en minúsculas y sin espacios (ej. `sudaderaflow.png`). Si me mandó foto, guardarla ahí.
2. Agregar/editar la entrada en `productos.json` con estos campos:
   - `nombre`: nombre del producto.
   - `precio`: número entero (ej. 250).
   - `categoria`: una de `sudaderas`, `audifonos`, `accesorios`, `celulares`, `perfumes`.
   - `emoji`: emoji de la categoría (🧥 🎧 🔌 📱 🧴).
   - `imagen`: `img/<nombre de archivo>.png` (DEBE existir en la carpeta img).
   - `descripcion`: texto de venta con características, color y tallas si aplica.
   - `tallas`: `"S, M, L, XL"` o `""` si no aplica.
   - `envio`: `"local"`.
3. Si el producto necesita foto automática cuando el cliente lo menciona, agregar su clave en `CLAVES_PRODUCTO` (en index.js), en orden de más específico a más genérico.
4. Verificar que la imagen referenciada EXISTE (prueba: abrir `C:\Users\jisus\Desktop\nyvex-bot\img\<archivo>`).
5. Commit + push (ver comando de arriba) y avisarme que pruebe.
6. IMPORTANTE: el catálogo de la página web `C:\Users\jisus\Desktop\Nyvex_drop\productos.json` es el mismo formato; si cambio algo en el bot, informarme si también hay que copiarlo ahí.

## ENTRENAR MEJOR AL BOT (pedirle mejoras de ventas)
- Editar `INSTRUCCIONES` en index.js: tono, flujo de venta, objeciones, respuestas a precios/envíos, urgencia, etc.
- No cambiar precios ni productos ahí directamente (se generan desde productos.json).
- Después: commit + push.

## DATOS CLAVE DEL NEGOCIO
- CLABE para depósitos: 638180010134011001.
- Zonas de entrega: Ameca, Ozumba, San Juan Atlautla, Tepetlixpa y Tecalco.
- Instagram: @nyvex_drop.
- Forma de pago: transferencia/depósito; el cliente manda comprobante para confirmar.

## REGLAS PARA EL ASISTENTE
- No mostrar ni subir `.env` ni claves.
- Mantener respuestas en español.
- No borrar archivos de `img/` sin confirmarme.
- Después de cada cambio, siempre commit + push y decirme que espere ~2 min.
