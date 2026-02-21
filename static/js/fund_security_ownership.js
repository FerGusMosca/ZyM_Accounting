// fund_security_ownership.js - Institutional Holdings Analysis

const BASE_URL = '/fund_security_ownership';

// DOM Elements
const els = {
  // Period selectors
  yearSelect: document.getElementById('yearSelect'),
  quarterSelect: document.getElementById('quarterSelect'),
  periodStatus: document.getElementById('periodStatus'),

  // Tabs
  tabs: document.querySelectorAll('.fso-tab'),
  tabContents: document.querySelectorAll('.fso-tab-content'),

  // Crowded Trades
  crowdedOffset: document.getElementById('crowdedOffset'),
  crowdedMinScore: document.getElementById('crowdedMinScore'),
  crowdedLimit: document.getElementById('crowdedLimit'),
  crowdedSearchBtn: document.getElementById('crowdedSearchBtn'),

  // Capitulation
  capMinOwners: document.getElementById('capMinOwners'),
  capOffset: document.getElementById('capOffset'),
  capLimit: document.getElementById('capLimit'),
  capSearchBtn: document.getElementById('capSearchBtn'),

  // Portfolio Viewer
  portfolioManager: document.getElementById('portfolioManager'),
  managerSuggestions: document.getElementById('managerSuggestions'),
  portfolioLimit: document.getElementById('portfolioLimit'),
  portfolioSearchBtn: document.getElementById('portfolioSearchBtn'),
  selectedManager: document.getElementById('selectedManager'),

  // Asset Ownership
  ownershipAsset: document.getElementById('ownershipAsset'),
  assetSuggestions: document.getElementById('assetSuggestions'),
  ownershipLimit: document.getElementById('ownershipLimit'),
  ownershipSearchBtn: document.getElementById('ownershipSearchBtn'),
  selectedAsset: document.getElementById('selectedAsset'),
  assetStats: document.getElementById('assetStats'),

  // Results
  resultMessage: document.getElementById('resultMessage'),
  resultsContainer: document.getElementById('resultsContainer'),
  resultsTitle: document.getElementById('resultsTitle'),
  paginationInfo: document.getElementById('paginationInfo'),
  tableHead: document.getElementById('tableHead'),
  tableBody: document.getElementById('tableBody'),
  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  pageInfo: document.getElementById('pageInfo'),
  exportContainer: document.getElementById('exportContainer'),
  exportCsvBtn: document.getElementById('exportCsvBtn')
};

// State
let currentTab = 'crowded';
let currentData = [];
let currentPagination = null;
let currentQueryType = null;
let debounceTimer = null;
let selectedManagerData = null;
let selectedAssetData = null;

// Initialize
function init() {
  loadAvailablePeriods();
  setupTabListeners();
  setupSearchListeners();
  setupPaginationListeners();
  setupSuggestionListeners();
  setupExportListener();
}

// Load available periods from database
async function loadAvailablePeriods() {
  try {
    const response = await fetch(`${BASE_URL}/available_periods`);
    const data = await response.json();

    if (data.status === 'ok' && data.periods.length > 0) {
      // Get unique years
      const years = [...new Set(data.periods.map(p => p.year))].sort((a, b) => b - a);

      // Populate year select
      els.yearSelect.innerHTML = '<option value="" disabled selected>Year</option>';
      years.forEach(year => {
        const opt = document.createElement('option');
        opt.value = year;
        opt.textContent = year;
        els.yearSelect.appendChild(opt);
      });

      // Auto-select most recent period
      if (data.periods.length > 0) {
        els.yearSelect.value = data.periods[0].year;
        els.quarterSelect.value = data.periods[0].quarter;
        els.periodStatus.textContent = `✓ ${data.periods.length} periods available`;
      }
    }
  } catch (err) {
    console.error('Failed to load periods:', err);
    els.periodStatus.textContent = '✗ Failed to load periods';
    els.periodStatus.style.color = '#F85149';
  }
}

// Setup tab listeners
function setupTabListeners() {
  els.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;

      // Update active tab
      els.tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update active content
      els.tabContents.forEach(content => {
        content.classList.remove('active');
        if (content.id === `tab-${tabId}`) {
          content.classList.add('active');
        }
      });

      currentTab = tabId;

      // Clear results when switching tabs
      clearResults();
    });
  });
}

