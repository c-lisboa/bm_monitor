const API_BASE = '/api';
const tabs = new Map(); // tg -> { panel, body, lastTimestamp, pollInterval, seenEntries: Set }
let currentServer = '';
let currentTG = '';
let ttsEnabled = true;

const serverSelect = document.getElementById('serverSelect');
const tgInput = document.getElementById('tgInput');
const btnAddTG = document.getElementById('btnAddTG');
const btnClear = document.getElementById('btnClear');
const btnTTS = document.getElementById('btnTTS');
const tgTabs = document.getElementById('tgTabs');
const tabPanels = document.getElementById('tabPanels');
const addTabBtn = document.getElementById('addTabBtn');
const currentTGEl = document.getElementById('currentTG');
const lastUpdateEl = document.getElementById('lastUpdate');
const entryCountEl = document.getElementById('entryCount');
const currentServerEl = document.getElementById('currentServer');

const POLL_INTERVAL_MS = 5000;

function init() {
    currentServer = serverSelect.value;
    currentTG = '';
    
    serverSelect.addEventListener('change', onServerChange);
    btnAddTG.addEventListener('click', addTG);
    btnClear.addEventListener('click', clearCurrentTab);
    btnTTS.addEventListener('click', toggleTTS);
    tgInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addTG(); });
    addTabBtn.addEventListener('click', () => tgInput.focus());
    
    tgTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.tg-tab');
        if (!tab) return;
        if (tab.classList.contains('add-tab')) return;
        if (e.target.classList.contains('close-tab')) {
            e.stopPropagation();
            removeTG(tab.dataset.tg);
        } else {
            switchTab(tab.dataset.tg);
        }
    });
    
    currentServerEl.textContent = currentServer;
    currentTGEl.textContent = 'Nenhuma TG selecionada';
    entryCountEl.textContent = '0 entradas';
}

function onServerChange() {
    currentServer = serverSelect.value;
    currentServerEl.textContent = currentServer;
    tabs.forEach((data, tg) => {
        data.lastTimestamp = 0;
        data.body.innerHTML = '';
        data.seenEntries.clear();
        updateEntryCount(tg);
        fetchDataForTG(tg);
    });
}

function addTG() {
    const tg = tgInput.value.trim();
    if (!tg) return alert('Digite uma TG válida');
    if (tabs.has(tg)) {
        switchTab(tg);
        return;
    }
    createTab(tg, true);
    tgInput.value = '';
}

function createTab(tg, makeActive = false) {
    const tab = document.createElement('button');
    tab.className = 'tg-tab' + (makeActive ? ' active' : '');
    tab.dataset.tg = tg;
    tab.innerHTML = `TG ${tg} <span class="close-tab">×</span>`;
    tgTabs.insertBefore(tab, addTabBtn);
    
    const panel = document.createElement('div');
    panel.className = 'tab-panel' + (makeActive ? ' active' : '');
    panel.dataset.tg = tg;
    panel.innerHTML = `
        <table class="heardTable">
            <thead>
                <tr>
                    <th>Data/Hora</th>
                    <th>Indicativo</th>
                    <th>Nome</th>
                    <th>Sobrenome</th>
                    <th>Cidade/Estado</th>
                    <th>País</th>
                    <th>DMR ID</th>
                    <th>Modo</th>
                </tr>
            </thead>
            <tbody class="heardBody"></tbody>
        </table>
    `;
    tabPanels.appendChild(panel);
    
    const body = panel.querySelector('.heardBody');
    
    tabs.set(tg, {
        tab,
        panel,
        body,
        lastTimestamp: 0,
        pollInterval: null,
        seenEntries: new Set()
    });
    
    if (makeActive) {
        switchTab(tg);
    }
    // Always start polling for new tabs
    startPollingForTG(tg);
}

function switchTab(tg) {
    if (!tabs.has(tg)) return;
    
    currentTG = tg;
    currentTGEl.textContent = `TG: ${tg}`;
    
    tabs.forEach((data, key) => {
        const isActive = key === tg;
        data.tab.classList.toggle('active', isActive);
        data.panel.classList.toggle('active', isActive);
    });
    
    updateEntryCount(tg);
    updateLastUpdate();
}

function removeTG(tg) {
    const data = tabs.get(tg);
    if (!data) return;
    
    if (data.pollInterval) clearInterval(data.pollInterval);
    
    data.tab.remove();
    data.panel.remove();
    tabs.delete(tg);
    
    if (currentTG === tg) {
        const firstTab = tgTabs.querySelector('.tg-tab:not(.add-tab)');
        if (firstTab) {
            switchTab(firstTab.dataset.tg);
        } else {
            currentTG = '';
            currentTGEl.textContent = 'TG: --';
            entryCountEl.textContent = '0 entradas';
        }
    }
}

