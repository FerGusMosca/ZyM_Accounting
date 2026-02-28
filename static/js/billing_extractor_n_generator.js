/**
 * billing_extractor_n_generator.js
 *
 * Cambios respecto a versión anterior:
 * - Carga datos del emisor desde /emisor_settings (pre-rellena y bloquea IVA)
 * - Nuevo mapeo de columnas del xlsx v2 (razon_social en col 2, domicilio en col 3)
 * - Mensajes de error descriptivos al no encontrar filas válidas
 * - Botón "Descargar Excel modelo" en la zona de carga
 * - Todo el texto de la UI en español
 */

// ─── Estado ────────────────────────────────────────────────────────────────────
const state = {
  rows: [],
  generatedPDFs: {}  // comp_nro → { url, filename }
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
  if (!comp)                    return [true, 'Comp. Nro vacío'];
  if (comp.startsWith('EMITIR'))return [true, `Pendiente: ${row.comp_nro}`];
  if (!row.amount || row.amount === 0) return [true, 'Importe cero o vacío'];
  if (!row.razon_social_cliente)       return [true, 'Sin razón social del cliente'];
  return [false, ''];
}

// ─── Carga inicial de settings del emisor ─────────────────────────────────────
async function loadEmisorSettings() {
  try {
    const resp = await fetch('/billing_extractor_n_generator/emisor_settings');
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.status !== 'ok') return;

    // Pre-cargar campos
    if (data.razon_social) $('inputEmisor').value    = data.razon_social;
    if (data.cuit)         $('inputCuit').value       = data.cuit;
    if (data.domicilio)    $('inputDomicilio').value  = data.domicilio;
    if (data.ib)           $('inputIB').value         = data.ib;
    if (data.inicio_act)   $('inputInicioAct').value  = data.inicio_act;

    // Condición IVA: seleccionar la opción correcta y bloquear el campo
    if (data.cond_iva) {
      const sel = $('inputCondIVA');
      for (const opt of sel.options) {
        if (opt.value === data.cond_iva) {
          opt.selected = true;
          break;
        }
      }
    }
    // El campo ya está disabled en el HTML; nos aseguramos
    $('inputCondIVA').disabled = true;

  } catch (e) {
    console.warn('No se pudieron cargar los settings del emisor:', e);
  }
}

// Cargar settings al iniciar la página
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

    /**
     * Nuevo layout de columnas (sin fila de encabezado):
     *   0: fecha_emision
     *   1: cuit_cliente
     *   2: razon_social_cliente   ← NUEVO
     *   3: domicilio_cliente      ← NUEVO
     *   4: nombre_contacto
     *   5: descripcion
     *   6: importe
     *   7: comp_nro
     *   8: cae_number
     *   9: vencimiento
     */
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
      ${skip
        ? `<td><span style="color:#8B949E;font-size:11px">omitida</span></td>`
        : `<td><div class="beg-row-actions">
            <button class="beg-btn beg-btn-icon" onclick="previewSingle(${i})" title="Ver factura">👁</button>
            <button class="beg-btn beg-btn-icon" onclick="generateSingle(${i})" title="Generar PDF">⚡</button>
            <button class="beg-btn beg-btn-arca" onclick="registrarEnArca(${i})" title="Registrar en ARCA">🏛</button>
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

// ─── Vista previa individual (HTML del backend en iframe) ──────────────────────
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
        a.href     = url;
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

// ─── Generar PDF individual ─────────────────────────────────────────────────────
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

// ─── Generar todas ──────────────────────────────────────────────────────────────
generateAllBtn.addEventListener('click', async () => {
  const validRows = state.rows.filter(r => !isSkippable(r)[0]);

  if (!validRows.length) {
    const motivos = state.rows.map(r => {
      const [, mot] = isSkippable(r);
      const comp = r.comp_nro || `fila ${r.idx + 1}`;
      return mot ? `<strong>${comp}:</strong> ${mot}` : null;
    }).filter(Boolean);

    showStatus(
      '⚠️ No hay facturas válidas para generar. Revisá los siguientes problemas:',
      'error',
      motivos
    );
    return;
  }

  generateAllBtn.classList.add('loading');
  pdfGallery.innerHTML = '';
  generatedSection.classList.remove('beg-hidden');
  const emisor = emisorData();
  let done = 0;

  for (const row of validRows) {
    showStatus(`⏳ Generando ${done + 1}/${validRows.length}: ${row.comp_nro}...`, 'info');
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
  showStatus(`✅ ${done} factura${done !== 1 ? 's' : ''} generada${done !== 1 ? 's' : ''} correctamente.`, 'success');
});

// ─── Tarjetas de la galería de PDFs ────────────────────────────────────────────
function addToPDFGallery(row, url, filename) {
  const card = document.createElement('div');
  card.className = 'beg-pdf-card';
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

function addToPDFGalleryPrintOnly(row) {
  const card = document.createElement('div');
  card.className = 'beg-pdf-card';
  card.innerHTML = `
    <div class="beg-pdf-card-title">${row.comp_nro}</div>
    <div class="beg-pdf-card-client">${row.razon_social_cliente}</div>
    <div class="beg-pdf-card-amount">${fmtCurrency(row.amount)}</div>
    <div class="beg-pdf-card-actions">
      <button class="beg-btn beg-btn-icon" onclick="previewSingle(${row.idx})">🖨 Imprimir</button>
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

    // Volcar el log del server a la consola
    (data.log || []).forEach(line => arcaLog(line));

    if (data.status === 'ok') {
      arcaLog('');
      arcaLog('✅ ¡Factura registrada en AFIP!');
      arcaLog(`   CAE:      ${data.cae}`);
      arcaLog(`   Vto CAE:  ${data.cae_vto}`);
      arcaLog(`   Cbte Nro: ${data.cbte_nro}`);
      // Actualizar el row con el CAE para futuras generaciones
      state.rows[idx].cae_number = data.cae;
      state.rows[idx].vencimiento = data.cae_vto;
    } else if (data.status === 'not_configured') {
      arcaLog('⚠️  ARCA no configurado en este ambiente.');
      arcaLog(`   ${data.error || ''}`);
    } else {
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
    (document.querySelector('.beg-container') || document.querySelector('main') || document.body).appendChild(panel);
  }
  $('arcaConsoleTitle').textContent = `🔌 ARCA — ${title}`;
  $('arcaConsoleBody').innerHTML = '';
  panel.classList.remove('beg-hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function arcaLog(line) {
  const body = $('arcaConsoleBody');
  if (!body) return;
  const el = document.createElement('div');
  el.className = 'beg-arca-line';
  // Colorear según prefijo
  if (line.startsWith('✅'))      el.style.color = '#3FB950';
  else if (line.startsWith('❌')) el.style.color = '#F85149';
  else if (line.startsWith('⚠️')) el.style.color = '#D29922';
  else if (line.startsWith('──')) el.style.color = '#58A6FF';
  else                             el.style.color = '#C9D1D9';
  el.textContent = line;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}