// Setup search button listeners
function setupSearchListeners() {
  els.crowdedSearchBtn.addEventListener('click', () => searchCrowdedTrades());
  els.capSearchBtn.addEventListener('click', () => searchCapitulation());
  els.portfolioSearchBtn.addEventListener('click', () => searchPortfolio());
  els.ownershipSearchBtn.addEventListener('click', () => searchAssetOwnership());
}

// Setup pagination listeners
function setupPaginationListeners() {
  els.prevPageBtn.addEventListener('click', () => changePage(-1));
  els.nextPageBtn.addEventListener('click', () => changePage(1));
}

// Setup suggestion listeners for autocomplete
function setupSuggestionListeners() {
  // Manager search
  els.portfolioManager.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchManagers(els.portfolioManager.value), 300);
  });

  els.portfolioManager.addEventListener('focus', () => {
    if (els.managerSuggestions.children.length > 0) {
      els.managerSuggestions.classList.add('active');
    }
  });

  // Asset search
  els.ownershipAsset.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchAssets(els.ownershipAsset.value), 300);
  });

  els.ownershipAsset.addEventListener('focus', () => {
    if (els.assetSuggestions.children.length > 0) {
      els.assetSuggestions.classList.add('active');
    }
  });

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.fso-control-group')) {
      els.managerSuggestions.classList.remove('active');
      els.assetSuggestions.classList.remove('active');
    }
  });
}

// Setup export listener
function setupExportListener() {
  els.exportCsvBtn.addEventListener('click', exportToCsv);
}

// Search managers for autocomplete
async function searchManagers(query) {
  if (!query || query.length < 2) {
    els.managerSuggestions.classList.remove('active');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('query', query);

    const response = await fetch(`${BASE_URL}/search_managers`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok' && data.managers.length > 0) {
      els.managerSuggestions.innerHTML = data.managers.map(m => `
        <div class="fso-suggestion-item" data-cik="${m.cik}" data-name="${escapeHtml(m.name)}">
          <span class="name">${escapeHtml(m.name)}</span>
        </div>
      `).join('');

      // Add click handlers
      els.managerSuggestions.querySelectorAll('.fso-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          selectedManagerData = {
            cik: item.dataset.cik,
            name: item.dataset.name
          };
          els.portfolioManager.value = item.dataset.name;
          els.managerSuggestions.classList.remove('active');
          els.selectedManager.textContent = `Selected: ${item.dataset.name}`;
          els.selectedManager.classList.add('active');
        });
      });

      els.managerSuggestions.classList.add('active');
    } else {
      els.managerSuggestions.classList.remove('active');
    }
  } catch (err) {
    console.error('Manager search failed:', err);
  }
}

// Search assets for autocomplete
async function searchAssets(query) {
  if (!query || query.length < 2) {
    els.assetSuggestions.classList.remove('active');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('query', query);

    const response = await fetch(`${BASE_URL}/search_assets`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok' && data.assets.length > 0) {
      els.assetSuggestions.innerHTML = data.assets.map(a => `
        <div class="fso-suggestion-item" data-cusip="${a.cusip}" data-name="${escapeHtml(a.name)}">
          <span class="ticker">${a.cusip}</span>
          <span class="name">${escapeHtml(a.name)}</span>
        </div>
      `).join('');

      els.assetSuggestions.querySelectorAll('.fso-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          selectedAssetData = {
            cusip: item.dataset.cusip,
            name: item.dataset.name
          };
          els.ownershipAsset.value = item.dataset.name;
          els.assetSuggestions.classList.remove('active');
          els.selectedAsset.textContent = `Selected: ${item.dataset.cusip} - ${item.dataset.name}`;
          els.selectedAsset.classList.add('active');
        });
      });

      els.assetSuggestions.classList.add('active');
    } else {
      els.assetSuggestions.classList.remove('active');
    }
  } catch (err) {
    console.error('Asset search failed:', err);
  }
}

// Validate period selection
function validatePeriod() {
  const year = els.yearSelect.value;
  const quarter = els.quarterSelect.value;

  if (!year || !quarter) {
    showResult('Please select Year and Quarter', 'error');
    return false;
  }
  return true;
}

