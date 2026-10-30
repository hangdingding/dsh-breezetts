/**
 * Host half of the Breeze voice bundle.
 *
 * The browser half never holds the TTS credential. It posts one utterance to the
 * same-origin route below; this Host handler forwards it to the configured TTS
 * provider and returns the audio bytes. Routes:
 *
 *   POST /breeze-voice/speak    { text } -> audio bytes
 *   GET  /breeze-voice/stream?text=...  -> progressive audio (Breeze protocol)
 *   GET  /breeze-voice/voices           -> voice catalog (Breeze protocol only)
 *   GET  /breeze-voice/health           -> non-secret configuration summary
 *
 * Two protocols are supported:
 *   - `breezeblue` (default): POST {baseUrl}/v1/text-to-speech/{voiceId}?output_format=...
 *     with `xi-api-key`; body is the Breeze TtsRequest shape.
 *   - `openai`: POST {endpoint} with an OpenAI-compatible
 *     `{model, input, voice, response_format, speed}` body (self-hosted vLLM etc.).
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULTS = Object.freeze({
  protocol: 'breezeblue',
  baseUrl: 'https://api.breeze.blue',
  voiceId: '',
  apiKey: '',
  modelId: '',
  languageCode: '',
  outputFormat: 'mp3',
  instructions: '',
  // Optional image (http/https) shown as the voice avatar; empty = monogram.
  avatarUrl: '',
  speed: 1,
  maxChars: 2000,
  timeoutMs: 120000,
  headers: {},
  extraBody: {},
  // OpenAI-compatible protocol.
  endpoint: '',
  model: '',
  voice: '',
});

const MAX_BODY_BYTES = 1_000_000;
const SPEAK_PATH = '/breeze-voice/speak';
const VOICES_PATH = '/breeze-voice/voices';
const VOICE_PATH = '/breeze-voice/voice';
const AVATAR_PATH = '/breeze-voice/avatar';
const HEALTH_PATH = '/breeze-voice/health';
const AVATAR_TTL_MS = 60 * 60 * 1000;
const MAX_AVATAR_BYTES = 2_000_000;

/** Cached voice metadata and avatar bytes; one Host instance owns these. */
const voiceMetaCache = new Map();
const avatarCache = new Map();
const previewCache = new Map();
const balanceCache = new Map();
const designCache = new Map();
const DESIGN_TTL_MS = 30 * 60 * 1000;
const MAX_ERROR_CHARS = 600;

const DEBUG_PATH = '/breeze-voice/debug';
const STREAM_PATH = '/breeze-voice/stream';
const BUILTIN_AVATAR = fileURLToPath(new URL('./avatar.png', import.meta.url));
const CONFIG_PATH = '/breeze-voice/config';
const PREVIEW_PATH = '/breeze-voice/preview';
const BALANCE_PATH = '/breeze-voice/balance';
const DESIGN_PATH = '/breeze-voice/design';
const DESIGN_AUDIO_PATH = '/breeze-voice/design/audio';
const DESIGN_SAVE_PATH = '/breeze-voice/design/save';
const CODE_COOLDOWN_MS = 60_000;
const SETTINGS_FILE = fileURLToPath(new URL('./settings.json', import.meta.url));
const MAX_PREVIEW_BYTES = 5_000_000;
/** Fields the settings dialog owns; everything else stays in the patch. */
const EDITABLE_KEYS = ['apiKey', 'voiceId', 'speed', 'instructions', 'languageCode', 'modelId', 'avatarUrl'];
const DEBUG_FILE = fileURLToPath(new URL('./debug.log', import.meta.url));

/**
 * Append one diagnostic line. Never throws: diagnostics must not break audio.
 * @param entry - JSON-serializable diagnostic record.
 */
function debugLog(entry) {
  try {
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore a read-only or missing file.
  }
}

export const inject = ['webServer'];

/**
 * Register the proxy routes with the browser HTTP carrier.
 * @param ctx - Host plugin context.
 * @param config - the patch row's config; missing fields fall back to DEFAULTS.
 */
