// deep_company_analysis.js - CÓDIGO ORIGINAL + POPUP + VALIDACIÓN ARREGLADA

const BASE_URL = '/deep_company_analysis';

// DOM elements
const els = {
  form: document.getElementById('analysisForm'),
  symbolInput: document.getElementById('symbolInput'),
  docTypeSelect: document.getElementById('docTypeSelect'),
  yearInput: document.getElementById('yearInput'),
  quarterSelect: document.getElementById('quarterSelect'),
  freeTextRow: document.getElementById('freeTextRow'),
  freeTextArea: document.getElementById('freeTextArea'),
  sentimentBtn: document.getElementById('sentimentBtn'),
  topicsBtn: document.getElementById('topicsBtn'),
  freeAnalysisBtn: document.getElementById('freeAnalysisBtn'),
  freeAnalysisPromptSection: document.getElementById('freeAnalysisPromptSection'),
  freeAnalysisPrompt: document.getElementById('freeAnalysisPrompt'),
  resultMessage: document.getElementById('resultMessage'),
  topicModal: document.getElementById('topicModal'),
  closeTopicModal: document.getElementById('closeTopicModal'),
  tagNameInput: document.getElementById('tagNameInput'),
  topicsInput: document.getElementById('topicsInput'),
  submitTopics: document.getElementById('submitTopics'),
  topicProgressContainer: document.getElementById('topicProgressContainer'),
  topicProgressMessages: document.getElementById('topicProgressMessages'),
  uploadFileBtn: document.getElementById('uploadFileBtn'),
  fileUploadInput: document.getElementById('fileUploadInput'),
  uploadedFileName: document.getElementById('uploadedFileName'),
  clearFileBtn: document.getElementById('clearFileBtn'),
  promptSelector: document.getElementById('promptSelector'),
  resultsModal: document.getElementById('resultsModal'),
  resultsModalTitle: document.getElementById('resultsModalTitle'),
  resultsModalContent: document.getElementById('resultsModalContent'),
  closeResultsModal: document.getElementById('closeResultsModal'),
  k8Row: document.getElementById('k8Row'),
  downloadK8Btn: document.getElementById('downloadK8Btn'),
  k8Status: document.getElementById('k8Status'),
  k8TextArea: document.getElementById('k8TextArea'),
  f4Row: document.getElementById('f4Row'),
  downloadF4Btn: document.getElementById('downloadF4Btn'),
  f4Status: document.getElementById('f4Status'),
  f4TextArea: document.getElementById('f4TextArea'),

};

// State
let currentSymbol = null;
let symbolValidated = false;
let validationDebounceTimer = null;

// Initialize
function init() {
  setupEventListeners();
  setupFileUploadListeners();
  setupPromptSelectorListener();
  setupResultsModalListeners();
  setAnalysisButtonsEnabled(false);
  els.downloadK8Btn.addEventListener('click', handleDownloadK8);
  els.downloadF4Btn.addEventListener('click', handleDownloadF4);
}

// NUEVO: Centralizar habilitación de botones
function setAnalysisButtonsEnabled(enabled) {
  els.sentimentBtn.disabled = !enabled;
  els.topicsBtn.disabled = !enabled;
  els.freeAnalysisBtn.disabled = !enabled;
}

// Setup event listeners
function setupEventListeners() {
  els.docTypeSelect.addEventListener('change', handleDocTypeChange);

  // CAMBIADO: Validar en input (con debounce) Y en blur
  els.symbolInput.addEventListener('input', handleSymbolInput);
  els.symbolInput.addEventListener('blur', validateSymbol);

  els.sentimentBtn.addEventListener('click', () => handleAnalysis('sentiment'));
  els.topicsBtn.addEventListener('click', openTopicModal);
  els.freeAnalysisBtn.addEventListener('click', () => handleAnalysis('free'));
  els.closeTopicModal.addEventListener('click', closeTopicModal);
  els.topicModal.addEventListener('click', (e) => {
    if (e.target === els.topicModal) closeTopicModal();
  });
  els.submitTopics.addEventListener('click', handleTopicAnalysis);
}

