// ── State ──────────────────────────────────────────────────────────
let all      = [];
let filtered = [];
let page     = 1;
const PER    = 25;
let sortKey  = 'fecha_emision';
let sortDir  = -1;

// ── Boot ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // FIX #3: fecha Desde = hoy menos 1 mes (antes era el 1ro del mes actual)
  const now   = new Date();
  const from  = new Date(now);
  from.setMonth(from.getMonth() - 1);

  document.getElementById('fFrom').value = iso(from);
  document.getElementById('fTo').value   = iso(now);
  load();
});

// ── Data ───────────────────────────────────────────────────────────
async function load() {
  showLoading();
  const from = document.getElementById('fFrom').value;
  const to   = document.getElementById('fTo').value;
  const qs   = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to)   qs.set('to',   to);
  try {
    const res  = await fetch(`/invoice_history/list?${qs}`);
    const data = await res.json();

    if (data.status === 'not_configured') {
      showMsg('⚙️', 'ARCA no configurado',
        data.message || 'Revisá las variables ARCA_* en el .env');
      document.getElementById('ihCount').textContent = 'Sin configuración';
      return;
    }
    if (data.status !== 'ok') throw new Error(data.message || 'Error del servidor');

    all = data.invoices || [];
    applyFilters();
    toast(`✅ ${all.length} facturas cargadas`, 'ok');
  } catch (e) {
    showMsg('⚠️', 'Error al cargar', e.message);
    document.getElementById('ihCount').textContent = 'Error';
    toast(`❌ ${e.message}`, 'err');
  }
}

// ── Filters ────────────────────────────────────────────────────────
function applyFilters() {
  const comp   = document.getElementById('fComp').value.trim().toLowerCase();
  const cuit   = document.getElementById('fCuit').value.trim().toLowerCase();
  const estado = document.getElementById('fEstado').value;

  filtered = all.filter(inv => {
    if (comp   && !inv.comp_nro?.toLowerCase().includes(comp))     return false;
    if (cuit   && !inv.cuit_cliente?.toLowerCase().includes(cuit)) return false;
    if (estado === 'ok'      && !inv.cae_number) return false;
    if (estado === 'pending' &&  inv.cae_number) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let va = a[sortKey] ?? '', vb = b[sortKey] ?? '';
    if (sortKey === 'amount') { va = +va||0; vb = +vb||0; }
    return va < vb ? -sortDir : va > vb ? sortDir : 0;
  });

  page = 1;
  renderStats();
  renderTable();
  renderPag();
}

