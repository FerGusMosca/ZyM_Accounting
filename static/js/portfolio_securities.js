/* ---------- PAGINATION ---------- */
function goPage(page) {
    if (page < 1) return;
    document.getElementById("pageInput").value = page;
    document.getElementById("pfForm").submit();
}

/* ---------- MODAL ---------- */
function openAddModal() {
    document.getElementById("addModal").style.display = "flex";
}
function closeAddModal() {
    document.getElementById("addModal").style.display = "none";
}

/* ---------- TABS ---------- */
function showTab(id, evt) {
    document.querySelectorAll(".tab-content").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach(x => x.classList.remove("active"));

    document.getElementById(id).classList.add("active");
    evt.target.classList.add("active");
}

/* ---------- SEARCH SECURITY ---------- */
async function searchSecurities() {
    const q = document.getElementById("searchInput").value.trim();
    const box = document.getElementById("searchResults");
    box.innerHTML = "";

    if (q.length < 2) return;

    const res = await fetch(`/portfolio_securities/search?query=${encodeURIComponent(q)}`);
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
        box.innerHTML = "<div class='sr-item empty'>No results</div>";
        return;
    }

    box.innerHTML = data.map(s => `
      <div class="sr-item" onclick="addSingle(${s.security_id})">
          <b>${s.ticker}</b> — ${s.name}
      </div>
    `).join("");
}

/* ---------- ADD SINGLE ---------- */
async function addSingle(secId) {
    const portfolioId = document.getElementById("portfolioSelect").value;

    const form = new FormData();
    form.append("portfolio_id", portfolioId);
    form.append("security_id", secId);

    const res = await fetch("/portfolio_securities/add_single", {
        method: "POST",
        body: form
    });

    const data = await res.json();
    if (data.status === "ok") location.reload();
    else alert("ERROR: " + data.message);
}

/* ---------- IMPORT CSV ---------- */
async function importCSV(btn) {

    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = "⏳ Importing...";

    const csv = document.getElementById("csvInput").value.trim();
    const resultBox = document.getElementById("csvResult");
    const portfolioId = document.getElementById("portfolioSelect").value;

    if (!csv) {
        resultBox.innerHTML = "<span class='err'>CSV is empty</span>";
        btn.disabled = false;
        btn.innerHTML = original;
        return;
    }

    const form = new FormData();
    form.append("portfolio_id", portfolioId);
    form.append("csv_text", csv);

    const res = await fetch("/portfolio_securities/import_csv", {
        method: "POST",
        body: form
    });

    const data = await res.json();

    if (data.status !== "ok") {
        resultBox.innerHTML = `<span class='err'>ERROR: ${data.message}</span>`;
        btn.disabled = false;
        btn.innerHTML = original;
        return;
    }

    const rep = data.report;
    resultBox.innerHTML = `
        <div class="csv-summary">
            <div>Inserted: <strong>${rep.inserted}</strong></div>
            <div>Updated: <strong>${rep.updated}</strong></div>
            <div>Not Found:</div>
            <ul>${rep.not_found.map(x => `<li>${x}</li>`).join("")}</ul>
        </div>
    `;

    setTimeout(() => location.reload(), 1500);
}


function showLoader(btn){
    btn.innerHTML = "⏳ Loading...";
}

document.addEventListener("dblclick", function (e) {
    const cell = e.target.closest(".editable");
    if (!cell) return;

    if (cell.querySelector("input")) return;

    const value = cell.innerText.trim();
    const input = document.createElement("input");

    input.value = value;
    input.className = "edit-input";

    cell.innerHTML = "";
    cell.appendChild(input);

    const row = cell.closest("tr");
    row.querySelector(".save-btn").disabled = false;
});


// Saves the edited row by sending updated fields to the backend
async function saveRow(btn) {
    // Find the closest table row (<tr>) containing the Save button
    const row = btn.closest("tr");

    // Create FormData to send as multipart/form-data (matches FastAPI Form expectations)
    const formData = new FormData();

    // Always send the security_id to identify which record to update
    formData.append("security_id", Number(row.dataset.id));

    // Iterate over all cells marked as editable
    row.querySelectorAll(".editable").forEach(cell => {
        // Skip the is_active field – it's not meant to be edited by the user
        if (cell.dataset.field === "is_active") return;

        // Find the input element inside the cell
        const input = cell.querySelector("input");
        if (!input) return;

        // Get the trimmed value to avoid sending empty strings
        const value = input.value.trim();

        // Only append the field if it has a non-empty value
        // This prevents sending invalid/empty data that could cause backend errors
        if (value !== "") {
            formData.append(cell.dataset.field, value);
        }
    });

    try {
        // Send POST request to the update endpoint
        const response = await fetch("/portfolio_securities/update", {
            method: "POST",
            body: formData
        });

        // Handle successful response
        if (response.ok) {
            alert("Updated successfully");
            location.reload(); // Refresh page to show updated data
        } else {
            // Handle HTTP errors (e.g., 400, 500)
            const errorText = await response.text();
            alert("Error updating record: " + errorText);
        }
    } catch (err) {
        // Handle network or JavaScript errors
        alert("Connection error");
        console.error(err);
    }
}

// Apply filters by reloading with query params
function applyFilters() {
    const ticker = document.getElementById("tickerFilter").value.trim();
    const symbol = document.getElementById("symbolFilter").value.trim();

    const portfolioId = document.getElementById("portfolioSelect").value;
    let url = `/portfolio_securities/load?portfolio_id=${portfolioId}`;
    if (ticker) url += `&ticker_filter=${encodeURIComponent(ticker)}`;
    if (symbol) url += `&symbol_filter=${encodeURIComponent(symbol)}`;
    window.location.href = url;
}

// Clear filters – reload without params
function clearFilters() {
    document.getElementById("tickerFilter").value = "";
    document.getElementById("symbolFilter").value = "";
    const portfolioId = document.getElementById("portfolioSelect").value;
    window.location.href = `/portfolio_securities/load?portfolio_id=${portfolioId}`;
}