// NUEVO: Debounce para validación en input
function handleSymbolInput() {
  clearTimeout(validationDebounceTimer);

  const symbol = els.symbolInput.value.trim();

  if (!symbol) {
    symbolValidated = false;
    currentSymbol = null;
    setAnalysisButtonsEnabled(false);
    showResult('', 'info'); // Limpiar mensaje
    return;
  }

  // Debounce 500ms
  validationDebounceTimer = setTimeout(() => {
    validateSymbol();
  }, 500);
}

function setupResultsModalListeners() {
  els.closeResultsModal.addEventListener('click', closeResultsModal);
  els.resultsModal.addEventListener('click', (e) => {
    if (e.target === els.resultsModal) closeResultsModal();
  });
}

function showResultsModal(title, content) {
  els.resultsModalTitle.textContent = title;
  els.resultsModalContent.innerHTML = content;
  els.resultsModal.classList.remove('dca-hidden');
}

function closeResultsModal() {
  els.resultsModal.classList.add('dca-hidden');
}

// FILE UPLOAD
function setupFileUploadListeners() {
  els.uploadFileBtn.addEventListener('click', () => {
    els.fileUploadInput.click();
  });
  els.fileUploadInput.addEventListener('change', handleFileUpload);
  els.clearFileBtn.addEventListener('click', clearUploadedFile);
}

async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  els.uploadedFileName.textContent = file.name;
  els.clearFileBtn.classList.remove('dca-hidden');
  try {
    const fileType = file.name.split('.').pop().toLowerCase();
    let extractedText = '';
    if (fileType === 'txt') {
      extractedText = await readTextFile(file);
    } else if (fileType === 'pdf') {
      extractedText = await extractTextFromPDF(file);
    } else if (fileType === 'doc' || fileType === 'docx') {
      extractedText = await extractTextFromWord(file);
    } else {
      showResult('Unsupported file type. Please use .txt, .pdf, .doc, or .docx', 'error', false);
      clearUploadedFile();
      return;
    }
    els.freeTextArea.value = extractedText;
    showResult(`✓ Text extracted from ${file.name} (${extractedText.length.toLocaleString()} characters)`, 'info', true);
  } catch (error) {
    console.error('Error extracting text from file:', error);
    showResult(`Error extracting text: ${error.message}`, 'error', false);
    clearUploadedFile();
  }
}

function clearUploadedFile() {
  els.fileUploadInput.value = '';
  els.uploadedFileName.textContent = '';
  els.clearFileBtn.classList.add('dca-hidden');
  els.freeTextArea.value = '';
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(new Error('Failed to read text file'));
    reader.readAsText(file);
  });
}

async function extractTextFromPDF(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF.js library not loaded. Please contact administrator.');
  }
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    fullText += pageText + '\n\n';
  }
  return fullText.trim();
}

