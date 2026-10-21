const state = {
  settings: null,
  running: false,
  core: { installed: false },
  addons: [],
  logs: [],
  page: 'overview',
  filter: 'all',
  selectedCore: 'paper',
  searchResults: []
};

const pageNames = {
  overview: 'ОБЗОР', setup: 'ЯДРО И ВЕРСИЯ', addons: 'ПЛАГИНЫ И МОДЫ',
  settings: 'НАСТРОЙКИ', console: 'КОНСОЛЬ'
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка запроса (${response.status}).`);
  return data;
}

function notify(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  const mark = document.createElement('span');
  mark.className = 'toast-mark';
  mark.textContent = type === 'error' ? '!' : '✓';
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(mark, text);
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 5000);
}

function navigate(page) {
  if (!pageNames[page]) return;
  state.page = page;
  $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === page));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === page));
  $('#page-breadcrumb').textContent = pageNames[page];
  location.hash = page;
  if (page === 'console') renderConsole();
  if (page === 'setup') loadVersions().catch((error) => notify(error.message, 'error'));
  if (page === 'settings') fillSettingsForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setField(form, name, value) {
  const field = form.elements.namedItem(name);
  if (!field) return;
  if (field.type === 'checkbox') field.checked = Boolean(value);
  else field.value = value ?? '';
}

function fillSettingsForm() {
  if (!state.settings) return;
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(state.settings)) setField(form, key, value);
  updatePresetButtons(state.settings.optimization || 'balanced');
}

function settingsPayload(form) {
  const result = {};
  for (const field of form.elements) {
    if (!field.name || field.disabled || field.type === 'submit' || field.type === 'button') continue;
    result[field.name] = field.type === 'checkbox' ? field.checked :
      field.type === 'number' ? Number(field.value) : field.value;
  }
  return result;
}

function updatePresetButtons(preset) {
  $$('.preset-option').forEach((button) => button.classList.toggle('selected', button.dataset.preset === preset));
  setField($('#settings-form'), 'optimization', preset);
}

function renderState() {
  if (!state.settings) return;
  const settings = state.settings;
  const plugins = state.addons.filter((addon) => addon.category === 'plugins').length;
  const mods = state.addons.filter((addon) => addon.category === 'mods').length;
  const total = plugins + mods;
  const name = settings.name || 'Мой сервер';
  $('#sidebar-name').textContent = name;
  $('#sidebar-version').textContent = `Minecraft ${settings.version} · ${String(settings.core).toUpperCase()}`;
  $('#welcome-name').textContent = name;
  $('#hero-name').textContent = name;
  $('#hero-version').textContent = settings.version;
  $('#hero-core').textContent = String(settings.core).toUpperCase();
  $('#version-value').textContent = settings.version;
  $('#memory-value').textContent = `${settings.minMemory}–${settings.maxMemory}`;
  $('#addon-total').textContent = total;
  $('#plugin-total').textContent = plugins;
  $('#mod-total').textContent = mods;
  $('#addon-count').textContent = total;
  $('#filter-all-count').textContent = total;
  $('#filter-plugin-count').textContent = plugins;
  $('#filter-mod-count').textContent = mods;
  $('#server-status').textContent = state.running ? 'Работает' : 'Остановлен';
  $('#status-note').textContent = state.running ? 'Процесс Java запущен' : 'Готов к запуску';
  $('#server-pid').textContent = `PROCESS / ${state.running && state.pid ? state.pid : '—'}`;
  $('#server-status-chip').textContent = state.running ? 'ONLINE' : 'OFFLINE';
  $('#server-status-chip').classList.toggle('online', state.running);
  $('#status-indicator').classList.toggle('running', state.running);
  $('#main-power').classList.toggle('is-running', state.running);
  $('#main-power-label').textContent = state.running ? 'Остановить сервер' : 'Запустить сервер';
  $('.power-glyph', $('#main-power')).textContent = state.running ? '■' : '▶';
  $('#console-indicator').classList.toggle('running', state.running);
  $('#console-status-dot').classList.toggle('running', state.running);
  $('#console-foot-dot').classList.toggle('running', state.running);
  $('#console-status-label').textContent = state.running ? 'РАБОТАЕТ' : 'ОСТАНОВЛЕН';
  $('#core-note').textContent = state.core.installed ? 'Ядро готово к запуску' : 'Ядро не установлено';
  $('#core-status-label').textContent = state.core.installed ? 'CORE / READY' : 'CORE / MISSING';
  $('#setup-status').classList.toggle('installed', state.core.installed);
  $('#setup-status').innerHTML = `<span></span>${state.core.installed ? 'ЯДРО УСТАНОВЛЕНО' : 'НЕТ ЯДРА'}`;
  $('#core-file-state').textContent = state.core.installed ? 'УСТАНОВЛЕНО' : 'НЕ УСТАНОВЛЕНО';
  $('#core-file-state').classList.toggle('installed', state.core.installed);
  $('#core-file-name').textContent = state.core.installed ? 'server.jar' : 'server.jar';
  $('#core-file-meta').textContent = state.core.installed ? formatSize(state.core.size) : 'Ядро сервера';
  renderAddons();
  renderActivity();
  renderConsole();
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function renderActivity() {
  const container = $('#activity-list');
  const recent = [...state.logs].slice(-5).reverse();
  container.replaceChildren();
  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-inline';
    empty.innerHTML = '<span>◌</span><p>Здесь появятся действия с сервером.</p>';
    container.append(empty);
    return;
  }
  for (const entry of recent) {
    const row = document.createElement('div');
    row.className = 'activity-entry';
    row.dataset.stream = entry.stream || 'system';
    const dot = document.createElement('span');
    dot.className = 'activity-dot';
    const text = document.createElement('span');
    text.className = 'activity-text';
    text.textContent = entry.text;
    const time = document.createElement('time');
    time.className = 'activity-time';
    time.textContent = formatTime(entry.time);
    row.append(dot, text, time);
    container.append(row);
  }
}

function renderAddons() {
  const container = $('#addon-list');
  const items = state.addons.filter((addon) => state.filter === 'all' || addon.category === state.filter);
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const symbol = document.createElement('span');
    symbol.className = 'empty-symbol';
    symbol.textContent = '▤';
    const title = document.createElement('h3');
    title.textContent = state.filter === 'all' ? 'Пока чистый лист' : `Нет файлов: ${state.filter === 'mods' ? 'моды' : 'плагины'}`;
    const copy = document.createElement('p');
    copy.innerHTML = 'Добавь дополнение из каталога<br>или загрузи свой файл.';
    const button = document.createElement('button');
    button.className = 'button button-outline';
    button.type = 'button';
    button.textContent = 'Открыть каталог ↗';
    button.addEventListener('click', openAddonSearch);
    empty.append(symbol, title, copy, button);
    container.append(empty);
    return;
  }
  const header = document.createElement('div');
  header.className = 'addon-table-head';
  header.innerHTML = '<span>ФАЙЛ</span><span>ТИП</span><span>РАЗМЕР</span><span></span>';
  container.append(header);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'addon-row';
    const main = document.createElement('div');
    main.className = 'addon-main';
    const icon = document.createElement('span');
    icon.className = 'addon-file-icon';
    icon.textContent = item.category === 'mods' ? 'M' : 'P';
    const copy = document.createElement('span');
    copy.className = 'addon-main-copy';
    const title = document.createElement('strong');
    title.textContent = item.name;
    title.title = item.name;
    const meta = document.createElement('small');
    meta.textContent = `JAR · ${new Date(item.modified).toLocaleDateString('ru-RU')}`;
    copy.append(title, meta);
    main.append(icon, copy);
    const type = document.createElement('span');
    type.className = `addon-type${item.category === 'mods' ? ' mod' : ''}`;
    type.textContent = item.category === 'mods' ? 'MOD' : 'PLUGIN';
    const size = document.createElement('span');
    size.className = 'addon-size';
    size.textContent = formatSize(item.size);
    const remove = document.createElement('button');
    remove.className = 'delete-addon';
    remove.type = 'button';
    remove.title = `Удалить ${item.name}`;
    remove.setAttribute('aria-label', `Удалить ${item.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => removeAddon(item));
    row.append(main, type, size, remove);
    container.append(row);
  }
}

