document.addEventListener('DOMContentLoaded', () => {
  loadMeta();       // instant — brand name sin esperar ARCA
  loadDashboard();  // async  — datos de ARCA cuando estén listos
});

// ── Instant: brand name + título (sin ARCA) ───────────────────────────────────
async function loadMeta() {
  try {
    const res  = await fetch('/dashboard/meta');
    const data = await res.json();
    const name = data.product_name || 'MOSCA';
    document.title = name;
    document.getElementById('heroTitle').textContent = name;
    document.getElementById('brandName').textContent = name;
    if (data.customer_name) {
      const sub = document.getElementById('brandSub');
      if (sub) sub.textContent = 'para ' + data.customer_name;
      document.getElementById('heroSubtitle').textContent =
        `Gestión de facturación, generación de comprobantes y trazabilidad contable para ${data.customer_name}.`;
    }
  } catch (e) {
    console.warn('loadMeta:', e);
  }
}

async function loadDashboard() {
  try {
    const res  = await fetch('/dashboard/recent_invoices?limit=10');
    const data = await res.json();

    // product_name → title, sidebar brand, hero title (PRODUCT_NAME in .env)
    const productName = data.product_name || 'MOSCA';
    document.title = productName;
    document.getElementById('heroTitle').textContent  = productName;
    document.getElementById('brandName').textContent  = productName;
    if (data.customer_name) {
      const sub = document.getElementById('brandSub');
      if (sub) sub.textContent = 'para ' + data.customer_name;
    }

    // customer_name → hero subtitle (CUSTOMER_NAME in .env)
    if (data.customer_name) {
      document.getElementById('heroSubtitle').textContent =
        `Gestión de facturación, generación de comprobantes y trazabilidad contable para ${data.customer_name}.`;
    }

    const notConfigured = data.status === 'not_configured';

    // Env badge
    if (notConfigured) {
      setEnvBadge('no-conf', '⚠ No configurado');
    } else {
      const isHomo = data.invoices?.length ? data.invoices[0].homo_no_cae !== undefined : true;
      setEnvBadge(isHomo ? 'homo' : 'prod', isHomo ? '🧪 Homologación' : '✓ Producción');
    }

    // ARCA not configured
    if (notConfigured) {
      setKpi('kpiArcaStatus', 'kpiArcaSub', '—', 'No configurado', false);
      setServiceStatus('dotWsaa', 'valWsaa', false, 'no conf.');
      setServiceStatus('dotWsfe', 'valWsfe', false, 'no conf.');
      setServiceStatus('dotToken', 'valToken', null, '—');
      setServiceStatus('dotCuit',  'valCuit',  null, '—');
      setServiceStatus('dotAmb',   'valAmb',   null, '—');
      document.getElementById('activityFeed').innerHTML =
        `<div style="color:#484F58;font-size:12px;font-family:'DM Mono',monospace;padding:20px 0">
          ARCA no está configurado en este ambiente.
        </div>`;
      return;
    }

    if (data.status === 'error') {
      setKpi('kpiArcaStatus', 'kpiArcaSub', 'ERROR', data.message?.slice(0, 30) || '', false);
      setServiceStatus('dotWsaa', 'valWsaa', false, 'error');
      setServiceStatus('dotWsfe', 'valWsfe', false, 'error');
      return;
    }

    // Status ok
    const invoices = data.invoices || [];

    if (invoices.length) {
      const last = invoices[0];
      setKpi('kpiLastComp', 'kpiLastSub',
        last.comp_nro || '—',
        `${last.fecha_emision || ''}  ·  $ ${fmtNum(last.amount)}`,
        true
      );
    } else {
      setKpi('kpiLastComp', 'kpiLastSub', '—', 'Sin facturas recientes', null);
    }

    // Filtrar facturas del mes en curso
    const now        = new Date();
    const mesActual  = now.getMonth() + 1;   // 1-12
    const anioActual = now.getFullYear();
    const mesMes = String(mesActual).padStart(2, '0');
    const MESES  = ['','enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];

    const invMes = invoices.filter(inv => {
      // fecha_emision format: "DD/MM/YYYY"
      const f = inv.fecha_emision || '';
      const parts = f.split('/');
      if (parts.length !== 3) return false;
      return parseInt(parts[1]) === mesActual && parseInt(parts[2]) === anioActual;
    });

    const total = invMes.reduce((s, i) => s + (+i.amount || 0), 0);
    setKpi('kpiTotal', 'kpiTotalSub',
      `$ ${fmtNum(total)}`,
      `${invMes.length} comprobante${invMes.length !== 1 ? 's' : ''} · ${MESES[mesActual]} ${anioActual}`,
      true
    );

    setKpi('kpiArcaStatus', 'kpiArcaSub', 'ONLINE', 'token activo', true);
    setServiceStatus('dotWsaa', 'valWsaa', true, 'OK');
    setServiceStatus('dotWsfe', 'valWsfe', true, 'OK');
    setServiceStatus('dotToken', 'valToken', true, 'vigente');
    setServiceStatus('dotCuit',  'valCuit',  null, data.cuit || '—');

    const homo = invoices[0]?.homo_no_cae !== undefined;
    setServiceStatus('dotAmb', 'valAmb', null,
      homo ? 'Homologación' : 'Producción',
      homo ? 'warn' : 'ok'
    );

    // Activity feed
    if (!invoices.length) {
      document.getElementById('activityFeed').innerHTML =
        `<div style="color:#484F58;font-size:12px;font-family:'DM Mono',monospace;padding:20px 0">Sin facturas recientes.</div>`;
      return;
    }

    document.getElementById('activityFeed').innerHTML = invoices.map((inv, i) => {
      const badgeHtml = inv.cae_number
        ? `<span style="color:#3FB950;font-size:10px;font-family:'DM Mono',monospace">✓ CAE</span>`
        : inv.homo_no_cae
          ? `<span style="color:#8B5CF6;font-size:10px;font-family:'DM Mono',monospace">🧪 homo</span>`
          : `<span style="color:#D29922;font-size:10px;font-family:'DM Mono',monospace">⏳ sin CAE</span>`;

      return `
        <div class="dash-activity-item" style="animation-delay:${i * 0.04}s">
          <div class="dash-activity-icon">🧾</div>
          <div class="dash-activity-body">
            <div class="dash-activity-text">
              <span style="color:#58A6FF;font-family:'DM Mono',monospace;font-size:12px">${inv.comp_nro || '—'}</span>
              &nbsp;·&nbsp;
              <span style="color:#8B949E">${inv.razon_social_cliente || inv.cuit_cliente || '—'}</span>
            </div>
            <div class="dash-activity-meta">
              $ ${fmtNum(inv.amount)} &nbsp;·&nbsp; ${inv.fecha_emision || '—'} &nbsp;·&nbsp; ${badgeHtml}
            </div>
          </div>
        </div>`;
    }).join('');

  } catch (e) {
    setKpi('kpiArcaStatus', 'kpiArcaSub', 'ERROR', e.message?.slice(0,30) || '', false);
    setServiceStatus('dotWsaa', 'valWsaa', false, 'sin respuesta');
    setServiceStatus('dotWsfe', 'valWsfe', false, 'sin respuesta');
    document.getElementById('activityFeed').innerHTML =
      `<div style="color:#F85149;font-size:12px;font-family:'DM Mono',monospace;padding:20px 0">Error: ${e.message}</div>`;
  }
}

function setKpi(valId, subId, val, sub, ok) {
  const el = document.getElementById(valId);
  el.textContent = val;
  el.classList.remove('loading');
  if (ok === true)  el.style.color = '#3FB950';
  if (ok === false) el.style.color = '#F85149';
  document.getElementById(subId).textContent = sub;
}

function setServiceStatus(dotId, valId, ok, label, colorClass) {
  const dot = document.getElementById(dotId);
  const val = document.getElementById(valId);
  dot.classList.remove('pulse');
  if (ok === true) {
    dot.className = 'arca-dot green';
    val.className = 'arca-status-value ok';
  } else if (ok === false) {
    dot.className = 'arca-dot red';
    val.className = 'arca-status-value error';
  } else {
    dot.className = 'arca-dot gray';
    val.className = colorClass ? `arca-status-value ${colorClass}` : 'arca-status-value';
  }
  val.textContent = label;
}

function setEnvBadge(type, label) {
  const el = document.getElementById('envBadge');
  el.textContent = label;
  el.className = `env-badge ${type === 'homo' ? 'homo' : type === 'prod' ? 'prod' : ''}`;
}

function fmtNum(val) {
  return (+val || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}