export function apply(ctx, config = {}) {
  const state = {
    patch: config && typeof config === 'object' ? config : {},
    settings: resolveSettings({ ...(config ?? {}), ...readOverrides() }),
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SPEAK_PATH,
    handler: (req, res) => handleSpeak(state.settings, req, res),
  }), 'breeze-voice: speak route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VOICES_PATH,
    handler: (req, res) => handleVoices(state.settings, req, res),
  }), 'breeze-voice: voices route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VOICE_PATH,
    handler: (req, res) => handleVoice(state.settings, req, res),
  }), 'breeze-voice: voice info route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AVATAR_PATH,
    handler: (req, res) => handleAvatar(state.settings, req, res),
  }), 'breeze-voice: avatar route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STREAM_PATH,
    handler: (req, res) => handleStream(state.settings, req, res),
  }), 'breeze-voice: stream route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: (req, res) => handleConfig(state, req, res),
  }), 'breeze-voice: config route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEW_PATH,
    handler: (req, res) => handlePreview(state.settings, req, res),
  }), 'breeze-voice: preview route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BALANCE_PATH,
    handler: (req, res) => handleBalance(state.settings, req, res),
  }), 'breeze-voice: balance route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DESIGN_PATH,
    handler: (req, res) => handleDesign(state.settings, req, res),
  }), 'breeze-voice: design route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DESIGN_AUDIO_PATH,
    handler: (req, res) => handleDesignAudio(req, res),
  }), 'breeze-voice: design audio route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DESIGN_SAVE_PATH,
    handler: (req, res) => handleDesignSave(state.settings, req, res),
  }), 'breeze-voice: design save route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEBUG_PATH,
    handler: (req, res) => handleDebug(req, res),
  }), 'breeze-voice: debug route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: (req, res) => {
      handleHealth(state.settings, req, res);
    },
  }), 'breeze-voice: health route');
}

/**
 * Merge the row config over the defaults without trusting its shape.
 * @param config - raw row config.
 * @returns a complete settings object.
 */
function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const settings = { ...DEFAULTS };
  for (const key of [
    'protocol', 'baseUrl', 'voiceId', 'apiKey', 'modelId', 'languageCode',
    'outputFormat', 'instructions', 'endpoint', 'model', 'voice', 'avatarUrl',
  ]) {
    if (typeof raw[key] === 'string') settings[key] = raw[key].trim();
  }
  if (settings.protocol !== 'openai') settings.protocol = 'breezeblue';
  if (settings.baseUrl === '') settings.baseUrl = DEFAULTS.baseUrl;
  if (Number.isFinite(raw.speed) && raw.speed > 0) settings.speed = raw.speed;
  if (Number.isFinite(raw.maxChars) && raw.maxChars > 0) settings.maxChars = Math.floor(raw.maxChars);
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) settings.timeoutMs = Math.floor(raw.timeoutMs);
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    settings.headers = { ...raw.headers };
  }
  if (raw.extraBody && typeof raw.extraBody === 'object' && !Array.isArray(raw.extraBody)) {
    settings.extraBody = { ...raw.extraBody };
  }
  return settings;
}

