// ==========================================
// NYVEX DROP - Tienda web conectada al bot
// El catálogo sale de productos.json (la misma
// fuente que usa el bot de WhatsApp).
// ==========================================

// Número del negocio (el mismo que responde el bot)
const WHATSAPP_NUMERO = "525534897969";

// CLABE para transferencia / depósito (se comparte al confirmar el pedido)
const CLABE = "638180010134011001";

// Tenis: aún no disponibles, se muestran como "Próximamente"
const TENIS_PROXIMAMENTE = [
  { nombre: "Tenis Urbanos", emoji: "👟" },
  { nombre: "Tenis Deportivos", emoji: "👟" },
  { nombre: "Tenis Retro", emoji: "👟" },
];

const SECCIONES = [
  { cat: "sudaderas", titulo: "Sudaderas", emoji: "🧥" },
  { cat: "audifonos", titulo: "Audífonos", emoji: "🎧" },
  { cat: "accesorios", titulo: "Accesorios", emoji: "🔌" },
  { cat: "celulares", titulo: "Celulares", emoji: "📱" },
  { cat: "perfumes", titulo: "Perfumes", emoji: "🧴" },
  { cat: "tenis", titulo: "Tenis", emoji: "👟" },
];

const ESTADOS = {
  pendiente: { emoji: "⏳", label: "Analizando pago", clase: "pendiente" },
  confirmado: { emoji: "✅", label: "Confirmado (preparando envío)", clase: "confirmado" },
  enviando: { emoji: "📦", label: "En camino", clase: "enviando" },
  entregado: { emoji: "🎉", label: "Entregado", clase: "entregado" },
};

function precio(n) {
  return "$" + Number(n).toLocaleString("es-MX");
}

// ---------- Elementos ----------
const menuToggle = document.getElementById("menuToggle");
const navLinks = document.getElementById("navLinks");
const grid = document.getElementById("productosGrid");
const categoriasGrid = document.getElementById("categoriasGrid");
const productosSubtitulo = document.getElementById("productosSubtitulo");

let productos = [];
let categoriaActiva = "todas";

// ---------- Menú móvil ----------
menuToggle.addEventListener("click", () => {
  navLinks.classList.toggle("abierto");
});
navLinks.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.classList.remove("abierto");
  });
});

// ---------- Modales ----------
function abrirModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add("abierto");
  document.body.style.overflow = "hidden";
}
function cerrarModales() {
  document.querySelectorAll(".modal-overlay").forEach((m) => m.classList.remove("abierto"));
  document.body.style.overflow = "";
}
document.querySelectorAll("[data-cerrar]").forEach((btn) => {
  btn.addEventListener("click", () => cerrarModales());
});
document.querySelectorAll(".modal-overlay").forEach((m) => {
  m.addEventListener("click", (e) => {
    if (e.target === m) cerrarModales();
  });
});

// ---------- Categorías ----------
function renderCategorias() {
  const cats = {};
  productos.forEach((p) => {
    (cats[p.categoria] = cats[p.categoria] || []).push(p);
  });

  categoriasGrid.innerHTML = [
    `<div class="categoria${categoriaActiva === "todas" ? " activa" : ""}" data-cat="todas">🛍️ Todo</div>`,
    ...Object.entries(cats).map(([cat, prods]) => {
      const emoji = prods[0].emoji || "🛍️";
      const etiqueta = cat.charAt(0).toUpperCase() + cat.slice(1);
      return `<div class="categoria${categoriaActiva === cat ? " activa" : ""}" data-cat="${cat}">${emoji} ${etiqueta}</div>`;
    }),
    `<div class="categoria${categoriaActiva === "tenis" ? " activa" : ""}" data-cat="tenis">👟 Tenis</div>`,
  ].join("");

  categoriasGrid.querySelectorAll("[data-cat]").forEach((el) => {
    el.addEventListener("click", () => {
      categoriaActiva = el.dataset.cat;
      renderCategorias();
      renderProductos();
      document.getElementById("productos").scrollIntoView({ behavior: "smooth" });
    });
  });
}

// ---------- Productos (secciones con divisores) ----------
function renderProducto(p) {
  if (p.proximamente) {
    return `
      <article class="producto producto-proximamente">
        <div class="producto-img">
          <span class="producto-img-emoji">${p.emoji || "👟"}</span>
        </div>
        <div class="producto-info">
          <p class="producto-nombre">${p.nombre}</p>
          <span class="producto-badge-prox">⏳ PRÓXIMAMENTE</span>
        </div>
      </article>`;
  }

  const idx = productos.findIndex((x) => x.nombre === p.nombre);
  const imgHtml = p.imagen
    ? `<img src="${p.imagen}" alt="${p.nombre}" class="producto-img-real">`
    : `<span class="producto-img-emoji">${p.emoji || "🛍️"}</span>`;
  const badge = p.tipo === "replica" ? `<span class="producto-badge">RÉPLICA</span>` : "";
  const descHtml = p.descripcion
    ? `<p class="producto-descripcion">${p.descripcion}</p>`
    : "";

  return `
    <article class="producto">
      <div class="producto-img">${badge}${imgHtml}</div>
      <div class="producto-info">
        <p class="producto-nombre">${p.nombre}</p>
        ${descHtml}
        <p class="producto-precio">${precio(p.precio)}</p>
        <button class="producto-boton" data-index="${idx}">
          💬 Comprar
        </button>
      </div>
    </article>`;
}