async function extractTextFromWord(file) {
  if (typeof mammoth === 'undefined') {
    throw new Error('Mammoth.js library not loaded. Please contact administrator.');
  }
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

// PROMPT LOADING
function setupPromptSelectorListener() {
  els.promptSelector.addEventListener('change', handlePromptSelection);
}

async function handlePromptSelection() {
  const selectedPrompt = els.promptSelector.value;
  if (!selectedPrompt) return;
  try {
    const promptFiles = {
      'standard_earnings': '/static/prompts/standard_earnings_transcripts.txt',
      'k8_events_analysis': '/static/prompts/k8_events_analysis.txt',
      'f4_insider_analysis': '/static/prompts/f4_insider_analysis.txt'
    };
    const promptFile = promptFiles[selectedPrompt];
    if (!promptFile) {
      showResult('Prompt file not found', 'error', false);
      return;
    }
    const response = await fetch(promptFile);
    if (!response.ok) {
      throw new Error(`Failed to load prompt: ${response.statusText}`);
    }
    const promptText = await response.text();
    els.freeAnalysisPrompt.value = promptText;
    showResult(`✓ Loaded prompt: ${els.promptSelector.options[els.promptSelector.selectedIndex].text}`, 'info', true);
  } catch (error) {
    console.error('Error loading prompt:', error);
    showResult(`Error loading prompt: ${error.message}`, 'error', false);
  }
}

// Handle document type change
function handleDocTypeChange() {
  const docType = els.docTypeSelect.value;

  // Hide all optional rows
  els.freeTextRow.classList.add('dca-hidden');
  els.k8Row.classList.add('dca-hidden');
  els.quarterSelect.classList.add('dca-hidden');

  // Hide free analysis section by default
  els.freeAnalysisBtn.classList.add('dca-hidden');
  els.freeAnalysisPromptSection.classList.add('dca-hidden');

  // Show standard buttons by default
  els.sentimentBtn.classList.remove('dca-hidden');
  els.topicsBtn.classList.remove('dca-hidden');

  if (docType === '10Q') {
    els.quarterSelect.classList.remove('dca-hidden');
  } else if (docType === 'FREE_TEXT') {
    els.freeTextRow.classList.remove('dca-hidden');
    els.freeAnalysisBtn.classList.remove('dca-hidden');
    els.freeAnalysisPromptSection.classList.remove('dca-hidden');
    // Hide sentiment/topics for free text
    els.sentimentBtn.classList.add('dca-hidden');
    els.topicsBtn.classList.add('dca-hidden');
  } else if (docType === '8K') {
    els.k8Row.classList.remove('dca-hidden');
    els.freeAnalysisBtn.classList.remove('dca-hidden');
    els.freeAnalysisPromptSection.classList.remove('dca-hidden');
    els.sentimentBtn.classList.add('dca-hidden');
    els.topicsBtn.classList.add('dca-hidden');
  }
  else if (docType === '4F') {  // NEW
    els.f4Row.classList.remove('dca-hidden');
    els.freeAnalysisBtn.classList.remove('dca-hidden');
    els.freeAnalysisPromptSection.classList.remove('dca-hidden');
    els.sentimentBtn.classList.add('dca-hidden');
    els.topicsBtn.classList.add('dca-hidden');
  }
}


async function validateSymbol() {
  const symbol = els.symbolInput.value.trim().toUpperCase();

  if (!symbol) {
    symbolValidated = false;
    currentSymbol = null;
    setAnalysisButtonsEnabled(false);
    return;
  }

  try {
    const formData = new FormData();
    formData.append('symbol', symbol);

    const response = await fetch(`${BASE_URL}/validate_symbol`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok' && data.valid) {
      currentSymbol = data.symbol;
      symbolValidated = true;
      setAnalysisButtonsEnabled(true); // Habilitar botones
      showResult(`✓ Symbol ${data.symbol} validated: ${data.name}`, 'success', false); // NO auto-hide
    } else {
      symbolValidated = false;
      currentSymbol = null;
      setAnalysisButtonsEnabled(false); // Deshabilitar botones
      showResult(`✗ Symbol ${symbol} not found in database`, 'error', false); // NO auto-hide
    }
  } catch (err) {
    console.error('Symbol validation failed:', err);
    symbolValidated = false;
    currentSymbol = null;
    setAnalysisButtonsEnabled(false);
    showResult(`Error validating symbol: ${err.message}`, 'error', false);
  }
}

// Open topic modal
function openTopicModal() {
  if (!els.form.checkValidity()) {
    els.form.reportValidity();
    return;
  }
  if (!symbolValidated) {
    showResult('Please enter a valid symbol first', 'error', true);
    els.symbolInput.focus();
    return;
  }
  els.tagNameInput.value = '';
  els.topicsInput.value = '';
  els.topicProgressContainer.classList.add('dca-hidden');
  els.topicProgressMessages.innerHTML = '';
  els.topicModal.classList.remove('dca-hidden');
}

// Close topic modal
function closeTopicModal() {
  els.topicModal.classList.add('dca-hidden');
}

function addProgressMessage(msg) {
  const html = `<div style="color:#8B949E; margin-top:4px;">${escapeHtml(msg)}</div>`;
  els.topicProgressMessages.innerHTML += html;
  els.topicProgressContainer.scrollTop = els.topicProgressContainer.scrollHeight;
}

// Handle topic analysis from modal
async function handleTopicAnalysis() {
  const tagName = els.tagNameInput.value.trim();
  const topicsText = els.topicsInput.value.trim();
  if (!tagName) {
    alert('Please enter a tag name (e.g., ai_innovation)');
    els.tagNameInput.focus();
    return;
  }
  if (!topicsText) {
    alert('Please enter at least one topic phrase');
    els.topicsInput.focus();
    return;
  }
  const btn = els.submitTopics;
  btn.classList.add('loading');
  btn.disabled = true; // AGREGADO
  els.topicProgressContainer.classList.remove('dca-hidden');
  els.topicProgressMessages.innerHTML =
    '<div style="color:#58A6FF;">🚀 Starting analysis...</div>';
  try {
    const symbol = els.symbolInput.value.trim().toUpperCase();
    const docType = els.docTypeSelect.value;
    const year = els.yearInput.value;
    const quarter = els.quarterSelect.value || null;
    const freeText = els.freeTextArea.value || null;
    const formData = new FormData();
    formData.append('symbol', symbol);
    formData.append('doc_type', docType);
    formData.append('year', year);
    formData.append('tag_name', tagName);
    formData.append('topic_list', topicsText);
    if (quarter) formData.append('quarter', quarter);
    if (freeText) formData.append('free_text', freeText);
    const response = await fetch(`${BASE_URL}/analyze_topics`, {
      method: 'POST',
      body: formData
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalData = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        if (!event.startsWith('data: ')) continue;
        const json = JSON.parse(event.slice(6));
        if (json.type === 'progress') {
          addProgressMessage(json.message);
        } else if (json.type === 'result') {
          finalData = json.data;
        } else if (json.type === 'error') {
          throw new Error(json.message);
        }
      }
    }
    if (!finalData) {
      throw new Error('No result data received from server');
    }
    closeTopicModal();
    displayResults(finalData, 'topics');
  } catch (err) {
    console.error('Topic analysis failed:', err);
    els.topicProgressMessages.innerHTML +=
      `<div style="color:#F85149;">❌ Error: ${err.message}</div>`;
    alert(`Analysis error: ${err.message}`);
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false; // AGREGADO
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Handle analysis button clicks
/**
 * Main analysis handler. Designed to be resilient to new document sources.
 * It automatically selects the correct text source based on the document type
 * to ensure the backend always receives the required 'free_text' field.
 */
async function handleAnalysis(analysisType) {
    // 1. INITIAL FORM VALIDATION
    if (!els.form.checkValidity()) {
        els.form.reportValidity();
        return;
    }

    if (!symbolValidated) {
        showResult('Please enter a valid symbol first', 'error', true);
        els.symbolInput.focus();
        return;
    }

    // 2. RESILIENT CONTENT EXTRACTION
    const docType = els.docTypeSelect.value;
    let textToAnalyze = "";

    if (docType === '8K') {
        textToAnalyze = els.k8TextArea.value.trim();
    } else if (docType === '4F') {
        textToAnalyze = els.f4TextArea.value.trim();
    } else if (docType === 'FREE_TEXT') {
        textToAnalyze = els.freeTextArea.value.trim();
    }
    // Para 10K y 10Q, textToAnalyze queda vacío - el backend descarga de SEC

    // Guard clause: SOLO para tipos que requieren texto local
    const requiresLocalText = ['8K', '4F', 'FREE_TEXT'].includes(docType);
    if (requiresLocalText && !textToAnalyze) {
        showResult(`No content found to analyze for ${docType}. Please download or paste text.`, 'error', true);
        return;
    }

    // 3. UI STATE & BUTTON SETUP
    let btn = (analysisType === 'sentiment') ? els.sentimentBtn : els.freeAnalysisBtn;
    const promptValue = els.freeAnalysisPrompt.value.trim();

    // The LLM "Free Analysis" requires a specific instructions prompt
    if (analysisType === 'free' && !promptValue) {
        showResult('Please enter a custom prompt for the free analysis', 'error', true);
        els.freeAnalysisPrompt.focus();
        return;
    }

    // Trigger loading state for the specific button
    btn.classList.add('loading');
    btn.disabled = true;

    try {
        // 4. DATA PACKAGING (FormData)
        const formData = new FormData();
        formData.append('symbol', els.symbolInput.value.trim().toUpperCase());
        formData.append('doc_type', docType);
        formData.append('year', els.yearInput.value);

        // Solo enviar free_text si hay contenido
        if (textToAnalyze) {
            formData.append('free_text', textToAnalyze);
        }

        if (els.quarterSelect.value) {
            formData.append('quarter', els.quarterSelect.value);
        }

        // Endpoint routing
        let endpoint = `${BASE_URL}/analyze_sentiment`;
        if (analysisType === 'free') {
            endpoint = `${BASE_URL}/free_analysis`;
            formData.append('prompt', promptValue);
        }

        // 5. ASYNC SERVER REQUEST
        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `Server Error: ${response.status}`);
        }

        // Success: Render results in the results modal
        displayResults(data, analysisType);

    } catch (err) {
        console.error('Analysis execution failed:', err);
        showResult(`Analysis error: ${err.message}`, 'error', true);
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
}
// Display analysis results - CON POPUP
function displayResults(data, analysisType) {
  let html = '';

  if (analysisType === 'sentiment') {
    if (data.status === 'failed' || data.status === 'error') {
      html = `
        <div class="dca-result-display">
          <h4>❌ Analysis Failed</h4>
          <p style="color:#F85149; font-size:15px;">
            <strong>Error:</strong> ${data.message || 'Unknown error occurred'}
          </p>
          ${data.error_type ? `<p style="color:#8B949E; font-size:13px;">Error type: ${data.error_type}</p>` : ''}
        </div>
      `;
    } else if (data.status === 'completed' && data.analysis) {
      const analysis = data.analysis || {};
      const metrics = analysis.metrics || {};
      const topPos = analysis.top_positive || [];
      const topNeg = analysis.top_negative || [];
      html = `
        <div class="dca-result-display">
          <h4>📊 Sentiment Analysis Results</h4>
          <div style="background:#161B22; padding:16px; border-radius:8px; margin-bottom:16px;">
            <div style="color:#8B949E; font-size:13px; margin-bottom:8px;">
              <strong>Symbol:</strong> ${data.symbol || 'N/A'} |
              <strong>Year:</strong> ${data.year || 'N/A'} |
              <strong>Period:</strong> ${data.period || 'N/A'}
            </div>
          </div>
          <div class="metric">
            <span class="metric-label">MD&A Sentiment Score</span>
            <span class="metric-value" style="color: ${getToneColor(metrics.mdna_sentiment || 0)};">
              ${(metrics.mdna_sentiment || 0).toFixed(3)}
            </span>
          </div>
          <div class="metric">
            <span class="metric-label">Financial Sentences Analyzed</span>
            <span class="metric-value">${metrics.financial_sentences || 0}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Forward-Looking Language</span>
            <span class="metric-value" style="color: ${(metrics.forward_ratio || 0) > 0.3 ? '#3FB950' : '#8B949E'};">
              ${((metrics.forward_ratio || 0) * 100).toFixed(1)}%
            </span>
          </div>
          <div class="metric">
            <span class="metric-label">Hedging Language</span>
            <span class="metric-value" style="color: ${(metrics.hedge_ratio || 0) > 0.2 ? '#F85149' : '#8B949E'};">
              ${((metrics.hedge_ratio || 0) * 100).toFixed(1)}%
            </span>
          </div>
          ${topPos.length > 0 ? `
            <h5 style="color:#3FB950; margin-top:24px; font-size:16px;">✅ Most Positive Statements:</h5>
            <div style="max-height:200px; overflow-y:auto;">
              ${topPos.map(item => `
                <div style="background:#1A3421; padding:12px; margin:8px 0; border-radius:6px; border-left:3px solid #3FB950;">
                  <div style="color:#E6EDF3; font-size:14px; line-height:1.5; margin-bottom:6px;">${item.sent}</div>
                  <div style="color:#8B949E; font-size:12px;">Score: ${item.score.toFixed(3)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${topNeg.length > 0 ? `
            <h5 style="color:#F85149; margin-top:24px; font-size:16px;">⚠️ Most Negative Statements:</h5>
            <div style="max-height:200px; overflow-y:auto;">
              ${topNeg.map(item => `
                <div style="background:#3A1214; padding:12px; margin:8px 0; border-radius:6px; border-left:3px solid #F85149;">
                  <div style="color:#E6EDF3; font-size:14px; line-height:1.5; margin-bottom:6px;">${item.sent}</div>
                  <div style="color:#8B949E; font-size:12px;">Score: ${item.score.toFixed(3)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    } else {
      html = `
        <div class="dca-result-display">
          <h4>⚠️ Unexpected Response</h4>
          <p style="color:#9E6A03;">Received data but in unexpected format. Status: ${data.status || 'unknown'}</p>
          <pre style="background:#161B22; padding:12px; border-radius:6px; font-size:12px; overflow-x:auto;">${JSON.stringify(data, null, 2)}</pre>
        </div>
      `;
    }

  } else if (analysisType === 'topics') {
    if (data.status === 'failed' || data.status === 'error') {
      html = `
        <div class="dca-result-display">
          <h4>❌ Topic Analysis Failed</h4>
          <p style="color:#F85149; font-size:15px;">
            <strong>Error:</strong> ${data.message || 'Unknown error occurred'}
          </p>
          ${data.error_type ? `<p style="color:#8B949E; font-size:13px;">Error type: ${data.error_type}</p>` : ''}
        </div>
      `;
    } else if (data.status === 'completed' && data.analysis) {
      const analysis = data.analysis || {};
      const topics = analysis.topics || {};
      const topicKeys = Object.keys(topics);
      html = `
        <div class="dca-result-display">
          <h4>🏷️ Topic Analysis Results</h4>
          <div style="background:#161B22; padding:16px; border-radius:8px; margin-bottom:16px;">
            <div style="color:#8B949E; font-size:13px; margin-bottom:8px;">
              <strong>Symbol:</strong> ${data.symbol || 'N/A'} |
              <strong>Year:</strong> ${data.year || 'N/A'} |
              <strong>Period:</strong> ${data.period || 'N/A'}
            </div>
            <div style="color:#8B949E; font-size:13px;">
              <strong>Source:</strong> ${data.source || 'N/A'} |
              <strong>Topics:</strong> ${topicKeys.length}
            </div>
          </div>
          ${topicKeys.map(topicKey => {
            const topic = topics[topicKey];
            const matches = topic.matches || [];
            const topScore = topic.top_score || 0;
            return `
              <div class="dca-topic-card" style="margin-bottom:20px; background:#161B22; padding:16px; border-radius:8px; border-left:4px solid #58A6FF;">
                <h5 style="color:#58A6FF; margin:0 0 12px 0; font-size:18px;">
                  ${topicKey.replace(/_/g, ' ').toUpperCase()}
                </h5>
                <div style="margin-bottom:16px;">
                  <span style="color:#8B949E; font-size:14px;">
                    Top Score: <span style="color:#3FB950; font-weight:bold;">${(topScore * 100).toFixed(1)}%</span> |
                    Matches: <span style="color:#58A6FF; font-weight:bold;">${matches.length}</span>
                  </span>
                </div>
                ${topic.summary ? `
                  <div style="color:#8B949E; font-size:13px; font-style:italic; margin-bottom:16px; padding:12px; background:#0D1117; border-radius:6px;">
                    ${topic.summary}
                  </div>
                ` : ''}
                ${matches.length > 0 ? `
                  <div style="margin-top:16px;">
                    <h6 style="color:#C9D1D9; font-size:14px; margin-bottom:12px;">📝 Top Matches:</h6>
                    <div style="max-height:400px; overflow-y:auto;">
                      ${matches.map((match, idx) => `
                        <div style="background:#0D1117; padding:12px; margin-bottom:12px; border-radius:6px; border-left:3px solid ${getScoreColor(match.score)};">
                          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <span style="color:#58A6FF; font-size:12px; font-weight:bold;">
                              Match #${idx + 1} | Chunk ${match.chunk_idx || 'N/A'}
                            </span>
                            <span style="color:${getScoreColor(match.score)}; font-size:12px; font-weight:bold;">
                              ${(match.score * 100).toFixed(1)}%
                            </span>
                          </div>
                          ${match.matched_phrase ? `
                            <div style="color:#3FB950; font-size:13px; margin-bottom:8px; padding:8px; background:#1A3421; border-radius:4px;">
                              <strong>Phrase:</strong> "${match.matched_phrase}"
                            </div>
                          ` : ''}
                          <div style="color:#C9D1D9; font-size:13px; line-height:1.6;">
                            ${(match.chunk_text || 'No text available').replace(/<[^>]*>/g, '')}
                          </div>
                        </div>
                      `).join('')}
                    </div>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else {
      html = `
        <div class="dca-result-display">
          <h4>⚠️ Unexpected Response</h4>
          <p style="color:#9E6A03;">Received data but in unexpected format. Status: ${data.status || 'unknown'}</p>
          <pre style="background:#161B22; padding:12px; border-radius:6px; font-size:12px; overflow-x:auto;">${JSON.stringify(data, null, 2)}</pre>
        </div>
      `;
    }

  } else if (analysisType === 'free') {
    if (data.status === 'error') {
      html = `
        <div class="dca-result-display">
          <h4>❌ Free Analysis Failed</h4>
          <p style="color:#F85149; font-size:15px;">
            <strong>Error:</strong> ${data.message || 'Unknown error occurred'}
          </p>
        </div>
      `;
    } else if (data.status === 'completed' && data.analysis && data.analysis.response) {
      const response = data.analysis.response;
      html = `
        <div class="dca-result-display">
          <h4>🤖 Free Analysis Results</h4>
          <div style="background:#161B22; padding:20px; border-radius:8px; border:1px solid #30363D; margin-top:16px;">
            <pre style="white-space:pre-wrap; margin:0; color:#C9D1D9; font-size:14px; line-height:1.6; text-align:left;">${response}</pre>
          </div>
        </div>
      `;
    } else {
      html = `
        <div class="dca-result-display">
          <h4>⚠️ Unexpected Response</h4>
          <p style="color:#9E6A03;">Received data but in unexpected format.</p>
          <pre style="background:#161B22; padding:12px; border-radius:6px; font-size:12px; overflow-x:auto;">${JSON.stringify(data, null, 2)}</pre>
        </div>
      `;
    }
  }

  // MOSTRAR EN POPUP
  let title = '';
  if (analysisType === 'sentiment') title = '📊 Sentiment Analysis';
  else if (analysisType === 'topics') title = '🏷️ Topic Analysis';
  else if (analysisType === 'free') title = '🤖 Free Analysis';

  showResultsModal(title, html);
  showResult(`✓ Analysis completed successfully`, 'success', true);
}

// CAMBIADO: Control de auto-hide
function showResult(message, type = 'info', autoHide = true) {
  if (!message) {
    els.resultMessage.style.display = 'none';
    return;
  }

  const colors = {
    success: '#238636',
    error: '#DA3633',
    info: '#58A6FF',
    warning: '#BB8009'
  };
  const icons = {
    success: '✓',
    error: '✗',
    info: 'ℹ',
    warning: '⚠'
  };

  els.resultMessage.style.color = colors[type] || colors.info;
  els.resultMessage.textContent = `${icons[type] || ''} ${message}`;
  els.resultMessage.style.display = 'block';

  // SOLO auto-hide si autoHide=true Y es info/success
  if (autoHide && (type === 'info' || type === 'success')) {
    setTimeout(() => {
      if (els.resultMessage.textContent.includes(message)) {
        els.resultMessage.style.display = 'none';
      }
    }, 5000);
  }
}

// Get color based on tone score
function getToneColor(score) {
  if (score > 0.7) return '#3FB950';
  if (score > 0.4) return '#9E6A03';
  return '#F85149';
}

// Get color based on match score (for topics)
function getScoreColor(score) {
  if (score > 0.6) return '#3FB950';
  if (score > 0.4) return '#9E6A03';
  return '#F85149';
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


// ─────────────────────────────────────────────────────────────
// Generic SEC Report Download Handler (refactored)
// ─────────────────────────────────────────────────────────────

/**
 * Generic handler for downloading SEC reports
 * @param {Object} config - Configuration object
 * @param {string} config.endpoint - API endpoint (e.g., '/download_k8')
 * @param {string} config.reportType - Display name (e.g., '8-K', 'Form 4')
 * @param {HTMLButtonElement} config.btn - Download button element
 * @param {HTMLElement} config.status - Status display element
 * @param {HTMLTextAreaElement} config.textArea - Textarea for content
 */
async function handleSecReportDownload(config) {
  const { endpoint, reportType, btn, status, textArea } = config;

  const symbol = els.symbolInput.value.trim().toUpperCase();
  const year = els.yearInput.value.trim();

  if (!symbol) {
    showResult('Please enter a symbol', 'error');
    return;
  }

  if (!year) {
    showResult('Please enter a year', 'error');
    return;
  }

  // Show loading state
  const originalBtnText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Downloading...';
  status.textContent = 'Connecting to MCP service...';
  textArea.value = '';

  try {
    const formData = new FormData();
    formData.append('symbol', symbol);
    formData.append('year', year);

    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status === 'ok' || data.status === 'completed') {
      textArea.value = data.content || data.text || JSON.stringify(data.result, null, 2);
      status.textContent = `✅ Downloaded ${reportType} for ${symbol} (${year})`;
      showResult(`${reportType} downloaded successfully for ${symbol}`, 'success');
    } else {
      status.textContent = `❌ ${data.message || 'Download failed'}`;
      showResult(data.message || 'Download failed', 'error');
    }
  } catch (err) {
    console.error(`Download ${reportType} failed:`, err);
    status.textContent = `❌ Error: ${err.message}`;
    showResult(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtnText;
  }
}




// ─────────────────────────────────────────────────────────────
// Specific handlers using the generic function
// ─────────────────────────────────────────────────────────────

async function handleDownloadK8() {
  await handleSecReportDownload({
    endpoint: '/download_k8',
    reportType: '8-K',
    btn: els.downloadK8Btn,
    status: els.k8Status,
    textArea: els.k8TextArea
  });
}

async function handleDownloadF4() {
  await handleSecReportDownload({
    endpoint: '/download_f4',
    reportType: 'Form 4',
    btn: els.downloadF4Btn,
    status: els.f4Status,
    textArea: els.f4TextArea
  });
}