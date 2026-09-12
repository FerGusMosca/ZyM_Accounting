/* records.js — Registros guardados de Cobranzas
 *
 * Muestra lo que ya esta en la base: facturas, cobros y cruces.
 * De cada factura y cada cobro se puede abrir el archivo original,
 * porque desde esta tanda el archivo queda guardado al subirlo.
 */

let facturas = [];
let pagos    = [];
let cruces   = [];
let clientes = [];

document.addEventListener('DOMContentLoaded', cargar);

/* ── Datos ─────────────────────────────────────────────────────── */

async function cargar() {
  const hint = document.getElementById('rgHint');
  hint.textContent = 'Cargando…';
  try {
    const res  = await fetch('/reconciliation/registros/data');
    const data = await res.json();

    if (data.status === 'no_db') {
      hint.textContent = 'No hay base configurada, así que todavía no hay registros guardados.';
      return;
    }
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');

    facturas = data.facturas || [];
    pagos    = data.pagos    || [];
    cruces   = data.cruces   || [];

    const resCli = await fetch('/reconciliation/registros/clients');
    const dataCli = await resCli.json();
    clientes = dataCli.clientes || [];

    renderAll();
  } catch (e) {
    hint.textContent = `No se pudieron traer los registros: ${e.message}`;
  }
}

/* ── Pantalla ──────────────────────────────────────────────────── */

function showTab(n) {
  [1, 2, 3, 4].forEach(i => {
    document.getElementById(`tab${i}`).classList.toggle('active', i === n);
    document.getElementById(`panel${i}`).hidden = i !== n;
  });
}

