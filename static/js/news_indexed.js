const form = document.getElementById('newsForm');
const btn = form.querySelector('button');
const errorMsg = document.getElementById('errorMsg');
const resultDiv = document.getElementById('result');

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorMsg.classList.remove('show');
  resultDiv.innerHTML = '<div class="loading-placeholder">⏳ Analizando noticias...</div>';

  const symbol = form.symbol.value.trim().toUpperCase();
  if (!symbol) {
    errorMsg.textContent = 'Por favor ingrese un símbolo válido.';
    errorMsg.classList.add('show');
    resultDiv.innerHTML = '';
    return;
  }

  btn.classList.add('loading');
  const formData = new FormData(form);

  try {
    const res = await fetch("/management_news_indexed/analyze", {
      method: 'POST',
      body: formData,
      cache: 'no-store'
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const data = await res.json();
    if (!data.bot_response) throw new Error('Respuesta vacía del bot.');

    resultDiv.innerHTML = `<strong>Bot:</strong><br><br>${data.bot_response}`;
  } catch (err) {
    resultDiv.innerHTML = `<p style="color:#f85149;font-weight:bold;">🔥 ERROR: ${err.message}</p>`;
    console.error('News Indexed error:', err);
  } finally {
    btn.classList.remove('loading');
  }
});