function renderConsole() {
  const container = $('#terminal-output');
  if (!container) return;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const active = state.running;
  $('#console-command').disabled = !active;
  $('#send-command').disabled = !active;
  container.replaceChildren();
  if (!state.logs.length) {
    const empty = document.createElement('div');
    empty.className = 'terminal-empty';
    empty.innerHTML = '<span>READY_</span><p>Здесь появится вывод Java.<br>Запусти сервер, чтобы начать.</p>';
    container.append(empty);
    return;
  }
  for (const entry of state.logs) {
    const line = document.createElement('div');
    line.className = 'terminal-line';
    line.dataset.stream = entry.stream || 'system';
    const time = document.createElement('time');
    time.textContent = formatTime(entry.time);
    const text = document.createElement('span');
    text.textContent = entry.text;
    line.append(time, text);
    container.append(line);
  }
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

async function refreshState() {
  const data = await api('/api/state');
  state.settings = data.settings;
  state.running = data.running;
  state.pid = data.pid;
  state.core = data.core;
  state.addons = data.addons;
  state.logs = data.logs;
  renderState();
}

async function loadVersions() {
  const source = state.selectedCore;
  const select = $('#core-version');
  const keepVersion = state.settings?.version || select.value;
  select.disabled = true;
  try {
    const data = await api(`/api/versions?source=${encodeURIComponent(source)}`);
    const versions = data.versions || [];
    if (!versions.length) throw new Error('Источник не вернул версии Minecraft.');
    select.replaceChildren(...versions.map((version) => new Option(version, version)));
    if (versions.includes(keepVersion)) select.value = keepVersion;
    $('#compat-title').textContent = source === 'fabric' ? 'Fabric' : 'Paper / Purpur';
    $('#compat-copy').textContent = source === 'fabric'
      ? 'Поддержка Fabric-модов. Перед установкой проверь, что каждый мод подходит для этой версии и загрузчика.'
      : 'Поддержка Bukkit и Spigot-плагинов. Выбери одну из этих сборок для установки плагинов.';
  } finally {
    select.disabled = false;
  }
}

async function saveSettings(event) {
  event?.preventDefault();
  const form = $('#settings-form');
  if (!form.reportValidity()) return;
  try {
    const data = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settingsPayload(form)) });
    state.settings = data.settings;
    renderState();
    notify('Настройки сохранены.');
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function toggleServer() {
  const route = state.running ? '/api/server/stop' : '/api/server/start';
  try {
    await api(route, { method: 'POST' });
    notify(state.running ? 'Команда остановки отправлена.' : 'Сервер запускается.');
    await refreshState();
  } catch (error) {
    notify(error.message, 'error');
    if (!state.core.installed) navigate('setup');
    else if (!state.settings.eulaAccepted) navigate('settings');
  }
}

