import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, '.host-data');
const SERVER_DIR = join(DATA_DIR, 'server');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const LOG_FILE = join(DATA_DIR, 'console.log');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4173;
const HOST = '127.0.0.1';
const MAX_UPLOAD = 512 * 1024 * 1024;
const MAX_DOWNLOAD = 512 * 1024 * 1024;
const USER_AGENT = 'minecraft-host-panel/1.0 (local server manager)';

const DEFAULT_SETTINGS = {
  name: 'Мой сервер',
  version: '1.21.4',
  core: 'paper',
  java: 'java',
  minMemory: 2,
  maxMemory: 4,
  port: 25565,
  motd: 'Minecraft server',
  maxPlayers: 20,
  difficulty: 'easy',
  gamemode: 'survival',
  levelName: 'world',
  viewDistance: 8,
  simulationDistance: 6,
  optimization: 'balanced',
  onlineMode: true,
  whitelist: false,
  pvp: true,
  eulaAccepted: false,
  advancedProperties: ''
};

let settings = { ...DEFAULT_SETTINGS };
let serverProcess = null;
let logs = [];
let stoppingTimer = null;

await mkdir(SERVER_DIR, { recursive: true });
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) };
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not load settings:', error.message);
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function addLog(text, stream = 'system') {
  const entry = { id: randomUUID(), time: new Date().toISOString(), stream, text };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  appendFile(LOG_FILE, `[${entry.time}] [${stream}] ${text}\n`).catch(() => {});
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Слишком большой JSON-запрос.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validVersion(version) {
  return typeof version === 'string' && /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(version);
}

function cleanFileName(value) {
  const name = normalize(decodeURIComponent(value || '')).split(/[\\/]/).pop();
  return name && name !== '.' && name !== '..' ? name.replace(/[^\w.() -]/g, '_') : '';
}

function safeServerFile(name) {
  const file = resolve(SERVER_DIR, name);
  if (!file.startsWith(SERVER_DIR + sep)) throw new Error('Недопустимый путь.');
  return file;
}

function validateSettings(input) {
  const next = { ...settings, ...input };
  if (typeof next.name !== 'string' || next.name.length > 80) throw new Error('Название сервера: не более 80 символов.');
  if (!validVersion(next.version)) throw new Error('Укажите версию Minecraft, например 1.21.4.');
  if (!['paper', 'purpur', 'fabric', 'custom'].includes(next.core)) throw new Error('Неизвестный тип ядра.');
  if (!/^[\w./-]{1,120}$/.test(next.java)) throw new Error('Укажите корректную команду Java.');
  if (!Number.isInteger(next.minMemory) || !Number.isInteger(next.maxMemory) || next.minMemory < 1 || next.maxMemory < next.minMemory || next.maxMemory > 256) throw new Error('Память: от 1 до 256 ГБ; минимум не должен быть выше максимума.');
  if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new Error('Порт должен быть от 1 до 65535.');
  if (!Number.isInteger(next.maxPlayers) || next.maxPlayers < 1 || next.maxPlayers > 1000) throw new Error('Количество игроков должно быть от 1 до 1000.');
  if (!['peaceful', 'easy', 'normal', 'hard'].includes(next.difficulty)) throw new Error('Неизвестная сложность.');
  if (!['survival', 'creative', 'adventure', 'spectator'].includes(next.gamemode)) throw new Error('Неизвестный режим игры.');
  if (!Number.isInteger(next.viewDistance) || next.viewDistance < 2 || next.viewDistance > 32) throw new Error('Дальность прорисовки должна быть от 2 до 32.');
  if (!Number.isInteger(next.simulationDistance) || next.simulationDistance < 2 || next.simulationDistance > 32) throw new Error('Дальность симуляции должна быть от 2 до 32.');
  if (!['quiet', 'balanced', 'performance'].includes(next.optimization)) throw new Error('Неизвестный профиль оптимизации.');
  if (typeof next.motd !== 'string' || next.motd.length > 120) throw new Error('MOTD: не более 120 символов.');
  if (typeof next.levelName !== 'string' || !/^[\w-]{1,64}$/.test(next.levelName)) throw new Error('Имя мира может содержать латинские буквы, цифры, дефис и подчёркивание.');
  if (typeof next.advancedProperties !== 'string' || next.advancedProperties.length > 10000) throw new Error('Дополнительные параметры слишком длинные.');
  return next;
}

function makeProperties() {
  const properties = {
    'server-port': settings.port,
    'motd': settings.motd.replace(/[\r\n=]/g, ' '),
    'max-players': settings.maxPlayers,
    'difficulty': settings.difficulty,
    'gamemode': settings.gamemode,
    'level-name': settings.levelName,
    'view-distance': settings.viewDistance,
    'simulation-distance': settings.simulationDistance,
    'entity-broadcast-range-percentage': { quiet: 50, balanced: 75, performance: 100 }[settings.optimization],
    'online-mode': settings.onlineMode,
    'white-list': settings.whitelist,
    'pvp': settings.pvp
  };
  const lines = settings.advancedProperties.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index > 0) properties[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return `${Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, ...options.headers },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Источник ответил ${response.status}.`);
  return response.json();
}

