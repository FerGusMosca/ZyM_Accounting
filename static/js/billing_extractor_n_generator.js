/**
 * billing_extractor_n_generator.js
 *
 * Fixes v2:
 * #1 - generateSingle: no abre modal, agrega card directo abajo
 * #2 - Logo "ZyM Accounting" en navbar lleva a /
 * #3 - Filas de la tabla se marcan con badge ✅ generada / ❌ error
 * #4 - "Generar Todas" itera con log en consola ARCA, sin abrir PDFs
 * #5 - Botón "Ver" agregado en cards print-only
 */

// ─── Estado ────────────────────────────────────────────────────────────────────
const state = {
  rows:          [],
  generatedPDFs: {},   // comp_nro → { url, filename }
  rowStatus:     {},   // comp_nro → 'ok' | 'error'  (PDF generation)
  arcaStatus:    {}    // comp_nro → 'ok' | 'error'  (ARCA registration)
};

// ─── Refs al DOM ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const fileInput        = $('fileInput');
const selectFileBtn    = $('selectFileBtn');
const uploadZone       = $('uploadZone');
const uploadedFile     = $('uploadedFile');
const controlsRow      = $('controlsRow');
const actionButtons    = $('actionButtons');
const previewBtn       = $('previewBtn');
const generateAllBtn   = $('generateAllBtn');
const statusMessage    = $('statusMessage');
const previewSection   = $('previewSection');
const previewTableBody = $('previewTableBody');
const invoiceCount     = $('invoiceCount');
const generatedSection = $('generatedSection');
const pdfGallery       = $('pdfGallery');
const downloadAllBtn   = $('downloadAllBtn');
const invoiceModal     = $('invoiceModal');
const closeModal       = $('closeModal');
const invoiceRender    = $('invoiceRender');
const modalTitle       = $('modalTitle');
const downloadInvBtn   = $('downloadInvoiceBtn');

// ─── FIX #2: Logo lleva a / ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Buscar el texto "ZyM Accounting" en el navbar y hacerlo clickeable
  document.querySelectorAll('nav a, .navbar a, a').forEach(a => {
    if (a.textContent.includes('Inicio')) return; // ya tiene link
  });
  // Por si el navbar tiene el texto directo (no en <a>)
  document.querySelectorAll('.navbar, nav').forEach(nav => {
    nav.style.cursor = 'pointer';
    // Solo si no hay ya un link de inicio
    if (!nav.querySelector('a[href="/"]')) {
      const brand = nav.querySelector('.dash-brand, .brand');
      if (brand) {
        brand.style.cursor = 'pointer';
        brand.addEventListener('click', () => window.location.href = '/');
      }
    }
  });
});

// ─── Helpers de UI ─────────────────────────────────────────────────────────────
function showStatus(msg, type = 'info', list = []) {
  let html = msg;
  if (list.length) {
    html += '<ul class="beg-status-list">' +
      list.map(item => `<li>${item}</li>`).join('') +
      '</ul>';
  }
  statusMessage.innerHTML = html;
  statusMessage.className = `beg-status ${type}`;
  statusMessage.classList.remove('beg-hidden');
}

function hideStatus() { statusMessage.classList.add('beg-hidden'); }

