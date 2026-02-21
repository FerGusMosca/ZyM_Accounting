// document_tag_indexer.js - Robust version with full error handling + spinner

const BASE_URL = '/document_tag_indexer';

// DOM elements cache
const els = {
  modeOld: document.getElementById('modeOld'),
  modeNew: document.getElementById('modeNew'),
  newSection: document.getElementById('newRunSection'),
  oldSection: document.getElementById('oldRunsSection'),
  portfolioSelect: document.getElementById('portfolioSelect'),
  sourceSelect: document.getElementById('sourceSelect'),
  quarterSelect: document.getElementById('quarterSelect'),
  tagModelSelect: document.getElementById('tagModelSelect'),
  tagNameInput: document.getElementById('tagNameInput'),
  docTypeSelect: document.getElementById('docTypeSelect'),
  tagTypeSelect: document.getElementById('tagTypeSelect'),
  tagContent: document.getElementById('tagContent'),
  form: document.getElementById('newRunForm'),
  resultMsg: document.getElementById('resultMessage'),
  createBtn: document.getElementById('createRunBtn') // 🔄 spinner button
};

// Toggle between modes
function toggleMode() {
  const isNewMode = els.modeNew.checked;
  els.newSection.classList.toggle('dti-hidden', !isNewMode);
  els.oldSection.classList.toggle('dti-hidden', isNewMode);
}

// Show/hide quarter select based on source
function handleSourceChange() {
  const isQ10 = els.sourceSelect.value === 'Q10';
  els.quarterSelect.classList.toggle('dti-hidden', !isQ10);

  if (!isQ10) els.quarterSelect.value = '';
  els.quarterSelect.required = isQ10;
}