async function installSelectedCore() {
  const button = $('#install-core');
  button.disabled = true;
  button.innerHTML = '<span>↻</span> Загрузка ядра...';
  try {
    await api('/api/core/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: state.selectedCore, version: $('#core-version').value })
    });
    await refreshState();
    notify(`Установлено ${state.selectedCore} для Minecraft ${state.settings.version}.`);
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>↓</span> Скачать и установить ядро';
  }
}

async function uploadJar(file, endpoint) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.jar')) {
    notify('Можно загрузить только файл .jar.', 'error');
    return;
  }
  if (file.size > 512 * 1024 * 1024) {
    notify('Файл превышает лимит 512 МБ.', 'error');
    return;
  }
  try {
    const data = await api(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/java-archive', 'X-File-Name': encodeURIComponent(file.name) }, body: file
    });
    await refreshState();
    notify(`Файл ${data.name} загружен.`);
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function removeAddon(item) {
  if (!confirm(`Удалить ${item.name}?`)) return;
  try {
    await api(`/api/addons/${item.category}/${encodeURIComponent(item.name)}`, { method: 'DELETE' });
    await refreshState();
    notify(`Файл ${item.name} удалён.`);
  } catch (error) {
    notify(error.message, 'error');
  }
}

function openAddonSearch() {
  const dialog = $('#search-dialog');
  $('#search-version').textContent = state.settings?.version || '—';
  dialog.showModal();
  updateSearchFilters();
  $('#search-query').focus();
}

function updateSearchFilters() {
  const modOption = $('#search-kind').querySelector('option[value="mod"]');
  const canInstallMods = state.settings?.core === 'fabric';
  modOption.disabled = !canInstallMods;
  if (!canInstallMods && $('#search-kind').value === 'mod') $('#search-kind').value = 'plugin';
  const isMod = $('#search-kind').value === 'mod';
  $('#loader-filter-wrap').hidden = !isMod || $('#search-source').value === 'curseforge';
  if (isMod && canInstallMods) {
    $('#search-loader').value = 'fabric';
    $$('#search-loader option').forEach((option) => { option.disabled = option.value !== 'fabric'; });
  } else {
    $$('#search-loader option').forEach((option) => { option.disabled = false; });
  }
}