function fmtCurrency(val) {
  if (!val && val !== 0) return '$ 0,00';
  return '$ ' + parseFloat(val).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function emisorData() {
  return {
    razon_social: $('inputEmisor').value.trim(),
    cuit:         $('inputCuit').value.trim(),
    domicilio:    $('inputDomicilio').value.trim(),
    ib:           $('inputIB').value.trim(),
    inicio_act:   $('inputInicioAct').value.trim(),
    cond_iva:     $('inputCondIVA').value
  };
}

function isSkippable(row) {
  const comp = String(row.comp_nro || '').toUpperCase().trim();
  if (!comp)                           return [true, 'Comp. Nro vacío'];
  if (comp.startsWith('EMITIR'))       return [true, `Pendiente: ${row.comp_nro}`];
  if (!row.amount || row.amount === 0) return [true, 'Importe cero o vacío'];
  if (!row.razon_social_cliente)       return [true, 'Sin razón social del cliente'];
  return [false, ''];
}

// ─── Status dots: PDF y ARCA separados ────────────────────────────────────────
function markRowStatus(compNro, status) {
  state.rowStatus[compNro] = status;
  const cell = document.querySelector(`[data-pdf-cell="${compNro}"]`);
  if (!cell) return;
  if (status === 'loading') {
    cell.innerHTML = `<span class="row-status-dot row-status-loading"></span>`;
  } else if (status === 'ok') {
    cell.innerHTML = `<span class="row-status-dot row-status-ok" title="PDF generado"></span>`;
  } else if (status === 'error') {
    cell.innerHTML = `<span class="row-status-dot row-status-error" title="Error al generar"></span>`;
  }
}

function markArcaStatus(compNro, status) {
  state.arcaStatus[compNro] = status;
  const cell = document.querySelector(`[data-arca-cell="${compNro}"]`);
  if (!cell) return;
  if (status === 'loading') {
    cell.innerHTML = `<span class="row-status-dot row-status-loading"></span>`;
  } else if (status === 'ok') {
    cell.innerHTML = `<span class="row-status-dot row-status-ok" title="CAE obtenido"></span>`;
  } else if (status === 'error') {
    cell.innerHTML = `<span class="row-status-dot row-status-error" title="Error ARCA"></span>`;
  }
}

// ─── Carga inicial de settings del emisor ─────────────────────────────────────
async function loadEmisorSettings() {
  try {
    const resp = await fetch('/billing_extractor_n_generator/emisor_settings');
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.status !== 'ok') return;

    if (data.razon_social) $('inputEmisor').value   = data.razon_social;
    if (data.cuit)         $('inputCuit').value      = data.cuit;
    if (data.domicilio)    $('inputDomicilio').value = data.domicilio;
    if (data.ib)           $('inputIB').value        = data.ib;
    if (data.inicio_act)   $('inputInicioAct').value = data.inicio_act;

    if (data.cond_iva) {
      const sel = $('inputCondIVA');
      for (const opt of sel.options) {
        if (opt.value === data.cond_iva) { opt.selected = true; break; }
      }
    }
    $('inputCondIVA').disabled = true;
  } catch (e) {
    console.warn('No se pudieron cargar los settings del emisor:', e);
  }
}

loadEmisorSettings();

// ─── Carga del archivo ─────────────────────────────────────────────────────────
selectFileBtn.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('click', e => {
  if (!e.target.closest('button') && !e.target.closest('a')) fileInput.click();
});
uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) processFile(fileInput.files[0]); });

async function processFile(file) {
  if (!file.name.match(/\.xlsx?$/i)) {
    showStatus('❌ Solo se admiten archivos Excel (.xlsx / .xls)', 'error');
    return;
  }
  showStatus('⏳ Leyendo archivo Excel...', 'info');

  try {
    const data = await file.arrayBuffer();
    await loadXLSX();
    const wb  = XLSX.read(data, { type: 'array', cellDates: true });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    state.rows = raw
      .filter(r => r && r[0])
      .map((r, i) => ({
        idx:                   i,
        fecha_emision:         fmtDate(r[0]),
        cuit_cliente:          cleanStr(r[1]),
        razon_social_cliente:  cleanStr(r[2]),
        domicilio_cliente:     cleanStr(r[3]),
        nombre_contacto:       cleanStr(r[4]),
        descripcion:           cleanStr(r[5]),
        amount:                parseFloat(r[6]) || 0,
        comp_nro:              cleanStr(r[7]),
        cae_number:            r[8] ? String(r[8]).replace(/\.0+$/, '').trim() : '',
        vencimiento:           r[9] ? String(r[9]).replace(/VENCIMIENTO\s*/i, '').trim() : ''
      }));

    // Reset statuses on new file
    state.rowStatus     = {};
    state.arcaStatus    = {};
    state.generatedPDFs = {};

    const validCount = state.rows.filter(r => !isSkippable(r)[0]).length;
    uploadedFile.textContent = `📄 ${file.name}  (${state.rows.length} filas · ${validCount} válidas)`;
    uploadedFile.classList.remove('beg-hidden');
    controlsRow.classList.remove('beg-hidden');
    actionButtons.classList.remove('beg-hidden');
    showStatus(
      `✅ Archivo cargado: <strong>${state.rows.length}</strong> filas detectadas, ` +
      `<strong>${validCount}</strong> listas para generar.`,
      'success'
    );
  } catch (err) {
    showStatus(`❌ Error al leer el archivo: ${err.message}`, 'error');
  }
}

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function fmtDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return [
      String(val.getDate()).padStart(2, '0'),
      String(val.getMonth() + 1).padStart(2, '0'),
      val.getFullYear()
    ].join('/');
  }
  const s   = String(val).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s.split(' ')[0];
}

