// reconciliation.js — estado en sessionStorage + base opcional
//
// Tanda 3 (pedidos del 29/08/2026):
//   1. Aviso cuando se sube dos veces la misma factura, con la opción de
//      cargarla igual.
//   3. Agrupar clientes bajo un nombre libre y ver el saldo total del grupo.
//   4. Un mismo CUIT sale siempre con el mismo nombre (lo resuelve el backend).

// ── State ──────────────────────────────────────────────────────────
let invoices = [];
let payments = [];
let lastResult = null;

let dbEnabled = false;      // hay base configurada y respondiendo
let agrupar = false;        // vista agrupada de la cuenta corriente
let grupos = [];            // [{id, nombre}]
let asignaciones = {};      // cuit -> {group_id, group_name}

const SS_KEY = 'zym_reconciliation_v1';

// ── Boot ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  restore();
  bindDrop('dropInv', 'fileInv', files => uploadFiles(files, 'invoices'));
  bindDrop('dropPay', 'filePay', files => uploadFiles(files, 'payments'));
  document.getElementById('importSession')
    .addEventListener('change', e => importSession(e.target.files[0]));
  renderAll();
  checkDb();
});

function persist() {
  sessionStorage.setItem(SS_KEY,
    JSON.stringify({ invoices, payments, lastResult, agrupar }));
}
function restore() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    invoices = s.invoices || [];
    payments = s.payments || [];
    lastResult = s.lastResult || null;
    agrupar = !!s.agrupar;
  } catch (_) { /* sesión corrupta → arrancar vacío */ }
}

// ── Base de datos ──────────────────────────────────────────────────
async function checkDb() {
  try {
    const res = await fetch('/reconciliation/db_status');
    const data = await res.json();
    dbEnabled = !!data.enabled;
  } catch (_) { dbEnabled = false; }

  const btn = document.getElementById('btnSaveDb');
  if (btn) btn.hidden = !dbEnabled;
  const chk = document.getElementById('chkAgrupar');
  if (chk) chk.checked = agrupar;
  if (dbEnabled) loadGroups();
}

async function loadGroups() {
  try {
    const res = await fetch('/reconciliation/groups');
    const data = await res.json();
    grupos = data.grupos || [];
    asignaciones = data.asignaciones || {};
  } catch (_) { /* sin grupos, la pantalla sigue andando */ }
}


// ── Modal propio de confirmar / pedir un dato ──────────────────────
// Reemplaza confirm() y prompt(), que salen con el estilo del sistema
// operativo. Devuelve una promesa: true/false, o el texto escrito.
let _askResolver = null;

function ask({ titulo, mensaje, ok = 'Sí', cancel = 'No', input = null }) {
  document.getElementById('askTitle').textContent = titulo;
  document.getElementById('askMsg').innerHTML = mensaje;
  document.getElementById('askOk').textContent = ok;
  document.getElementById('askCancel').textContent = cancel;

  const campo = document.getElementById('askInput');
  campo.hidden = input === null;
  campo.value = input || '';

  document.getElementById('askModal').hidden = false;
  if (input !== null) setTimeout(() => { campo.focus(); campo.select(); }, 30);

  return new Promise(res => { _askResolver = res; });
}

function askResolve(acepta) {
  document.getElementById('askModal').hidden = true;
  const campo = document.getElementById('askInput');
  const valor = campo.hidden ? acepta : (acepta ? campo.value.trim() : null);
  const r = _askResolver; _askResolver = null;
  if (r) r(valor);
}

document.addEventListener('keydown', e => {
  if (document.getElementById('askModal').hidden) return;
  // Escape y Enter cierran sin hacer nada: la opcion segura es la de salir.
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); askResolve(false); }
});

// ── Upload — un archivo por request, para tener progreso real ──────
function bindDrop(dropId, inputId, handler) {
  const drop = document.getElementById(dropId);
  const input = document.getElementById(inputId);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { handler(input.files); input.value = ''; });
  ['dragover', 'dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, e => {
      e.preventDefault();
      drop.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop') handler(e.dataTransfer.files);
    }));
}