/**
 * Turn one posted utterance into audio.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleSpeak(settings, req, res) {
  const startedAt = Date.now();
  const client = req.headers['x-breeze-client'] ?? null;
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    writeJson(res, 405, { error: '只支持 POST 请求' });
    return;
  }

  const missing = missingSetting(settings);
  if (missing !== '') {
    writeJson(res, 400, { error: missing });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, { error: describeError(error, '请求体不是合法的 JSON') });
    return;
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text === '') {
    writeJson(res, 400, { error: '没有需要朗读的文字' });
    return;
  }
  if (text.length > settings.maxChars) {
    writeJson(res, 413, {
      error: `单段文字超过上限（${settings.maxChars} 字），请缩短后重试`,
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const upstream = await requestSpeech(settings, text, controller.signal);
    const audio = Buffer.from(await upstream.arrayBuffer());
    if (audio.length === 0) throw new Error('语音服务返回了空音频');
    debugLog({ event: 'speak', client, chars: text.length, ms: Date.now() - startedAt, bytes: audio.length });
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? mimeFor(settings.outputFormat),
      'content-length': String(audio.length),
      'cache-control': 'no-store',
    });
    res.end(audio);
  } catch (error) {
    debugLog({
      event: 'speak-error',
      client,
      chars: text.length,
      ms: Date.now() - startedAt,
      error: describeError(error, '语音合成失败'),
    });
    writeJson(res, 502, { error: describeError(error, '语音合成失败') });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream one utterance so playback starts after the first audio bytes instead of
 * waiting for the whole file. `audio.src` can only issue GET, so the text travels
 * in the query string.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleStream(settings, req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    writeJson(res, 405, { error: '只支持 GET 请求' });
    return;
  }
  if (settings.protocol !== 'breezeblue') {
    writeJson(res, 404, { error: '当前协议不支持流式朗读' });
    return;
  }
  const missing = missingSetting(settings);
  if (missing !== '') {
    writeJson(res, 400, { error: missing });
    return;
  }
  const text = (new URL(req.url, 'http://localhost').searchParams.get('text') ?? '').trim();
  if (text === '') {
    writeJson(res, 400, { error: '没有需要朗读的文字' });
    return;
  }
  if (text.length > settings.maxChars) {
    writeJson(res, 413, { error: `文字超过单次朗读上限（${settings.maxChars} 字）` });
    return;
  }

  const startedAt = Date.now();
  const client = req.headers['x-breeze-client'] ?? null;
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const target = new URL(`${trimSlash(settings.baseUrl)}/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}/stream`);
  if (settings.outputFormat !== '') target.searchParams.set('output_format', settings.outputFormat);

  const body = { text };
  if (settings.modelId !== '') body.model_id = settings.modelId;
  if (settings.languageCode !== '') body.language_code = settings.languageCode;
  if (settings.instructions !== '') body.instructions = settings.instructions;
  if (Number.isFinite(settings.speed) && settings.speed !== 1) body.voice_settings = { speed: settings.speed };

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/*', ...authHeaders(settings), ...settings.headers },
      body: JSON.stringify({ ...body, ...settings.extraBody }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      writeJson(res, 502, { error: await describeUpstreamFailure(upstream) });
      return;
    }
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? mimeFor(settings.outputFormat),
      'cache-control': 'no-store',
    });
    let bytes = 0;
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        bytes += chunk.length;
        res.write(Buffer.from(chunk));
      }
    }
    res.end();
    debugLog({ event: 'stream', client, chars: text.length, ms: Date.now() - startedAt, bytes });
  } catch (error) {
    if (!res.headersSent) {
      writeJson(res, 502, { error: describeError(error, '流式合成失败') });
    } else if (!res.writableEnded) {
      res.end();
    }
    debugLog({
      event: 'stream-error',
      client,
      chars: text.length,
      ms: Date.now() - startedAt,
      error: describeError(error, '流式合成失败'),
    });
  }
}

/**
 * Send one email verification code through the official auth service.
 *
 * Contract (implemented by the Breeze backend):
 *   POST {authBase}/v1/auth/email/send  { email }  -> 200 { request_id? }
 * @param state - apply-scope mutable state.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
/**
 * Verify the code, obtain an API key, and persist it.
 *
 * Contract:
 *   POST {authBase}/v1/auth/email/verify { email, code, request_id }
 *     -> 200 { api_key }  (preferred)  or  { session_token }
 *   When only a session token is returned:
 *   POST {authBase}/v1/api-keys  Authorization: Bearer <session_token> { name }
 *     -> 200 { api_key }
 * @param state - apply-scope mutable state.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
/**
 * Auth base URL for the phone sign-in form.
 * @param settings - resolved plugin settings.
 * @returns the base URL without a trailing slash.
 */
/**
 * Validate and normalize an email address.
 * @param value - raw email input.
 * @returns a trimmed address, or an empty string.
 */
/**
 * Parse a JSON body without throwing.
 * @param text - response text.
 * @returns the parsed object, or an empty object.
 */
/**
 * Build a readable message from a failed upstream text body.
 * @param text - response body.
 * @param status - HTTP status.
 * @param url - request URL.
 * @returns the message.
 */
/**
 * Report the account's credit balance for the configured key.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleBalance(settings, req, res) {
  if (settings.protocol !== 'breezeblue') {
    writeJson(res, 404, { error: '当前协议不提供余额查询' });
    return;
  }
  if (settings.apiKey === '') {
    writeJson(res, 400, { error: '还没有配置 apiKey' });
    return;
  }
  const cached = balanceCache.get(settings.apiKey);
  if (cached !== undefined && Date.now() - cached.at < 30000) {
    writeJson(res, 200, cached.value);
    return;
  }
  try {
    const response = await fetch(`${trimSlash(settings.baseUrl)}/v1/balance`, {
      headers: authHeaders(settings),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      writeJson(res, 502, { error: await describeUpstreamFailure(response) });
      return;
    }
    const payload = await response.json();
    const value = {
      balance: Number(payload.balance) || 0,
      millicredits: Number(payload.balance_millicredits) || 0,
    };
    balanceCache.set(settings.apiKey, { at: Date.now(), value });
    writeJson(res, 200, value);
  } catch (error) {
    writeJson(res, 502, { error: describeError(error, '无法读取余额') });
  }
}

/**
 * Drop expired design previews so memory stays bounded.
 */
function pruneDesignCache() {
  const now = Date.now();
  for (const [id, entry] of designCache) {
    if (now - entry.at > DESIGN_TTL_MS) designCache.delete(id);
  }
}

