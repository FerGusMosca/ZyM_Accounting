// ================================================
// Intercept form submit and send async request
// ================================================
document.getElementById("fallbackForm").addEventListener("submit", async function (e) {
    e.preventDefault();

    // Get button and result container
    const btn = this.querySelector("button");
    const resultDiv = document.getElementById("result");

    // --------------------------------------------
    // Loading state (button + result box)
    // --------------------------------------------
    btn.disabled = true;
    btn.innerHTML = "⌛ Searching...";

    resultDiv.innerHTML = `
        <div class="loading-box">
            ⏳ Loading...
        </div>
    `;

    // --------------------------------------------
    // Build request body
    // --------------------------------------------
    const formData = new FormData(this);

    // --------------------------------------------
    // Send async POST request
    // --------------------------------------------
    const resp = await fetch("/management_sentiment_rankings_fallback/analyze", {
        method: "POST",
        body: formData
    });

    const json = await resp.json();

    // --------------------------------------------
    // Render bot response (replace newlines)
    // --------------------------------------------
    resultDiv.innerHTML = json.bot_response.replace(/\n/g, "<br>");

    // --------------------------------------------
    // Reset button state
    // --------------------------------------------
    btn.disabled = false;
    btn.innerHTML = "<span>Search</span>";
});


// ================================================
// Show quarter selector only when Q10 is selected
// ================================================
const k10Sel = document.getElementById("k10Selector");
const qSel  = document.getElementById("quarterSelector");

k10Sel.addEventListener("change", () => {
    qSel.style.display = (k10Sel.value === "Q10") ? "block" : "none";
});
