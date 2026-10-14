const API_BASE = '/api';
const POLL_INTERVAL_MS = 5000;
const MAX_ROWS_PER_TG = 200;
const MAX_SEEN_KEYS_PER_TG = 1000;
const CALL_DUPLICATE_WINDOW_SECONDS = 10;

const tabs = new Map(); // TG -> dados da aba
let currentTG = '';
let ttsEnabled = true;
let pollTimer = null;
let pollInFlight = false;

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
const apiStatusEl = document.getElementById('apiStatus');

function init() {
    btnAddTG.addEventListener('click', addTG);
    btnClear.addEventListener('click', clearCurrentTab);
    btnTTS.addEventListener('click', toggleTTS);

    tgInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') addTG();
    });

    addTabBtn.addEventListener('click', () => tgInput.focus());

    tgTabs.addEventListener('click', (event) => {
        const tab = event.target.closest('.tg-tab');
        if (!tab || tab.classList.contains('add-tab')) return;

        if (event.target.closest('.close-tab')) {
            event.stopPropagation();
            removeTG(tab.dataset.tg);
        } else {
            switchTab(tab.dataset.tg);
        }
    });

    tabPanels.addEventListener('click', (event) => {
        const button = event.target.closest('.view-button');
        if (!button) return;

        const panel = button.closest('.tab-panel');
        if (panel) setPanelView(panel, button.dataset.view);
    });

    currentTGEl.textContent = 'Nenhuma TG selecionada';
    entryCountEl.textContent = '0 entradas';
    setApiStatus('Aguardando consulta...', '');

    // Um único temporizador consulta o servidor para todas as TGs abertas.
    pollTimer = setInterval(pollAllActiveTGs, POLL_INTERVAL_MS);
}

function addTG() {
    const tg = tgInput.value.trim();

    if (!/^\d{1,20}$/.test(tg)) {
        alert('Digite uma TG contendo somente números.');
        return;
    }

    if (tabs.has(tg)) {
        switchTab(tg);
        tgInput.value = '';
        return;
    }

    createTab(tg, true);
    tgInput.value = '';
}

function createTab(tg, makeActive = false) {
    const tab = document.createElement('button');
    tab.className = 'tg-tab' + (makeActive ? ' active' : '');
    tab.dataset.tg = tg;

    const label = document.createElement('span');
    label.textContent = `TG ${tg}`;

    const closeButton = document.createElement('span');
    closeButton.className = 'close-tab';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', `Fechar TG ${tg}`);

    tab.append(label, closeButton);
    tgTabs.insertBefore(tab, addTabBtn);

    const panel = document.createElement('div');
    panel.className = 'tab-panel' + (makeActive ? ' active' : '');
    panel.dataset.tg = tg;

    panel.innerHTML = `
        <div class="view-buttons" role="group" aria-label="Visualização da TG ${tg}">
            <button class="view-button active" type="button" data-view="calls">
                Chamadas
            </button>
            <button class="view-button" type="button" data-view="first">
                Primeira conexão
            </button>
            <button class="view-button" type="button" data-view="last">
                Última conexão
            </button>
        </div>

        <section class="view-section active" data-view-section="calls">
            <div class="table-wrapper">
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
            </div>
        </section>

        <section class="view-section" data-view-section="first">
            <p class="list-description">
                Um registro por radioamador, usando a primeira conexão observada
                nesta rodada.
            </p>
            <div class="table-wrapper">
                <table class="heardTable">
                    <thead>
                        <tr>
                            <th>Data/Hora da primeira conexão</th>
                            <th>Indicativo</th>
                            <th>Nome</th>
                            <th>Sobrenome</th>
                            <th>Cidade/Estado</th>
                            <th>País</th>
                            <th>DMR ID</th>
                        </tr>
                    </thead>
                    <tbody class="firstConnectionsBody"></tbody>
                </table>
            </div>
        </section>

        <section class="view-section" data-view-section="last">
            <p class="list-description">
                Um registro por radioamador, usando a última conexão observada
                nesta rodada.
            </p>
            <div class="table-wrapper">
                <table class="heardTable">
                    <thead>
                        <tr>
                            <th>Data/Hora da última conexão</th>
                            <th>Indicativo</th>
                            <th>Nome</th>
                            <th>Sobrenome</th>
                            <th>Cidade/Estado</th>
                            <th>País</th>
                            <th>DMR ID</th>
                        </tr>
                    </thead>
                    <tbody class="lastConnectionsBody"></tbody>
                </table>
            </div>
        </section>
    `;

    tabPanels.appendChild(panel);

    const roundStartedAt = Math.floor(Date.now() / 1000);

    tabs.set(tg, {
        tab,
        panel,
        body: panel.querySelector('.heardBody'),
        firstConnectionsBody: panel.querySelector('.firstConnectionsBody'),
        lastConnectionsBody: panel.querySelector('.lastConnectionsBody'),
        lastTimestamp: roundStartedAt,
        roundId: 0,
        seenEntries: new Set(),
        seenQueue: [],
        firstConnections: new Map(),
        lastConnections: new Map(),
        callsignIdentity: new Map(),
        dmridIdentity: new Map(),
        lastDisplayedCallByIdentity: new Map()
    });

    if (makeActive) switchTab(tg);

    // Consulta imediatamente, salvo se já houver uma consulta em andamento.
    pollAllActiveTGs();
}