function searchRecord(record, source, kind) {
  if (source === 'curseforge') {
    return {
      id: record.id,
      title: record.name,
      description: record.summary || 'Дополнение сообщества CurseForge.',
      author: record.authors?.[0]?.name || 'CurseForge',
      downloads: record.downloadCount,
      icon: record.logo?.url,
      slug: record.slug,
      kind,
      source,
      loaders: record.latestFilesIndexes?.map((item) => item.gameVersion).filter(Boolean).slice(0, 3) || []
    };
  }
  return {
    id: record.project_id,
    title: record.title,
    description: record.description,
    author: record.author,
    downloads: record.downloads,
    icon: record.icon_url,
    slug: record.slug,
    kind,
    source,
    loaders: record.display_categories || record.categories || []
  };
}

function safeImageUrl(value, source) {
  try {
    const url = new URL(value);
    const trusted = source === 'curseforge' ? url.hostname === 'forgecdn.net' || url.hostname.endsWith('.forgecdn.net') : url.hostname === 'cdn.modrinth.com';
    return url.protocol === 'https:' && trusted ? url.href : '';
  } catch {
    return '';
  }
}

function formatDownloads(value) {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat('ru-RU', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value) + ' загрузок';
}

function renderSearchResults() {
  const container = $('#search-results');
  container.replaceChildren();
  if (!state.searchResults.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.innerHTML = '<span>⌕</span><p>Ничего не найдено для выбранной версии.</p>';
    container.append(empty);
    return;
  }
  for (const result of state.searchResults) {
    const row = document.createElement('article');
    row.className = 'search-result';
    const imageUrl = safeImageUrl(result.icon, result.source);
    const image = imageUrl ? document.createElement('img') : document.createElement('span');
    image.className = imageUrl ? 'result-icon' : 'result-icon result-icon-placeholder';
    if (imageUrl) {
      image.src = imageUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => { image.removeAttribute('src'); image.classList.add('result-icon-placeholder'); image.textContent = result.kind === 'mod' ? 'M' : 'P'; });
    } else image.textContent = result.kind === 'mod' ? 'M' : 'P';
    const copy = document.createElement('div');
    copy.className = 'result-copy';
    const title = document.createElement('strong');
    title.textContent = result.title;
    const description = document.createElement('p');
    description.textContent = result.description;
    const meta = document.createElement('div');
    meta.className = 'result-meta';
    for (const label of [result.author, formatDownloads(result.downloads)]) {
      if (!label) continue;
      const item = document.createElement('span');
      item.textContent = label;
      meta.append(item);
    }
    for (const loader of result.loaders.slice(0, 2)) {
      const item = document.createElement('span');
      item.className = 'result-loader';
      item.textContent = loader;
      meta.append(item);
    }
    copy.append(title, description, meta);
    const button = document.createElement('button');
    button.className = 'button button-outline result-install';
    button.type = 'button';
    button.textContent = 'Установить';
    button.addEventListener('click', () => installAddon(result, button));
    row.append(image, copy, button);
    container.append(row);
  }
}

async function searchAddons() {
  const query = $('#search-query').value.trim();
  const kind = $('#search-kind').value;
  const source = $('#search-source').value;
  if (!query) {
    notify('Введи название дополнения для поиска.', 'error');
    $('#search-query').focus();
    return;
  }
  const button = $('#run-search');
  button.disabled = true;
  button.innerHTML = '<span>↻</span> Ищем...';
  $('#search-results').innerHTML = '<div class="search-empty"><span>↻</span><p>Подключаемся к каталогу...</p></div>';
  try {
    const params = new URLSearchParams({ query, kind, version: state.settings.version });
    if (kind === 'mod') params.set('loader', $('#search-loader').value);
    const data = await api(`/api/${source}/search?${params}`);
    const records = source === 'curseforge' ? data.data || [] : data.hits || [];
    state.searchResults = records.map((record) => searchRecord(record, source, kind));
    renderSearchResults();
  } catch (error) {
    state.searchResults = [];
    $('#search-results').replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    const message = document.createElement('p');
    message.textContent = error.message;
    empty.append(message);
    $('#search-results').append(empty);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Найти <span>↗</span>';
  }
}

