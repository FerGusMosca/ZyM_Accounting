/*
  Management Sentiment — FULL FILE (BOT6 VERSION)
  - Valida form
  - Llama al backend
  - Parsea JSON
  - Render con cajas .sentiment-section estilo Competition
*/

const reportSel = document.getElementById('report');
const quarterSel = document.getElementById('quarter');
const form = document.getElementById('sentimentForm');
const btn = form.querySelector('button');
const errorMsg = document.getElementById('errorMsg');
const resultDiv = document.getElementById('result');

/* Mostrar / ocultar quarter */
function updateLayout() {
  const isQ10 = reportSel.value === 'Q10';
  quarterSel.style.display = isQ10 ? 'block' : 'none';
  quarterSel.style.gridArea = 'quarter';
}
reportSel.addEventListener('change', updateLayout);
window.addEventListener('resize', updateLayout);
updateLayout();

/* --- Submit Handler --- */
form.addEventListener('submit', async e => {
  e.preventDefault();
  errorMsg.classList.remove('show');
  errorMsg.textContent = '';

  resultDiv.innerHTML =
    '<div class="loading-placeholder" style="padding:14px;color:#9aa4b2">⏳ Loading...</div>';

  const symbol = form.symbol.value.trim().toUpperCase();
  const year = form.year.value;
  const report = form.report.value;
  const quarter = report === 'Q10' ? form.quarter.value : null;

  if (!symbol || !year || !report || (report === 'Q10' && !quarter)) {
    errorMsg.textContent = 'Please fill in all fields before searching.';
    errorMsg.classList.add('show');
    resultDiv.innerHTML = '';
    return;
  }

  btn.classList.add('loading');

  const formData = new FormData(form);
  if (report !== 'Q10') formData.delete('quarter');

  try {
    const res = await fetch("/management_sentiment/analyze", {
      method: 'POST',
      body: formData,
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const data = await res.json();
    if (!data.bot_response) throw new Error('Missing bot_response field');

    let parsed;
    try {
      parsed = (typeof data.bot_response === 'string')
        ? JSON.parse(data.bot_response)
        : data.bot_response;
    } catch (e) {
      throw new Error('Invalid JSON format in bot_response: ' + e.message);
    }

    const conf = parsed.Confidence || 'N/A';
    const tone = parsed.GeneralTone || 'N/A';
    const risk = parsed.RiskFocus || 'N/A';

    const positivos = Array.isArray(parsed.PositivosClaves)
      ? parsed.PositivosClaves.map(t => `<li>${t}</li>`).join('')
      : '<li>No positive points</li>';

    const riesgos = Array.isArray(parsed.RiesgosPrincipales)
      ? parsed.RiesgosPrincipales.map(t => `<li>${t}</li>`).join('')
      : '<li>No risks listed</li>';

    const futuro = parsed.PerspectivaFutura || 'N/A';

    /* ---- RENDER ESTILO COMPETITION ---- */
    resultDiv.innerHTML = `
      <div class="confidence">
        <strong>Confianza:</strong> ${conf}
      </div>

      <div class="general-tone">
        <strong>Tono General:</strong> ${tone}
      </div>

      <div class="risk-focus">
        <strong>Enfoque de Riesgo:</strong> ${risk}
      </div>

      <div class="sentiment-section">
        <h3>✅ Positivos Clave</h3>
        <ul>${positivos}</ul>
      </div>

      <div class="sentiment-section">
        <h3>⚠️ Riesgos Principales</h3>
        <ul>${riesgos}</ul>
      </div>

      <div class="sentiment-section">
        <h3>📈 Perspectiva Futura</h3>
        <p>${futuro}</p>
      </div>
    `;

  } catch (err) {
    resultDiv.innerHTML = `
      <p style="color:#f85149;font-weight:bold;padding:20px;background:#1c1f26;border-radius:8px;">
        🔥 ERROR: ${err.message}
      </p>`;
    console.error('Sentiment error:', err);
  } finally {
    btn.classList.remove('loading');
  }
});