/**
 * Generate three voice-design previews from a description.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleDesign(settings, req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    writeJson(res, 405, { error: '只支持 POST 请求' });
    return;
  }
  if (settings.protocol !== 'breezeblue') {
    writeJson(res, 400, { error: '当前协议不支持音色设计' });
    return;
  }
  if (settings.apiKey === '') {
    writeJson(res, 400, { error: '还没有配置 apiKey' });
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, { error: describeError(error, '请求体不是合法的 JSON') });
    return;
  }
  const description = typeof payload.description === 'string' ? payload.description.trim() : '';
  if (description.length < 3 || description.length > 500) {
    writeJson(res, 400, { error: '音色描述需要 3–500 字' });
    return;
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text.length > 500) {
    writeJson(res, 400, { error: '试听台词不能超过 500 字' });
    return;
  }
  const language = /^[a-z]{2}$/.test(String(payload.language ?? '')) ? String(payload.language) : 'zh';

  const body = {
    voice_description: description,
    language_code: language,
    preview_count: 3,
  };
  if (text !== '') body.text = text;

  try {
    const response = await fetch(`${trimSlash(settings.baseUrl)}/v1/voice-previews/design`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      writeJson(res, 502, { error: await describeUpstreamFailure(response) });
      return;
    }
    const data = await response.json();
    pruneDesignCache();
    const previews = [];
    for (const item of Array.isArray(data.previews) ? data.previews : []) {
      const id = typeof item.generated_voice_id === 'string' ? item.generated_voice_id : '';
      if (id === '' || typeof item.audio_base_64 !== 'string') continue;
      const buffer = Buffer.from(item.audio_base_64, 'base64');
      const mime = typeof item.media_type === 'string' ? item.media_type : 'audio/mpeg';
      designCache.set(id, { buffer, mime, at: Date.now() });
      previews.push({ id, mime, duration: Number(item.duration_secs) || null });
    }
    if (previews.length === 0) {
      writeJson(res, 502, { error: '没有生成可试听的预览' });
      return;
    }
    writeJson(res, 200, { previews, text: typeof data.text === 'string' ? data.text : '' });
  } catch (error) {
    writeJson(res, 502, { error: describeError(error, '音色设计失败') });
  }
}

/**
 * Serve one cached design preview.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
function handleDesignAudio(req, res) {
  const id = new URL(req.url, 'http://localhost').searchParams.get('id') ?? '';
  const hit = designCache.get(id);
  if (hit === undefined) {
    writeJson(res, 404, { error: '预览已过期，请重新生成' });
    return;
  }
  res.writeHead(200, {
    'content-type': hit.mime,
    'content-length': String(hit.buffer.length),
    'cache-control': 'private, max-age=600',
  });
  res.end(hit.buffer);
}

/**
 * Save one preview as a private voice.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleDesignSave(settings, req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    writeJson(res, 405, { error: '只支持 POST 请求' });
    return;
  }
  if (settings.protocol !== 'breezeblue' || settings.apiKey === '') {
    writeJson(res, 400, { error: '请先配置 apiKey' });
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, { error: describeError(error, '请求体不是合法的 JSON') });
    return;
  }
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (id === '') {
    writeJson(res, 400, { error: '缺少预览 ID' });
    return;
  }
  const name = (typeof payload.name === 'string' ? payload.name.trim() : '').slice(0, 80) || '我的音色';
  const language = /^[a-z]{2}$/.test(String(payload.language ?? '')) ? String(payload.language) : 'zh';
  const body = { voice_name: name, language_code: language };
  if (typeof payload.description === 'string' && payload.description.trim() !== '') {
    body.voice_description = payload.description.trim().slice(0, 1000);
  }

  try {
    const response = await fetch(`${trimSlash(settings.baseUrl)}/v1/voice-previews/${encodeURIComponent(id)}/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      writeJson(res, 502, { error: await describeUpstreamFailure(response) });
      return;
    }
    const data = await response.json();
    const voiceId = typeof data.voice_id === 'string' ? data.voice_id : '';
    if (voiceId === '') {
      writeJson(res, 502, { error: '保存成功但没有返回音色 ID' });
      return;
    }
    designCache.delete(id);
    voiceMetaCache.clear();
    debugLog({ event: 'design-save', voiceId });
    writeJson(res, 200, { ok: true, voiceId, name: typeof data.name === 'string' ? data.name : name });
  } catch (error) {
    writeJson(res, 502, { error: describeError(error, '保存音色失败') });
  }
}

/**
 * Record one browser diagnostic event.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleDebug(req, res) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: '只支持 POST 请求' });
    return;
  }
  try {
    const payload = await readJsonBody(req);
    debugLog({ ...payload, source: 'client', client: req.headers['x-breeze-client'] ?? null });
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
  } catch (error) {
    writeJson(res, 400, { error: describeError(error, '无法记录诊断') });
  }
}

/**
 * Proxy the Breeze voice catalog so the user can find a voice_id without
 * putting the API key in the browser.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleVoices(settings, req, res) {
  if (settings.protocol !== 'breezeblue') {
    writeJson(res, 404, { error: '当前配置为 openai 协议，不提供音色目录' });
    return;
  }
  if (settings.apiKey === '') {
    writeJson(res, 400, { error: '还没有配置 apiKey' });
    return;
  }
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = new URL(`${trimSlash(settings.baseUrl)}/v1/voices`);
  const search = (params.get('search') ?? '').trim().slice(0, 80);
  if (search !== '') target.searchParams.set('search', search);
  const pageSize = Math.min(Math.max(Number(params.get('page_size')) || 8, 1), 24);
  target.searchParams.set('page_size', String(pageSize));
  target.searchParams.set('page', String(Math.max(Number(params.get('page')) || 1, 1)));
  const language = (params.get('language_code') ?? '').trim();
  if (/^[a-z]{2}$/.test(language)) target.searchParams.set('language_code', language);

  try {
    const response = await fetch(target, {
      headers: authHeaders(settings),
      signal: AbortSignal.timeout(Math.min(settings.timeoutMs, 30000)),
    });
    if (!response.ok) {
      writeJson(res, 502, { error: await describeUpstreamFailure(response) });
      return;
    }
    const payload = await response.json();
    const list = Array.isArray(payload.voices) ? payload.voices : [];
    const base = trimSlash(settings.baseUrl);
    const voices = [];
    for (const voice of list) {
      const id = typeof voice.voice_id === 'string' ? voice.voice_id : '';
      if (id === '') continue;
      const name = typeof voice.name === 'string' ? voice.name : '';
      const description = typeof voice.description === 'string' ? voice.description : '';
      voiceMetaCache.set(`${base}|${id}`, {
        name,
        description,
        previewUrl: typeof voice.preview_url === 'string' ? voice.preview_url : '',
      });
      voices.push({
        id,
        name,
        description,
        languageCode: typeof voice.language_code === 'string' ? voice.language_code : '',
        gender: typeof voice.gender === 'string' ? voice.gender : null,
      });
    }
    writeJson(res, 200, {
      voices,
      total: Number(payload.total) || voices.length,
      hasMore: payload.has_more === true,
      page: Number(payload.page) || 1,
    });
  } catch (error) {
    writeJson(res, 502, { error: describeError(error, '无法读取音色列表') });
  }
}

/**
 * Report the live, non-secret configuration so the install can be checked with curl.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
function handleHealth(settings, req, res) {
  writeJson(res, 200, {
    ok: true,
    protocol: settings.protocol,
    hasAvatar: hasAvatar(settings),
    endpoint: settings.protocol === 'openai'
      ? settings.endpoint
      : `${trimSlash(settings.baseUrl)}/v1/text-to-speech/${settings.voiceId || '{voice_id}'}`,
    voiceId: settings.voiceId,
    modelId: settings.modelId,
    languageCode: settings.languageCode,
    outputFormat: settings.outputFormat,
    speed: settings.speed,
    hasApiKey: settings.apiKey !== '',
    maxChars: settings.maxChars,
  });
}

/**
 * Read the persisted settings overrides, ignoring anything unknown.
 * @returns a partial settings object.
 */
function readOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const key of EDITABLE_KEYS) {
      if (parsed[key] !== undefined) out[key] = parsed[key];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist the editable settings fields.
 * @param settings - resolved settings.
 */
async function writeOverrides(settings) {
  const body = {};
  for (const key of EDITABLE_KEYS) body[key] = settings[key];
  await writeFile(SETTINGS_FILE, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/**
 * Fetch and cache one voice's display metadata.
 * @param settings - resolved plugin settings.
 * @param voiceId - Breeze voice id.
 * @returns the metadata, or undefined when it cannot be read.
 */
async function fetchVoiceMeta(settings, voiceId) {
  const cacheKey = `${trimSlash(settings.baseUrl)}|${voiceId}`;
  const cached = voiceMetaCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(
      `${trimSlash(settings.baseUrl)}/v1/voices/${encodeURIComponent(voiceId)}`,
      { headers: authHeaders(settings), signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) return undefined;
    const payload = await response.json();
    const meta = {
      name: typeof payload.name === 'string' ? payload.name : '',
      description: typeof payload.description === 'string' ? payload.description : '',
      previewUrl: typeof payload.preview_url === 'string' ? payload.preview_url : '',
    };
    voiceMetaCache.set(cacheKey, meta);
    return meta;
  } catch {
    return undefined;
  }
}

/**
 * The settings the dialog may see: no secret, only a hint of it.
 * @param settings - resolved plugin settings.
 * @returns a JSON-serializable snapshot.
 */
async function publicConfig(settings) {
  let name = '';
  let description = '';
  if (settings.protocol === 'breezeblue' && settings.voiceId !== '' && settings.apiKey !== '') {
    const meta = await fetchVoiceMeta(settings, settings.voiceId);
    if (meta) {
      name = meta.name;
      description = meta.description;
    }
  }
  return {
    voiceId: settings.voiceId,
    voiceName: name,
    voiceDescription: description,
    speed: settings.speed,
    instructions: settings.instructions,
    languageCode: settings.languageCode,
    modelId: settings.modelId,
    avatarUrl: settings.avatarUrl,
    hasAvatar: hasAvatar(settings),
    hasApiKey: settings.apiKey !== '',
    apiKeyHint: settings.apiKey === '' ? '' : `••••${settings.apiKey.slice(-4)}`,
    streaming: settings.protocol === 'breezeblue',
  };
}

/**
 * Read or persist the dialog-owned settings.
 * @param state - apply-scope mutable state.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleConfig(state, req, res) {
  if (req.method === 'GET') {
    writeJson(res, 200, await publicConfig(state.settings));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    writeJson(res, 405, { error: '只支持 GET/POST 请求' });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, { error: describeError(error, '请求体不是合法的 JSON') });
    return;
  }

  const next = {};
  if (payload.apiKey !== undefined) {
    if (typeof payload.apiKey !== 'string' || payload.apiKey.length > 200) {
      writeJson(res, 400, { error: '密钥格式不对' });
      return;
    }
    next.apiKey = payload.apiKey.trim();
  }
  if (payload.voiceId !== undefined) {
    const voiceId = typeof payload.voiceId === 'string' ? payload.voiceId.trim() : '';
    if (voiceId === '' || voiceId.length > 128) {
      writeJson(res, 400, { error: '音色 ID 不能为空' });
      return;
    }
    next.voiceId = voiceId;
  }
  if (payload.speed !== undefined) {
    const speed = Number(payload.speed);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
      writeJson(res, 400, { error: '语速需要在 0.5–2 之间' });
      return;
    }
    next.speed = speed;
  }
  if (payload.instructions !== undefined) {
    if (typeof payload.instructions !== 'string' || payload.instructions.length > 500) {
      writeJson(res, 400, { error: '语气描述不能超过 500 字' });
      return;
    }
    next.instructions = payload.instructions.trim();
  }
  if (payload.languageCode !== undefined) {
    const language = String(payload.languageCode).trim();
    if (language !== '' && !/^[a-z]{2}$/.test(language)) {
      writeJson(res, 400, { error: '语言代码需要是两位小写字母' });
      return;
    }
    next.languageCode = language;
  }
  if (payload.avatarUrl !== undefined) {
    const avatar = String(payload.avatarUrl).trim();
    if (avatar !== '' && !/^https?:\/\//i.test(avatar)) {
      writeJson(res, 400, { error: '头像地址需要以 http(s):// 开头' });
      return;
    }
    next.avatarUrl = avatar;
  }

  const merged = { ...state.settings, ...next };
  try {
    await writeOverrides(merged);
  } catch {
    writeJson(res, 500, { error: '无法保存设置' });
    return;
  }
  state.settings = resolveSettings({ ...state.patch, ...readOverrides() });
  voiceMetaCache.clear();
  debugLog({
    event: 'config',
    voiceId: state.settings.voiceId,
    hasKey: state.settings.apiKey !== '',
    speed: state.settings.speed,
  });
  writeJson(res, 200, await publicConfig(state.settings));
}

/**
 * Proxy a free voice-preview clip so the dialog can audition voices without
 * spending credits.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handlePreview(settings, req, res) {
  const voiceId = (new URL(req.url, 'http://localhost').searchParams.get('voice_id') ?? '').trim();
  if (voiceId === '') {
    writeJson(res, 400, { error: '缺少 voice_id' });
    return;
  }
  const meta = await fetchVoiceMeta(settings, voiceId);
  if (!meta || meta.previewUrl === '') {
    writeJson(res, 404, { error: '这个音色没有试听音频' });
    return;
  }
  let url;
  try {
    url = new URL(meta.previewUrl);
  } catch {
    writeJson(res, 400, { error: '试听地址不可用' });
    return;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'r.breeze.blue') {
    writeJson(res, 400, { error: '试听地址不在允许范围' });
    return;
  }
  const hit = previewCache.get(meta.previewUrl);
  if (hit !== undefined && Date.now() - hit.at < AVATAR_TTL_MS) {
    sendPreview(res, hit.type, hit.body);
    return;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) throw new Error('试听音频为空');
    if (body.length > MAX_PREVIEW_BYTES) throw new Error('试听音频过大');
    const type = response.headers.get('content-type') ?? 'audio/mpeg';
    previewCache.set(meta.previewUrl, { type, body, at: Date.now() });
    sendPreview(res, type, body);
  } catch (error) {
    writeJson(res, 502, { error: describeError(error, '无法获取试听音频') });
  }
}

/**
 * Send one preview clip.
 * @param res - HTTP response.
 * @param type - audio MIME type.
 * @param body - audio bytes.
 */
function sendPreview(res, type, body) {
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(body.length),
    'cache-control': 'private, max-age=3600',
  });
  res.end(body);
}

/**
 * Whether a portrait is available: the configured image or the packaged default.
 * @param settings - resolved plugin settings.
 * @returns true when the browser can request an image.
 */
function hasAvatar(settings) {
  return settings.avatarUrl !== '' || existsSync(BUILTIN_AVATAR);
}

/**
 * Return display metadata for the configured voice.
 *
 * Breeze's voice objects carry no portrait image, so the browser falls back to a
 * monogram built from this name unless the patch sets `avatarUrl`.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleVoice(settings, req, res) {
  debugLog({ event: 'voice-info', client: req.headers['x-breeze-client'] ?? null });
  let name = '';
  let description = '';
  if (settings.protocol === 'breezeblue' && settings.voiceId !== '' && settings.apiKey !== '') {
    const meta = await fetchVoiceMeta(settings, settings.voiceId);
    if (meta) {
      name = meta.name;
      description = meta.description;
    }
  }
  writeJson(res, 200, {
    voiceId: settings.voiceId,
    name,
    description,
    hasAvatar: hasAvatar(settings),
    streaming: settings.protocol === 'breezeblue',
    hasApiKey: settings.apiKey !== '',
  });
}

/**
 * Proxy the configured avatar image so the page keeps one origin and CSP stays tight.
 * @param settings - resolved plugin settings.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleAvatar(settings, req, res) {
  const source = settings.avatarUrl;
  if (source === '') {
    try {
      sendAvatar(res, 'image/png', readFileSync(BUILTIN_AVATAR), 'no-cache');
    } catch {
      writeJson(res, 404, { error: '没有可用的头像' });
    }
    return;
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    writeJson(res, 400, { error: 'avatarUrl 不是合法的 URL' });
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    writeJson(res, 400, { error: 'avatarUrl 只支持 http/https' });
    return;
  }

  const hit = avatarCache.get(source);
  if (hit !== undefined && Date.now() - hit.at < AVATAR_TTL_MS) {
    sendAvatar(res, hit.type, hit.body);
    return;
  }
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') ?? 'application/octet-stream';
    if (!type.startsWith('image/')) throw new Error('返回内容不是图片');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) throw new Error('图片为空');
    if (body.length > MAX_AVATAR_BYTES) throw new Error('图片超过 2 MB');
    avatarCache.set(source, { type, body, at: Date.now() });
    sendAvatar(res, type, body);
  } catch (error) {
    writeJson(res, 502, { error: describeError(error, '无法获取头像') });
  }
}

/**
 * Send one avatar image.
 * @param res - HTTP response.
 * @param type - image MIME type.
 * @param body - image bytes.
 */
function sendAvatar(res, type, body, cache = 'private, max-age=3600') {
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(body.length),
    'cache-control': cache,
  });
  res.end(body);
}