// Load dropdown options from API
async function loadDropdownData() {
  try {
    const responses = await Promise.all([
      fetch(`${BASE_URL}/portfolios`),
      fetch(`${BASE_URL}/sources`),
      fetch(`${BASE_URL}/tag_models`),
      fetch(`${BASE_URL}/doc_types`),
      fetch(`${BASE_URL}/tag_types`)
    ]);

    const jsons = await Promise.all(responses.map(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${res.url}`);
      return res.json();
    }));

    const [portfolios, sources, models, docTypes, tagTypes] = jsons;

    (portfolios.portfolios || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = p;
      els.portfolioSelect.appendChild(opt);
    });
    if (portfolios.error) throw new Error(portfolios.error);

    (sources.sources || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.code;
      opt.textContent = s.name;
      els.sourceSelect.appendChild(opt);
    });
    if (sources.error) throw new Error(sources.error);

    (models.models || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = m;
      els.tagModelSelect.appendChild(opt);
    });
    if (models.error) throw new Error(models.error);

    (docTypes.doc_types || []).forEach(dt => {
      const opt = document.createElement('option');
      opt.value = dt.code;
      opt.textContent = dt.name;
      els.docTypeSelect.appendChild(opt);
    });
    if (docTypes.error) throw new Error(docTypes.error);

    (tagTypes.tag_types || []).forEach(tt => {
      const opt = document.createElement('option');
      opt.value = tt.code;
      opt.textContent = tt.name;
      els.tagTypeSelect.appendChild(opt);
    });
    if (tagTypes.error) throw new Error(tagTypes.error);

  } catch (err) {
    console.error('Dropdown load failed:', err);
    showResult(err.message || err, 'error');
  }
}

function showResult(message, status) {
  els.resultMsg.textContent = message;
  els.resultMsg.className =
    status === 'error'
      ? 'dti-result dti-error dti-visible'
      : 'dti-result dti-success dti-visible';
}

// Handle form submission + spinner
async function handleFormSubmit(e) {
  e.preventDefault();

  const formData = new FormData(els.form);
  if (els.sourceSelect.value !== 'Q10') formData.delete('quarter');

  els.createBtn.classList.add('loading'); // 🔄 SHOW SPINNER

  try {
    const response = await fetch(`${BASE_URL}/create_run`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (!response.ok || data.status !== 'ok') {
      throw new Error(data.message || data.error || `HTTP ${response.status}`);
    }

    showResult(`✓ Run created: ${data.message}`, 'success');

  } catch (err) {
    console.error('Form submit failed:', err);
    showResult(`Submission error: ${err.message || 'Please try again'}`, 'error');

  } finally {
    els.createBtn.classList.remove('loading'); // ✅ HIDE SPINNER
  }
}

function init() {
    // Mode toggle listeners (enhanced version that lazy-loads old runs)
    els.modeOld.addEventListener('change', toggleModeEnhanced);
    els.modeNew.addEventListener('change', toggleModeEnhanced);

    // Standard listeners
    els.sourceSelect.addEventListener('change', handleSourceChange);
    els.form.addEventListener('submit', handleFormSubmit);

    // Old Runs specific events (pagination + modal)
    setupOldRunsEvents();

    // Initial loads
    loadDropdownData();
    toggleModeEnhanced();      // Sets correct initial view + loads old runs if needed
    handleSourceChange();
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


// ─────────────────────────────────────────────────────────────
//                  OLD RUNS SECTION LOGIC
// ─────────────────────────────────────────────────────────────

const oldRuns = {
  currentPage: 1,
  pageSize: 15,
  allRuns: [],

/**
 * Load previous tagging runs from the real backend API
 * Replaces mock data with actual fetch to /old_runs endpoint
 */
async loadRuns() {
  try {
    // Use current page and pageSize for pagination
    const page = this.currentPage;
    const size = this.pageSize;  // e.g. 15

    // Real API call - adjust query params if your backend uses offset/limit instead
    const url = `${BASE_URL}/old_runs?page=${page}&size=${size}`;

    // Optional: add filters if you have them later
    // const url = `${BASE_URL}/old_runs?page=${page}&size=${size}&tag_name=ai_adoption&portfolio=US_BIGCAP_EX_SMALL`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();

    // Assuming the backend returns an array of objects with the expected fields
    this.allRuns = data.map(run => ({
      id: run.id,
      portfolio: run.portfolio,
      source: run.source,
      year: run.year,
      quarter: run.quarter,
      sec_processed: run.sec_processed,
      tag_model: run.tag_model,
      doc_type: run.doc_type,
      tag_name: run.tag_name || "N/A",          // fallback if field doesn't exist
      run_date: run.run_date,
      status: run.status,
      tag_json: run.tag_json || "{}",
      rank_folder: run.rank_folder || "N/A"
    }));

    this.renderTable();

  } catch (err) {
    console.error("Failed to load old runs from API:", err);
    document.getElementById('runsTableBody').innerHTML =
      '<tr><td colspan="9" style="text-align:center;padding:3rem;color:#F85149">Error loading previous runs from server</td></tr>';
  }
},

  // Render current page of runs into the table
  renderTable() {
    const tbody = document.getElementById('runsTableBody');
    tbody.innerHTML = '';

    const start = (this.currentPage - 1) * this.pageSize;
    const end = start + this.pageSize;
    const pageItems = this.allRuns.slice(start, end);

    pageItems.forEach(run => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${run.id}</td>
        <td>${run.portfolio}</td>
        <td>${run.source}</td>
        <td>${run.year}</td>
        <td>${run.tag_model}</td>
        <td>${run.doc_type}</td>
        <td>${run.tag_name}</td>
        <td>${run.run_date}</td>
        <td>${run.status}</td>
        <td class="json-cell">
          <button class="view-json-btn" data-json='${run.tag_json}'>JSON</button>
        </td>
        <td class="json-cell">
            <button class="view-rank-btn"
              data-rank="${run.rank_folder}"
              data-year="${run.year}"
              data-quarter="${run.quarter || ''}"
              data-secprocessed="${run.sec_processed || ''}"
            >
              Details
            </button>
        </td>
        <td class="json-cell">
          <button class="run-query-btn"
                  data-id="${run.id}"
                  data-portfolio="${run.portfolio}"
                  data-source="${run.source}"
                  data-year="${run.year}"
                  data-tag="${run.tag_name}"
                  data-rank-folder="${run.rank_folder}"
                  >
            Run Query
          </button>
        </td>

      `;
      tbody.appendChild(row);
    });

    // Update pagination controls
    const totalPages = Math.ceil(this.allRuns.length / this.pageSize);
    document.getElementById('pageInfo').textContent = `Page ${this.currentPage} of ${totalPages || 1}`;
    document.getElementById('prevPage').disabled = this.currentPage === 1;
    document.getElementById('nextPage').disabled = this.currentPage >= totalPages;
  }
};

