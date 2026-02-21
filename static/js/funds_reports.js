/**
 * Funds Reports (#10-Rag ZeroHedge) – Frontend logic
 */

const form       = document.getElementById('rankingForm');
const btn        = form.querySelector('button');
const errorMsg   = document.getElementById('errorMsg');
const resultDiv  = document.getElementById('result');

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    errorMsg.textContent = '';
    resultDiv.textContent = 'Processing…';

    const query = form.query.value.trim();
    if (!query) {
        errorMsg.textContent = 'Please enter a query.';
        resultDiv.textContent = '';
        return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    const formData = new FormData(form);

    try {
        const res = await fetch('/funds_reports/analyze', {
            method: 'POST',
            body: formData
        });

        const data = await res.json();

        if (data.message === 'ok') {
            resultDiv.innerHTML = data.bot_response.replace(/\n/g, '<br>');
        } else {
            throw new Error(data.bot_response || 'Unknown error from bot');
        }

    } catch (err) {
        resultDiv.textContent = `Error: ${err.message}`;
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
});