function renderSeccion(seccion, lista, i) {
  const divisor = i === 0 ? "" : `<div class="seccion-divisor"></div>`;
  return `
    ${divisor}
    <div class="seccion-prod">
      <h3 class="seccion-prod-titulo">${seccion.emoji} ${seccion.titulo}</h3>
      <div class="productos-grid">
        ${lista.map((p) => renderProducto(p)).join("")}
      </div>
    </div>`;
}

function renderProductos() {
  if (categoriaActiva === "todas") {
    productosSubtitulo.textContent = `${productos.length} productos en catálogo + Tenis próximamente`;
    let html = "";
    let i = 0;
    SECCIONES.forEach((seccion) => {
      const lista =
        seccion.cat === "tenis"
          ? TENIS_PROXIMAMENTE.map((t) => ({ ...t, proximamente: true }))
          : productos.filter((p) => p.categoria === seccion.cat);
      if (!lista.length) return;
      html += renderSeccion(seccion, lista, i);
      i++;
    });
    grid.innerHTML = html;
    return;
  }

  const seccion = SECCIONES.find((s) => s.cat === categoriaActiva);
  if (!seccion) return;

  productosSubtitulo.textContent =
    categoriaActiva === "tenis"
      ? "Tenis: llegamos pronto 😉"
      : `Categoría: ${seccion.titulo}`;

  const lista =
    categoriaActiva === "tenis"
      ? TENIS_PROXIMAMENTE.map((t) => ({ ...t, proximamente: true }))
      : productos.filter((p) => p.categoria === categoriaActiva);

  grid.innerHTML = renderSeccion(seccion, lista, 0);
}

// ---------- Cargar catálogo (una sola fuente: productos.json) ----------
async function cargarProductos() {
  try {
    const res = await fetch("productos.json");
    if (!res.ok) throw new Error("No se pudo cargar");
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      productos = data;
    }
  } catch (error) {
    grid.innerHTML = `<div class="pedido-vacio">No se pudo cargar el catálogo. Escríbenos por <a href="https://wa.me/${WHATSAPP_NUMERO}" target="_blank">WhatsApp</a> 😊</div>`;
    return;
  }
  renderCategorias();
  renderProductos();
}

