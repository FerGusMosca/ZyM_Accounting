// reconciliation.js — estado en sessionStorage + base opcional
//
// Tanda 3 (pedidos del 29/08/2026):
//   1. Aviso cuando se sube dos veces la misma factura, con la opción de
//      cargarla igual.
//   3. Agrupar clientes bajo un nombre libre y ver el saldo total del grupo.
//   4. Un mismo CUIT sale siempre con el mismo nombre (lo resuelve el backend).
//
// Tanda 4 (pedidos del 20/09/2026):
//   1. Cruce manual: se eligen facturas pendientes y un pago, y se cruzan.
//   2. Si el pago sobra, lo que sobra queda como un pago aparte (remanente).
//   3. Traer recupera lo ya conciliado: concilia solo y los cruces guardados
//      vuelven tal cual, sin recalcularlos.
//
// Tanda 5 (pedidos del 20/09/2026):
//   1. Desarmar cruces: de a uno (✕) o el grupo entero (⤫ grupo). Lo ya
//      guardado se saca de a uno, como dice la regla.
//   2. Facturas y pagos se guardan solos al pasar de paso. "Guardar en base"
//      guarda los cruces. Si se cierra con cruces sin guardar, avisa.

// ── State ──────────────────────────────────────────────────────────
// Un comprobante puede venir como PDF o como foto sacada del celular.
const ACEPTADOS = /\.(pdf|jpg|jpeg|png|webp|heic)$/i;

let invoices = [];
let payments = [];
let lastResult = null;
let manuales = [];          // cruces a mano: [{pago: key, facturas: [key]}]
let selFacturas = [];       // facturas elegidas para el cruce a mano
let selPago = null;         // pago elegido para el cruce a mano
let descartados = [];       // cruces desarmados en pantalla: [{factura, pago}]
let aSacar = [];            // cruces GUARDADOS que se desarmaron: se sacan al guardar
let pasoActual = 1;         // paso que se esta viendo

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
    JSON.stringify({ invoices, payments, lastResult, agrupar, manuales, descartados, aSacar }));
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
    manuales = s.manuales || [];
    descartados = s.descartados || [];
    aSacar = s.aSacar || [];
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
  if (dbEnabled) {
    loadGroups();
    arrancarEnHoy();
  }
}