function loadXLSX() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar la librería XLSX'));
    document.head.appendChild(s);
  });
}

// ─── Tabla de vista previa ──────────────────────────────────────────────────────
previewBtn.addEventListener('click', renderPreviewTable);

function renderPreviewTable() {
  if (!state.rows.length) {
    showStatus('⚠️ No hay datos cargados.', 'error');
    return;
  }

  previewTableBody.innerHTML = '';
  let validCount = 0;

  state.rows.forEach((row, i) => {
    const [skip, motivo] = isSkippable(row);
    const tr = document.createElement('tr');
    if (skip) tr.style.opacity = '0.4';

    // Restaurar estado visual si ya fue generada antes
    const prevStatus = state.rowStatus[row.comp_nro];
    if (prevStatus === 'ok')    tr.style.background = 'rgba(63,185,80,.06)';
    if (prevStatus === 'error') tr.style.background = 'rgba(248,81,73,.06)';

    // Status dots: PDF y ARCA en columnas separadas
    let statusDot = '';
    if (!skip) {
      const pdfStatus  = state.rowStatus[row.comp_nro];
      const arcaStatus = state.arcaStatus[row.comp_nro];
      const pdfClass   = pdfStatus  === 'ok' ? 'row-status-ok'  : pdfStatus  === 'error' ? 'row-status-error'  : '';
      const arcaClass  = arcaStatus === 'ok' ? 'row-status-ok'  : arcaStatus === 'error' ? 'row-status-error' : '';
      statusDot = `
        <td style="text-align:center;width:36px">
          <span class="row-status-dot ${pdfClass}" data-pdf-cell="${row.comp_nro}" title="PDF"></span>
        </td>
        <td style="text-align:center;width:36px">
          <span class="row-status-dot ${arcaClass}" data-arca-cell="${row.comp_nro}" title="ARCA"></span>
        </td>`;
    } else {
      statusDot = `<td></td><td></td>`;
    }

    const actionsCell = skip
      ? `<td><span style="color:#8B949E;font-size:11px">omitida</span></td>`
      : `<td><div class="beg-row-actions">
          <button class="beg-btn beg-btn-icon" onclick="previewSingle(${i})" title="Ver factura">👁</button>
          <button class="beg-btn beg-btn-icon" onclick="generateSingle(${i})" title="Generar PDF">⚡</button>
          <button class="beg-btn beg-btn-arca" onclick="registrarEnArca(${i})" title="Registrar en ARCA">🏛</button>
        </div></td>`;

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="beg-comp-nro">${row.comp_nro || '—'}</td>
      <td>${row.fecha_emision || '—'}</td>
      <td>${row.cuit_cliente}</td>
      <td>${row.razon_social_cliente || '—'}</td>
      <td class="beg-desc ${skip ? 'beg-warn' : ''}" title="${row.descripcion}">
        ${skip ? `⏭ ${motivo}` : (row.descripcion || '(sin descripción)')}
      </td>
      <td class="beg-amount">${fmtCurrency(row.amount)}</td>
      <td>${row.vencimiento || '—'}</td>
      ${statusDot}
      ${actionsCell}
    `;
    previewTableBody.appendChild(tr);
    if (!skip) validCount++;
  });

  invoiceCount.textContent = validCount;
  previewSection.classList.remove('beg-hidden');
  hideStatus();
}

// ─── Vista previa individual — abre modal (botón 👁) ───────────────────────────
window.previewSingle = async function(idx) {
  const row    = state.rows[idx];
  const emisor = emisorData();

  modalTitle.textContent = `🧾 ${row.comp_nro} — ${row.razon_social_cliente}`;
  invoiceRender.innerHTML = '<div style="color:#8B949E;padding:40px;text-align:center">⏳ Cargando vista previa...</div>';
  invoiceModal.classList.remove('beg-hidden');

  try {
    const resp = await fetch('/billing_extractor_n_generator/generate_pdf', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ row, emisor, copy_label: 'ORIGINAL' })
    });

    const contentType = resp.headers.get('content-type') || '';

    if (contentType.includes('application/pdf')) {
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      invoiceRender.innerHTML = `<iframe src="${url}" style="width:100%;height:70vh;border:none;border-radius:4px"></iframe>`;
      downloadInvBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `factura_${row.comp_nro.replace(/[^a-z0-9]/gi, '_')}.pdf`;
        a.click();
      };
    } else {
      const html = await resp.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url  = URL.createObjectURL(blob);
      invoiceRender.innerHTML = `<iframe src="${url}" style="width:100%;height:70vh;border:none;border-radius:4px"></iframe>`;
      downloadInvBtn.textContent = '🖨 Imprimir / Guardar PDF';
      downloadInvBtn.onclick = () => {
        const win = window.open(url, '_blank');
        if (win) { win.focus(); setTimeout(() => win.print(), 800); }
      };
    }
  } catch (err) {
    invoiceRender.innerHTML = `<div style="color:#F85149;padding:20px">❌ Error: ${err.message}</div>`;
  }
};

closeModal.addEventListener('click', () => invoiceModal.classList.add('beg-hidden'));
invoiceModal.addEventListener('click', e => { if (e.target === invoiceModal) invoiceModal.classList.add('beg-hidden'); });

// ─── FIX #1: Generar PDF individual — NO abre modal, agrega card abajo ─────────
window.generateSingle = async function(idx) {
  const row    = state.rows[idx];
  const emisor = emisorData();

  // Asegurar que la tabla esté visible para poder pintar el dot
  if (previewSection.classList.contains('beg-hidden')) {
    renderPreviewTable();
  }
  markRowStatus(row.comp_nro, 'loading');

  try {
    const resp = await fetch('/billing_extractor_n_generator/generate_pdf', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ row, emisor, copy_label: 'ORIGINAL' })
    });

    const contentType = resp.headers.get('content-type') || '';

    if (contentType.includes('application/pdf')) {
      const blob     = await resp.blob();
      const filename = `factura_${row.comp_nro.replace(/[^a-z0-9]/gi, '_')}.pdf`;
      const url      = URL.createObjectURL(blob);
      state.generatedPDFs[row.comp_nro] = { url, filename };

      generatedSection.classList.remove('beg-hidden');
      // Reemplazar card si ya existe, o agregar nueva
      const existingCard = document.querySelector(`[data-card="${row.comp_nro}"]`);
      if (existingCard) existingCard.remove();
      addToPDFGallery(row, url, filename);
      markRowStatus(row.comp_nro, 'ok');

    } else {
      // Sin wkhtmltopdf: guardar HTML para imprimir
      const html = await resp.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url  = URL.createObjectURL(blob);
      state.generatedPDFs[row.comp_nro] = { url, filename: `factura_${row.comp_nro}.html` };

      generatedSection.classList.remove('beg-hidden');
      const existingCard = document.querySelector(`[data-card="${row.comp_nro}"]`);
      if (existingCard) existingCard.remove();
      addToPDFGalleryPrintOnly(row, url);
      markRowStatus(row.comp_nro, 'ok');
    }
  } catch (err) {
    markRowStatus(row.comp_nro, 'error');
    showStatus(`❌ Error generando ${row.comp_nro}: ${err.message}`, 'error');
  }
};

async function _fetchPdfBlob(row, emisor) {
  const resp = await fetch('/billing_extractor_n_generator/generate_pdf', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ row, emisor, copy_label: 'ORIGINAL' })
  });
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/pdf')) {
    return { type: 'pdf', blob: await resp.blob() };
  } else {
    return { type: 'html', text: await resp.text() };
  }
}

// ─── FIX #4: Generar todas — itera con consola ARCA, sin abrir PDFs ────────────
generateAllBtn.addEventListener('click', async () => {
  const validRows = state.rows.filter(r => !isSkippable(r)[0]);

  if (!validRows.length) {
    const motivos = state.rows.map(r => {
      const [, mot] = isSkippable(r);
      const comp = r.comp_nro || `fila ${r.idx + 1}`;
      return mot ? `<strong>${comp}:</strong> ${mot}` : null;
    }).filter(Boolean);
    showStatus('⚠️ No hay facturas válidas para generar.', 'error', motivos);
    return;
  }

  generateAllBtn.classList.add('loading');
  pdfGallery.innerHTML = '';
  generatedSection.classList.remove('beg-hidden');

  // Asegurar que la tabla esté visible para poder pintar los dots
  if (previewSection.classList.contains('beg-hidden')) {
    renderPreviewTable();
  }
  arcaConsoleOpen('Generación masiva');

  const emisor = emisorData();
  let done = 0, errors = 0;

  for (const row of validRows) {
    arcaLog(`── Generando ${row.comp_nro} (${done + 1}/${validRows.length})…`);
    markRowStatus(row.comp_nro, 'loading');

    try {
      const result = await _fetchPdfBlob(row, emisor);

      if (result.type === 'pdf') {
        const filename = `factura_${row.comp_nro.replace(/[^a-z0-9]/gi, '_')}.pdf`;
        const url      = URL.createObjectURL(result.blob);
        state.generatedPDFs[row.comp_nro] = { url, filename };
        addToPDFGallery(row, url, filename);
        markRowStatus(row.comp_nro, 'ok');
        arcaLog(`✅ ${row.comp_nro} — OK  ($ ${row.amount.toLocaleString('es-AR')})`);
      } else {
        const blob = new Blob([result.text], { type: 'text/html' });
        const url  = URL.createObjectURL(blob);
        state.generatedPDFs[row.comp_nro] = { url, filename: `factura_${row.comp_nro}.html` };
        addToPDFGalleryPrintOnly(row, url);
        markRowStatus(row.comp_nro, 'ok');
        arcaLog(`✅ ${row.comp_nro} — HTML (sin wkhtmltopdf)`);
      }
      done++;
    } catch (err) {
      errors++;
      markRowStatus(row.comp_nro, 'error');
      arcaLog(`❌ ${row.comp_nro} — Error: ${err.message}`);
    }
  }

  generateAllBtn.classList.remove('loading');
  arcaLog('');
  arcaLog(`── Completado: ${done} generadas, ${errors} errores ──`);
  showStatus(
    `✅ ${done} factura${done !== 1 ? 's' : ''} generada${done !== 1 ? 's' : ''}` +
    (errors ? ` · <span style="color:#F85149">❌ ${errors} con error</span>` : ''),
    done > 0 ? 'success' : 'error'
  );
});

// ─── Tarjetas de la galería de PDFs ────────────────────────────────────────────
function addToPDFGallery(row, url, filename) {
  const card = document.createElement('div');
  card.className = 'beg-pdf-card';
  card.setAttribute('data-card', row.comp_nro);
  card.innerHTML = `
    <div class="beg-pdf-card-title">${row.comp_nro}</div>
    <div class="beg-pdf-card-client">${row.razon_social_cliente}</div>
    <div class="beg-pdf-card-amount">${fmtCurrency(row.amount)}</div>
    <div class="beg-pdf-card-actions">
      <button class="beg-btn beg-btn-icon" onclick="window.open('${url}','_blank')">👁 Ver</button>
      <a href="${url}" download="${filename}" class="beg-btn beg-btn-icon">⬇️ PDF</a>
      <button class="beg-btn beg-btn-arca" onclick="registrarEnArca(${row.idx})">🏛 ARCA</button>
    </div>
  `;
  pdfGallery.appendChild(card);
}

// FIX #5: agregar botón Ver en cards print-only
function addToPDFGalleryPrintOnly(row, url) {
  const card = document.createElement('div');
  card.className = 'beg-pdf-card';
  card.setAttribute('data-card', row.comp_nro);
  card.innerHTML = `
    <div class="beg-pdf-card-title">${row.comp_nro}</div>
    <div class="beg-pdf-card-client">${row.razon_social_cliente}</div>
    <div class="beg-pdf-card-amount">${fmtCurrency(row.amount)}</div>
    <div class="beg-pdf-card-actions">
      <button class="beg-btn beg-btn-icon" onclick="window.open('${url}','_blank')">👁 Ver</button>
      <button class="beg-btn beg-btn-icon" onclick="previewSingle(${row.idx})">🖨 Imprimir</button>
      <button class="beg-btn beg-btn-arca" onclick="registrarEnArca(${row.idx})">🏛 ARCA</button>
    </div>
  `;
  pdfGallery.appendChild(card);
}

// ─── Descargar ZIP ─────────────────────────────────────────────────────────────
downloadAllBtn.addEventListener('click', async () => {
  const entries = Object.values(state.generatedPDFs);
  if (!entries.length) {
    showStatus('⚠️ Primero generá las facturas.', 'error');
    return;
  }
  try {
    await loadJSZip();
    const zip = new JSZip();
    for (const { url, filename } of entries) {
      const resp = await fetch(url);
      const blob = await resp.blob();
      zip.file(filename, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(URL.createObjectURL(zipBlob), 'facturas.zip');
  } catch {
    showStatus('⚠️ No se pudo generar el ZIP. Descargá cada factura individualmente.', 'error');
  }
});

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}

function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) return resolve();
    const s = document.createElement('script');
    s.src     = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ─── ARCA: Registrar factura ────────────────────────────────────────────────────
window.registrarEnArca = async function(idx) {
  const row = state.rows[idx];
  arcaConsoleOpen(row.comp_nro);
  arcaLog('⏳ Iniciando comunicación con ARCA/AFIP...');

  try {
    const resp = await fetch('/billing_extractor_n_generator/registrar_arca', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ row })
    });
    const data = await resp.json();

    (data.log || []).forEach(line => arcaLog(line));

    if (data.status === 'ok') {
      markArcaStatus(row.comp_nro, 'ok');
      arcaLog('');
      arcaLog('✅ ¡Factura registrada en AFIP!');
      arcaLog(`   CAE:      ${data.cae}`);
      arcaLog(`   Vto CAE:  ${data.cae_vto}`);
      arcaLog(`   Cbte Nro: ${data.cbte_nro}`);
      state.rows[idx].cae_number  = data.cae;
      state.rows[idx].vencimiento = data.cae_vto;
    } else if (data.status === 'not_configured') {
      arcaLog('⚠️  ARCA no configurado en este ambiente.');
      arcaLog(`   ${data.error || ''}`);
    } else {
      markArcaStatus(row.comp_nro, 'error');
      arcaLog(`❌ Error: ${data.error || 'desconocido'}`);
    }
  } catch (err) {
    arcaLog(`❌ Error de red: ${err.message}`);
  }
};

// ─── Consola de debug ARCA ─────────────────────────────────────────────────────
function arcaConsoleOpen(title) {
  let panel = $('arcaConsolePanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'arcaConsolePanel';
    panel.className = 'beg-arca-console';
    panel.innerHTML = `
      <div class="beg-arca-console-header">
        <span id="arcaConsoleTitle">🔌 Consola ARCA</span>
        <button onclick="document.getElementById('arcaConsolePanel').classList.add('beg-hidden')"
                style="background:none;border:none;color:#8B949E;cursor:pointer;font-size:16px">✕</button>
      </div>
      <div id="arcaConsoleBody" class="beg-arca-console-body"></div>
    `;
    document.body.appendChild(panel);
  }
  $('arcaConsoleTitle').textContent = `🔌 ARCA — ${title}`;
  // En "Generar Todas" NO limpiar la consola entre iteraciones (title = 'Generación masiva')
  if (title !== 'Generación masiva') {
    $('arcaConsoleBody').innerHTML = '';
  }
  panel.classList.remove('beg-hidden');
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);
}

function arcaLog(line) {
  const body = $('arcaConsoleBody');
  if (!body) return;
  const el = document.createElement('div');
  el.className = 'beg-arca-line';
  if (line.startsWith('✅'))      el.style.color = '#3FB950';
  else if (line.startsWith('❌')) el.style.color = '#F85149';
  else if (line.startsWith('⚠️')) el.style.color = '#D29922';
  else if (line.startsWith('──')) el.style.color = '#58A6FF';
  else                             el.style.color = '#C9D1D9';
  el.textContent = line;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}