// ---------- Modal de compra ----------
function abrirCheckout(producto) {
  const tallas = (producto.tallas || "").split(",").map((t) => t.trim()).filter(Boolean);
  const tallaHtml = tallas.length
    ? `<div class="campo">
         <label>Talla</label>
         <select id="checkoutTalla">
           ${tallas.map((t) => `<option value="${t}">${t}</option>`).join("")}
         </select>
       </div>`
    : "";

  document.getElementById("checkoutContenido").innerHTML = `
    <h3>${producto.nombre}</h3>
    <p class="modal-precio">${precio(producto.precio)}</p>
    <div class="campo">
      <label>Tu nombre</label>
      <input type="text" id="checkoutNombre" placeholder="Ej. Angel">
    </div>
    <div class="campo">
      <label>Tu WhatsApp (para avisarte)</label>
      <input type="tel" id="checkoutNumero" placeholder="Ej. 5522334455">
    </div>
    ${tallaHtml}
    <div class="aviso-clabe">
      💳 El pago es por <strong>transferencia o depósito</strong>. Al confirmar tu pedido te damos tu folio y los datos de pago; solo envías tu comprobante por WhatsApp.
    </div>
    <div class="modal-botones">
      <button class="btn" id="checkoutConfirmar">Confirmar pedido</button>
      <a href="https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent("Hola Nyvex Drop 👋 Me interesa: " + producto.nombre + " por " + precio(producto.precio))}" target="_blank" class="btn btn-ghost">Solo preguntar por WhatsApp</a>
    </div>
  `;

  abrirModal("modalCheckout");

  document.getElementById("checkoutConfirmar").addEventListener("click", async () => {
    const nombre = document.getElementById("checkoutNombre").value.trim();
    const numero = document.getElementById("checkoutNumero").value.trim();
    const tallaEl = document.getElementById("checkoutTalla");
    const talla = tallaEl ? tallaEl.value : "";
    const contenido = document.getElementById("checkoutContenido");

    if (!nombre || numero.replace(/[^0-9]/g, "").length < 10) {
      contenido.insertAdjacentHTML(
        "afterbegin",
        `<div class="mensaje-error">Escribe tu nombre y un WhatsApp válido (10 dígitos).</div>`
      );
      return;
    }

    contenido.innerHTML = `<p style="text-align:center;color:var(--gris)">Registrando tu pedido…</p>`;

    let id = "";
    try {
      const res = await fetch("api/pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre,
          numero,
          producto: producto.nombre,
          talla,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) id = data.id;
    } catch (e) {
      id = "";
    }

    if (id) {
      // Pedido registrado en el sistema → el dueño ya fue avisado
      const textoWhatsApp = `Hola Nyvex Drop 👋 Ya confirmé mi pedido *${id}* de *${producto.nombre}*${talla ? " (talla " + talla + ")" : ""} por ${precio(producto.precio)}. Te envío mi comprobante de pago:`;
      contenido.innerHTML = `
        <h3>✅ Pedido registrado</h3>
        <p style="color:var(--gris);font-size:0.9rem">Guarda tu folio para darle seguimiento:</p>
        <div class="exito-id">${id}</div>
        <div class="aviso-clabe">
          💳 Haz tu pago por transferencia o depósito a la CLABE<br>
          <strong>${CLABE}</strong><br>
          (total: ${precio(producto.precio)}${talla ? " · talla " + talla : ""})
        </div>
        <div class="modal-botones">
          <a href="https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(textoWhatsApp)}" target="_blank" class="btn">📎 Enviar comprobante por WhatsApp</a>
          <a href="#rastrear" class="btn btn-ghost" id="irRastrear">📦 Ver estatus de mi pedido</a>
        </div>
      `;
      document.getElementById("irRastrear").addEventListener("click", () => {
        cerrarModales();
        document.getElementById("rastrearInput").value = numero;
        document.getElementById("rastrearForm").dispatchEvent(new Event("submit"));
        document.getElementById("rastrear").scrollIntoView({ behavior: "smooth" });
      });
    } else {
      // Fallback: si no hay conexión con la API, se va directo a WhatsApp
      const textoWhatsApp = `Hola Nyvex Drop 👋 Quiero pedir *${producto.nombre}*${talla ? " (talla " + talla + ")" : ""} por ${precio(producto.precio)}. Mi nombre es ${nombre} y mi WhatsApp es ${numero}. ¿Cómo hago el pago?`;
      window.open(`https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(textoWhatsApp)}`, "_blank");
      contenido.innerHTML = `
        <h3>💬 Pedido por WhatsApp</h3>
        <p style="color:var(--gris)">Se abrió WhatsApp con tu pedido listo. Manda el mensaje y un asesor te confirma.</p>
        <div class="modal-botones">
          <a href="https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(textoWhatsApp)}" target="_blank" class="btn">💬 Abrir WhatsApp</a>
        </div>
      `;
    }
  });
}

grid.addEventListener("click", (e) => {
  const boton = e.target.closest(".producto-boton");
  if (!boton) return;
  const prod = productos[Number(boton.dataset.index)];
  if (prod) abrirCheckout(prod);
});

// ---------- Rastrear pedido ----------
const rastrearForm = document.getElementById("rastrearForm");
const rastrearInput = document.getElementById("rastrearInput");
const rastrearResultado = document.getElementById("rastrearResultado");

function estadoInfo(e) {
  return ESTADOS[e] || { emoji: "❓", label: e || "Desconocido", clase: "pendiente" };
}

function formatFecha(iso) {
  const d = new Date(iso);
  return d.toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

rastrearForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const valor = rastrearInput.value.trim();
  if (!valor) return;

  rastrearResultado.innerHTML = `<p class="pedido-vacio">Buscando…</p>`;

  const esId = /^[a-z0-9]{6}$/i.test(valor);
  const query = esId ? `id=${encodeURIComponent(valor)}` : `numero=${encodeURIComponent(valor)}`;

  try {
    const res = await fetch(`api/pedidos?${query}`);
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      rastrearResultado.innerHTML = `<div class="pedido-vacio">No encontramos pedidos con ese dato. Si acabas de comprar, verifica tu folio o escríbenos por <a href="https://wa.me/${WHATSAPP_NUMERO}" target="_blank">WhatsApp</a> 😊</div>`;
      return;
    }

    rastrearResultado.innerHTML = data
      .map((p) => {
        const est = estadoInfo(p.estado);
        const productos = (p.productos || []).map((x) => `<li>${x}</li>`).join("");
        return `
          <div class="pedido-card estado-${est.clase}">
            <h3><span>${est.emoji} Pedido <strong>${p.id}</strong></span><span class="pedido-estado">${est.label}</span></h3>
            <p class="pedido-fecha">${formatFecha(p.fecha)}${p.talla ? " · Talla: " + p.talla : ""}</p>
            <ul>${productos}</ul>
          </div>`;
      })
      .join("");
  } catch (error) {
    rastrearResultado.innerHTML = `<div class="pedido-vacio">No pudimos consultar tu pedido. Escríbenos por <a href="https://wa.me/${WHATSAPP_NUMERO}" target="_blank">WhatsApp</a> 😊</div>`;
  }
});

// ---------- Iniciar ----------
cargarProductos();