// Al abrir la pantalla se muestra lo guardado del ÚLTIMO AÑO: Desde es
// hoy menos un año y Hasta es hoy. Se pueden cambiar y apretar Traer.
function fechaTexto(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function arrancarEnHoy() {
  const hoy = new Date();
  const haceUnAnio = new Date(hoy);
  haceUnAnio.setFullYear(hoy.getFullYear() - 1);

  const desde = document.getElementById('dbDesde');
  const hasta = document.getElementById('dbHasta');
  if (!desde || !hasta) return;
  if (desde.value || hasta.value) return;   // si ya eligio fechas, no pisar

  desde.value = fechaTexto(haceUnAnio);
  hasta.value = fechaTexto(hoy);
  await traerDeLaBase({ silencioso: true });
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
  const files = [...fileList].filter(f => ACEPTADOS.test(f.name));
  if (!files.length) { toast('⚠️ Solo se aceptan PDF o fotos (jpg, png)'); return; }

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
  await conciliar();
}

/**
 * Llama al motor. Manda también los cruces hechos a mano; los cruces que
 * ya estaban guardados en la base los recupera el servidor solo.
 * silencioso: sin cartel de espera ni aviso (se usa al traer de la base).
 */
async function conciliar({ silencioso = false } = {}) {
  if (!invoices.length && !payments.length) return;
  if (!silencioso) trabajando(`Cruzando ${invoices.length} factura(s) con ${payments.length} pago(s)…`);
  try {
    const res = await fetch('/reconciliation/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoices, payments, manuales, descartados, sacar: aSacar })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    lastResult = data;
    limpiarSeleccion(false);
    persist(); renderAll();
    if (!silencioso) toast(`✅ Conciliado: ${data.resumen.n_matches} cruce(s)`);
  } catch (e) {
    toast(`❌ ${e.message}`);
  } finally {
    if (!silencioso) listo();
  }
}

// ── Cruce a mano ───────────────────────────────────────────────────
// Se eligen una o varias facturas pendientes y UN pago. Al cruzar, el pago
// se reparte entre las facturas en el orden elegido. Si sobra plata, queda
// como un pago aparte (remanente) que se puede volver a cruzar.
function toggleFactura(key) {
  const i = selFacturas.indexOf(key);
  if (i >= 0) selFacturas.splice(i, 1); else selFacturas.push(key);
  renderResult();
}

function elegirPago(key) {
  selPago = selPago === key ? null : key;
  renderResult();
}

function limpiarSeleccion(render = true) {
  selFacturas = []; selPago = null;
  if (render) renderResult();
}

function renderSeleccion() {
  const bar = document.getElementById('rcManualBar');
  if (!bar || !lastResult) return;
  const facts = lastResult.facturas_pendientes.filter(f => selFacturas.includes(f.key));
  const pago  = lastResult.pagos_sin_imputar.find(p => p.key === selPago);
  bar.hidden = !facts.length && !pago;
  if (bar.hidden) return;

  const totFact = facts.reduce((a, f) => a + Number(f.saldo || 0), 0);
  const libre   = pago ? Number(pago.libre || 0) : 0;
  const dif     = libre - totFact;

  let estado = '';
  if (facts.length && pago) {
    if (Math.abs(dif) < 0.005)  estado = '<span class="rc-badge alta">Cierra justo</span>';
    else if (dif > 0)           estado = `<span class="rc-badge cuenta">Quedan ${money(dif)} libres como pago aparte</span>`;
    else                        estado = `<span class="rc-badge media">Faltan ${money(-dif)}: la última factura queda con saldo</span>`;
  }

  document.getElementById('rcManualInfo').innerHTML = `
    <div><span class="rc-manual-label">Facturas elegidas</span>
         <span class="rc-manual-val">${facts.length} · ${money(totFact)}</span></div>
    <div class="rc-manual-arrow">↔</div>
    <div><span class="rc-manual-label">Pago elegido</span>
         <span class="rc-manual-val">${pago ? `${esc(trunc(pago.originante, 28))} · ${money(libre)}` : '—'}</span></div>
    <div>${estado}</div>`;
  document.getElementById('btnCruzar').disabled = !(facts.length && pago);
}

async function cruzarManual() {
  const facts = lastResult.facturas_pendientes
    .filter(f => selFacturas.includes(f.key))
    .sort((a, b) => selFacturas.indexOf(a.key) - selFacturas.indexOf(b.key));
  const pago = lastResult.pagos_sin_imputar.find(p => p.key === selPago);
  if (!facts.length || !pago) return;

  const totFact = facts.reduce((a, f) => a + Number(f.saldo || 0), 0);
  const dif = Number(pago.libre || 0) - totFact;
  let detalle = `Se imputa el pago de <b>${esc(pago.originante)}</b> (${money(pago.libre)}) ` +
                `contra ${facts.length} factura(s) por ${money(totFact)}.`;
  if (dif > 0.005)  detalle += `\n\nSobran <b>${money(dif)}</b>: quedan como un pago aparte, sin imputar, para cruzarlo después.`;
  if (dif < -0.005) detalle += `\n\nEl pago no alcanza: la última factura queda con saldo de <b>${money(-dif)}</b>.`;
  detalle += '\n\nTodavía no se guarda nada: queda en pantalla hasta “Guardar en base”.';

  const seguir = await ask({ titulo: 'Cruzar a mano', mensaje: detalle,
                             cancel: 'Cancelar', ok: 'Cruzar' });
  if (!seguir) return;

  const previo = manuales.find(m => m.pago === pago.key);
  const keys = facts.map(f => f.key);
  if (previo) keys.forEach(k => { if (!previo.facturas.includes(k)) previo.facturas.push(k); });
  else manuales.push({ pago: pago.key, facturas: keys });
  persist();
  await conciliar();
}

// ── Desarmar cruces ────────────────────────────────────────────────
// Un cruce sin guardar se desarma en pantalla: si era a mano se saca de la
// lista de cruces a mano; si lo armó el sistema, se anota para que no lo
// vuelva a armar. La plata vuelve sola al pago (y a su remanente).
function quitarArista(invKey, payKey) {
  // Se saca de los cruces a mano (si estaba) y se anota como desarmado, así
  // ni el cruce automático ni un cruce a mano viejo lo vuelven a armar.
  // Si después se lo cruza a mano de nuevo, el cruce a mano igual funciona.
  const g = manuales.find(m => m.pago === payKey);
  if (g) g.facturas = g.facturas.filter(k => k !== invKey);
  manuales = manuales.filter(m => m.facturas.length);
  if (!descartados.some(d => d.factura === invKey && d.pago === payKey)) {
    descartados.push({ factura: invKey, pago: payKey });
  }
}

// Desarma UN cruce (una arista).
async function desarmarArista(i) {
  const m = lastResult && lastResult.matches[i];
  if (!m) return;
  if (m.guardado) return desarmarGuardado(m);
  quitarArista(m.factura.key, m.pago.key);
  persist();
  await conciliar();
  toast('↩️ Cruce desarmado: la factura y el pago vuelven a estar libres');
}

// Un cruce ya guardado se desarma en pantalla, de a uno, con confirmación.
// No toca la base en el momento: se saca recién con "Guardar en base", y
// "Cancelar cambios" lo vuelve atrás.
async function desarmarGuardado(m) {
  const seguir = await ask({
    titulo: 'Desarmar un cruce guardado',
    mensaje: `Factura <b>${esc(m.factura.comp)}</b> con el pago de <b>${esc(m.pago.originante)}</b> ` +
             `por ${money(m.monto)}.\n\nLa factura vuelve a pendientes y la plata vuelve al pago.\n\n` +
             `En la base se saca recién al apretar “Guardar en base”. ` +
             `Con “Cancelar cambios” vuelve a quedar como estaba.`,
    cancel: 'Volver',
    ok: 'Desarmar',
  });
  if (!seguir) return;
  if (!aSacar.includes(m.match_id)) aSacar.push(m.match_id);
  quitarArista(m.factura.key, m.pago.key);
  persist();
  await conciliar();
  toast('↩️ Cruce desarmado; se saca de la base al guardar');
}

// Grupos: facturas y pagos unidos por cruces (un pago con varias facturas,
// una factura con varios pagos, o mezcla). Devuelve un número de grupo por
// cada cruce.
function gruposDeCruces(matches) {
  const padre = {};
  const raiz = x => { while (padre[x] !== x) { padre[x] = padre[padre[x]]; x = padre[x]; } return x; };
  const unir = (a, b) => {
    [a, b].forEach(x => { if (!(x in padre)) padre[x] = x; });
    padre[raiz(a)] = raiz(b);
  };
  matches.forEach(m => unir('f:' + m.factura.key, 'p:' + m.pago.key));
  return matches.map(m => raiz('f:' + m.factura.key));
}

// Desarma el grupo entero de un cruce. Lo ya guardado queda: se saca de a uno.
async function desarmarGrupo(i) {
  if (!lastResult) return;
  const grupos = gruposDeCruces(lastResult.matches);
  const g = grupos[i];
  const delGrupo = lastResult.matches.filter((_, j) => grupos[j] === g);
  const libres = delGrupo.filter(m => !m.guardado);
  const guardados = delGrupo.length - libres.length;

  const seguir = await ask({
    titulo: 'Desarmar el grupo entero',
    mensaje: `Se desarman ${libres.length} cruce(s) de este grupo y todo vuelve a quedar sin imputar.` +
             (guardados ? `\n\n${guardados} cruce(s) ya guardado(s) quedan: esos se sacan de a uno.` : ''),
    cancel: 'Cancelar',
    ok: 'Desarmar',
  });
  if (!seguir) return;
  libres.forEach(m => quitarArista(m.factura.key, m.pago.key));
  persist();
  await conciliar();
  toast(`↩️ ${libres.length} cruce(s) desarmado(s)`);
}

// ── Cancelar cambios ───────────────────────────────────────────────
// Vuelve la pantalla a la carga inicial: descarta TODO lo hecho sin guardar
// (cruces a mano, cruces desarmados, lo que se sumó a la pantalla) y vuelve
// a traer de la base lo guardado entre las fechas elegidas. Las fechas no se
// tocan.
async function cancelarCambios() {
  const seguir = await ask({
    titulo: 'Cancelar cambios',
    mensaje: 'Se anulan <b>todas las acciones hechas en esta pantalla</b> que no se guardaron ' +
             'y la pantalla vuelve a la carga inicial, con las mismas fechas.\n\n' +
             'Lo que ya está guardado en la base no se toca.',
    cancel: 'Volver',
    ok: 'Anular todo',
  });
  if (!seguir) return;
  invoices = []; payments = []; lastResult = null;
  manuales = []; descartados = []; aSacar = [];
  limpiarSeleccion(false);
  persist(); renderAll();
  if (dbEnabled) {
    await traerDeLaBase();
  } else {
    showStep(1);
  }
  toast('↩️ Se anularon los cambios: pantalla como en la carga inicial');
}

// ── Guardado al pasar de paso ──────────────────────────────────────
// Facturas y pagos se guardan solos al cambiar de paso, así no se pierden
// si nadie aprieta "Guardar en base". Los cruces NO: esos solo con el botón.
async function guardarDocs() {
  if (!dbEnabled) return;
  const sinGuardar = d => !d._guardado && !d._de_la_base && !d._id_bd;
  const invs = invoices.filter(sinGuardar);
  const pays = payments.filter(sinGuardar);
  if (!invs.length && !pays.length) return;
  try {
    const res = await fetch('/reconciliation/save_docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoices: invs, payments: pays })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    invs.forEach(d => { d._guardado = true; });
    pays.forEach(d => { d._guardado = true; });
    persist();
    toast(`💾 Guardado: ${invs.length} factura(s) y ${pays.length} pago(s)`);
  } catch (e) {
    toast(`❌ No se pudo guardar al pasar de paso: ${e.message}`);
  }
}

// Si quedan cruces sin guardar y se cierra la pestaña, el navegador avisa.
function hayCrucesSinGuardar() {
  return dbEnabled && (aSacar.length > 0 ||
         (!!lastResult && lastResult.matches.some(m => !m.guardado)));
}
window.addEventListener('beforeunload', e => {
  if (!hayCrucesSinGuardar()) return;
  e.preventDefault();
  e.returnValue = '';
});

// ── Guardar en la base ─────────────────────────────────────────────
async function saveToDb() {
  if (!lastResult) { toast('⚠️ Primero hacé una conciliación'); return; }
  const seguir = await ask({
    titulo: 'Guardar en base',
    mensaje: 'Se guardan los cruces de esta pantalla.\n\n' +
             'Las facturas y los pagos ya se fueron guardando al pasar de paso; ' +
             'las facturas cubiertas se registran como pagadas.',
    cancel: 'Cancelar',
    ok: 'Guardar',
  });
  if (!seguir) return;
  trabajando('Guardando en la base…');
  try {
    const res = await fetch('/reconciliation/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoices, payments, result: lastResult, sacar: aSacar })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');
    invoices.forEach(d => { d._guardado = true; });
    payments.forEach(d => { d._guardado = true; });
    manuales = [];   // ya quedaron guardados: vuelven como cruces guardados
    aSacar = [];     // ya se sacaron de la base
    persist();
    toast(`💾 Guardado: ${data.n_matches} cruce(s)` +
          (data.n_sacados ? `, ${data.n_sacados} sacado(s)` : ''));
    loadGroups();
    listo();
    // Vuelve a conciliar: ahora los cruces aparecen como guardados.
    await conciliar({ silencioso: true });
  } catch (e) {
    toast(`❌ ${e.message}`);
  } finally {
    listo();
  }
}

// ── Cartel de "esperá" ─────────────────────────────────────────────
// Tapa la pantalla mientras el servidor trabaja, asi no se aprieta
// dos veces el mismo boton.
function trabajando(texto) {
  document.getElementById('rcBusyText').textContent = texto;
  document.getElementById('rcBusy').hidden = false;
}

function listo() {
  document.getElementById('rcBusy').hidden = true;
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
  else                       hint.textContent = `Conciliado: ${lastResult.resumen.n_matches} cruce(s). Podés cruzar a mano, seguir sumando facturas o pagos y volver a conciliar.`;
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
  const lista = kind === 'invoices' ? invoices : payments;
  const d = lista[i];
  if (d && (d._guardado || d._de_la_base || d._id_bd)) {
    toast('ℹ️ Se quitó de la pantalla; en la base sigue guardado');
  }
  lista.splice(i, 1);
  // Los cruces a mano que usaban ese documento dejan de aplicar solos:
  // el motor ignora lo que ya no está en pantalla.
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

  const grupos = gruposDeCruces(r.matches);
  document.getElementById('matchBody').innerHTML = r.matches.length
    ? r.matches.map((m, i) => {
        const parcial = Math.abs(Number(m.monto) - Number(m.factura.importe)) > 0.005;
        const libresEnGrupo = r.matches.filter((x, j) => grupos[j] === grupos[i] && !x.guardado).length;
        const accion =
          `<div class="rc-acciones">
             <button class="rc-del" title="${m.guardado ? 'Sacar de la base este cruce solo' : 'Desarmar este cruce solo'}"
                     onclick="desarmarArista(${i})">✕</button>
             ${libresEnGrupo > 1
               ? `<button class="rc-del rc-del-grupo" title="Desarmar todo el grupo: todas las facturas y pagos unidos a este cruce"
                          onclick="desarmarGrupo(${i})">⤫ grupo</button>`
               : ''}
           </div>`;
        return `
      <tr>
        <td><span class="rc-badge ${m.confianza}">${label(m.confianza)}</span></td>
        <td class="mono">${esc(m.factura.comp)} · ${esc(m.factura.fecha)}</td>
        <td>${esc(m.factura.cliente)}</td>
        <td class="num">${money(m.monto)}${parcial ? `<div class="rc-sub">de ${money(m.factura.importe)}</div>` : ''}</td>
        <td>${esc(m.pago.banco || '-')} · ${esc(m.pago.originante)} · <span class="mono">${esc(m.pago.fecha)}</span>${m.pago.corregido ? ' <span class="rc-badge media">corregido</span>' : ''}</td>
        <td>${accion}</td>
      </tr>`; }).join('')
    : `<tr><td colspan="6">Sin cruces todavía.</td></tr>`;

  document.getElementById('pendBody').innerHTML = r.facturas_pendientes.length
    ? r.facturas_pendientes.map(f => {
        const sel = selFacturas.includes(f.key);
        const parcial = Number(f.pagado || 0) > 0.005;
        return `
      <tr class="rc-selectable ${sel ? 'sel-inv' : ''}" onclick="toggleFactura('${esc(f.key)}')">
        <td><input type="checkbox" ${sel ? 'checked' : ''} onclick="event.stopPropagation(); toggleFactura('${esc(f.key)}')"></td>
        <td class="mono">${esc(f.comp)}</td><td class="mono">${esc(f.fecha)}</td>
        <td>${esc(f.cliente)}</td>
        <td class="num">${money(f.saldo)}${parcial ? `<div class="rc-sub">de ${money(f.importe)}</div>` : ''}</td>
        <td>${esc(trunc(f.descripcion, 70))}</td>
      </tr>`; }).join('')
    : `<tr><td colspan="6">🎉 No hay facturas pendientes.</td></tr>`;

  document.getElementById('unassBody').innerHTML = r.pagos_sin_imputar.length
    ? r.pagos_sin_imputar.map(p => {
        const sel = selPago === p.key;
        return `
      <tr class="rc-selectable ${sel ? 'sel-pay' : ''} ${p.remanente ? 'remanente' : ''}" onclick="elegirPago('${esc(p.key)}')">
        <td><input type="radio" name="rcPago" ${sel ? 'checked' : ''} onclick="event.stopPropagation(); elegirPago('${esc(p.key)}')"></td>
        <td>${esc(p.banco || '-')}${p.remanente ? ' <span class="rc-badge remanente" title="Lo que sobró de este pago después de un cruce">Remanente</span>' : ''}</td>
        <td class="mono">${esc(p.fecha)}</td>
        <td>${esc(p.originante)}</td>
        <td class="num">${money(p.libre)}${p.remanente ? `<div class="rc-sub">de ${money(p.importe)}</div>` : ''}</td>
        <td>${p.a_cuenta
              ? '<span class="rc-badge cuenta">A cuenta del cliente</span>'
              : '<span class="rc-badge rojo">Sin imputar</span>'}</td>
      </tr>`; }).join('')
    : `<tr><td colspan="6">Todos los pagos quedaron imputados.</td></tr>`;

  renderSeleccion();
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
  const blob = new Blob([JSON.stringify({ invoices, payments, lastResult, manuales, descartados, aSacar }, null, 2)],
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
      manuales = s.manuales || [];
      descartados = s.descartados || [];
      aSacar = s.aSacar || [];
      limpiarSeleccion(false);
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
                 'importe', 'imputado', 'banco_pago', 'fecha_pago', 'originante', 'motivo']];
  const grupoDe = {};
  (lastResult.cuentas_corrientes || []).forEach(c => {
    grupoDe[c.cuit] = c.grupo || 'Sin grupo';
  });
  lastResult.matches.forEach(m => rows.push([
    labelPlano(m.confianza), grupoDe[m.factura.cuit] || 'Sin grupo',
    m.factura.comp, m.factura.fecha, m.factura.cliente,
    m.factura.cuit, numeroCSV(m.factura.importe), numeroCSV(m.monto), m.pago.banco, m.pago.fecha,
    m.pago.originante, m.motivo]));
  lastResult.facturas_pendientes.forEach(f => rows.push([
    'PENDIENTE', grupoDe[f.cuit] || 'Sin grupo', f.comp, f.fecha, f.cliente,
    f.cuit, numeroCSV(f.importe), numeroCSV(f.pagado), '', '', '', '']));
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
  invoices = []; payments = []; lastResult = null; manuales = []; descartados = []; aSacar = [];
  limpiarSeleccion(false);
  sessionStorage.removeItem(SS_KEY);
  renderAll(); showStep(1);
  toast('🧹 Sesión limpia');
}

// ── Steps ──────────────────────────────────────────────────────────
function showStep(n) {
  if (n !== pasoActual && (pasoActual === 1 || pasoActual === 2)) guardarDocs();
  pasoActual = n;
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
  return { alta: '✔ Alta', media: '~ Media', revisar: '⚠ Revisar', manual: '✋ Manual' }[c] || c;
}
// En el Excel el estado va sin simbolos, para poder filtrar por texto.
function labelPlano(c) {
  return { alta: 'Alta', media: 'Media', revisar: 'Revisar', manual: 'Manual' }[c] || c;
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


// ── Traer de la base lo ya guardado ────────────────────────────────
// Suma a la pantalla las facturas y los cobros de un rango de fechas,
// para poder cruzarlos con lo que se esta subiendo ahora. Lo que ya
// estaba en la pantalla no se toca, y lo repetido no se carga dos veces.
async function traerDeLaBase(opciones = {}) {
  const silencioso = opciones.silencioso === true;
  const desde = document.getElementById('dbDesde').value;
  const hasta = document.getElementById('dbHasta').value;
  if (!desde && !hasta) { toast('⚠️ Elegí al menos una fecha'); return; }

  if (!silencioso) trabajando('Buscando lo guardado…');
  try {
    const res = await fetch('/reconciliation/load_from_db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desde, hasta })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');

    let nuevasInv = 0, nuevosPay = 0;
    (data.invoices || []).forEach(d => {
      if (!invoices.some(x => x._hash === d._hash)) { invoices.push(d); nuevasInv++; }
    });
    (data.payments || []).forEach(d => {
      if (!payments.some(x => x._hash === d._hash)) { payments.push(d); nuevosPay++; }
    });

    if (nuevasInv || nuevosPay) { lastResult = null; persist(); renderAll(); }
    if (!silencioso || nuevasInv || nuevosPay) {
      toast(`↓ ${nuevasInv} factura(s) y ${nuevosPay} cobro(s) traídos de la base`);
    }

    // Lo traído se concilia solo: los cruces ya guardados vuelven tal cual y
    // lo que no estaba cruzado se intenta cruzar. Antes quedaba la pantalla
    // en "Todavía no hay conciliación" y parecía que no se había guardado.
    if ((invoices.length || payments.length) && (nuevasInv || nuevosPay || !lastResult)) {
      await conciliar({ silencioso: true });
      if (!silencioso) showStep(3);
    }
  } catch (e) {
    if (!silencioso) toast(`❌ ${e.message}`);
  } finally {
    listo();
  }
}


// ── Fecha en formato argentino ─────────────────────────────────────
// El calendario del navegador muestra el formato del idioma de la
// compu, que a veces es el de Estados Unidos. Por eso la fecha se
// escribe a mano, siempre dd/mm/aaaa, y el sistema la entiende asi.
function formatearFecha(input) {
  const n = (input.value || '').replace(/\D/g, '').slice(0, 8);
  if (n.length <= 2) { input.value = n; return; }
  if (n.length <= 4) { input.value = `${n.slice(0, 2)}/${n.slice(2)}`; return; }
  input.value = `${n.slice(0, 2)}/${n.slice(2, 4)}/${n.slice(4)}`;
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