/**
 * Explain which required setting is still empty.
 * @param settings - resolved plugin settings.
 * @returns a message, or an empty string when the configuration can run.
 */
function missingSetting(settings) {
  if (settings.protocol === 'openai') {
    if (settings.endpoint === '') return '还没有配置 endpoint';
    if (settings.model === '') return '还没有配置 model';
    return '';
  }
  if (settings.voiceId === '') {
    return '还没有配置 voiceId：在 https://breezeblue.ai/app 里选一个音色，或 GET /breeze-voice/voices 查看';
  }
  if (settings.apiKey === '') {
    return '还没有配置 apiKey：在 https://breezeblue.ai/app/developer/api-keys 创建后填入插件配置';
  }
  return '';
}

/**
 * Call the upstream speech API.
 * @param settings - resolved plugin settings.
 * @param text - already validated utterance.
 * @param signal - timeout signal.
 * @returns the upstream response when it carries audio.
 */
async function requestSpeech(settings, text, signal) {
  const request = settings.protocol === 'openai'
    ? openAiRequest(settings, text)
    : breezeRequest(settings, text);

  let response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error('语音服务响应超时');
    }
    throw new Error(`无法连接语音服务 ${hostOf(request.url)}：${describeError(error, '连接失败')}`);
  }

  if (!response.ok) {
    throw new Error(await describeUpstreamFailure(response));
  }
  return response;
}