function setPanelView(panel, view) {
    panel.querySelectorAll('.view-button').forEach((button) => {
        button.classList.toggle('active', button.dataset.view === view);
    });

    panel.querySelectorAll('.view-section').forEach((section) => {
        section.classList.toggle(
            'active',
            section.dataset.viewSection === view
        );
    });
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
}

function removeTG(tg) {
    const data = tabs.get(tg);
    if (!data) return;

    data.tab.remove();
    data.panel.remove();
    tabs.delete(tg);

    if (currentTG === tg) {
        const firstTab = tgTabs.querySelector('.tg-tab:not(.add-tab)');

        if (firstTab) {
            switchTab(firstTab.dataset.tg);
        } else {
            currentTG = '';
            currentTGEl.textContent = 'Nenhuma TG selecionada';
            entryCountEl.textContent = '0 entradas';
        }
    }
}

async function pollAllActiveTGs() {
    if (pollInFlight || tabs.size === 0) return;

    pollInFlight = true;

    const requestRoundIds = new Map();
    let since = Infinity;

    tabs.forEach((data, tg) => {
        requestRoundIds.set(tg, data.roundId);
        since = Math.min(since, data.lastTimestamp);
    });

    if (!Number.isFinite(since)) since = 0;

    try {
        const response = await fetch(
            `${API_BASE}/heard?since=${encodeURIComponent(since)}`
        );

        if (!response.ok) {
            let message = 'Falha ao consultar o BrandMeister.';

            try {
                const errorResult = await response.json();
                if (errorResult.error) message = errorResult.error;
            } catch (_) {
                // Mantém a mensagem padrão se a resposta não for JSON.
            }

            throw new Error(message);
        }

        const result = await response.json();
        const entries = Array.isArray(result.entries) ? result.entries : [];

        tabs.forEach((data, tg) => {
            // Se uma TG foi limpa durante a consulta, descarta essa resposta
            // para ela. Uma TG criada durante a consulta ainda pode recebê-la.
            if (
                requestRoundIds.has(tg) &&
                requestRoundIds.get(tg) !== data.roundId
            ) {
                return;
            }

            const baseline = data.lastTimestamp;
            const tgEntries = entries
                .filter((entry) => {
                    return (
                        String(entry.tg) === tg &&
                        Number(entry.raw_timestamp) >= baseline
                    );
                })
                .sort((a, b) => {
                    return (
                        Number(a.raw_timestamp) -
                        Number(b.raw_timestamp)
                    );
                });

            tgEntries.forEach((entry) => {
                // As listas de conexão recebem todos os registros, mesmo que
                // uma chamada seja suprimida na aba "Chamadas".
                updateConnectionLists(data, entry);
                addRow(tg, entry);
            });

            const timestamps = tgEntries
                .map((entry) => Number(entry.raw_timestamp))
                .filter(Number.isFinite);

            if (timestamps.length > 0) {
                data.lastTimestamp = Math.max(
                    data.lastTimestamp,
                    ...timestamps
                );
                updateLastUpdate();
            }

            updateEntryCount(tg);
        });

        setApiStatus('Conectado ao BrandMeister', 'success');
    } catch (error) {
        console.error('Erro ao consultar o BrandMeister:', error);
        setApiStatus(
            error.message || 'Erro de conexão com o BrandMeister.',
            'error'
        );
    } finally {
        pollInFlight = false;
    }
}

