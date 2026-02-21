/* static/js/competition.js — FULL FILE (MATCHES sentiment.js EXACTLY) */
/* Handles the Competition & Threat Analysis form:
   - Validates inputs
   - Sends POST request
   - Parses JSON safely
   - Uses same button loading behavior as sentiment.js
*/

const reportSel = document.getElementById('report');
const quarterSel = document.getElementById('quarter');
const form = document.getElementById('competitionForm');
const btn = form.querySelector('button');
const errorMsg = document.getElementById('errorMsg');
const resultDiv = document.getElementById('result');

/* Show or hide quarter field */
function updateLayout() {
  const isQ10 = reportSel.value === 'Q10';
  quarterSel.style.display = isQ10 ? 'block' : 'none';
  quarterSel.style.gridArea = 'quarter';
}
reportSel.addEventListener('change', updateLayout);
window.addEventListener('resize', updateLayout);
updateLayout();

/* --- Submit handler --- */
form.addEventListener('submit', async e => {
  e.preventDefault();

  // Reset errors
  errorMsg.classList.remove('show');
  errorMsg.textContent = '';

  // Show loading placeholder
  resultDiv.innerHTML =
    '<div class="loading-placeholder" style="padding:14px;color:#9aa4b2">⏳ Loading...</div>';

  // Validate fields
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

  // Activate button loader (identical to sentiment)
  btn.classList.add('loading');

  const formData = new FormData(form);
  if (report !== 'Q10') formData.delete('quarter');

  try {
    const res = await fetch("/management_competition/analyze", {
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
    if (!data.bot_response)
      throw new Error('Missing bot_response field');

    let parsed;
    try {
      parsed = (typeof data.bot_response === 'string')
        ? JSON.parse(data.bot_response)
        : data.bot_response;
    } catch (err) {
      throw new Error('Invalid JSON format in bot_response: ' + err.message);
    }

    /* Extract fields */
    const conf = parsed.Confidence || 'N/A';
    const market = Array.isArray(parsed.MarketCompetition)
      ? parsed.MarketCompetition.map(x => `<li>${x}</li>`).join('')
      : '<li>N/A</li>';

    const reg = Array.isArray(parsed.RegulatoryPressures)
      ? parsed.RegulatoryPressures.map(x => `<li>${x}</li>`).join('')
      : '<li>N/A</li>';

    const ops = Array.isArray(parsed.OperationalThreats)
      ? parsed.OperationalThreats.map(x => `<li>${x}</li>`).join('')
      : '<li>N/A</li>';

    const strat = Array.isArray(parsed.StrategicRisks)
      ? parsed.StrategicRisks.map(x => `<li>${x}</li>`).join('')
      : '<li>N/A</li>';

    const src = parsed.Source || 'N/A';

    /* Render HTML */
    resultDiv.innerHTML = `
      <div class="confidence"><strong>Confianza:</strong> ${conf}</div>

      <div class="section">
        <h3>🏁 Competencia de Mercado</h3>
        <ul>${market}</ul>
      </div>

      <div class="section">
        <h3>⚖️ Presiones Regulatorias</h3>
        <ul>${reg}</ul>
      </div>

      <div class="section">
        <h3>⚙️ Amenazas Operativas</h3>
        <ul>${ops}</ul>
      </div>

      <div class="section">
        <h3>🎯 Riesgos Estratégicos</h3>
        <ul>${strat}</ul>
      </div>

      <div class="source"><strong>Fuente:</strong> ${src}</div>
    `;

  } catch (err) {
    resultDiv.innerHTML = `
      <p style="color:#f85149;font-weight:bold;padding:20px;background:#1c1f26;border-radius:8px;">
        🔥 ERROR: ${err.message}
      </p>
    `;
    console.error('Competition error:', err);
  } finally {
    // Reset button loader
    btn.classList.remove('loading');
  }
});