/**
 * Build a Breeze Blue Convert-text-to-speech request.
 * @param settings - resolved plugin settings.
 * @param text - utterance.
 * @returns URL, headers and JSON body.
 */
function breezeRequest(settings, text) {
  const url = new URL(`${trimSlash(settings.baseUrl)}/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}`);
  url.searchParams.set('delivery', 'sync');
  if (settings.outputFormat !== '') url.searchParams.set('output_format', settings.outputFormat);

  const body = { text };
  if (settings.modelId !== '') body.model_id = settings.modelId;
  if (settings.languageCode !== '') body.language_code = settings.languageCode;
  if (settings.instructions !== '') body.instructions = settings.instructions;
  if (Number.isFinite(settings.speed) && settings.speed !== 1) body.voice_settings = { speed: settings.speed };

  return {
    url: url.toString(),
    headers: { 'content-type': 'application/json', ...authHeaders(settings), ...settings.headers },
    body: { ...body, ...settings.extraBody },
  };
}

/**
 * Build an OpenAI-compatible /audio/speech request.
 * @param settings - resolved plugin settings.
 * @param text - utterance.
 * @returns URL, headers and JSON body.
 */
function openAiRequest(settings, text) {
  const body = { input: text };
  if (settings.model !== '') body.model = settings.model;
  if (settings.voice !== '') body.voice = settings.voice;
  if (settings.outputFormat !== '') body.response_format = settings.outputFormat;
  if (Number.isFinite(settings.speed)) body.speed = settings.speed;

  const headers = { 'content-type': 'application/json', accept: 'audio/*, application/octet-stream' };
  if (settings.apiKey !== '') headers.authorization = `Bearer ${settings.apiKey}`;

  return {
    url: settings.endpoint,
    headers: { ...headers, ...settings.headers },
    body: { ...body, ...settings.extraBody },
  };
}

