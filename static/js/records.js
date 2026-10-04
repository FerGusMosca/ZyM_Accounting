/* records.js — Registros guardados de Cobranzas
 *
 * Muestra lo que ya esta en la base: facturas, cobros, cruces y clientes.
 * De cada factura y cada cobro se puede abrir el archivo original.
 *
 * Tanda 7 (pedidos del 04/10/2026):
 *   - Todo paginado: cada pagina se lee de la base en el momento. No se
 *     guarda ninguna lista en el navegador ni se la reutiliza.
 *   - Borrar pide confirmacion en un cuadro propio.
 *   - Si la factura o el cobro tiene cruces, se avisa antes cuantos son y al
 *     borrar se eliminan tambien los cruces.
 */

const TABS = { 1: 'facturas', 2: 'cobros', 3: 'cruces', 4: 'clientes' };

let tabActual = 1;
const paginaDe = { 1: 1, 2: 1, 3: 1, 4: 1 };   // pagina que se esta viendo en cada solapa
let tamano = 25;                              // registros por pagina
let totalesTabs = { facturas: 0, cobros: 0, cruces: 0, clientes: 0 };

// Solo lo de la pagina que se esta viendo, recien leido de la base.
let facturas = [];
let pagos    = [];
let cruces   = [];
let clientes = [];

let temporizadorBusqueda = null;

document.addEventListener('DOMContentLoaded', () => cargar());

// Todos los pedidos van con la orden de no usar nada guardado.
function pedir(url, opciones = {}) {
  return fetch(url, { ...opciones, cache: 'no-store' });
}

/* ── Datos ─────────────────────────────────────────────────────── */

function textoBusqueda() {
  return (document.getElementById('rgSearch').value || '').trim();
}

// Spinner sobre la tabla mientras se lee de la base (cambio de pagina, de
// solapa, busqueda, Actualizar, despues de borrar o guardar): asi se ve que
// la pantalla esta trabajando y no colgada. Mientras tanto el paginador
// queda deshabilitado para no pedir dos veces.
let lecturas = 0;
function mostrarCargando(si) {
  lecturas += si ? 1 : -1;
  const activo = lecturas > 0;
  document.querySelectorAll('.rc-panel').forEach(panel => {
    let capa = panel.querySelector('.rg-loading');
    if (!capa) {
      capa = document.createElement('div');
      capa.className = 'rg-loading';
      capa.innerHTML = '<div class="rg-loading-box"><span class="rg-loading-spin"></span><span>Cargando…</span></div>';
      panel.appendChild(capa);
    }
    capa.hidden = !activo;
  });
  // Se apagan solo los que estaban prendidos, y se vuelven a prender esos
  // mismos al terminar (si la lectura fallo, el paginador sigue usable).
  document.querySelectorAll('.rg-pager button, .rg-pager select').forEach(el => {
    if (activo && !el.disabled) { el.disabled = true; el.dataset.bloq = '1'; }
    if (!activo && el.dataset.bloq) { el.disabled = false; delete el.dataset.bloq; }
  });
}

// Lee de la base la pagina de la solapa que se esta viendo.
async function cargar() {
  const hint = document.getElementById('rgHint');
  hint.textContent = 'Cargando…';
  mostrarCargando(true);
  try {
    const url = `/reconciliation/registros/page?tab=${TABS[tabActual]}` +
                `&page=${paginaDe[tabActual]}&size=${tamano}` +
                `&q=${encodeURIComponent(textoBusqueda())}`;
    const res  = await pedir(url);
    const data = await res.json();

    if (data.status === 'no_db') {
      hint.textContent = 'No hay base configurada, así que todavía no hay registros guardados.';
      return;
    }
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');

    paginaDe[tabActual] = data.page;     // el servidor corrige si la pagina ya no existe
    totalesTabs = data.totales;
    if (tabActual === 1) facturas = data.items;
    if (tabActual === 2) pagos    = data.items;
    if (tabActual === 3) cruces   = data.items;
    if (tabActual === 4) clientes = data.items;

    renderTab(data);
  } catch (e) {
    hint.textContent = `No se pudieron traer los registros: ${e.message}`;
  } finally {
    mostrarCargando(false);
  }
}

