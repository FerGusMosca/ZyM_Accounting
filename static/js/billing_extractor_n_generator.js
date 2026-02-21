/**
 * billing_extractor_n_generator.js
 * Handles: xlsx upload → parse → preview table → invoice modal (web render)
 *          → backend PDF generation via /generate_pdf (wkhtmltopdf)
 *          → batch ZIP via /generate_all
 *
 * API change: /generate_pdf now accepts { row, emisor, copy_label }
 * The backend owns the template rendering — JS just shows a live preview.
 */

// ─── State ─────────────────────────────────────────────────────────────────────
const state = {
  rows: [],
  generatedPDFs: {}   // comp_nro → { url, filename }
};

// ─── DOM refs ──────────────────────────────────────────────────────────────────
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

// ─── UI helpers ────────────────────────────────────────────────────────────────
function showStatus(msg, type = 'info') {
  statusMessage.textContent = msg;
  statusMessage.className = `beg-status ${type}`;
  statusMessage.classList.remove('beg-hidden');
}
function hideStatus() { statusMessage.classList.add('beg-hidden'); }

function fmtCurrency(val) {
  if (!val && val !== 0) return '$ 0,00';
  return '$ ' + parseFloat(val).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const comp = String(row.comp_nro || '').toUpperCase();
  return comp.startsWith('EMITIR') || comp === '' || !row.amount;
}

// ─── File Upload ───────────────────────────────────────────────────────────────
selectFileBtn.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('click', e => {
  if (!e.target.closest('button')) fileInput.click();
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

    // Column layout (no header):
    // 0:fecha  1:cuit_cli  2:domicilio_cli  3:nombre_cli  4:desc
    // 5:amount  6:comp_nro  7:cae  8:vencimiento
    state.rows = raw
      .filter(r => r && r[0])
      .map((r, i) => ({
        idx:               i,
        fecha_emision:     fmtDate(r[0]),
        cuit_cliente:      String(r[1] || '').trim(),
        domicilio_cliente: String(r[2] || '').trim(),
        nombre_cliente:    String(r[3] || '').trim(),
        descripcion:       String(r[4] || '').trim(),
        amount:            parseFloat(r[5]) || 0,
        comp_nro:          String(r[6] || '').trim(),
        cae_number:        r[7] ? String(r[7]).replace(/\.0+$/, '').trim() : '',
        vencimiento:       r[8] ? String(r[8]).replace(/VENCIMIENTO\s*/i, '').trim() : ''
      }));

    uploadedFile.textContent = `📄 ${file.name}  (${state.rows.length} filas)`;
    uploadedFile.classList.remove('beg-hidden');
    controlsRow.classList.remove('beg-hidden');
    actionButtons.classList.remove('beg-hidden');
    showStatus(`✅ Archivo cargado: ${state.rows.length} filas detectadas`, 'success');

  } catch (err) {
    showStatus(`❌ Error al leer el archivo: ${err.message}`, 'error');
  }
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
  const s = String(val).trim();
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
    s.onerror = () => reject(new Error('No se pudo cargar XLSX'));
    document.head.appendChild(s);
  });
}

// ─── Preview table ─────────────────────────────────────────────────────────────
previewBtn.addEventListener('click', renderPreviewTable);