// Setup event listeners for pagination buttons and JSON modal
function setupOldRunsEvents() {
  document.getElementById('prevPage')?.addEventListener('click', () => {
    if (oldRuns.currentPage > 1) {
      oldRuns.currentPage--;
      oldRuns.renderTable();
    }
  });

  document.getElementById('nextPage')?.addEventListener('click', () => {
    oldRuns.currentPage++;
    oldRuns.renderTable();
  });

  // Handle click on "View JSON" buttons → show modal
  document.addEventListener('click', e => {
    if (e.target.classList.contains('view-json-btn')) {
      const jsonStr = e.target.dataset.json;
      try {
        const prettyJson = JSON.stringify(JSON.parse(jsonStr), null, 2);
        document.getElementById('jsonContent').textContent = prettyJson;
        document.getElementById('jsonModal').classList.remove('dti-hidden');
      } catch (err) {
        document.getElementById('jsonContent').textContent = "Invalid JSON format";
      }
    }

    // Close modal when clicking close button or outside the content area
    if (e.target.id === 'closeModal' || e.target === document.getElementById('jsonModal')) {
      document.getElementById('jsonModal').classList.add('dti-hidden');
    }
  });

   // View Rank Folder modal
    document.addEventListener('click', e => {
    if (e.target.classList.contains('view-rank-btn')) {
          const { rank, year, quarter, secprocessed } = e.target.dataset;

          document.getElementById('rankContent').innerHTML = `
            <div><strong>Rank:</strong><br>${rank}</div><br>
            <div><strong>Year:</strong> ${year}</div>
            <div><strong>Quarter:</strong> ${quarter || '-'}</div>
            <div><strong>Securities processed:</strong> ${secprocessed || '-'}</div>
          `;

          document.getElementById('rankModal').classList.remove('dti-hidden');
    }

      if (
        e.target.classList.contains('close-rank-modal') ||
        e.target === document.getElementById('rankModal')
      ) {
        document.getElementById('rankModal').classList.add('dti-hidden');
      }
    });

}

// Enhanced toggle mode: loads old runs data only the first time we switch to "Old Runs" view
function toggleModeEnhanced() {
  const isNewMode = els.modeNew.checked;
  els.newSection.classList.toggle('dti-hidden', !isNewMode);
  els.oldSection.classList.toggle('dti-hidden', isNewMode);

  // Load data lazily - only when switching to old runs for the first time
  if (!isNewMode && oldRuns.allRuns.length === 0) {
    oldRuns.loadRuns();
  }
}

// Run Query button
document.addEventListener('click', async e => {
  if (!e.target.classList.contains('run-query-btn')) return;

  const payload = {
    run_id: e.target.dataset.id,
    portfolio: e.target.dataset.portfolio,
    source: e.target.dataset.source,
    year: e.target.dataset.year,
    tag_name: e.target.dataset.tag,
    rank_folder: e.target.dataset.rankFolder
  };

  e.target.disabled = true;
  e.target.textContent = 'Running...';
});


let currentRunQueryPayload = null;

// Open Run Query modal
document.addEventListener('click', e => {
  if (!e.target.classList.contains('run-query-btn')) return;

  currentRunQueryPayload = {
    run_id: Number(e.target.dataset.id),
    portfolio: e.target.dataset.portfolio,
    source: e.target.dataset.source,
    year: Number(e.target.dataset.year),
    tag_name: e.target.dataset.tag,
    rank_folder: e.target.dataset.rankFolder
  };

  document.getElementById('runQueryInput').value = '';
  document.getElementById('runQueryResponse').textContent = '';
  document.getElementById('runQueryModal').classList.remove('dti-hidden');
});

// Submit query
document.getElementById('submitRunQueryBtn').addEventListener('click', async () => {
  const queryText = document.getElementById('runQueryInput').value.trim();
  if (!queryText || !currentRunQueryPayload) return;

  document.getElementById('runQueryResponse').textContent = 'Running query...';

  try {
    const res = await fetch(`${BASE_URL}/run_query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...currentRunQueryPayload,
        query: queryText
      })
    });

    const data = await res.json();

    document.getElementById('runQueryResponse').textContent =
      data.answer || 'No response';

  } catch (err) {
    document.getElementById('runQueryResponse').textContent =
      'Error executing query';
  }
});

// Close modal
document.addEventListener('click', e => {
  if (
    e.target.classList.contains('close-run-query-modal') ||
    e.target === document.getElementById('runQueryModal')
  ) {
    document.getElementById('runQueryModal').classList.add('dti-hidden');


    const btns = document.querySelectorAll('.run-query-btn');
    btns.forEach(btn => {
      btn.disabled = false;
      btn.textContent = 'Run Query';
    });

    currentRunQueryPayload = null;
  }
});


document.getElementById('submitRunQueryBtn').addEventListener('click', async () => {
  const btn = document.getElementById('submitRunQueryBtn');
  const queryText = document.getElementById('runQueryInput').value.trim();
  if (!queryText || !currentRunQueryPayload) return;

  btn.classList.add('loading');
  document.getElementById('runQueryResponse').textContent = 'Running query...';

  try {
    const res = await fetch(`${BASE_URL}/run_query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...currentRunQueryPayload,
        query: queryText
      })
    });

    const data = await res.json();

    document.getElementById('runQueryResponse').textContent =
      data.answer || 'No response';

  } catch (err) {
    document.getElementById('runQueryResponse').textContent =
      'Error executing query';

  } finally {
    btn.classList.remove('loading');
  }
});