// #1 - Search Crowded Trades
async function searchCrowdedTrades(offset = null) {
  if (!validatePeriod()) return;

  const btn = els.crowdedSearchBtn;
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('year', els.yearSelect.value);
    formData.append('quarter', els.quarterSelect.value);
    formData.append('offset', offset !== null ? offset : els.crowdedOffset.value);
    formData.append('limit', els.crowdedLimit.value);

    const minScore = els.crowdedMinScore.value;
    if (minScore) {
      formData.append('min_crowd_score', minScore);
    }

    const response = await fetch(`${BASE_URL}/crowded_trades`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok') {
      currentData = data.data;
      currentPagination = data.pagination;
      currentQueryType = 'crowded';

      displayCrowdedResults(data);
      showResult(`Found ${data.pagination.total.toLocaleString()} assets`, 'success');
    } else {
      showResult(data.message || 'Search failed', 'error');
    }
  } catch (err) {
    console.error('Crowded search failed:', err);
    showResult(`Error: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// #2 - Search Capitulation
async function searchCapitulation(offset = null) {
  if (!validatePeriod()) return;

  const btn = els.capSearchBtn;
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('year', els.yearSelect.value);
    formData.append('quarter', els.quarterSelect.value);
    formData.append('offset', offset !== null ? offset : els.capOffset.value);
    formData.append('limit', els.capLimit.value);
    formData.append('min_owners', els.capMinOwners.value);

    const response = await fetch(`${BASE_URL}/capitulation_trades`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok') {
      currentData = data.data;
      currentPagination = data.pagination;
      currentQueryType = 'capitulation';

      displayCrowdedResults(data); // Same format as crowded
      showResult(`Found ${data.pagination.total.toLocaleString()} assets (min ${data.query_params.min_owners} owners)`, 'success');
    } else {
      showResult(data.message || 'Search failed', 'error');
    }
  } catch (err) {
    console.error('Capitulation search failed:', err);
    showResult(`Error: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// #3 - Search Portfolio
async function searchPortfolio(offset = 0) {
  if (!validatePeriod()) return;

  const managerName = els.portfolioManager.value.trim();
  if (!managerName) {
    showResult('Please enter a fund/manager name', 'error');
    return;
  }

  const btn = els.portfolioSearchBtn;
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('manager_name', managerName);
    formData.append('year', els.yearSelect.value);
    formData.append('quarter', els.quarterSelect.value);
    formData.append('offset', offset);
    formData.append('limit', els.portfolioLimit.value);

    const response = await fetch(`${BASE_URL}/portfolio_viewer`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok') {
      currentData = data.data;
      currentPagination = data.pagination;
      currentQueryType = 'portfolio';

      if (data.selected_manager) {
        els.selectedManager.textContent = `Selected: ${data.selected_manager.name}`;
        els.selectedManager.classList.add('active');
        selectedManagerData = data.selected_manager;
      }

      displayPortfolioResults(data);

      if (data.data.length === 0) {
        showResult(data.message || 'No holdings found for this manager/period', 'info');
      } else {
        showResult(`Found ${data.pagination.total.toLocaleString()} holdings`, 'success');
      }
    } else {
      showResult(data.message || 'Search failed', 'error');
    }
  } catch (err) {
    console.error('Portfolio search failed:', err);
    showResult(`Error: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// #4 - Search Asset Ownership
async function searchAssetOwnership(offset = 0) {
  if (!validatePeriod()) return;

  const assetId = els.ownershipAsset.value.trim();
  if (!assetId) {
    showResult('Please enter an asset identifier', 'error');
    return;
  }

  const btn = els.ownershipSearchBtn;
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('asset_identifier', assetId);
    formData.append('year', els.yearSelect.value);
    formData.append('quarter', els.quarterSelect.value);
    formData.append('offset', offset);
    formData.append('limit', els.ownershipLimit.value);

    const response = await fetch(`${BASE_URL}/asset_ownership`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok') {
      currentData = data.data;
      currentPagination = data.pagination;
      currentQueryType = 'ownership';

      if (data.selected_asset) {
        els.selectedAsset.textContent = `Selected: ${data.selected_asset.ticker || ''} - ${data.selected_asset.name}`;
        els.selectedAsset.classList.add('active');
        selectedAssetData = data.selected_asset;
      }

      // Display stats
      if (data.stats) {
        displayAssetStats(data.stats);
      }

      displayOwnershipResults(data);

      if (data.data.length === 0) {
        showResult(data.message || 'No owners found for this asset/period', 'info');
      } else {
        showResult(`Found ${data.stats.total_owners.toLocaleString()} institutional owners`, 'success');
      }
    } else {
      showResult(data.message || 'Search failed', 'error');
    }
  } catch (err) {
    console.error('Ownership search failed:', err);
    showResult(`Error: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// Display crowded/capitulation results - UPDATED FOR NEO4J DATA
// Data comes with: rank, asset, owners, total_weight, crowd_score
function displayCrowdedResults(data) {
  const title = currentQueryType === 'crowded' ? '🔥 Crowded Trades Ranking' : '📉 Capitulation Ranking';
  els.resultsTitle.textContent = title;

  // Build header - simplified: only Asset column (no ticker/name/cusip separate)
  els.tableHead.innerHTML = `
    <tr>
      <th>Rank</th>
      <th>Asset</th>
      <th class="numeric">Owners</th>
      <th class="numeric">Total Weight</th>
      <th class="numeric">Crowd Score</th>
    </tr>
  `;

  // Build body - use 'asset' field directly
  els.tableBody.innerHTML = data.data.map(row => `
    <tr>
      <td class="rank">#${row.rank}</td>
      <td class="ticker">${escapeHtml(row.asset || 'Unknown')}</td>
      <td class="numeric owners">${row.owners.toLocaleString()}</td>
      <td class="numeric weight">${formatScientific(row.total_weight)}</td>
      <td class="numeric crowd-score">${formatScientific(row.crowd_score)}</td>
    </tr>
  `).join('');

  updatePagination(data.pagination);
  els.resultsContainer.classList.add('active');
  els.exportContainer.classList.remove('fso-hidden');
}

// Display portfolio results
function displayPortfolioResults(data) {
  els.resultsTitle.textContent = `💼 Portfolio Holdings - ${data.selected_manager?.name || 'Unknown'}`;

  // Build header
  els.tableHead.innerHTML = `
    <tr>
      <th>Ticker</th>
      <th>Name</th>
      <th>CUSIP</th>
      <th class="numeric">Weight</th>
      <th class="numeric">Shares</th>
      <th class="numeric">Value ($)</th>
    </tr>
  `;

  // Build body
  els.tableBody.innerHTML = data.data.map(row => `
    <tr>
      <td class="ticker">${row.ticker || 'N/A'}</td>
      <td>${escapeHtml(row.name || 'Unknown')}</td>
      <td>${row.cusip}</td>
      <td class="numeric weight">${formatScientific(row.weight)}</td>
      <td class="numeric">${row.shares ? row.shares.toLocaleString() : 'N/A'}</td>
      <td class="numeric">${row.value ? formatCurrency(row.value) : 'N/A'}</td>
    </tr>
  `).join('');

  updatePagination(data.pagination);
  els.resultsContainer.classList.add('active');
  els.exportContainer.classList.remove('fso-hidden');
}

// Display ownership results - Uses 'name' field from AssetOwnerDTO
function displayOwnershipResults(data) {
  els.resultsTitle.textContent = `🏛️ Institutional Owners - ${data.selected_asset?.name || 'Unknown'}`;

  els.tableHead.innerHTML = `
    <tr>
      <th>Manager</th>
      <th class="numeric">Weight</th>
    </tr>
  `;

  els.tableBody.innerHTML = data.data.map(row => `
    <tr>
      <td>${escapeHtml(row.name || 'Unknown')}</td>
      <td class="numeric weight">${formatScientific(row.weight)}</td>
    </tr>
  `).join('');

  updatePagination(data.pagination);
  els.resultsContainer.classList.add('active');
  els.exportContainer.classList.remove('fso-hidden');
}

// Display asset stats
function displayAssetStats(stats) {
  els.assetStats.innerHTML = `
    <div class="fso-stat">
      <div class="fso-stat-value">${stats.total_owners.toLocaleString()}</div>
      <div class="fso-stat-label">Total Owners</div>
    </div>
    <div class="fso-stat">
      <div class="fso-stat-value">${formatScientific(stats.total_weight)}</div>
      <div class="fso-stat-label">Total Weight</div>
    </div>
    <div class="fso-stat">
      <div class="fso-stat-value">${formatScientific(stats.crowd_score)}</div>
      <div class="fso-stat-label">Crowd Score</div>
    </div>
  `;
  els.assetStats.classList.add('active');
}

// Update pagination controls
function updatePagination(pagination) {
  const { offset, limit, total, has_more } = pagination;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  els.paginationInfo.textContent = `Showing ${offset + 1}-${Math.min(offset + limit, total)} of ${total.toLocaleString()}`;
  els.pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;

  els.prevPageBtn.disabled = offset === 0;
  els.nextPageBtn.disabled = !has_more;
}

// Change page
function changePage(direction) {
  if (!currentPagination) return;

  const newOffset = currentPagination.offset + (direction * currentPagination.limit);

  if (newOffset < 0 || newOffset >= currentPagination.total) return;

  // Update offset input for the current tab
  if (currentQueryType === 'crowded') {
    els.crowdedOffset.value = newOffset;
    searchCrowdedTrades(newOffset);
  } else if (currentQueryType === 'capitulation') {
    els.capOffset.value = newOffset;
    searchCapitulation(newOffset);
  } else if (currentQueryType === 'portfolio') {
    searchPortfolio(newOffset);
  } else if (currentQueryType === 'ownership') {
    searchAssetOwnership(newOffset);
  }
}

// Format number in scientific notation for large values
function formatScientific(num) {
  if (num === null || num === undefined) return 'N/A';

  const absNum = Math.abs(num);

  // Handle very large numbers (from Neo4j crowd_score)
  if (absNum >= 1e18) {
    return `${(num / 1e18).toFixed(2)}E`;  // Exa
  } else if (absNum >= 1e15) {
    return `${(num / 1e15).toFixed(2)}P`;  // Peta
  } else if (absNum >= 1e12) {
    return `${(num / 1e12).toFixed(2)}T`;  // Tera
  } else if (absNum >= 1e9) {
    return `${(num / 1e9).toFixed(2)}B`;   // Billion
  } else if (absNum >= 1e6) {
    return `${(num / 1e6).toFixed(2)}M`;   // Million
  } else if (absNum >= 1e4) {
    return `${(num / 1e3).toFixed(1)}K`;   // Thousand
  } else if (absNum >= 100) {
    return num.toFixed(0);
  } else if (absNum >= 1) {
    return num.toFixed(2);
  } else if (absNum > 0) {
    return num.toExponential(2);
  }
  return '0';
}

// Format currency
function formatCurrency(num) {
  if (num === null || num === undefined) return 'N/A';

  if (num >= 1e12) {
    return `$${(num / 1e12).toFixed(2)}T`;
  } else if (num >= 1e9) {
    return `$${(num / 1e9).toFixed(2)}B`;
  } else if (num >= 1e6) {
    return `$${(num / 1e6).toFixed(2)}M`;
  } else if (num >= 1e3) {
    return `$${(num / 1e3).toFixed(1)}K`;
  }
  return `$${num.toFixed(2)}`;
}

// Show result message
function showResult(message, type = 'info') {
  els.resultMessage.textContent = message;
  els.resultMessage.className = `fso-result active ${type}`;

  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      els.resultMessage.classList.remove('active');
    }, 5000);
  }
}

// Clear results
function clearResults() {
  els.resultsContainer.classList.remove('active');
  els.exportContainer.classList.add('fso-hidden');
  els.resultMessage.classList.remove('active');
  els.selectedManager.classList.remove('active');
  els.selectedAsset.classList.remove('active');
  els.assetStats.classList.remove('active');
  currentData = [];
  currentPagination = null;
  currentQueryType = null;
}

// Export to CSV
function exportToCsv() {
  if (!currentData || currentData.length === 0) {
    showResult('No data to export', 'error');
    return;
  }

  // Get headers from first row
  const headers = Object.keys(currentData[0]);

  // Build CSV
  let csv = headers.join(',') + '\n';

  currentData.forEach(row => {
    const values = headers.map(header => {
      const value = row[header];
      // Escape commas and quotes
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value ?? '';
    });
    csv += values.join(',') + '\n';
  });

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  const filename = `${currentQueryType}_${els.yearSelect.value}_Q${els.quarterSelect.value}.csv`;

  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showResult(`Exported ${currentData.length} rows to ${filename}`, 'success');
}

// Escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}