async function installAddon(result, button) {
  if (state.running) {
    notify('Останови сервер перед установкой дополнения.', 'error');
    return;
  }
  button.disabled = true;
  button.textContent = 'Загрузка...';
  try {
    await api('/api/addons/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: result.source, kind: result.kind, projectId: result.id, modId: result.id, loader: $('#search-loader').value })
    });
    await refreshState();
    notify(`${result.title} установлен.`);
    button.textContent = 'Установлено';
  } catch (error) {
    notify(error.message, 'error');
    button.disabled = false;
    button.textContent = 'Установить';
  }
}

async function sendCommand(event) {
  event.preventDefault();
  const input = $('#console-command');
  const command = input.value.trim();
  if (!command) return;
  try {
    await api('/api/server/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command })
    });
    input.value = '';
    await refreshState();
    input.focus();
  } catch (error) {
    notify(error.message, 'error');
  }
}

function applyPreset(preset) {
  const values = {
    quiet: { viewDistance: 6, simulationDistance: 4 },
    balanced: { viewDistance: 8, simulationDistance: 6 },
    performance: { viewDistance: 10, simulationDistance: 8 }
  };
  const chosen = values[preset];
  if (!chosen) return;
  setField($('#settings-form'), 'viewDistance', chosen.viewDistance);
  setField($('#settings-form'), 'simulationDistance', chosen.simulationDistance);
  updatePresetButtons(preset);
}

function setClock() {
  $('#clock').textContent = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function bindEvents() {
  $$('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $('#main-power').addEventListener('click', toggleServer);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#save-settings-top').addEventListener('click', saveSettings);
  $$('.core-option').forEach((button) => button.addEventListener('click', async () => {
    if (state.running) return notify('Останови сервер перед сменой ядра.', 'error');
    state.selectedCore = button.dataset.core;
    $$('.core-option').forEach((option) => option.classList.toggle('selected', option === button));
    try { await loadVersions(); } catch (error) { notify(error.message, 'error'); }
  }));
  $('#refresh-versions').addEventListener('click', () => loadVersions().catch((error) => notify(error.message, 'error')));
  $('#install-core').addEventListener('click', installSelectedCore);
  $('#core-file').addEventListener('change', (event) => uploadJar(event.target.files[0], '/api/core/upload'));
  $('#addon-file').addEventListener('change', (event) => {
    uploadJar(event.target.files[0], `/api/addons/upload?category=${state.filter === 'mods' ? 'mods' : 'plugins'}`);
    event.target.value = '';
  });
  const dropZone = $('.drop-zone');
  for (const eventName of ['dragenter', 'dragover']) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
  for (const eventName of ['dragleave', 'drop']) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); });
  dropZone.addEventListener('drop', (event) => uploadJar(event.dataTransfer.files[0], '/api/core/upload'));
  $$('.segment').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.segment').forEach((segment) => segment.classList.toggle('active', segment === button));
    renderAddons();
  }));
  $('#open-addon-search').addEventListener('click', openAddonSearch);
  $('#empty-search').addEventListener('click', openAddonSearch);
  $('#close-search').addEventListener('click', () => $('#search-dialog').close());
  $('#search-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  $('#search-kind').addEventListener('change', updateSearchFilters);
  $('#search-source').addEventListener('change', updateSearchFilters);
  $('#run-search').addEventListener('click', searchAddons);
  $('#search-query').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); searchAddons(); } });
  $$('.preset-option').forEach((button) => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
  $('#command-form').addEventListener('submit', sendCommand);
  $('#clear-console').addEventListener('click', () => { state.logs = []; renderConsole(); });
  $('#download-log').addEventListener('click', () => {
    const text = state.logs.map((entry) => `[${entry.time}] [${entry.stream}] ${entry.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'minecraft-console.log';
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

async function init() {
  bindEvents();
  setClock();
  setInterval(setClock, 15_000);
  try {
    await refreshState();
    fillSettingsForm();
    const initial = location.hash.slice(1);
    if (pageNames[initial]) navigate(initial);
    if (state.settings.core === 'fabric') {
      state.selectedCore = 'fabric';
      $$('.core-option').forEach((button) => button.classList.toggle('selected', button.dataset.core === 'fabric'));
    } else if (state.settings.core === 'purpur') {
      state.selectedCore = 'purpur';
      $$('.core-option').forEach((button) => button.classList.toggle('selected', button.dataset.core === 'purpur'));
    }
    setInterval(() => refreshState().catch(() => {}), 2000);
  } catch (error) {
    notify(`Не удалось подключиться к панели: ${error.message}`, 'error');
  }
}

init();