function clearFilters() {
  ['fComp','fCuit'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('fEstado').value = '';
  applyFilters();
}

function setSort(key) {
  sortDir = sortKey === key ? sortDir * -1 : -1;
  sortKey = key;
  applyFilters();
}

// ── Stats ──────────────────────────────────────────────────────────
function renderStats() {
  const total  = filtered.length;
  const monto  = filtered.reduce((s,i) => s + (+i.amount||0), 0);
  const sinCae = filtered.filter(i => !i.cae_number).length;
  const clients = new Set(filtered.map(i=>i.cuit_cliente).filter(Boolean)).size;

  document.getElementById('sTotal').textContent    = total;
  document.getElementById('sMonto').textContent    = '$ ' + ar(monto);
  document.getElementById('sSinCAE').textContent   = sinCae;
  document.getElementById('sClientes').textContent = clients;
}

// ── Table ──────────────────────────────────────────────────────────
const COLS = [
  { key:'fecha_emision', label:'Fecha' },
  { key:'comp_nro',      label:'Comprobante' },
  { key:'cuit_cliente',  label:'CUIT Cliente' },
  { key:'amount',        label:'Importe' },
  { key:'cae_number',    label:'CAE' },
  { key:'vencimiento',   label:'Vto. CAE' },
  { key:'_status',       label:'Estado' },
];

function renderTable() {
  const start = (page-1)*PER;
  const slice = filtered.slice(start, start+PER);

  const n = filtered.length;
  document.getElementById('ihCount').innerHTML =
    n === 0
      ? 'Sin resultados'
      : `Mostrando <strong>${start+1}–${Math.min(start+PER,n)}</strong> de <strong>${n}</strong>`;

  if (!n) {
    document.getElementById('ihTableBody').innerHTML = `
      <div class="ih-state">
        <div class="ih-state-icon">🔍</div>
        <div class="ih-state-title">Sin resultados</div>
        <div class="ih-state-sub">No hay facturas con los filtros aplicados.</div>
      </div>`;
    return;
  }

  const th = COLS.map(c => `
    <th onclick="setSort('${c.key}')" class="${sortKey===c.key?'sorted':''}">
      ${c.label}
      <span class="sort-ic">${sortKey===c.key?(sortDir>0?'▲':'▼'):'↕'}</span>
    </th>`).join('') + '<th></th>';

  // FIX #2: serializar el invoice como data-attribute en base64 para evitar
  // problemas de escaping con comillas simples/dobles en JSON inline.
  const rows = slice.map((inv, i) => {
    const hasCae  = !!inv.cae_number;
    const badge = invBadge(inv);
    const caeCell = hasCae
      ? `<span class="td-cae has-cae">${inv.cae_number}</span>`
      : `<span class="td-cae">—</span>`;

    // Encode invoice data safely to avoid inline-JSON escaping issues
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(inv))));

    return `
    <tr style="animation-delay:${i*.025}s" data-inv="${encoded}" onclick="openDrawerEncoded(this)">
      <td class="td-mono">${inv.fecha_emision||'—'}</td>
      <td class="td-mono">${inv.comp_nro||'—'}</td>
      <td class="td-mono" style="color:#8B949E">${inv.cuit_cliente||'—'}</td>
      <td class="td-amount">$ ${ar(+inv.amount||0)}</td>
      <td>${caeCell}</td>
      <td class="td-mono" style="color:#8B949E;font-size:11px">${inv.vencimiento||'—'}</td>
      <td>${badge}</td>
      <td>
        <button class="btn btn-ghost btn-sm"
          onclick="event.stopPropagation(); openDrawerEncoded(this.closest('tr'))">→</button>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('ihTableBody').innerHTML =
    `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
}

// FIX #2: leer el invoice desde el data-attribute para evitar errores de parsing
function openDrawerEncoded(tr) {
  try {
    const encoded = tr.getAttribute('data-inv');
    const inv     = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    openDrawer(inv);
  } catch (e) {
    toast('❌ Error al abrir detalle: ' + e.message, 'err');
    console.error('openDrawerEncoded error:', e);
  }
}

// ── Pagination ─────────────────────────────────────────────────────
function renderPag() {
  const total = Math.ceil(filtered.length / PER);
  if (total <= 1) { document.getElementById('ihPag').innerHTML=''; return; }
  let h = `<button class="pg-btn" onclick="goPage(${page-1})" ${page===1?'disabled':''}>‹</button>`;
  for (let p=1; p<=total; p++) {
    if (p===1||p===total||Math.abs(p-page)<=1)
      h += `<button class="pg-btn ${p===page?'active':''}" onclick="goPage(${p})">${p}</button>`;
    else if (Math.abs(p-page)===2)
      h += `<span style="color:#484F58;padding:0 3px">…</span>`;
  }
  h += `<button class="pg-btn" onclick="goPage(${page+1})" ${page===total?'disabled':''}>›</button>`;
  document.getElementById('ihPag').innerHTML = h;
}

function goPage(p) {
  const total = Math.ceil(filtered.length / PER);
  if (p<1||p>total) return;
  page = p;
  renderTable();
  renderPag();
  document.querySelector('.ih-table-box').scrollIntoView({behavior:'smooth',block:'start'});
}

