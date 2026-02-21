const form = document.getElementById('rankingForm');
const btn = form.querySelector('button');
const errorMsg = document.getElementById('errorMsg');
const resultDiv = document.getElementById('result');

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorMsg.textContent = '';
  resultDiv.innerHTML = '<div style="color:#9aa4b2;padding:10px;">⏳ Procesando...</div>';

  const query = form.query.value.trim();
  if (!query) {
    errorMsg.textContent = 'Por favor, escribe una consulta válida.';
    return;
  }

  btn.disabled = true;
  const formData = new FormData(form);

  try {
    const res = await fetch("/management_sentiment_rankings/analyze", {
      method: "POST",
      body: formData
    });
    const data = await res.json();

    resultDiv.innerHTML = `
      <div class="response-block">
        <h4>📈 Respuesta:</h4>
        <p>${data.bot_response.replace(/\n/g, "<br>")}</p>
      </div>`;
  } catch (err) {
    resultDiv.innerHTML = `<p style="color:#f85149">🔥 ERROR: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
  }
});
