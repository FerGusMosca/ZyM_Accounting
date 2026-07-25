// reconciliation.js — estado sin BD: sessionStorage + export/import JSON

// ── State ──────────────────────────────────────────────────────────
let invoices = [];
let payments = [];
let lastResult = null;

const SS_KEY = 'zym_reconciliation_v1';

// ── Boot ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  restore();
  bindDrop('dropInv', 'fileInv', files => uploadFiles(files, 'invoices'));
  bindDrop('dropPay', 'filePay', files => uploadFiles(files, 'payments'));
  document.getElementById('importSession')
    .addEventListener('change', e => importSession(e.target.files[0]));
  renderAll();
});

function persist() {
  sessionStorage.setItem(SS_KEY, JSON.stringify({ invoices, payments, lastResult }));
}
function restore() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    invoices = s.invoices || [];
    payments = s.payments || [];
    lastResult = s.lastResult || null;
  } catch (_) { /* sesión corrupta → arrancar vacío */ }
}

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

  let ok = 0;
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

      (data.documents || []).forEach(d => { target.push(d); ok++; });
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
    <tr>
      <td class="mono">${esc(inv.punto_venta)}-${esc(inv.comp_nro)}</td>
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
    <tr>
      <td>${esc(p.banco || '-')}${p._corregido ? ' <span class="rc-badge media" title="El extractor había invertido pagador y cobrador — corregido automáticamente">corregido</span>' : ''}</td>
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

  document.getElementById('ccGrid').innerHTML = r.cuentas_corrientes.map(c => `
    <div class="rc-cc-card">
      <div class="rc-cc-name">${esc(c.cliente)}</div>
      <div class="rc-cc-cuit">${esc(c.cuit) || 'sin CUIT'}</div>
      <div class="rc-cc-row"><span>Facturado (${c.n_facturas})</span>
        <span class="val">${money(c.facturado)}</span></div>
      <div class="rc-cc-row"><span>Cobrado (${c.n_pagos})</span>
        <span class="val">${money(c.cobrado)}</span></div>
      <div class="rc-cc-row rc-cc-saldo"><span>Saldo</span>
        <span class="val ${c.saldo > 0 ? 'pos' : 'zero'}">${money(c.saldo)}</span></div>
    </div>`).join('');

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
  const rows = [['estado', 'factura', 'fecha_factura', 'cliente', 'cuit', 'importe',
                 'banco_pago', 'fecha_pago', 'originante', 'motivo']];
  lastResult.matches.forEach(m => rows.push([
    label(m.confianza), m.factura.comp, m.factura.fecha, m.factura.cliente,
    m.factura.cuit, m.factura.importe, m.pago.banco, m.pago.fecha,
    m.pago.originante, m.motivo]));
  lastResult.facturas_pendientes.forEach(f => rows.push([
    'PENDIENTE', f.comp, f.fecha, f.cliente, f.cuit, f.importe, '', '', '', '']));
  const csv = rows.map(r => r.map(c =>
    `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zym_conciliacion_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function resetAll() {
  if (!confirm('¿Borrar todas las facturas, pagos y la conciliación de esta sesión?')) return;
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
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 3200);
}