function addRow(tg, entry) {
    const data = tabs.get(tg);
    if (!data) return;

    const timestamp = Number(entry.raw_timestamp);
    const callsign = normalizeCallsign(entry.callsign);
    const dmrid = normalizeDmrid(entry.dmrid);

    const identityKey =
        (callsign && data.callsignIdentity.get(callsign)) ||
        (dmrid && data.dmridIdentity.get(dmrid)) ||
        (callsign
            ? `callsign:${callsign}`
            : dmrid
                ? `dmrid:${dmrid}`
                : '');

    const entryKey = identityKey
        ? `${timestamp}-${identityKey}`
        : `${timestamp}-${dmrid}-${callsign}`;

    if (data.seenEntries.has(entryKey)) return;

    rememberSeenEntry(data, entryKey);

    // Suprime chamadas da mesma identidade dentro da janela de 10 segundos.
    // A atualização das listas de primeira/última conexão ocorre antes daqui.
    if (identityKey && Number.isFinite(timestamp)) {
        const lastDisplayedTimestamp =
            data.lastDisplayedCallByIdentity.get(identityKey);

        if (
            Number.isFinite(lastDisplayedTimestamp) &&
            Math.abs(timestamp - lastDisplayedTimestamp) <=
                CALL_DUPLICATE_WINDOW_SECONDS
        ) {
            return;
        }

        data.lastDisplayedCallByIdentity.set(identityKey, timestamp);
    }

    const tr = document.createElement('tr');
    tr.className = 'new-entry';
    tr.dataset.entryKey = entryKey;
    tr.dataset.dmrid = entry.dmrid || '';
    tr.dataset.time = entry.raw_timestamp;

    tr.innerHTML = `
        <td>${escapeHtml(entry.timestamp)}</td>
        <td class="callsign">${escapeHtml(entry.callsign)}</td>
        <td>${escapeHtml(entry.name)}</td>
        <td>${escapeHtml(entry.surname)}</td>
        <td>${escapeHtml(entry.city_state)}</td>
        <td>${escapeHtml(entry.country)}</td>
        <td class="dmrid">${escapeHtml(entry.dmrid)}</td>
        <td>
            <span class="mode mode-${getModeClass(entry.mode)}">
                ${escapeHtml(entry.mode || 'DMR')}
            </span>
        </td>
    `;

    data.body.insertBefore(tr, data.body.firstChild);

    while (data.body.children.length > MAX_ROWS_PER_TG) {
        data.body.lastElementChild.remove();
    }

    if (ttsEnabled && entry.callsign) {
        speakCallsign(entry.callsign, entry.name);
    }

    setTimeout(() => tr.classList.remove('new-entry'), 2000);
}

function rememberSeenEntry(data, entryKey) {
    data.seenEntries.add(entryKey);
    data.seenQueue.push(entryKey);

    if (data.seenQueue.length > MAX_SEEN_KEYS_PER_TG) {
        const oldestKey = data.seenQueue.shift();
        data.seenEntries.delete(oldestKey);
    }
}

function updateConnectionLists(data, entry) {
    const callsign = normalizeCallsign(entry.callsign);
    const dmrid = normalizeDmrid(entry.dmrid);
    const timestamp = Number(entry.raw_timestamp);

    if (!Number.isFinite(timestamp) || (!callsign && !dmrid)) return;

    const callsignKey = callsign
        ? data.callsignIdentity.get(callsign)
        : null;
    const dmridKey = dmrid
        ? data.dmridIdentity.get(dmrid)
        : null;

    // Prefere a identidade já conhecida pelo indicativo; caso contrário,
    // reutiliza a identidade associada ao DMR ID.
    const identityKey =
        callsignKey ||
        dmridKey ||
        (callsign ? `callsign:${callsign}` : `dmrid:${dmrid}`);

    const otherKey =
        callsignKey && dmridKey && callsignKey !== dmridKey
            ? dmridKey
            : null;

    if (otherKey) {
        mergeIdentity(data, identityKey, otherKey);
    }

    if (callsign) data.callsignIdentity.set(callsign, identityKey);
    if (dmrid) data.dmridIdentity.set(dmrid, identityKey);

    const firstEntry = data.firstConnections.get(identityKey);
    if (!firstEntry || timestamp < Number(firstEntry.raw_timestamp)) {
        data.firstConnections.set(identityKey, entry);
    }

    const lastEntry = data.lastConnections.get(identityKey);
    if (!lastEntry || timestamp >= Number(lastEntry.raw_timestamp)) {
        data.lastConnections.set(identityKey, entry);
    }

    renderConnectionTable(
        data.firstConnectionsBody,
        data.firstConnections,
        'asc'
    );

    renderConnectionTable(
        data.lastConnectionsBody,
        data.lastConnections,
        'desc'
    );
}