function startPollingForTG(tg) {
    const data = tabs.get(tg);
    if (!data) return;
    
    if (data.pollInterval) clearInterval(data.pollInterval);
    data.pollInterval = setInterval(() => fetchDataForTG(tg), POLL_INTERVAL_MS);
    fetchDataForTG(tg);
}

async function fetchDataForTG(tg) {
    const data = tabs.get(tg);
    if (!data) return;
    
    try {
        const url = `${API_BASE}/heard?server=${encodeURIComponent(currentServer)}&tg=${encodeURIComponent(tg)}&since=${data.lastTimestamp}`;
        const resp = await fetch(url);
        const result = await resp.json();
        
        if (result.entries && result.entries.length > 0) {
            result.entries.forEach(entry => addRow(tg, entry));
            data.lastTimestamp = Math.max(data.lastTimestamp, ...result.entries.map(e => e.raw_timestamp));
            updateLastUpdate();
        }
        updateEntryCount(tg);
    } catch (err) {
        console.error(`Erro ao buscar dados para TG ${tg}:`, err);
    }
}

function addRow(tg, entry) {
    const data = tabs.get(tg);
    if (!data) return;
    
    // Create unique key for deduplication
    const entryKey = `${entry.dmrid}-${entry.raw_timestamp}-${entry.callsign}`;
    if (data.seenEntries.has(entryKey)) return;
    data.seenEntries.add(entryKey);
    
    const tr = document.createElement('tr');
    tr.className = 'new-entry';
    tr.dataset.dmrid = entry.dmrid;
    tr.dataset.time = entry.raw_timestamp;
    tr.innerHTML = `
        <td>${entry.timestamp}</td>
        <td class="callsign">${escapeHtml(entry.callsign)}</td>
        <td>${escapeHtml(entry.name)}</td>
        <td>${escapeHtml(entry.surname)}</td>
        <td>${escapeHtml(entry.city_state)}</td>
        <td>${escapeHtml(entry.country)}</td>
        <td class="dmrid">${escapeHtml(entry.dmrid)}</td>
        <td><span class="mode mode-${getModeClass(entry.mode)}">${escapeHtml(entry.mode || 'DMR')}</span></td>
    `;
    
    data.body.insertBefore(tr, data.body.firstChild);
    
    if (ttsEnabled && entry.callsign) {
        speakCallsign(entry.callsign, entry.name);
    }
    
    setTimeout(() => tr.classList.remove('new-entry'), 2000);
}

function getModeClass(mode) {
    const m = (mode || '').toLowerCase();
    if (m.includes('mmdvm') || m.includes('dmr')) return 'dmr';
    if (m.includes('ydsf') || m.includes('fusion')) return 'ydsf';
    if (m.includes('p25')) return 'p25';
    if (m.includes('nxdn')) return 'nxdn';
    if (m.includes('m17')) return 'm17';
    return 'unknown';
}

function clearCurrentTab() {
    if (!currentTG) return;
    const data = tabs.get(currentTG);
    if (!data) return;
    
    // Stop any ongoing speech
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
    
    data.body.innerHTML = '';
    data.lastTimestamp = 0;
    data.seenEntries.clear();
    updateEntryCount(currentTG);
    updateLastUpdate();
}

function toggleTTS() {
    ttsEnabled = !ttsEnabled;
    btnTTS.textContent = ttsEnabled ? '🔊 TTS' : '🔇 TTS';
    btnTTS.classList.toggle('btn-tts', ttsEnabled);
    btnTTS.style.background = ttsEnabled ? '#27ae60' : '#95a5a6';
    btnTTS.style.color = 'white';
    
    // Stop any ongoing speech when muting
    if (!ttsEnabled && 'speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
}

function speakCallsign(callsign, name) {
    if (!('speechSynthesis' in window)) return;
    
    speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(`${callsign}, ${name || ''}`);
    utterance.lang = 'pt-BR';
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 0.8;
    speechSynthesis.speak(utterance);
}

function updateEntryCount(tg) {
    const data = tabs.get(tg || currentTG);
    if (!data) {
        entryCountEl.textContent = '0 entradas';
        return;
    }
    const count = data.body.children.length;
    entryCountEl.textContent = `${count} entrada${count !== 1 ? 's' : ''}`;
}

function updateLastUpdate() {
    const now = new Date();
    lastUpdateEl.textContent = `Última atualização: ${now.toLocaleTimeString('pt-BR')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', init);