// Buscar: vuelve a la primera pagina de todas las solapas y lee de nuevo.
function buscar() {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(() => {
    [1, 2, 3, 4].forEach(i => { paginaDe[i] = 1; });
    cargar();
  }, 300);
}

function irAPagina(n) {
  paginaDe[tabActual] = Math.max(1, n);
  cargar();
}

function cambiarTamano(valor) {
  tamano = Number(valor) || 25;
  [1, 2, 3, 4].forEach(i => { paginaDe[i] = 1; });
  cargar();
}

/* ── Pantalla ──────────────────────────────────────────────────── */

function showTab(n) {
  tabActual = n;
  [1, 2, 3, 4].forEach(i => {
    document.getElementById(`tab${i}`).classList.toggle('active', i === n);
    document.getElementById(`panel${i}`).hidden = i !== n;
  });
  cargar();     // cada vez que se entra a una solapa se lee de la base
}

function renderTab(data) {
  const t = totalesTabs;
  document.getElementById('cntInv').textContent = t.facturas;
  document.getElementById('cntPay').textContent = t.cobros;
  document.getElementById('cntMat').textContent = t.cruces;
  document.getElementById('cntCli').textContent = t.clientes;

  document.getElementById('rgHint').textContent =
    `${t.facturas} factura(s), ${t.cobros} cobro(s), ${t.cruces} cruce(s) y ` +
    `${t.clientes} cliente(s)` + (textoBusqueda() ? ' que coinciden con la búsqueda.' : ' guardados.');

  if (tabActual === 1) renderFacturas();
  if (tabActual === 2) renderPagos();
  if (tabActual === 3) renderCruces();
  if (tabActual === 4) renderClientes();
  renderPager(data);
}