function mergeIdentity(data, targetKey, sourceKey) {
    const sourceFirst = data.firstConnections.get(sourceKey);
    const targetFirst = data.firstConnections.get(targetKey);

    if (
        sourceFirst &&
        (!targetFirst ||
            Number(sourceFirst.raw_timestamp) <
                Number(targetFirst.raw_timestamp))
    ) {
        data.firstConnections.set(targetKey, sourceFirst);
    }

    const sourceLast = data.lastConnections.get(sourceKey);
    const targetLast = data.lastConnections.get(targetKey);

    if (
        sourceLast &&
        (!targetLast ||
            Number(sourceLast.raw_timestamp) >
                Number(targetLast.raw_timestamp))
    ) {
        data.lastConnections.set(targetKey, sourceLast);
    }

    data.firstConnections.delete(sourceKey);
    data.lastConnections.delete(sourceKey);

    data.callsignIdentity.forEach((key, alias) => {
        if (key === sourceKey) data.callsignIdentity.set(alias, targetKey);
    });

    data.dmridIdentity.forEach((key, alias) => {
        if (key === sourceKey) data.dmridIdentity.set(alias, targetKey);
    });

    const sourceDisplayedTimestamp =
        data.lastDisplayedCallByIdentity.get(sourceKey);
    const targetDisplayedTimestamp =
        data.lastDisplayedCallByIdentity.get(targetKey);

    if (Number.isFinite(sourceDisplayedTimestamp)) {
        if (
            !Number.isFinite(targetDisplayedTimestamp) ||
            sourceDisplayedTimestamp > targetDisplayedTimestamp
        ) {
            data.lastDisplayedCallByIdentity.set(
                targetKey,
                sourceDisplayedTimestamp
            );
        }

        data.lastDisplayedCallByIdentity.delete(sourceKey);
    }
}

function renderConnectionTable(tbody, entriesMap, order) {
    const entries = Array.from(entriesMap.values());

    entries.sort((a, b) => {
        const difference =
            Number(a.raw_timestamp) - Number(b.raw_timestamp);

        return order === 'asc' ? difference : -difference;
    });

    const rows = document.createDocumentFragment();

    entries.forEach((entry) => {
        const values = [
            entry.timestamp,
            entry.callsign,
            entry.name,
            entry.surname,
            entry.city_state,
            entry.country,
            entry.dmrid
        ];

        const tr = document.createElement('tr');

        values.forEach((value, index) => {
            const td = document.createElement('td');
            td.textContent = value == null ? '' : String(value);

            if (index === 1) td.className = 'callsign';
            if (index === 6) td.className = 'dmrid';

            tr.appendChild(td);
        });

        rows.appendChild(tr);
    });

    tbody.replaceChildren(rows);
}

function normalizeCallsign(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeDmrid(value) {
    return String(value || '').trim();
}

function getModeClass(mode) {
    const value = (mode || '').toLowerCase();

    if (value.includes('mmdvm') || value.includes('dmr')) return 'dmr';
    if (value.includes('ydsf') || value.includes('fusion')) return 'ydsf';
    if (value.includes('p25')) return 'p25';
    if (value.includes('nxdn')) return 'nxdn';
    if (value.includes('m17')) return 'm17';

    return 'unknown';
}

function clearCurrentTab() {
    if (!currentTG) return;

    const data = tabs.get(currentTG);
    if (!data) return;

    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }

    data.roundId += 1;
    data.lastTimestamp = Math.floor(Date.now() / 1000);

    data.seenEntries.clear();
    data.seenQueue = [];
    data.firstConnections.clear();
    data.lastConnections.clear();
    data.callsignIdentity.clear();
    data.dmridIdentity.clear();
    data.lastDisplayedCallByIdentity.clear();

    data.body.replaceChildren();
    data.firstConnectionsBody.replaceChildren();
    data.lastConnectionsBody.replaceChildren();

    updateEntryCount(currentTG);
    updateLastUpdate();
    setApiStatus('Nova rodada iniciada. Aguardando chamadas...', '');

    pollAllActiveTGs();
}

function toggleTTS() {
    ttsEnabled = !ttsEnabled;
    btnTTS.textContent = ttsEnabled ? '🔊 TTS' : '🔇 TTS';
    btnTTS.classList.toggle('btn-tts', ttsEnabled);
    btnTTS.style.background = ttsEnabled ? '#27ae60' : '#95a5a6';
    btnTTS.style.color = 'white';

    if (!ttsEnabled && 'speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
}

function speakCallsign(callsign, name) {
    if (!('speechSynthesis' in window)) return;

    const utterance = new SpeechSynthesisUtterance(
        `${callsign}, ${name || ''}`
    );

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
    entryCountEl.textContent =
        `${count} entrada${count !== 1 ? 's' : ''}`;
}

function updateLastUpdate() {
    lastUpdateEl.textContent =
        `Última atualização: ${new Date().toLocaleTimeString('pt-BR')}`;
}

function setApiStatus(message, state) {
    apiStatusEl.textContent = message;
    apiStatusEl.classList.remove('success', 'error');

    if (state) apiStatusEl.classList.add(state);
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', init);