async function uploadFiles(fileList, kind) {
  const files = [...fileList].filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!files.length) { toast('⚠️ Solo se aceptan PDF'); return; }

  const isInv  = kind === 'invoices';
  const target = isInv ? invoices : payments;
  const pfx    = isInv ? 'Inv' : 'Pay';
  const errEl  = document.getElementById(isInv ? 'invErrors' : 'payErrors');
  const endpoint = `/reconciliation/parse_${kind}`;

  errEl.innerHTML = '';
  progressStart(pfx, files.length);

  let ok = 0, saltados = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    progressStep(pfx, i, files.length, f.name);

    const fd = new FormData();
    fd.append('files', f);

    try {
      const res  = await fetch(endpoint, { method: 'POST', body: fd });
      const data = await res.json();

      if (data.status === 'not_configured') {
        errEl.innerHTML = `<div class="rc-error">⚙️ ${esc(data.message)} — agregá la clave al .env y reiniciá la app.</div>`;
        break;
      }
      if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');

      for (const d of (data.documents || [])) {
        if (!await aceptarDoc(d, target, isInv, errEl)) { saltados++; continue; }
        target.push(d); ok++;
      }
      (data.errors || []).forEach(e =>
        errEl.innerHTML += `<div class="rc-error">❌ ${esc(e.archivo)}: ${esc(e.error)}</div>`);
    } catch (e) {
      errEl.innerHTML += `<div class="rc-error">❌ ${esc(f.name)}: ${esc(e.message)}</div>`;
    }

    progressStep(pfx, i + 1, files.length, f.name);
    // Los datos nuevos invalidan la conciliación anterior
    lastResult = null;
    persist(); renderAll();
  }

  progressEnd(pfx);
  if (ok) toast(`✅ ${ok} documento(s) procesado(s)`);
  if (saltados) toast(`↩️ ${saltados} documento(s) repetido(s) no se cargaron`);
}

/**
 * Decide si el documento se carga o se descarta.
 *
 * Hay dos formas de que esté repetido:
 *   - ya se subió en esta misma pantalla (se compara la huella del archivo)
 *   - ya está guardado en la base, quizá de otro día (lo avisa el backend)
 * En los dos casos se pregunta antes de cargarlo, nunca se bloquea solo.
 */
async function aceptarDoc(d, target, isInv, errEl) {
  const queEs = isInv ? 'factura' : 'comprobante';

  const yaEnPantalla = d._hash && target.some(x => x._hash === d._hash);
  if (yaEnPantalla) {
    const seguir = await ask({
      titulo: `Este ${queEs} ya lo subiste`,
      mensaje: `Ya está en esta pantalla:\n\n<b>${esc(d._archivo)}</b>\n\n` +
               `Si lo cargás igual va a aparecer dos veces.`,
      cancel: 'No cargar',
      ok: 'Cargar igual',
    });
    if (!seguir) return false;
    errEl.innerHTML += `<div class="rc-dupe">⚠️ ${esc(d._archivo)}: repetido en esta pantalla, cargado igual.</div>`;
    return true;
  }

  if (d._duplicado) {
    const pagada = /PAGADA/.test(d._aviso || '');
    const seguir = await ask({
      titulo: pagada ? `Esta ${queEs} figura pagada` : `Este ${queEs} ya está registrado`,
      mensaje: `<b>${esc(d._archivo)}</b>\n\n${esc(d._aviso)}.` +
               (pagada ? '\n\nSi la cargás igual vas a poder imputarle un pago nuevo.' : ''),
      cancel: 'No cargar',
      ok: 'Cargar igual',
    });
    if (!seguir) return false;
    errEl.innerHTML += `<div class="rc-dupe">⚠️ ${esc(d._archivo)}: ${esc(d._aviso)} — cargado igual.</div>`;
    return true;
  }

  return true;
}

// ── Barra de progreso ──────────────────────────────────────────────
function progressStart(pfx, total) {
  document.getElementById(`load${pfx}`).hidden = false;
  progressStep(pfx, 0, total, '');
}
function progressStep(pfx, done, total, name) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById(`load${pfx}Bar`).style.width = pct + '%';
  document.getElementById(`load${pfx}Pct`).textContent = pct + '%';
  document.getElementById(`load${pfx}Text`).textContent =
    done >= total
      ? 'Listo'
      : `Leyendo ${done + 1} de ${total} — ${trunc(name, 42)}`;
}
function progressEnd(pfx) {
  setTimeout(() => { document.getElementById(`load${pfx}`).hidden = true; }, 450);
}