// ── Drawer ─────────────────────────────────────────────────────────
function openDrawer(inv) {
  document.getElementById('drawerTitle').textContent = inv.comp_nro || 'Detalle';
  const hasCae = !!inv.cae_number;

  // FIX #1: mostrar claramente si tiene o no CAE, con nota explicativa
  // cuando no tiene CAE a pesar de haber sido enviada a ARCA.
  const badge = invBadge(inv);

  const caeNote = !hasCae
    ? `<div class="drow" style="background:rgba(210,153,34,.07)">
         <span class="dkey" style="color:#D29922">ℹ️ Nota</span>
         <span class="dval" style="color:#D29922;font-family:'Outfit',sans-serif;font-size:11px;line-height:1.5">
           Esta factura fue registrada en ARCA pero el CAE no fue almacenado localmente.
           El CAE real puede consultarse directamente en el portal de AFIP.
         </span>
       </div>`
    : '';

  document.getElementById('drawerBody').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span class="td-mono" style="font-size:1rem;color:#E6EDF3">${inv.comp_nro||'—'}</span>
      ${badge}
    </div>

    <div class="dsec">
      <div class="dsec-ttl">Comprobante</div>
      <div class="drow"><span class="dkey">Punto de venta</span><span class="dval">${inv.punto_venta||'—'}</span></div>
      <div class="drow"><span class="dkey">Nro. factura</span><span class="dval">${inv.invoice_number||'—'}</span></div>
      <div class="drow"><span class="dkey">Fecha emisión</span><span class="dval">${inv.fecha_emision||'—'}</span></div>
      <div class="drow"><span class="dkey">Importe</span><span class="dval green">$ ${ar(+inv.amount||0)}</span></div>
    </div>

    <div class="dsec">
      <div class="dsec-ttl">Cliente</div>
      <div class="drow"><span class="dkey">CUIT</span><span class="dval">${inv.cuit_cliente||'—'}</span></div>
      ${inv.razon_social_cliente
        ? `<div class="drow"><span class="dkey">Razón social</span><span class="dval" style="font-family:'Outfit',sans-serif">${inv.razon_social_cliente}</span></div>`
        : `<div class="drow"><span class="dkey">Razón social</span><span class="dval" style="color:#484F58;font-family:'Outfit',sans-serif">No disponible en AFIP</span></div>`}
    </div>

    <div class="dsec">
      <div class="dsec-ttl">AFIP / ARCA</div>
      <div class="drow"><span class="dkey">CAE</span><span class="dval blue">${inv.cae_number||'—'}</span></div>
      <div class="drow"><span class="dkey">Vto. CAE</span><span class="dval">${inv.vencimiento||'—'}</span></div>
      <div class="drow"><span class="dkey">Resultado</span><span class="dval">${inv.resultado||'—'}</span></div>
      ${caeNote}
    </div>
  `;

  document.getElementById('overlay').classList.add('open');
  document.getElementById('drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('drawer').classList.remove('open');
}

document.addEventListener('keydown', e => { if (e.key==='Escape') closeDrawer(); });

// ── CSV Export ─────────────────────────────────────────────────────
function exportCSV() {
  if (!filtered.length) { toast('Sin datos para exportar', 'err'); return; }
  const cols = ['fecha_emision','comp_nro','cuit_cliente','amount','cae_number','vencimiento','resultado'];
  const hdr  = cols.join(',');
  const rows = filtered.map(inv =>
    cols.map(c=>`"${(inv[c]??'').toString().replace(/"/g,'""')}"`).join(',')
  );
  const blob = new Blob([hdr+'\n'+rows.join('\n')], {type:'text/csv;charset=utf-8;'});
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `facturas_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('✅ CSV exportado', 'ok');
}

function invBadge(inv) {
  if (inv.cae_number)  return `<span class="badge ok">✓ Con CAE</span>`;
  if (inv.homo_no_cae) return `<span class="badge homo">🧪 Homo OK</span>`;
  return `<span class="badge pending">⏳ Sin CAE</span>`;
}

// ── UI helpers ─────────────────────────────────────────────────────
function showLoading() {
  document.getElementById('ihTableBody').innerHTML = `
    <div class="ih-state">
      <div class="spinner"></div>
      <div class="ih-state-title">Consultando AFIP…</div>
      <div class="ih-state-sub">Puede tomar unos segundos dependiendo del volumen.</div>
    </div>`;
  document.getElementById('ihCount').textContent = 'Cargando…';
  document.getElementById('ihPag').innerHTML = '';
}

function showMsg(icon, title, sub) {
  document.getElementById('ihTableBody').innerHTML = `
    <div class="ih-state">
      <div class="ih-state-icon">${icon}</div>
      <div class="ih-state-title">${title}</div>
      <div class="ih-state-sub">${sub}</div>
    </div>`;
}

function ar(v) {
  return v.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
}

function iso(d) { return d.toISOString().slice(0,10); }

function toast(msg, type='ok') {
  const c  = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(()=>el.remove(), 4200);
}