/**
 * Authentication headers for the Breeze protocol.
 * @param settings - resolved plugin settings.
 * @returns headers carrying the key.
 */
function authHeaders(settings) {
  return settings.apiKey === '' ? {} : { 'xi-api-key': settings.apiKey };
}

/**
 * Build a readable message from a failed upstream response.
 * @param response - upstream response.
 * @returns the message.
 */
async function describeUpstreamFailure(response) {
  const raw = (await response.text().catch(() => '')).trim();
  let message = raw.slice(0, MAX_ERROR_CHARS);
  try {
    const payload = JSON.parse(raw);
    const parts = [payload.code, payload.detail || payload.error || payload.message].filter(Boolean);
    if (parts.length > 0) message = parts.join(': ');
  } catch {
    // Keep the raw text when the body is not JSON.
  }
  const hint = response.status === 401
    ? '（apiKey 无效或已停用）'
    : response.status === 402 ? '（额度不足）' : '';
  return `语音服务返回 ${response.status}${hint}${message === '' ? '' : `：${message}`}`;
}

/**
 * Read and parse one bounded JSON body.
 * @param req - HTTP request.
 * @returns the parsed object.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象');
  return value;
}

/**
 * Write one JSON response.
 * @param res - HTTP response.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function writeJson(res, status, value) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Describe an error without leaking a stack.
 * @param error - thrown value.
 * @param fallback - message used for non-Error values.
 * @returns a short message.
 */
function describeError(error, fallback) {
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}

/**
 * Pick a MIME type for a configured response format.
 * @param format - configured format name.
 * @returns the matching MIME type.
 */
function mimeFor(format) {
  const base = String(format).toLowerCase();
  if (base.startsWith('wav')) return 'audio/wav';
  if (base.startsWith('flac')) return 'audio/flac';
  if (base.startsWith('aac')) return 'audio/aac';
  if (base.startsWith('opus')) return 'audio/opus';
  if (base.startsWith('pcm')) return 'audio/pcm';
  return 'audio/mpeg';
}

/**
 * Extract the host of a URL for a readable error.
 * @param url - request URL.
 * @returns the host, or the input when it cannot be parsed.
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/**
 * Remove trailing slashes from a base URL.
 * @param value - base URL.
 * @returns the trimmed value.
 */
function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}