// ── Conciliar ──────────────────────────────────────────────────────
async function runReconcile() {
  if (!invoices.length) { toast('⚠️ Cargá al menos una factura'); showStep(1); return; }
  if (!payments.length) { toast('⚠️ Cargá al menos un comprobante de pago'); showStep(2); return; }
  showStep(3);
  try {
    const res = await fetch('/reconciliation/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoices, payments })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    lastResult = data;
    persist(); renderAll();
    toast(`✅ Conciliado: ${data.resumen.n_matches} cruce(s)`);
  } catch (e) {
    toast(`❌ ${e.message}`);
  }
}

// ── Guardar en la base ─────────────────────────────────────────────
async function saveToDb() {
  if (!lastResult) { toast('⚠️ Primero hacé una conciliación'); return; }
  const seguir = await ask({
    titulo: 'Guardar en base',
    mensaje: 'Se van a guardar las facturas, los cobros y los cruces.\n\n' +
             'Las facturas que quedaron cubiertas se registran como pagadas.',
    cancel: 'Cancelar',
    ok: 'Guardar',
  });
  if (!seguir) return;
  try {
    const res = await fetch('/reconciliation/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoices, payments, result: lastResult })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    toast(`💾 Guardado: ${data.n_facturas} factura(s), ${data.n_pagos} pago(s), ${data.n_matches} cruce(s)`);
    loadGroups();
  } catch (e) {
    toast(`❌ ${e.message}`);
  }
}

// ── Grupos de clientes ─────────────────────────────────────────────
function toggleAgrupar() {
  agrupar = document.getElementById('chkAgrupar').checked;
  persist(); renderResult();
}

async function openGroups() {
  document.getElementById('groupsNoDb').hidden = dbEnabled;
  if (dbEnabled) await loadGroups();
  renderGroupsModal();
  document.getElementById('groupsModal').hidden = false;
}

function closeGroups() {
  document.getElementById('groupsModal').hidden = true;
  if (lastResult) runReconcile();   // vuelve a traer los grupos actualizados
}

function renderGroupsModal() {
  document.getElementById('groupList').innerHTML = grupos.length
    ? grupos.map(g => `
        <span class="rc-grouptag">
          ${esc(g.nombre)}
          <button onclick="renameGroup(${g.id})" title="Cambiar el nombre">✎</button>
          <button onclick="deleteGroup(${g.id})" title="Borrar el grupo">✕</button>
        </span>`).join('')
    : '<span class="rc-assign-cuit">Todavía no hay grupos.</span>';

  const clientes = lastResult
    ? lastResult.cuentas_corrientes.filter(c => c.cuit)
    : [];

  document.getElementById('assignList').innerHTML = clientes.length
    ? clientes.map(c => {
        const actual = (asignaciones[c.cuit] || {}).group_id || '';
        const opts = ['<option value="">Sin grupo</option>']
          .concat(grupos.map(g =>
            `<option value="${g.id}" ${String(g.id) === String(actual) ? 'selected' : ''}>${esc(g.nombre)}</option>`))
          .join('');
        return `
          <div class="rc-assign-row">
            <div>
              <div class="rc-assign-name">${esc(c.cliente)}</div>
              <div class="rc-assign-cuit">${esc(c.cuit)}</div>
            </div>
            <select class="rc-select" onchange="assignGroup('${esc(c.cuit)}', this.value)"
                    ${dbEnabled ? '' : 'disabled'}>${opts}</select>
          </div>`;
      }).join('')
    : '<span class="rc-assign-cuit">Hacé una conciliación primero para ver los clientes.</span>';
}

async function createGroup() {
  const input = document.getElementById('newGroupName');
  const nombre = input.value.trim();
  if (!nombre) { toast('⚠️ Poné un nombre para el grupo'); return; }
  if (!dbEnabled) { toast('⚠️ Sin base no se pueden guardar grupos'); return; }
  try {
    const res = await fetch('/reconciliation/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    input.value = '';
    await loadGroups(); renderGroupsModal();
    toast('✅ Grupo creado');
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function renameGroup(groupId) {
  const g = grupos.find(x => x.id === groupId);
  const nombre = await ask({
    titulo: 'Cambiar el nombre del grupo',
    mensaje: 'Poné el nombre nuevo:',
    cancel: 'Cancelar',
    ok: 'Guardar',
    input: g ? g.nombre : '',
  });
  if (!nombre) return;
  try {
    const res = await fetch('/reconciliation/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId, nombre })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    await loadGroups(); renderGroupsModal();
    toast('✅ Nombre cambiado');
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function deleteGroup(groupId) {
  const seguir = await ask({
    titulo: 'Borrar el grupo',
    mensaje: 'Los clientes quedan sin grupo. No se borra ninguna factura ni ningún pago.',
    cancel: 'Cancelar',
    ok: 'Borrar',
  });
  if (!seguir) return;
  try {
    const res = await fetch('/reconciliation/groups/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    await loadGroups(); renderGroupsModal();
    toast('🗑 Grupo borrado');
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function assignGroup(cuit, groupId) {
  const c = (lastResult ? lastResult.cuentas_corrientes : [])
    .find(x => x.cuit === cuit);
  try {
    const res = await fetch('/reconciliation/assign_group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cuit,
        cliente: c ? c.cliente : cuit,
        group_id: groupId ? Number(groupId) : null
      })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    await loadGroups();
    toast('✅ Cliente asignado');
  } catch (e) { toast(`❌ ${e.message}`); }
}

// ── Render ─────────────────────────────────────────────────────────
function renderAll() {
  document.getElementById('invCount').textContent = invoices.length;
  document.getElementById('payCount').textContent = payments.length;
  renderInvTable(); renderPayTable(); renderResult(); renderHint();
}

// Guía: qué falta hacer ahora
function renderHint() {
  const hint = document.getElementById('rcHint');
  const btnPay = document.getElementById('btnToPay');
  const btnRec = document.getElementById('btnReconcile');
  if (btnPay) btnPay.disabled = invoices.length === 0;
  if (btnRec) btnRec.disabled = invoices.length === 0 || payments.length === 0;
  if (!hint) return;
  if (!invoices.length)      hint.textContent = 'Paso 1 — Subí los PDF de las facturas emitidas. Podés hacerlo en varias tandas.';
  else if (!payments.length) hint.textContent = `Paso 2 — ${invoices.length} factura(s) cargada(s). Ahora subí los comprobantes de pago que te fueron llegando.`;
  else if (!lastResult)      hint.textContent = `Paso 3 — ${invoices.length} factura(s) y ${payments.length} pago(s) listos. Apretá “Conciliar ahora”.`;
  else                       hint.textContent = `Conciliado: ${lastResult.resumen.n_matches} cruce(s). Podés seguir sumando facturas o pagos y volver a conciliar.`;
}

function renderInvTable() {
  const t = document.getElementById('invTable');
  const b = document.getElementById('invBody');
  t.hidden = !invoices.length;
  b.innerHTML = invoices.map((inv, i) => `
    <tr class="${inv._duplicado ? 'dupe' : ''}">
      <td class="mono">${esc(inv.punto_venta)}-${esc(inv.comp_nro)}${inv._duplicado ? ' <span class="rc-badge media" title="Ya estaba registrada — la cargaste igual">repetida</span>' : ''}</td>
      <td class="mono">${esc(inv.fecha_emision)}</td>
      <td>${esc(inv.razon_social_cliente)}</td>
      <td class="mono">${esc(inv.cuit_cliente)}</td>
      <td class="num">${money(inv.importe_total)}</td>
      <td>${esc(trunc(inv.descripcion, 70))}</td>
      <td><button class="rc-del" onclick="delDoc('invoices', ${i})" title="Quitar">✕</button></td>
    </tr>`).join('');
}

function renderPayTable() {
  const t = document.getElementById('payTable');
  const b = document.getElementById('payBody');
  t.hidden = !payments.length;
  b.innerHTML = payments.map((p, i) => `
    <tr class="${p._duplicado ? 'dupe' : ''}">
      <td>${esc(p.banco || '-')}${p._corregido ? ' <span class="rc-badge media" title="El extractor había invertido pagador y cobrador — corregido automáticamente">corregido</span>' : ''}${p._duplicado ? ' <span class="rc-badge media" title="Ya estaba registrado — lo cargaste igual">repetido</span>' : ''}</td>
      <td class="mono">${esc(p.fecha)}</td>
      <td>${esc(p.originante)}</td>
      <td class="mono">${esc(p.cuit_originante)}</td>
      <td class="num">${money(p.importe)}</td>
      <td>${esc(trunc(p.referencia || p.concepto, 40))}</td>
      <td><button class="rc-del" onclick="delDoc('payments', ${i})" title="Quitar">✕</button></td>
    </tr>`).join('');
}

function delDoc(kind, i) {
  (kind === 'invoices' ? invoices : payments).splice(i, 1);
  lastResult = null;
  persist(); renderAll();
}

function renderResult() {
  const empty = document.getElementById('rcEmpty');
  const box   = document.getElementById('rcResult');
  if (!lastResult) { empty.hidden = false; box.hidden = true; return; }
  empty.hidden = true; box.hidden = false;

  const r = lastResult;

  document.getElementById('rcKpis').innerHTML = [
    ['Facturas', r.resumen.n_facturas],
    ['Pagos', r.resumen.n_pagos],
    ['Cruces', r.resumen.n_matches],
    ['Facturado', money(r.resumen.total_facturado)],
    ['Cobrado', money(r.resumen.total_cobrado)],
    ['Pendiente', money(r.resumen.total_pendiente)],
  ].map(([l, v]) => `
    <div class="rc-kpi"><div class="rc-kpi-label">${l}</div>
    <div class="rc-kpi-value">${v}</div></div>`).join('');

  renderCuentaCorriente(r);

  document.getElementById('matchBody').innerHTML = r.matches.length
    ? r.matches.map(m => `
      <tr>
        <td><span class="rc-badge ${m.confianza}">${label(m.confianza)}</span></td>
        <td class="mono">${esc(m.factura.comp)} · ${esc(m.factura.fecha)}</td>
        <td>${esc(m.factura.cliente)}</td>
        <td class="num">${money(m.factura.importe)}</td>
        <td>${esc(m.pago.banco || '-')} · ${esc(m.pago.originante)} · <span class="mono">${esc(m.pago.fecha)}</span>${m.pago.corregido ? ' <span class="rc-badge media">corregido</span>' : ''}</td>
        <td>${esc(m.motivo)}</td>
      </tr>`).join('')
    : `<tr><td colspan="6">Sin cruces todavía.</td></tr>`;

  document.getElementById('pendBody').innerHTML = r.facturas_pendientes.length
    ? r.facturas_pendientes.map(f => `
      <tr>
        <td class="mono">${esc(f.comp)}</td><td class="mono">${esc(f.fecha)}</td>
        <td>${esc(f.cliente)}</td><td class="num">${money(f.importe)}</td>
        <td>${esc(trunc(f.descripcion, 70))}</td>
      </tr>`).join('')
    : `<tr><td colspan="5">🎉 No hay facturas pendientes.</td></tr>`;

  document.getElementById('unassBody').innerHTML = r.pagos_sin_imputar.length
    ? r.pagos_sin_imputar.map(p => `
      <tr>
        <td>${esc(p.banco || '-')}</td><td class="mono">${esc(p.fecha)}</td>
        <td>${esc(p.originante)}</td><td class="num">${money(p.importe)}</td>
        <td>${p.a_cuenta
              ? '<span class="rc-badge cuenta">A cuenta del cliente</span>'
              : '<span class="rc-badge rojo">Sin imputar</span>'}</td>
      </tr>`).join('')
    : `<tr><td colspan="5">Todos los pagos quedaron imputados.</td></tr>`;
}

/** Tarjeta de un cliente. Es la misma en la vista plana y en la agrupada. */
function ccCard(c) {
  return `
    <div class="rc-cc-card">
      <div class="rc-cc-name">${esc(c.cliente)}</div>
      <div class="rc-cc-cuit">${esc(c.cuit) || 'sin CUIT'}</div>
      <div class="rc-cc-row"><span>Facturado (${c.n_facturas})</span>
        <span class="val">${money(c.facturado)}</span></div>
      <div class="rc-cc-row"><span>Cobrado (${c.n_pagos})</span>
        <span class="val">${money(c.cobrado)}</span></div>
      <div class="rc-cc-row rc-cc-saldo"><span>Saldo</span>
        <span class="val ${c.saldo > 0 ? 'pos' : 'zero'}">${money(c.saldo)}</span></div>
    </div>`;
}

/**
 * Cuenta corriente, plana o agrupada.
 * Agrupada: un bloque por grupo, con el saldo total arriba y las tarjetas de
 * sus clientes adentro. Los clientes sin grupo quedan al final.
 */
function renderCuentaCorriente(r) {
  const plana = document.getElementById('ccGrid');
  const agrup = document.getElementById('ccGrouped');

  if (!agrupar) {
    plana.hidden = false; agrup.hidden = true;
    plana.innerHTML = r.cuentas_corrientes.map(ccCard).join('');
    return;
  }

  plana.hidden = true; agrup.hidden = false;
  const resumen = r.grupos_resumen || [];
  agrup.innerHTML = resumen.map(g => {
    const clientes = r.cuentas_corrientes.filter(c => (c.grupo || 'Sin grupo') === g.grupo);
    return `
      <div class="rc-group">
        <div class="rc-group-head">
          <div>
            <div class="rc-group-name">${esc(g.grupo)}</div>
            <div class="rc-group-meta">${g.n_clientes} cliente(s) · Facturado ${money(g.facturado)} · Cobrado ${money(g.cobrado)}</div>
          </div>
          <div class="rc-group-tot">Saldo ${money(g.saldo)}</div>
        </div>
        <div class="rc-cc-grid">${clientes.map(ccCard).join('')}</div>
      </div>`;
  }).join('');
}

// ── Session export / import ────────────────────────────────────────
function exportSession() {
  const blob = new Blob([JSON.stringify({ invoices, payments, lastResult }, null, 2)],
                        { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zym_conciliacion_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importSession(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      invoices = s.invoices || [];
      payments = s.payments || [];
      lastResult = s.lastResult || null;
      persist(); renderAll();
      toast('✅ Sesión cargada');
    } catch (_) { toast('❌ El archivo no es una sesión válida'); }
  };
  reader.readAsText(file);
}

function exportCSV() {
  if (!lastResult) { toast('⚠️ Primero hacé una conciliación'); return; }
  // El nombre del cliente y el grupo vienen ya unificados por CUIT desde el
  // backend, asi que el mismo cliente no puede salir con dos nombres.
  const rows = [['estado', 'grupo', 'factura', 'fecha_factura', 'cliente', 'cuit',
                 'importe', 'banco_pago', 'fecha_pago', 'originante', 'motivo']];
  const grupoDe = {};
  (lastResult.cuentas_corrientes || []).forEach(c => {
    grupoDe[c.cuit] = c.grupo || 'Sin grupo';
  });
  lastResult.matches.forEach(m => rows.push([
    labelPlano(m.confianza), grupoDe[m.factura.cuit] || 'Sin grupo',
    m.factura.comp, m.factura.fecha, m.factura.cliente,
    m.factura.cuit, numeroCSV(m.factura.importe), m.pago.banco, m.pago.fecha,
    m.pago.originante, m.motivo]));
  lastResult.facturas_pendientes.forEach(f => rows.push([
    'PENDIENTE', grupoDe[f.cuit] || 'Sin grupo', f.comp, f.fecha, f.cliente,
    f.cuit, numeroCSV(f.importe), '', '', '', '']));
  const csv = rows.map(r => r.map(c =>
    `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zym_conciliacion_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function resetAll() {
  const seguir = await ask({
    titulo: 'Limpiar la pantalla',
    mensaje: 'Se borran las facturas, los pagos y la conciliación que tenés acá.\n\n' +
             'Lo que ya guardaste en la base no se toca.',
    cancel: 'Cancelar',
    ok: 'Limpiar',
  });
  if (!seguir) return;
  invoices = []; payments = []; lastResult = null;
  sessionStorage.removeItem(SS_KEY);
  renderAll(); showStep(1);
  toast('🧹 Sesión limpia');
}

// ── Steps ──────────────────────────────────────────────────────────
function showStep(n) {
  [1, 2, 3].forEach(i => {
    document.getElementById(`panel${i}`).hidden = i !== n;
    document.getElementById(`stepTab${i}`).classList.toggle('active', i === n);
  });
}

// ── Utils ──────────────────────────────────────────────────────────
function money(v) {
  return '$ ' + Number(v || 0).toLocaleString('es-AR',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function label(c) {
  return { alta: '✔ Alta', media: '~ Media', revisar: '⚠ Revisar' }[c] || c;
}
// En el Excel el estado va sin simbolos, para poder filtrar por texto.
function labelPlano(c) {
  return { alta: 'Alta', media: 'Media', revisar: 'Revisar' }[c] || c;
}
// Importe con separador de miles y dos decimales, formato argentino.
function numeroCSV(v) {
  return Number(v || 0).toLocaleString('es-AR',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 3200);
}