async function downloadToFile(url, destination, options = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...options.headers },
    signal: AbortSignal.timeout(120_000),
    redirect: 'follow'
  });
  if (!response.ok || !response.body) throw new Error(`Не удалось скачать файл (HTTP ${response.status}).`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_DOWNLOAD) throw new Error('Файл превышает лимит 512 МБ.');
  let downloaded = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      callback(downloaded > MAX_DOWNLOAD ? new Error('Файл превышает лимит 512 МБ.') : null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination));
}

async function installCore(source, version) {
  if (!validVersion(version)) throw new Error('Версия Minecraft указана неверно.');
  const temporary = join(DATA_DIR, `core-${randomUUID()}.download`);
  try {
    if (source === 'paper') {
      const builds = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`);
      const build = builds.find((item) => item.channel === 'STABLE') || builds[0];
      const downloadUrl = build?.downloads?.['server:default']?.url;
      if (!downloadUrl || new URL(downloadUrl).hostname !== 'fill-data.papermc.io') throw new Error('Для этой версии Paper пока нет доступной стабильной сборки.');
      await downloadToFile(downloadUrl, temporary);
    } else if (source === 'purpur') {
      await downloadToFile(`https://api.purpurmc.org/v2/purpur/${version}/latest/download`, temporary);
    } else if (source === 'fabric') {
      const [loaders, installers] = await Promise.all([
        fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${version}`),
        fetchJson('https://meta.fabricmc.net/v2/versions/installer')
      ]);
      const loader = loaders.find((item) => item.loader?.stable) || loaders[0];
      const installer = installers.find((item) => item.stable) || installers[0];
      if (!loader || !installer) throw new Error('Fabric не нашёл подходящие загрузчик и установщик.');
      await downloadToFile(`https://meta.fabricmc.net/v2/versions/loader/${version}/${loader.loader.version}/${installer.version}/server/jar`, temporary);
    } else {
      throw new Error('Выберите Paper, Purpur, Fabric или загрузите своё ядро.');
    }
    await rename(temporary, join(SERVER_DIR, 'server.jar'));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function getInventory() {
  const items = [];
  for (const folder of ['plugins', 'mods']) {
    const directory = join(SERVER_DIR, folder);
    await mkdir(directory, { recursive: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.jar') continue;
      const details = await stat(join(directory, entry.name));
      items.push({ name: entry.name, category: folder, size: details.size, modified: details.mtime.toISOString() });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function getState() {
  let core = null;
  try {
    const details = await stat(join(SERVER_DIR, 'server.jar'));
    core = { installed: true, size: details.size, modified: details.mtime.toISOString() };
  } catch { core = { installed: false }; }
  return {
    settings,
    running: Boolean(serverProcess && serverProcess.exitCode === null),
    pid: serverProcess?.pid || null,
    core,
    addons: await getInventory(),
    logs
  };
}

function streamProcess(stream, name) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) if (line) addLog(line, name);
  });
  stream.on('end', () => { if (pending) addLog(pending, name); });
}

async function startServer() {
  if (serverProcess && serverProcess.exitCode === null) throw new Error('Сервер уже запущен.');
  if (!settings.eulaAccepted) throw new Error('Сначала подтвердите принятие EULA в настройках.');
  await stat(join(SERVER_DIR, 'server.jar')).catch(() => { throw new Error('Сначала установите ядро сервера.'); });
  await writeFile(join(SERVER_DIR, 'eula.txt'), 'eula=true\n');
  await writeFile(join(SERVER_DIR, 'server.properties'), makeProperties());
  logs = [];
  addLog(`Запуск ${settings.name} · Minecraft ${settings.version} · Java ${settings.java}`);
  const gcPauseTarget = { quiet: 250, balanced: 200, performance: 100 }[settings.optimization];
  serverProcess = spawn(settings.java, [
    `-Xms${settings.minMemory}G`, `-Xmx${settings.maxMemory}G`,
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', `-XX:MaxGCPauseMillis=${gcPauseTarget}`, '-XX:+DisableExplicitGC',
    '-jar', 'server.jar', 'nogui'
  ], { cwd: SERVER_DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  streamProcess(serverProcess.stdout, 'server');
  streamProcess(serverProcess.stderr, 'error');
  serverProcess.on('error', (error) => {
    addLog(`Не удалось запустить Java: ${error.message}`, 'error');
    serverProcess = null;
  });
  serverProcess.on('exit', (code, signal) => {
    clearTimeout(stoppingTimer);
    stoppingTimer = null;
    addLog(`Процесс завершён · code=${code ?? 'null'} · signal=${signal || 'none'}`);
    serverProcess = null;
  });
  return { started: true };
}

async function uploadFile(request, response, category) {
  if (serverProcess && serverProcess.exitCode === null) throw new Error('Остановите сервер перед загрузкой файлов.');
  const fileName = cleanFileName(request.headers['x-file-name']);
  if (!fileName || extname(fileName).toLowerCase() !== '.jar') return sendError(response, 400, 'Разрешены только файлы .jar.');
  const folder = category === 'core' ? SERVER_DIR : join(SERVER_DIR, category);
  await mkdir(folder, { recursive: true });
  const destination = join(folder, category === 'core' ? 'server.jar' : fileName);
  const temporary = join(folder, `.upload-${randomUUID()}`);
  let size = 0;
  try {
    await pipeline(request, async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new Error('Файл превышает лимит 512 МБ.');
        yield chunk;
      }
    }, createWriteStream(temporary, { flags: 'wx' }));
    if (!size) throw new Error('Файл пуст.');
    await rename(temporary, destination);
    if (category === 'core') {
      settings = validateSettings({ core: 'custom' });
      await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } else {
      addLog(`Загружен файл ${category}/${fileName}`);
    }
    sendJson(response, 200, { uploaded: true, name: fileName, size });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function modrinthSearch(url) {
  const kind = url.searchParams.get('kind') === 'plugin' ? 'plugin' : 'mod';
  if (kind === 'mod' && settings.core !== 'fabric') throw Object.assign(new Error('Моды доступны только после установки Fabric-ядра.'), { status: 409 });
  const facets = [[`project_type:${kind}`]];
  const version = url.searchParams.get('version');
  const loader = url.searchParams.get('loader');
  if (version) facets.push([`versions:${version}`]);
  if (kind === 'mod' && loader && loader !== 'any') facets.push([`categories:${loader}`]);
  const query = new URLSearchParams({
    query: url.searchParams.get('query') || '',
    limit: '12',
    index: 'relevance',
    facets: JSON.stringify(facets)
  });
  return fetchJson(`https://api.modrinth.com/v2/search?${query}`);
}

async function installModrinth(input) {
  if (!input.projectId || !['plugin', 'mod'].includes(input.kind)) throw new Error('Не удалось определить проект Modrinth.');
  if (input.kind === 'mod' && settings.core !== 'fabric') throw new Error('Для установки модов сначала выберите Fabric-ядро.');
  const versions = await fetchJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(input.projectId)}/version`);
  const compatible = versions.find((version) => {
    if (!version.game_versions?.includes(settings.version)) return false;
    if (input.kind === 'mod') {
      const loader = input.loader || 'fabric';
      return version.loaders?.includes(loader);
    }
    return true;
  });
  if (!compatible) throw new Error(`Для Minecraft ${settings.version} не найдена совместимая версия.`);
  const file = compatible.files?.find((entry) => entry.primary) || compatible.files?.[0];
  if (!file?.url || new URL(file.url).hostname !== 'cdn.modrinth.com') throw new Error('Источник вернул некорректный файл.');
  const filename = cleanFileName(file.filename);
  if (!filename || extname(filename).toLowerCase() !== '.jar') throw new Error('Источник не вернул JAR-файл.');
  const category = input.kind === 'plugin' ? 'plugins' : 'mods';
  const destination = join(SERVER_DIR, category, filename);
  await mkdir(join(SERVER_DIR, category), { recursive: true });
  if (serverProcess && serverProcess.exitCode === null) throw new Error('Остановите сервер перед установкой плагина или мода.');
  await downloadToFile(file.url, destination);
  addLog(`Установлен ${input.kind}: ${filename} (Modrinth)`);
  return { name: filename, category };
}

function curseforgeHeaders() {
  if (!process.env.CURSEFORGE_API_KEY) throw Object.assign(new Error('Для CurseForge задайте CURSEFORGE_API_KEY в окружении перед запуском панели.'), { status: 503 });
  return { 'x-api-key': process.env.CURSEFORGE_API_KEY };
}

async function curseforgeSearch(url) {
  const headers = curseforgeHeaders();
  const kind = url.searchParams.get('kind') === 'plugin' ? 'plugin' : 'mod';
  if (kind === 'mod' && settings.core !== 'fabric') throw Object.assign(new Error('Моды доступны только после установки Fabric-ядра.'), { status: 409 });
  const query = new URLSearchParams({
    gameId: '432', classId: kind === 'plugin' ? '5' : '6',
    searchFilter: url.searchParams.get('query') || '', pageSize: '12', index: '0',
    gameVersion: settings.version, ...(kind === 'mod' ? { modLoaderType: '4' } : {}), sortField: '2', sortOrder: 'desc'
  });
  return fetchJson(`https://api.curseforge.com/v1/mods/search?${query}`, { headers });
}

async function installCurseForge(input) {
  const headers = curseforgeHeaders();
  if (!['plugin', 'mod'].includes(input.kind)) throw new Error('Неизвестный тип дополнения.');
  if (input.kind === 'mod' && settings.core !== 'fabric') throw new Error('Для установки модов сначала выберите Fabric-ядро.');
  if (!Number.isSafeInteger(Number(input.modId)) || Number(input.modId) < 1) throw new Error('Некорректный идентификатор CurseForge.');
  const query = new URLSearchParams({ gameVersion: settings.version, ...(input.kind === 'mod' ? { modLoaderType: '4' } : {}), pageSize: '20', index: '0' });
  const data = await fetchJson(`https://api.curseforge.com/v1/mods/${input.modId}/files?${query}`, { headers });
  const file = (data.data || []).find((item) => item.downloadUrl && item.fileName?.toLowerCase().endsWith('.jar'));
  if (!file) throw new Error('У проекта нет доступного JAR для этой версии Minecraft.');
  const category = input.kind === 'plugin' ? 'plugins' : 'mods';
  if (serverProcess && serverProcess.exitCode === null) throw new Error('Остановите сервер перед установкой плагина или мода.');
  const destination = join(SERVER_DIR, category, cleanFileName(file.fileName));
  await mkdir(join(SERVER_DIR, category), { recursive: true });
  await downloadToFile(file.downloadUrl, destination);
  addLog(`Установлен ${input.kind}: ${file.fileName} (CurseForge)`);
  return { name: file.fileName, category };
}

async function handleApi(request, response, url) {
  const route = url.pathname;
  try {
    if (request.method === 'GET' && route === '/api/state') return sendJson(response, 200, await getState());
    if (request.method === 'PUT' && route === '/api/settings') {
      settings = validateSettings(await readJson(request));
      await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      return sendJson(response, 200, { settings });
    }
    if (request.method === 'GET' && route === '/api/versions') {
      const source = url.searchParams.get('source');
      if (source === 'paper') {
        const data = await fetchJson('https://fill.papermc.io/v3/projects/paper/versions');
        const versions = (data.versions || []).map((item) => item.version?.id).filter(Boolean).reverse();
        return sendJson(response, 200, { versions });
      }
      if (source === 'purpur') {
        const data = await fetchJson('https://api.purpurmc.org/v2/purpur');
        return sendJson(response, 200, { versions: data.versions.reverse() });
      }
      if (source === 'fabric') {
        const data = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
        return sendJson(response, 200, { versions: data.filter((item) => item.stable).map((item) => item.version) });
      }
      return sendError(response, 400, 'Неизвестный источник ядра.');
    }
    if (request.method === 'POST' && route === '/api/core/install') {
      if (serverProcess && serverProcess.exitCode === null) return sendError(response, 409, 'Остановите сервер перед заменой ядра.');
      const input = await readJson(request);
      const source = ['paper', 'purpur', 'fabric'].includes(input.source) ? input.source : '';
      await installCore(source, input.version);
      settings = validateSettings({ core: source, version: input.version });
      await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      addLog(`Установлено ядро ${source} для Minecraft ${input.version}`);
      return sendJson(response, 200, { installed: true, source, version: input.version });
    }
    if (request.method === 'POST' && route === '/api/core/upload') return uploadFile(request, response, 'core');
    if (request.method === 'POST' && route === '/api/addons/upload') {
      const category = url.searchParams.get('category') === 'plugins' ? 'plugins' : 'mods';
      return uploadFile(request, response, category);
    }
    if (request.method === 'GET' && route === '/api/modrinth/search') return sendJson(response, 200, await modrinthSearch(url));
    if (request.method === 'GET' && route === '/api/curseforge/search') return sendJson(response, 200, await curseforgeSearch(url));
    if (request.method === 'POST' && route === '/api/addons/install') {
      if (serverProcess && serverProcess.exitCode === null) return sendError(response, 409, 'Остановите сервер перед установкой плагина или мода.');
      const input = await readJson(request);
      const installed = input.source === 'curseforge' ? await installCurseForge(input) : await installModrinth(input);
      return sendJson(response, 200, { installed: true, ...installed });
    }
    if (request.method === 'DELETE' && route.startsWith('/api/addons/')) {
      if (serverProcess && serverProcess.exitCode === null) return sendError(response, 409, 'Остановите сервер перед удалением файла.');
      const [, , , category, ...fileParts] = route.split('/');
      const rawFilename = fileParts.join('/');
      let decodedFilename;
      try { decodedFilename = decodeURIComponent(rawFilename); } catch { return sendError(response, 400, 'Некорректный путь файла.'); }
      const filename = cleanFileName(rawFilename);
      if (!['plugins', 'mods'].includes(category) || fileParts.length !== 1 || !filename || filename !== decodedFilename || extname(filename).toLowerCase() !== '.jar') return sendError(response, 400, 'Некорректный путь файла.');
      await rm(safeServerFile(join(category, filename)));
      return sendJson(response, 200, { removed: true });
    }
    if (request.method === 'POST' && route === '/api/server/start') return sendJson(response, 200, await startServer());
    if (request.method === 'POST' && route === '/api/server/stop') {
      if (!serverProcess || serverProcess.exitCode !== null) return sendError(response, 409, 'Сервер не запущен.');
      serverProcess.stdin.write('stop\n');
      stoppingTimer = setTimeout(() => {
        if (serverProcess && serverProcess.exitCode === null) {
          addLog('Нет ответа на остановку; завершаю процесс.', 'error');
          serverProcess.kill('SIGTERM');
        }
      }, 15_000);
      return sendJson(response, 200, { stopping: true });
    }
    if (request.method === 'POST' && route === '/api/server/command') {
      if (!serverProcess || serverProcess.exitCode !== null) return sendError(response, 409, 'Сервер не запущен.');
      const input = await readJson(request);
      const command = String(input.command || '').trim();
      if (!command || command.length > 1000 || /[\r\n\0]/.test(command)) return sendError(response, 400, 'Введите одну команду длиной до 1000 символов.');
      serverProcess.stdin.write(`${command}\n`);
      addLog(`> ${command}`, 'command');
      return sendJson(response, 200, { sent: true });
    }
    if (request.method === 'GET' && route === '/api/logs') return sendJson(response, 200, { logs });
    return sendError(response, 404, 'Маршрут не найден.');
  } catch (error) {
    return sendError(response, error.status || 400, error.message || 'Не удалось выполнить запрос.');
  }
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon'
};

const app = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin) {
    try {
      const origin = new URL(request.headers.origin);
      if (origin.host !== request.headers.host || !['127.0.0.1', 'localhost'].includes(origin.hostname)) return sendError(response, 403, 'Изменяющие запросы разрешены только с локальной панели.');
    } catch {
      return sendError(response, 403, 'Недопустимый источник запроса.');
    }
  }
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + sep)) return sendError(response, 403, 'Доступ запрещён.');
  try {
    const details = await stat(file);
    if (!details.isFile()) return sendError(response, 404, 'Файл не найден.');
    response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(response);
  } catch {
    sendError(response, 404, 'Файл не найден.');
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Minecraft Host Panel: http://${HOST}:${PORT}`);
  console.log('Для CurseForge задайте CURSEFORGE_API_KEY в окружении.');
});