function renderPreviewTable() {
  if (!state.rows.length) { showStatus('⚠️ No hay datos cargados.', 'error'); return; }

  previewTableBody.innerHTML = '';
  let validCount = 0;

  state.rows.forEach((row, i) => {
    const skip = isSkippable(row);
    const tr   = document.createElement('tr');
    if (skip) tr.style.opacity = '0.4';

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="beg-comp-nro">${row.comp_nro || '—'}</td>
      <td>${row.fecha_emision || '—'}</td>
      <td>${row.cuit_cliente}</td>
      <td>${row.nombre_cliente}</td>
      <td class="beg-desc ${skip ? 'beg-warn' : ''}" title="${row.descripcion}">${row.descripcion || '(sin descripción)'}</td>
      <td class="beg-amount">${fmtCurrency(row.amount)}</td>
      <td>${row.vencimiento || '—'}</td>
      ${skip
        ? `<td><span style="color:#8B949E;font-size:11px">⏭ omitida</span></td>`
        : `<td><div class="beg-row-actions">
            <button class="beg-btn beg-btn-icon" onclick="previewSingle(${i})" title="Ver">👁</button>
            <button class="beg-btn beg-btn-icon" onclick="generateSingle(${i})" title="PDF">⚡</button>
          </div></td>`
      }
    `;
    previewTableBody.appendChild(tr);
    if (!skip) validCount++;
  });

  invoiceCount.textContent = validCount;
  previewSection.classList.remove('beg-hidden');
  hideStatus();
}

// ─── Web preview (iframe of backend-rendered HTML) ─────────────────────────────
window.previewSingle = async function(idx) {
  const row   = state.rows[idx];
  const emisor = emisorData();

  modalTitle.textContent = `🧾 ${row.comp_nro} — ${row.nombre_cliente}`;
  invoiceRender.innerHTML = '<div style="color:#8B949E;padding:40px;text-align:center">⏳ Cargando preview...</div>';
  invoiceModal.classList.remove('beg-hidden');

  try {
    // Ask backend to render the HTML (uses the template + logo)
    const resp = await fetch('/billing_extractor_n_generator/generate_pdf', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ row, emisor, copy_label: 'ORIGINAL' })
    });

    const contentType = resp.headers.get('content-type') || '';

    if (contentType.includes('application/pdf')) {
      // Backend returned a real PDF → show in an iframe
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      invoiceRender.innerHTML = `<iframe src="${url}" style="width:100%;height:70vh;border:none;border-radius:4px"></iframe>`;
      // Wire download button
      downloadInvBtn.onclick = () => {
        const a = document.createElement('a');
        a.href     = url;
        a.download = `factura_${row.comp_nro.replace(/[^a-z0-9]/gi, '_')}.pdf`;
        a.click();
      };
    } else {
      // Fallback: backend returned HTML (no wkhtmltopdf) → show in iframe via blob
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
    invoiceRender.innerHTML = `<div style="color:#F85149;padding:20px">Error: ${err.message}</div>`;
  }
};

closeModal.addEventListener('click', () => invoiceModal.classList.add('beg-hidden'));
invoiceModal.addEventListener('click', e => { if (e.target === invoiceModal) invoiceModal.classList.add('beg-hidden'); });

// ─── Generate single PDF ───────────────────────────────────────────────────────
window.generateSingle = async function(idx) {
  const row    = state.rows[idx];
  const emisor = emisorData();
  showStatus(`⏳ Generando ${row.comp_nro}...`, 'info');

  const blob = await _fetchPdfBlob(row, emisor);
  if (blob) {
    const filename = `factura_${row.comp_nro.replace(/[^a-z0-9]/gi, '_')}.pdf`;
    const url = URL.createObjectURL(blob);
    state.generatedPDFs[row.comp_nro] = { url, filename };
    triggerDownload(url, filename);
    generatedSection.classList.remove('beg-hidden');
    addToPDFGallery(row, url, filename);
    showStatus(`✅ Factura ${row.comp_nro} descargada`, 'success');
  } else {
    showStatus(`✅ Factura ${row.comp_nro} lista para imprimir`, 'success');
  }
};

async function _fetchPdfBlob(row, emisor, copyLabel = 'ORIGINAL') {
  try {
    const resp = await fetch('/billing_extractor_n_generator/generate_pdf', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ row, emisor, copy_label: copyLabel })
    });

    const contentType = resp.headers.get('content-type') || '';

    if (contentType.includes('application/pdf')) {
      return await resp.blob();
    } else {
      // HTML fallback — open print dialog
      const html = await resp.text();
      const win  = window.open('', '_blank');
      if (win) {
        win.document.write(html);
        win.document.close();
        win.focus();
        setTimeout(() => win.print(), 600);
      }
      return null;
    }
  } catch (err) {
    showStatus(`❌ Error: ${err.message}`, 'error');
    return null;
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}

// ─── Generate all ──────────────────────────────────────────────────────────────
generateAllBtn.addEventListener('click', async () => {
  const valid = state.rows.filter(r => !isSkippable(r));
  if (!valid.length) { showStatus('⚠️ No hay facturas válidas.', 'error'); return; }

  generateAllBtn.classList.add('loading');
  pdfGallery.innerHTML = '';
  generatedSection.classList.remove('beg-hidden');
  const emisor = emisorData();
  let done = 0;

  for (const row of valid) {
    showStatus(`⏳ Generando ${done + 1}/${valid.length}: ${row.comp_nro}...`, 'info');
    const blob = await _fetchPdfBlob(row, emisor);
    if (blob) {
      const filename = `factura_${row.comp_nro.replace(/[^a-z0-9]/gi, '_')}.pdf`;
      const url = URL.createObjectURL(blob);
      state.generatedPDFs[row.comp_nro] = { url, filename };
      addToPDFGallery(row, url, filename);
    } else {
      addToPDFGalleryPrintOnly(row);
    }
    done++;
  }

  generateAllBtn.classList.remove('loading');
  showStatus(`✅ ${done} facturas generadas.`, 'success');
});

// ─── PDF Gallery cards ─────────────────────────────────────────────────────────
function addToPDFGallery(row, url, filename) {
  const card = document.createElement('div');
  card.className = 'beg-pdf-card';
  card.innerHTML = `
    <div class="beg-pdf-card-title">${row.comp_nro}</div>
    <div class="beg-pdf-card-client">${row.nombre_cliente}</div>
    <div class="beg-pdf-card-amount">${fmtCurrency(row.amount)}</div>
    <div class="beg-pdf-card-actions">
      <button class="beg-btn beg-btn-icon" onclick="window.open('${url}','_blank')">👁 Ver</button>
      <a href="${url}" download="${filename}" class="beg-btn beg-btn-icon">⬇️ PDF</a>
    </div>
  `;
  pdfGallery.appendChild(card);
}

function addToPDFGalleryPrintOnly(row) {
  const card = document.createElement('div');
  card.className = 'beg-pdf-card';
  card.innerHTML = `
    <div class="beg-pdf-card-title">${row.comp_nro}</div>
    <div class="beg-pdf-card-client">${row.nombre_cliente}</div>
    <div class="beg-pdf-card-amount">${fmtCurrency(row.amount)}</div>
    <div class="beg-pdf-card-actions">
      <button class="beg-btn beg-btn-icon" onclick="previewSingle(${row.idx})">🖨 Imprimir</button>
    </div>
  `;
  pdfGallery.appendChild(card);
}

// ─── Download all ZIP ──────────────────────────────────────────────────────────
downloadAllBtn.addEventListener('click', async () => {
  const entries = Object.values(state.generatedPDFs);
  if (!entries.length) { showStatus('⚠️ Primero generá las facturas.', 'error'); return; }

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

function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) return resolve();
    const s = document.createElement('script');
    s.src    = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}