function renderAll() {
  const q = (document.getElementById('rgSearch').value || '').trim().toLowerCase();
  const hit = (...campos) => !q || campos.some(c => (c || '').toString().toLowerCase().includes(q));

  const fs = facturas.filter(f => hit(f.comprobante, f.cliente, f.cuit, f.descripcion, f.archivo));
  const ps = pagos.filter(p => hit(p.originante, p.cuit, p.banco, p.referencia, p.archivo));
  const cs = cruces.filter(c => hit(c.comprobante, c.cliente, c.banco, c.originante));
  const ks = clientes.filter(k => hit(k.nombre, k.cuit, k.grupo));

  document.getElementById('cntInv').textContent = fs.length;
  document.getElementById('cntPay').textContent = ps.length;
  document.getElementById('cntMat').textContent = cs.length;
  document.getElementById('cntCli').textContent = ks.length;

  document.getElementById('rgHint').textContent =
    `${facturas.length} factura(s), ${pagos.length} cobro(s) y ${cruces.length} cruce(s) guardados.`;

  document.getElementById('invBody').innerHTML = fs.length ? fs.map(f => `
    <tr class="rg-row" onclick="verFactura(${f.id})">
      <td>${esc(f.comprobante)}</td>
      <td>${esc(f.fecha) || '—'}</td>
      <td>${esc(f.cliente)}</td>
      <td class="mono">${esc(f.cuit)}</td>
      <td class="num">${money(f.importe)}</td>
      <td class="num">${money(f.imputado)}</td>
      <td>${estado(f.estado)}</td>
      <td>${archivo(f)}</td>
    </tr>`).join('') : vacio(8, 'No hay facturas guardadas.');

  document.getElementById('payBody').innerHTML = ps.length ? ps.map(p => `
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

  document.getElementById('matBody').innerHTML = cs.length ? cs.map(c => `
    <tr>
      <td>${esc(c.comprobante)}</td>
      <td>${esc(c.cliente)}</td>
      <td>${esc(c.banco) || ''} ${esc(c.originante) || ''} · ${esc(c.fecha_pago) || '—'}</td>
      <td class="num">${money(c.importe)}</td>
      <td>${confianza(c.confianza)}</td>
      <td><button class="rc-del" title="Sacar este cruce"
                  onclick="sacarCruce(${c.id})">✕</button></td>
    </tr>`).join('') : vacio(6, 'No hay cruces guardados.');

  document.getElementById('cliBody').innerHTML = ks.length ? ks.map(k => `
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

function estado(e) {
  return e === 'paid'
    ? '<span class="rc-badge alta">✓ Pagada</span>'
    : '<span class="rc-badge media">~ Pendiente</span>';
}

function confianza(c) {
  const cls = c === 'alta' ? 'alta' : (c === 'media' ? 'media' : 'revisar');
  return `<span class="rc-badge ${cls}">${esc(c)}</span>`;
}

/* ── Detalle ───────────────────────────────────────────────────── */

function verFactura(id) {
  const f = facturas.find(x => x.id === id);
  if (!f) return;
  const propios = cruces.filter(c => c.invoice_id === id);
  abrirDetalle(`Factura ${f.comprobante}`, [
    ['Cliente',     f.cliente],
    ['CUIT',        f.cuit],
    ['Fecha',       f.fecha],
    ['Importe',     money(f.importe)],
    ['Imputado',    money(f.imputado)],
    ['Estado',      f.estado === 'paid' ? 'Pagada' : 'Pendiente'],
    ['Descripción', f.descripcion],
    ['Archivo',     f.archivo],
  ], propios.map(c => `${c.fecha_pago || '—'} · ${c.banco || ''} ${c.originante || ''} · ${money(c.importe)}`), f);
}

function verPago(id) {
  const p = pagos.find(x => x.id === id);
  if (!p) return;
  const propios = cruces.filter(c => c.payment_id === id);
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

  // Los clientes que ya existen salen en la lista del campo "Quién pagó".
  document.getElementById('apClientes').innerHTML =
    clientes.map(k => `<option value="${esc(k.nombre)}">${esc(k.cuit)}</option>`).join('');

  document.getElementById('rgAlta').hidden = false;
}

/* Si lo que escribió coincide con un cliente que ya existe, se le completa
   el CUIT solo. Si no coincide con ninguno, queda como cliente nuevo. */
function completarCliente() {
  const escrito = document.getElementById('apOriginante').value.trim().toLowerCase();
  const hint    = document.getElementById('apClienteHint');
  const k = clientes.find(x => (x.nombre || '').toLowerCase() === escrito);

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
    const res  = await fetch('/reconciliation/registros/payment_manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    cerrarAltaPago();
    await cargar();
    showTab(2);
  } catch (e) {
    mostrarError(err, `No se pudo guardar: ${e.message}`);
  }
}

async function borrarPago(id) {
  const p = pagos.find(x => x.id === id);
  if (!p) return;
  const texto = p.imputado
    ? 'Ese cobro ya está imputado a una factura. Si lo borrás, la factura vuelve a quedar pendiente. ¿Seguimos?'
    : '¿Borrar este cobro?';
  if (!confirm(texto)) return;

  try {
    const res  = await fetch('/reconciliation/registros/payment_delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_id: id }),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    await cargar();
  } catch (e) {
    alert(`No se pudo borrar: ${e.message}`);
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
    const res  = await fetch('/reconciliation/registros/client_name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clienteEditando.id, nombre: nombre }),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    cerrarRename();
    await cargar();
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
  if (!confirm(`Sacar la imputación de ${c.comprobante} con el pago de ${money(c.importe)}?\n\n` +
               'La factura y el pago quedan, solo se deshace el cruce.')) return;

  try {
    const res  = await fetch('/reconciliation/registros/match_delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match_id: id }),
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    await cargar();
    showTab(3);
  } catch (e) {
    alert(`No se pudo sacar el cruce: ${e.message}`);
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
    const res  = await fetch('/reconciliation/registros/payment_file',
                             { method: 'POST', body: fd });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    cerrarDetalle();
    await cargar();
    showTab(2);
  } catch (e) {
    alert(`No se pudo subir el comprobante: ${e.message}`);
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