function renderPager(data) {
  const caja = document.getElementById(`pager${tabActual}`);
  if (!caja) return;
  const desde = data.total ? (data.page - 1) * data.size + 1 : 0;
  const hasta = Math.min(data.page * data.size, data.total);
  caja.innerHTML = `
    <span class="rg-pager-info">${desde}–${hasta} de ${data.total}</span>
    <button class="btn btn-ghost" ${data.page <= 1 ? 'disabled' : ''} onclick="irAPagina(1)" title="Primera">«</button>
    <button class="btn btn-ghost" ${data.page <= 1 ? 'disabled' : ''} onclick="irAPagina(${data.page - 1})" title="Anterior">‹</button>
    <span class="rg-pager-pag">Página ${data.page} de ${data.pages}</span>
    <button class="btn btn-ghost" ${data.page >= data.pages ? 'disabled' : ''} onclick="irAPagina(${data.page + 1})" title="Siguiente">›</button>
    <button class="btn btn-ghost" ${data.page >= data.pages ? 'disabled' : ''} onclick="irAPagina(${data.pages})" title="Última">»</button>
    <label class="rg-pager-size">Por página
      <select onchange="cambiarTamano(this.value)">
        ${[10, 25, 50, 100].map(n => `<option value="${n}" ${n === data.size ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>`;
}

function renderFacturas() {
  document.getElementById('invBody').innerHTML = facturas.length ? facturas.map(f => {
    const sigla = sigla_de(f);
    const nota  = sigla === 'NC';
    return `
    <tr class="rg-row ${sigla ? 'nota' : ''} ${nota ? 'nc' : ''}" onclick="verFactura(${f.id})">
      <td>${sigla ? `<span class="rc-badge ${nota ? 'nc' : 'nd'}" title="${nota ? 'Nota de crédito: resta de la deuda' : 'Nota de débito: suma a la deuda'}">${sigla}</span> ` : ''}${esc(f.comprobante)}</td>
      <td>${esc(f.fecha) || '—'}</td>
      <td>${esc(f.cliente)}</td>
      <td class="mono">${esc(f.cuit)}</td>
      <td class="num ${Number(f.importe) < 0 ? 'neg' : ''}">${money(f.importe)}</td>
      <td class="num">${money(f.imputado)}</td>
      <td>${estado(f.estado)}</td>
      <td>${archivo(f)}</td>
      <td><button class="rc-del" title="Borrar este comprobante de la base"
                  onclick="event.stopPropagation(); borrarFactura(${f.id})">✕</button></td>
    </tr>`; }).join('') : vacio(9, 'No hay facturas guardadas.');
}

function renderPagos() {
  document.getElementById('payBody').innerHTML = pagos.length ? pagos.map(p => `
    <tr class="rg-row" onclick="verPago(${p.id})">
      <td>${esc(p.fecha) || '—'}</td>
      <td>${esc(p.originante) || '—'}</td>
      <td class="mono">${esc(p.cuit) || '—'}</td>
      <td>${esc(p.banco) || '—'}</td>
      <td class="num">${money(p.importe)}</td>
      <td class="num">${money(p.imputado)}</td>
      <td>${archivo(p)}</td>
      <td><button class="rc-del" title="Borrar este cobro"
                  onclick="event.stopPropagation(); borrarPago(${p.id})">✕</button></td>
    </tr>`).join('') : vacio(8, 'No hay cobros guardados.');
}

function renderCruces() {
  document.getElementById('matBody').innerHTML = cruces.length ? cruces.map(c => `
    <tr>
      <td>${esc(c.comprobante)}</td>
      <td>${esc(c.cliente)}</td>
      <td>${esc(c.banco) || ''} ${esc(c.originante) || ''} · ${esc(c.fecha_pago) || '—'}</td>
      <td class="num">${money(c.importe)}</td>
      <td>${confianza(c.confianza)}</td>
      <td><button class="rc-del" title="Sacar este cruce"
                  onclick="sacarCruce(${c.id})">✕</button></td>
    </tr>`).join('') : vacio(6, 'No hay cruces guardados.');
}

function renderClientes() {
  document.getElementById('cliBody').innerHTML = clientes.length ? clientes.map(k => `
    <tr>
      <td>${esc(k.nombre)}</td>
      <td class="mono">${esc(k.cuit)}</td>
      <td>${esc(k.grupo) || '—'}</td>
      <td class="num">${k.n_facturas}</td>
      <td class="num">${money(k.facturado)}</td>
      <td><button class="rg-file" onclick="editarNombre(${k.id})">✎ Editar nombre</button></td>
    </tr>`).join('') : vacio(6, 'Todavía no hay clientes.');
}

function vacio(cols, texto) {
  return `<tr><td colspan="${cols}" class="rg-empty">${texto}</td></tr>`;
}

function archivo(d) {
  if (!d.tiene_archivo) return '<span class="rg-nofile">sin archivo</span>';
  return `<a class="rg-file" href="/reconciliation/registros/file/${d.huella}"
             target="_blank" onclick="event.stopPropagation()"
             title="${esc(d.archivo) || 'Abrir'}">📄 Ver</a>`;
}

/** "NC", "ND" o vacio si es una factura comun. */
function sigla_de(f) {
  const t = String(f.tipo || 'FACTURA').toUpperCase();
  return t === 'NOTA_CREDITO' ? 'NC' : t === 'NOTA_DEBITO' ? 'ND' : '';
}

function estado(e) {
  if (e === 'nota') return '<span class="rc-badge nc">— No se cobra</span>';
  return e === 'paid'
    ? '<span class="rc-badge alta">✓ Pagada</span>'
    : '<span class="rc-badge media">~ Pendiente</span>';
}

function confianza(c) {
  const cls = c === 'alta' ? 'alta'
            : c === 'media' ? 'media'
            : c === 'manual' ? 'manual'
            : 'revisar';
  return `<span class="rc-badge ${cls}">${esc(c)}</span>`;
}

/* ── Detalle ───────────────────────────────────────────────────── */

async function verFactura(id) {
  const f = facturas.find(x => x.id === id);
  if (!f) return;
  let propios;
  try { propios = await crucesDe('invoice', id); }
  catch (e) { toast(`❌ No se pudieron traer los cruces: ${e.message}`); return; }
  const sigla = sigla_de(f);
  const comoSeLlama = sigla === 'NC' ? 'Nota de crédito'
                    : sigla === 'ND' ? 'Nota de débito'
                    : 'Factura';
  abrirDetalle(`${comoSeLlama} ${f.comprobante}`, [
    ['Cliente',     f.cliente],
    ['CUIT',        f.cuit],
    ['Fecha',       f.fecha],
    ['Importe',     money(f.importe)],
    ['Imputado',    money(f.imputado)],
    ['Estado',      f.estado === 'nota' ? 'No se cobra'
                  : f.estado === 'paid' ? 'Pagada' : 'Pendiente'],
    ['Ajusta a',    f.ajusta || '—'],
    ['Descripción', f.descripcion],
    ['Archivo',     f.archivo],
  ], propios.map(c => `${c.fecha_pago || '—'} · ${c.banco || ''} ${c.originante || ''} · ${money(c.importe)}`), f);
}

async function verPago(id) {
  const p = pagos.find(x => x.id === id);
  if (!p) return;
  let propios;
  try { propios = await crucesDe('payment', id); }
  catch (e) { toast(`❌ No se pudieron traer los cruces: ${e.message}`); return; }
  abrirDetalle('Comprobante de pago', [
    ['Fecha',      p.fecha],
    ['Originante', p.originante],
    ['CUIT',       p.cuit],
    ['Banco',      p.banco],
    ['Referencia', p.referencia],
    ['Importe',    money(p.importe)],
    ['Imputado',   money(p.imputado)],
    ['Archivo',    p.archivo],
  ], propios.map(c => `${c.comprobante} · ${c.cliente} · ${money(c.importe)}`), p, true);
}

function abrirDetalle(titulo, filas, imputaciones, d, esPago = false) {
  document.getElementById('rgModalTitle').textContent = titulo;
  document.getElementById('rgModalBody').innerHTML = `
    <div class="rg-detail">
      ${filas.map(([l, v]) => `
        <div class="rg-detail-row">
          <span class="rg-detail-label">${l}</span>
          <span class="rg-detail-value">${esc(v) || '—'}</span>
        </div>`).join('')}
    </div>
    <h4 class="rg-detail-sub">Imputaciones</h4>
    ${imputaciones.length
      ? `<ul class="rg-list">${imputaciones.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`
      : '<p class="rg-empty">Todavía no tiene imputaciones.</p>'}
    ${d.tiene_archivo
      ? `<a class="btn btn-primary" target="_blank"
             href="/reconciliation/registros/file/${d.huella}">📄 Abrir el archivo original</a>`
      : (esPago
          ? `<button class="btn btn-primary" onclick="elegirComprobante(${d.id})">
               📎 Adjuntar el comprobante
             </button>
             <p class="rg-form-hint">Podés subir el PDF o la foto ahora, el pago ya cargado no cambia.</p>`
          : '<p class="rg-nofile">El archivo original no quedó guardado (se subió antes de esta versión).</p>')}
  `;
  document.getElementById('rgModal').hidden = false;
}

function cerrarDetalle(ev) {
  if (ev && ev.target !== ev.currentTarget) return;
  document.getElementById('rgModal').hidden = true;
}

/* ── Utilidades ────────────────────────────────────────────────── */

function money(n) {
  return '$ ' + Number(n || 0).toLocaleString('es-AR',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/* ── Pago cargado a mano ───────────────────────────────────────── */

function abrirAltaPago() {
  ['apFecha', 'apImporte', 'apOriginante', 'apCuit', 'apBanco', 'apReferencia']
    .forEach(id => document.getElementById(id).value = '');
  document.getElementById('apError').hidden = true;

  // Los clientes que ya existen salen en la lista del campo "Quién pagó":
  // se buscan en la base a medida que se escribe.
  clientesSugeridos = [];
  document.getElementById('apClientes').innerHTML = '';

  document.getElementById('rgAlta').hidden = false;
}

let clientesSugeridos = [];
let temporizadorClientes = null;

function sugerirClientes() {
  clearTimeout(temporizadorClientes);
  temporizadorClientes = setTimeout(async () => {
    const escrito = document.getElementById('apOriginante').value.trim();
    if (!escrito) { clientesSugeridos = []; document.getElementById('apClientes').innerHTML = ''; return; }
    try {
      const res  = await pedir(`/reconciliation/registros/clients?q=${encodeURIComponent(escrito)}`);
      const data = await res.json();
      if (data.status !== 'ok') return;
      clientesSugeridos = data.clientes || [];
      document.getElementById('apClientes').innerHTML =
        clientesSugeridos.map(k => `<option value="${esc(k.nombre)}">${esc(k.cuit)}</option>`).join('');
      completarCliente();
    } catch (_) { /* sin sugerencias, se puede escribir igual */ }
  }, 250);
}

/* Si lo que escribió coincide con un cliente que ya existe, se le completa
   el CUIT solo. Si no coincide con ninguno, queda como cliente nuevo. */
function completarCliente() {
  const escrito = document.getElementById('apOriginante').value.trim().toLowerCase();
  const hint    = document.getElementById('apClienteHint');
  const k = clientesSugeridos.find(x => (x.nombre || '').toLowerCase() === escrito);

  if (k) {
    document.getElementById('apCuit').value = k.cuit || '';
    hint.textContent = 'Cliente que ya existe: el cobro se le suma a su cuenta.';
    hint.classList.add('ok');
  } else {
    hint.textContent = 'Si el cliente no está en la lista, escribilo igual y se carga como nuevo.';
    hint.classList.remove('ok');
  }
}

function cerrarAltaPago(ev) {
  if (ev && ev.target !== ev.currentTarget) return;
  document.getElementById('rgAlta').hidden = true;
}

async function guardarPagoManual() {
  const err = document.getElementById('apError');
  const importe = aNumero(document.getElementById('apImporte').value);
  const fecha   = document.getElementById('apFecha').value;

  if (!importe || importe <= 0) { mostrarError(err, 'Poné un importe.'); return; }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) {
    mostrarError(err, 'Poné la fecha del pago como dd/mm/aaaa.'); return;
  }

  const body = {
    fecha:      fecha,
    importe:    importe,
    originante: document.getElementById('apOriginante').value.trim(),
    cuit:       document.getElementById('apCuit').value.trim(),
    banco:      document.getElementById('apBanco').value.trim() || 'Carga manual',
    referencia: document.getElementById('apReferencia').value.trim(),
  };

  try {
    const res  = await pedir('/reconciliation/registros/payment_manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    cerrarAltaPago();
    showTab(2);
  } catch (e) {
    mostrarError(err, `No se pudo guardar: ${e.message}`);
  }
}

/** Los cruces guardados de una factura o de un cobro, leidos de la base ahora. */
async function crucesDe(que, id) {
  const url = que === 'invoice'
    ? `/reconciliation/registros/invoice_matches?invoice_id=${id}`
    : `/reconciliation/registros/payment_matches?payment_id=${id}`;
  const res  = await pedir(url);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
  return data.cruces || [];
}

/** Hasta 8 lineas de cruces para mostrar en el aviso; el resto va en una sola linea. */
function listaDeCruces(lineas) {
  const vistas = lineas.slice(0, 8).map(t => `• ${esc(t)}`);
  if (lineas.length > 8) vistas.push(`• … y ${lineas.length - 8} más`);
  return vistas.join('\n');
}

async function borrarFactura(id) {
  const f = facturas.find(x => x.id === id);
  if (!f) return;

  let propios;
  try { propios = await crucesDe('invoice', id); }
  catch (e) { toast(`❌ No se pudo revisar la factura: ${e.message}`); return; }

  const nombre = f.comprobante ? `la factura <b>${esc(f.comprobante)}</b>` : 'esta factura';
  let mensaje = `Se va a borrar ${nombre} de la base.`;
  if (propios.length) {
    mensaje += `\n\n⚠️ Tiene <b>${propios.length} cruce(s)</b> con cobros. ` +
               `Al borrarla <b>se eliminan también esos cruces</b>:\n` +
               listaDeCruces(propios.map(c =>
                 `${c.fecha_pago || '—'} · ${c.banco || ''} ${c.originante || ''} · ${money(c.importe)}`)) +
               `\n\nLos cobros quedan en la base, libres para cruzarlos de nuevo.`;
  }
  mensaje += '\n\nNo se puede deshacer.';

  const seguir = await confirmar({
    titulo: propios.length ? 'Borrar la factura y sus cruces' : 'Borrar la factura',
    mensaje,
    ok: propios.length ? 'Borrar factura y cruces' : 'Borrar',
    cancel: 'Cancelar',
  });
  if (!seguir) return;

  try {
    const res  = await pedir('/reconciliation/registros/invoice_delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoice_id: id }),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    await cargar();
    if (data.n_cruces) {
      await avisar('Factura borrada',
        `Se borró ${nombre} y se eliminaron <b>${data.n_cruces} cruce(s)</b>.\n\n` +
        `Los cobros que tenía imputados quedaron libres.`);
    } else {
      toast('🗑 Factura borrada');
    }
  } catch (e) {
    toast(`❌ No se pudo borrar: ${e.message}`);
  }
}

async function borrarPago(id) {
  const p = pagos.find(x => x.id === id);
  if (!p) return;

  let propios;
  try { propios = await crucesDe('payment', id); }
  catch (e) { toast(`❌ No se pudo revisar el cobro: ${e.message}`); return; }

  const quien = p.originante ? `el cobro de <b>${esc(p.originante)}</b> por ${money(p.importe)}` : 'este cobro';
  let mensaje = `Se va a borrar ${quien} de la base.`;
  if (propios.length) {
    mensaje += `\n\n⚠️ Tiene <b>${propios.length} cruce(s)</b> con facturas. ` +
               `Al borrarlo <b>se eliminan también esos cruces</b>:\n` +
               listaDeCruces(propios.map(c =>
                 `${c.comprobante} · ${c.cliente} · ${money(c.importe)}`)) +
               `\n\nLas facturas que cubría vuelven a quedar pendientes.`;
  }
  mensaje += '\n\nNo se puede deshacer.';

  const seguir = await confirmar({
    titulo: propios.length ? 'Borrar el cobro y sus cruces' : 'Borrar el cobro',
    mensaje,
    ok: propios.length ? 'Borrar cobro y cruces' : 'Borrar',
    cancel: 'Cancelar',
  });
  if (!seguir) return;

  try {
    const res  = await pedir('/reconciliation/registros/payment_delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_id: id }),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    await cargar();
    if (data.n_cruces) {
      await avisar('Cobro borrado',
        `Se borró ${quien} y se eliminaron <b>${data.n_cruces} cruce(s)</b>.\n\n` +
        `Las facturas que cubría volvieron a quedar pendientes.`);
    } else {
      toast('🗑 Cobro borrado');
    }
  } catch (e) {
    toast(`❌ No se pudo borrar: ${e.message}`);
  }
}

/* ── Nombre del cliente ────────────────────────────────────────── */

let clienteEditando = null;

function editarNombre(id) {
  const k = clientes.find(x => x.id === id);
  if (!k) return;
  clienteEditando = k;

  document.getElementById('rnCuit').textContent   = k.cuit || '';
  document.getElementById('rnActual').textContent = k.nombre || '';
  document.getElementById('rnNombre').value       = k.nombre || '';
  document.getElementById('rnError').hidden       = true;
  document.getElementById('rgRename').hidden      = false;
  setTimeout(() => document.getElementById('rnNombre').focus(), 50);
}

function cerrarRename(ev) {
  if (ev && ev.target !== ev.currentTarget) return;
  document.getElementById('rgRename').hidden = true;
  clienteEditando = null;
}

async function guardarNombre() {
  if (!clienteEditando) return;
  const err    = document.getElementById('rnError');
  const nombre = document.getElementById('rnNombre').value.trim();

  if (!nombre) { mostrarError(err, 'El nombre no puede quedar vacío.'); return; }
  if (nombre === clienteEditando.nombre) { cerrarRename(); return; }

  try {
    const res  = await pedir('/reconciliation/registros/client_name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clienteEditando.id, nombre: nombre }),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    cerrarRename();
    showTab(4);
  } catch (e) {
    mostrarError(err, `No se pudo cambiar el nombre: ${e.message}`);
  }
}

function mostrarError(el, texto) {
  el.textContent = texto;
  el.hidden = false;
}


/* ── Sacar un cruce (de a uno, nunca en tanda) ──────────────────── */

async function sacarCruce(id) {
  const c = cruces.find(x => x.id === id);
  if (!c) return;
  const seguir = await confirmar({
    titulo: 'Sacar el cruce',
    mensaje: `Se saca la imputación de <b>${esc(c.comprobante)}</b> con el pago de ${money(c.importe)}.\n\n` +
             'La factura y el pago quedan en la base, solo se deshace el cruce.',
    ok: 'Sacar el cruce',
    cancel: 'Cancelar',
  });
  if (!seguir) return;

  try {
    const res  = await pedir('/reconciliation/registros/match_delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match_id: id }),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    showTab(3);
    toast('↩️ Cruce sacado');
  } catch (e) {
    toast(`❌ No se pudo sacar el cruce: ${e.message}`);
  }
}

/* ── Adjuntar el comprobante a un pago ya cargado ───────────────── */

let pagoParaComprobante = null;

function elegirComprobante(paymentId) {
  pagoParaComprobante = paymentId;
  const input = document.getElementById('rgPayFile');
  input.value = '';
  input.click();
}

async function subirComprobante(input) {
  if (!input.files.length || !pagoParaComprobante) return;

  const fd = new FormData();
  fd.append('payment_id', pagoParaComprobante);
  fd.append('file', input.files[0]);

  try {
    const res  = await pedir('/reconciliation/registros/payment_file',
                             { method: 'POST', body: fd });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    cerrarDetalle();
    showTab(2);
  } catch (e) {
    toast(`❌ No se pudo subir el comprobante: ${e.message}`);
  } finally {
    pagoParaComprobante = null;
  }
}

/* ── Formato de importe y de CUIT ───────────────────────────────── */

function formatearImporte(input) {
  let v = input.value.replace(/[^\d,]/g, '');
  const partes  = v.split(',');
  const enteros = (partes[0] || '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const dec     = partes.length > 1 ? ',' + partes[1].slice(0, 2) : '';
  input.value = enteros + dec;
}

function aNumero(texto) {
  return parseFloat((texto || '').replace(/\./g, '').replace(',', '.')) || 0;
}

function formatearFecha(input) {
  const n = (input.value || '').replace(/\D/g, '').slice(0, 8);
  if (n.length <= 2) { input.value = n; return; }
  if (n.length <= 4) { input.value = `${n.slice(0, 2)}/${n.slice(2)}`; return; }
  input.value = `${n.slice(0, 2)}/${n.slice(2, 4)}/${n.slice(4)}`;
}

function formatearCuit(input) {
  const n = (input.value || '').replace(/\D/g, '').slice(0, 11);
  if (n.length <= 2)  { input.value = n; return; }
  if (n.length <= 10) { input.value = `${n.slice(0, 2)}-${n.slice(2)}`; return; }
  input.value = `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`;
}


// ── Calendarito ────────────────────────────────────────────────────
// El campo se escribe siempre dd/mm/aaaa. El boton abre el calendario
// del navegador y lo que se elige vuelve escrito en ese mismo formato.
function abrirCalendario(id) {
  const campo = document.getElementById(id);
  const cal   = document.getElementById(id + '_cal');
  const m = (campo.value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  cal.value = m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  if (cal.showPicker) { cal.showPicker(); } else { cal.click(); }
}

function desdeCalendario(id) {
  const cal = document.getElementById(id + '_cal');
  if (!cal.value) return;
  const [a, me, d] = cal.value.split('-');
  document.getElementById(id).value = `${d}/${me}/${a}`;
}


/* ── Cuadro propio de confirmar / avisar ───────────────────────────
   Reemplaza al confirm() y al alert() del navegador. Devuelve una promesa:
   true si se acepta, false si se cancela. Escape y Enter cancelan: la opcion
   segura es la de salir. */
let _confirmarResolver = null;

function confirmar({ titulo, mensaje, ok = 'Aceptar', cancel = 'Cancelar', soloAviso = false }) {
  document.getElementById('cfTitulo').textContent  = titulo;
  document.getElementById('cfMensaje').innerHTML   = mensaje;
  document.getElementById('cfOk').textContent      = ok;
  document.getElementById('cfCancel').textContent  = cancel;
  document.getElementById('cfCancel').hidden       = soloAviso;
  document.getElementById('cfOk').classList.toggle('rg-btn-peligro', !soloAviso);
  document.getElementById('rgConfirm').hidden      = false;
  return new Promise(res => { _confirmarResolver = res; });
}

function avisar(titulo, mensaje) {
  return confirmar({ titulo, mensaje, ok: 'Entendido', soloAviso: true });
}

function confirmarResolver(acepta) {
  document.getElementById('rgConfirm').hidden = true;
  const r = _confirmarResolver; _confirmarResolver = null;
  if (r) r(acepta);
}

document.addEventListener('keydown', e => {
  if (document.getElementById('rgConfirm').hidden) return;
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); confirmarResolver(false); }
});

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 4500);
}
