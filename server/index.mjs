// Personalised Voice AI Chat server: serves the frontend, drives the DeepSeek Harness CLI
// (via its SDK client, as a background subprocess), and fronts local STT/TTS.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { promises as fs, createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MEMORY = path.join(ROOT, 'memory')
const DSH_HOME = path.join(MEMORY, 'dsh-home')
const SETTINGS_FILE = path.join(MEMORY, 'settings.json')
const WEB = path.join(ROOT, 'web')
const PORT = Number(process.env.APP_PORT || 3080)
const HOST = '127.0.0.1'
const WHISPER_MODEL = path.join(ROOT, 'voice', 'models', 'ggml-base.en.bin')
const TTS_PY = path.join(ROOT, 'voice', 'venv', 'bin', 'python')
const TTS_WORKER = path.join(ROOT, 'voice', 'tts_worker.py')
const SDK_CLIENT = path.join(ROOT, 'harness', 'packages', 'sdk', 'client', 'lib', 'index.js')
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-ai-chat-'))

const DEFAULTS = {
  openrouterKey: '',
  activeModel: 'openai/gpt-oss-20b',
  favourites: [{ id: 'openai/gpt-oss-20b', name: 'OpenAI: gpt-oss-20b' }],
  sessionId: '',
  voice: { wakeWord: 'friday', sendWord: 'done', speed: 1.0, pause: 1.5, alwaysOn: false, showChat: false, bargeIn: true },
}

// ---------- settings (local file, owner-only) ----------
let settings = structuredClone(DEFAULTS)
async function loadSettings() {
  await fs.mkdir(MEMORY, { recursive: true })
  await fs.writeFile(path.join(MEMORY, '.graphifyignore'), 'dsh-home/\ngraphify-out/\nsettings.json\nworkspace/\n').catch(() => {})
  try {
    const saved = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'))
    settings = { ...DEFAULTS, ...saved, voice: { ...DEFAULTS.voice, ...saved.voice } }
  } catch { /* first run */ }
}
async function saveSettings() {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 })
  await fs.chmod(SETTINGS_FILE, 0o600)
}
const publicSettings = () => ({
  hasKey: Boolean(settings.openrouterKey),
  keyHint: settings.openrouterKey ? `…${settings.openrouterKey.slice(-4)}` : '',
  activeModel: settings.activeModel,
  favourites: settings.favourites,
  voice: settings.voice,
  platform: { ready: Boolean(harness) },
})

// ---------- SSE ----------
const clients = new Set()
function broadcast(type, data = {}) {
  const frame = `data: ${JSON.stringify({ type, t: Date.now(), ...data })}\n\n`
  for (const res of clients) res.write(frame)
}

// ---------- harness profile patch ----------
// Compact, layered prompt (identity → rules → voice → delegation → memory), in the spirit of chims-re's layered
// composition: only what the model needs every turn; heavy tools are disabled instead of described.
const PERSONA = [
  'You are FRIDAY, a voice-driven agent on the {{model}} model. Work like Claude Code: act autonomously, read before editing, verify by running, finish the task.',
  'Auto mode is on: never ask permission or questions; decide and state the decision.',
  'The current directory is your workspace; create everything here unless told otherwise.',
  'VOICE: your plain-text reply is read aloud, so use 1-3 short sentences with no markdown, paths or URLs. Put anything meant to be shown but not spoken in fenced blocks: ```mermaid for flowcharts and diagrams, ```<lang> for code. Fenced blocks are displayed on screen and never spoken.',
  'SUBAGENTS (only for independent, parallel or long work; max 2): give each a complete brief, then end your turn with one short sentence. Their results arrive on their own and you then report ONCE. Never spawn a subagent to check on another, and never call list_agents, job_output or sleep to wait.',
  'MEMORY GRAPH (a knowledge graph of the code in this folder, refreshed automatically): to look up existing code, call the bash tool with command `graphify query "<question>"`; also `graphify explain "<name>"` and `graphify path "<A>" "<B>"`. Prefer it over grep. There is no separate graphify tool.',
  'BROWSER: you CAN operate a real, visible Chrome (clicks, forms, screenshots) and must do so when asked to use the browser; never say you cannot. Use the bash tool: `agent-browser open <url>`, `agent-browser snapshot -i` (lists elements as @e1, @e2…), `agent-browser click @e1`, `agent-browser fill @e2 "text"`, `agent-browser press Enter`, `agent-browser get text @e1`, `agent-browser screenshot file.png`. Refs expire when the page changes, so snapshot again after every click or navigation. Say what you found briefly; do not read pages aloud. Run `agent-browser skills get core` once if you need the full guide.',
  'Be concise, accurate and candid.',
].join('\n')

const DISABLED_TOOLS = ['tool-schedule', 'tool-ask-user', 'present', 'tool-workflow', 'tool-goal', 'tool-subagent-fork', 'tool-working-directory', 'tool-skill'] // ~half of the tool-schema tokens

async function writeProfilePatch() {
  const ids = new Map()
  for (const f of settings.favourites) ids.set(f.id, f.name)
  if (!ids.has(settings.activeModel)) ids.set(settings.activeModel, settings.activeModel)
  const models = [...ids.keys()].map((id) => `          - id: ${JSON.stringify(id)}`).join('\n')
  const yaml = `# Generated by Personalised Voice AI Chat from memory/settings.json; edits are overwritten.
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${PORT}/or/v1
        models:
${models}

- id: system-prompt
  config:
    personaPrefix: ${JSON.stringify(PERSONA)}
${DISABLED_TOOLS.map((id) => `\n- id: ${id}\n  disabled: true`).join('')}
`
  const dir = path.join(DSH_HOME, 'profiles', 'sdk')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'cordis.patch.yml'), yaml)
}

// ---------- harness manager ----------
let sdk = null
let harness = null
let starting = null
let status = 'idle'
let chain = Promise.resolve()
let generation = 0

function setStatus(next) {
  status = next
  broadcast('status', { status })
}

async function ensureHarness() {
  if (harness) return harness
  if (starting) return starting
  starting = (async () => {
    if (!settings.openrouterKey) throw new Error('No OpenRouter API key set. Open the menu and add one.')
    sdk ??= await import(SDK_CLIENT)
    await writeProfilePatch()
    const h = new sdk.DeepSeekHarness({
      profile: 'sdk',
      provider: 'openrouter',
      model: settings.activeModel,
      cwd: MEMORY,
      dshHome: DSH_HOME,
      initializeTimeoutMs: 60_000,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: settings.openrouterKey,
        DSH_PERMISSION_MODE: 'danger-full-access', // auto mode, always on
        PATH: `${os.homedir()}/.local/bin:${process.env.PATH}`,
        GRAPHIFY_BACKEND: 'none', // code-only graph: local, no LLM calls
        AGENT_BROWSER_HEADED: '1', // browser control is visible on screen
        AGENT_BROWSER_SESSION: 'voice-ai-chat',
      },
    })
    await h.start()
    if (settings.sessionId) {
      try { await h.resumeSession(settings.sessionId) } catch { settings.sessionId = '' }
    }
    if (!settings.sessionId) {
      settings.sessionId = `chat-${Date.now().toString(36)}`
      await saveSettings()
    }
    harness = h
    broadcast('model', { model: settings.activeModel })
    return h
  })()
  try { return await starting } finally { starting = null }
}

async function closeHarness() {
  generation++
  const h = harness
  harness = null
  if (h) await h.close().catch(() => {})
}

const textOf = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : ''))
    .join('')

function forward(n) {
  touch()
  const p = n.params ?? {}
  if (n.method === 'subagent.started') return broadcast('card', { id: p.childSessionId, title: 'Subagent', body: 'working…', status: 'running' })
  if (n.method === 'subagent.finished') return broadcast('card', { id: p.childSessionId, title: 'Subagent', body: textOf(p.lastAssistantMessage).slice(0, 600) || String(p.status), status: p.status === 'ok' ? 'done' : 'error' })
  if (n.method !== 'session.event' || !p.event) return
  const e = p.event
  const root = p.sessionId === settings.sessionId
  const tag = root ? '' : 'sub · '
  const d = e.data ?? {}
  if (e.type === 'tool/call') {
    const args = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '')
    broadcast('feed', { kind: 'tool', text: `${tag}${d.name ?? 'tool'} ${args}`.slice(0, 220) })
    if (d.name === 'todo_write' || d.name === 'present') {
      let body = args
      try {
        const a = JSON.parse(args)
        if (d.name === 'todo_write') body = (a.todos ?? []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.content ?? t.title ?? ''}`).join('\n')
        else body = String(a.title ?? a.text ?? a.path ?? args).slice(0, 400)
      } catch { /* raw args */ }
      broadcast('card', { id: `${d.name}-${p.sessionId}`, title: d.name === 'todo_write' ? 'Tasks' : 'Presenting', body, status: 'info' })
    }
  } else if (e.type === 'assistant/message') {
    const t = textOf(d.message?.content)
    if (t.trim()) {
      broadcast('feed', { kind: 'assistant', text: `${tag}${t}`.slice(0, 400) })
      if (root) broadcast('say', { text: t }) // speak as soon as each step commits
    }
  }
}

let lastActivity = Date.now()
const touch = () => { lastActivity = Date.now() }
setInterval(() => { // watchdog: a turn with no events, tool output or model traffic is stuck
  if (status === 'working' && Date.now() - lastActivity > 150_000) {
    lastActivity = Date.now()
    broadcast('error', { text: 'The agent is stuck: no activity for 150 seconds (model not responding or a subagent is waiting). Stopping it.' })
    closeHarness().then(() => { chain = Promise.resolve(); setStatus('idle') })
  }
}, 10_000).unref()

let graphTimer = null
function refreshGraph() { // keep the memory graph current; local tree-sitter, no network
  clearTimeout(graphTimer)
  graphTimer = setTimeout(() => {
    const env = { ...process.env, PATH: `${os.homedir()}/.local/bin:${process.env.PATH}`, GRAPHIFY_BACKEND: 'none' }
    spawn('graphify', ['update', '.'], { cwd: MEMORY, env, stdio: 'ignore' }).on('error', () => {})
  }, 2000)
}

function enqueue(text) {
  const mine = generation
  chain = chain.then(async () => {
    if (mine !== generation) return
    setStatus('working')
    touch()
    broadcast('user', { text })
    const t0 = Date.now()
    try {
      const h = await ensureHarness()
      const result = await h.run(text, { sessionId: settings.sessionId, onNotification: forward })
      const end = [...result.events].reverse().find((e) => e.type === 'turn/end')
      if (process.env.APP_DEBUG) console.error('turn/end', JSON.stringify(end), result.events.filter((e) => /error|fail/i.test(e.type)).map((e) => JSON.stringify(e).slice(0, 400)))
      if (mine === generation && end && end.data?.reason?.kind && end.data.reason.kind !== 'completed') {
        const detail = JSON.stringify(end.data.reason)
        if (/does not match pattern|input\[\d+\]\.name/.test(detail)) { // a previous model left a malformed tool name in the shared history
          settings.sessionId = ''
          await saveSettings()
          await closeHarness()
          broadcast('error', { text: 'The new model rejected the old conversation history (malformed tool name left by the previous model). I started a fresh session: please repeat your request.' })
        } else broadcast('error', { text: `Turn ended: ${detail.slice(0, 300)}` })
      } else if (mine === generation && !result.finalResponse.trim() && !result.events.some((e) => e.type === 'tool/call')) {
        broadcast('error', { text: 'The model returned an empty reply (model may not support this request or tools).' })
      }
      if (mine === generation) broadcast('reply', { text: result.finalResponse, ms: Date.now() - t0 })
    } catch (err) {
      if (mine === generation) broadcast('error', { text: String(err?.message ?? err) })
    } finally {
      if (mine === generation) { setStatus('idle'); refreshGraph() }
    }
  })
}

// ---------- models ----------
let modelCache = { at: 0, list: [] }
async function fetchModels() {
  if (Date.now() - modelCache.at < 10 * 60_000 && modelCache.list.length) return modelCache.list
  const res = await fetch('https://openrouter.ai/api/v1/models')
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`)
  const { data } = await res.json()
  const list = data
    .map((m) => ({
      id: m.id,
      name: m.name,
      context: m.context_length,
      prompt: Number(m.pricing?.prompt ?? 0) * 1e6,
      completion: Number(m.pricing?.completion ?? 0) * 1e6,
      tools: (m.supported_parameters ?? []).includes('tools'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  modelCache = { at: Date.now(), list }
  return list
}

// ---------- voice ----------

const WHISPER_PORT = 8178
let whisper = null
let whisperKey = ''
function startWhisper() {
  const prompt = `${settings.voice.wakeWord}. ${settings.voice.sendWord}.`
  whisperKey = prompt
  whisper = spawn('whisper-server', ['-m', WHISPER_MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT), '-l', 'en', '-nt', '-t', '6', '--prompt', prompt], { stdio: 'ignore' })
  whisper.on('exit', () => { whisper = null })
}
function restartWhisper() {
  if (whisper && whisperKey !== `${settings.voice.wakeWord}. ${settings.voice.sendWord}.`) { whisper.kill(); whisper = null }
}
const cleanText = (t) => t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()

async function transcribe(wav) {
  if (!whisper) startWhisper()
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav')
  form.append('temperature', '0')
  form.append('response_format', 'json')
  for (let attempt = 0; attempt < 20; attempt++) { // server needs a moment to load the model
    try {
      const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form })
      if (res.ok) return cleanText((await res.json()).text ?? '')
      throw new Error(`whisper HTTP ${res.status}`)
    } catch (err) {
      if (err.cause?.code !== 'ECONNREFUSED' || attempt === 19) throw err
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

let tts = null
const ttsPending = new Map()
function ensureTts() {
  if (tts) return tts
  const child = spawn(TTS_PY, [TTS_WORKER], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      try {
        const msg = JSON.parse(line)
        const p = ttsPending.get(msg.id)
        if (p) { ttsPending.delete(msg.id); msg.ok ? p.resolve() : p.reject(new Error(msg.error)) }
      } catch { /* ignore */ }
    }
  })
  child.on('exit', () => { tts = null; for (const p of ttsPending.values()) p.reject(new Error('tts exited')); ttsPending.clear() })
  tts = child
  return child
}
function speak(text, speed) {
  const id = crypto.randomUUID()
  const out = path.join(TMP, `${id}.wav`)
  return new Promise((resolve, reject) => {
    ttsPending.set(id, { resolve: () => resolve(out), reject })
    ensureTts().stdin.write(`${JSON.stringify({ id, text, speed, out })}\n`)
  })
}

// ---------- OpenRouter proxy: caps concurrency and retries 429/5xx so parallel agents don't get the key blocked ----------
const MAX_PARALLEL = 3
const gate = { active: 0, waiting: [] }
const acquire = () => (gate.active < MAX_PARALLEL ? (gate.active++, Promise.resolve()) : new Promise((r) => gate.waiting.push(r)))
const release = () => { const next = gate.waiting.shift(); if (next) next(); else gate.active-- }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function proxyOpenRouter(req, res, url) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, 64 << 20)
  const target = `https://openrouter.ai/api/${url.pathname.slice('/or/'.length)}${url.search}`
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'accept-encoding'].includes(k)))
  for (let attempt = 0; ; attempt++) {
    if (gate.waiting.length) broadcast('feed', { kind: 'system', text: `${gate.waiting.length} model request(s) queued (max ${MAX_PARALLEL} parallel)` })
    await acquire()
    let upstream
    try {
      upstream = await fetch(target, { method: req.method, headers, body })
    } catch (err) {
      release()
      if (attempt >= 3) { res.writeHead(502, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `network error reaching OpenRouter: ${err.message}` } })) }
      await sleep(1000 * 2 ** attempt); continue
    }
    if ((upstream.status === 429 || upstream.status >= 502) && upstream.status <= 504 || upstream.status === 429) {
      if (attempt < 4) {
        const wait = Math.min(20_000, Number(upstream.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt) + Math.random() * 400
        await upstream.arrayBuffer().catch(() => {})
        release()
        broadcast('feed', { kind: 'system', text: `OpenRouter ${upstream.status}: retrying in ${(wait / 1000).toFixed(1)}s` })
        await sleep(wait); continue
      }
    }
    const out = {}
    upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v })
    res.writeHead(upstream.status, out)
    try {
      for await (const chunk of upstream.body) { touch(); if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)) }
    } catch { /* client or upstream went away */ }
    release()
    return res.end()
  }
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.riv': 'application/octet-stream', '.svg': 'image/svg+xml', '.json': 'application/json' }
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const readBody = (req, limit = 25 << 20) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0
  req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})
const readJson = async (req) => JSON.parse((await readBody(req)).toString() || '{}')

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`
  if (req.method === 'POST' && req.headers['x-app'] !== '1') return json(res, 403, { error: 'missing x-app header' })

  switch (route) {
    case 'GET /api/state':
      return json(res, 200, { ...publicSettings(), status })
    case 'GET /api/events':
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    case 'GET /api/models':
      return json(res, 200, await fetchModels())
    case 'POST /api/settings': {
      const b = await readJson(req)
      let restart = false
      if (typeof b.openrouterKey === 'string' && b.openrouterKey.trim() && b.openrouterKey.trim() !== settings.openrouterKey) {
        settings.openrouterKey = b.openrouterKey.trim(); restart = true
      }
      if (b.voice) {
        const v = b.voice
        if (typeof v.wakeWord === 'string' && v.wakeWord.trim()) settings.voice.wakeWord = v.wakeWord.trim().toLowerCase()
        if (typeof v.sendWord === 'string' && v.sendWord.trim()) settings.voice.sendWord = v.sendWord.trim().toLowerCase()
        if (Number.isFinite(v.pause)) settings.voice.pause = Math.max(0.5, Math.min(60, v.pause))
        if (typeof v.alwaysOn === 'boolean') settings.voice.alwaysOn = v.alwaysOn
        if (typeof v.showChat === 'boolean') settings.voice.showChat = v.showChat
        if (typeof v.bargeIn === 'boolean') settings.voice.bargeIn = v.bargeIn
        if (Number.isFinite(v.speed)) settings.voice.speed = Math.max(0.5, Math.min(2.5, v.speed))
      }
      await saveSettings()
      if (b.voice) restartWhisper()
      if (restart) { await closeHarness(); ensureHarness().then(() => broadcast('ready')).catch(() => {}) }
      return json(res, 200, publicSettings())
    }
    case 'POST /api/favourites': {
      const b = await readJson(req)
      if (!Array.isArray(b.favourites)) return json(res, 400, { error: 'favourites[] required' })
      settings.favourites = b.favourites.filter((f) => f && typeof f.id === 'string').map((f) => ({ id: f.id, name: String(f.name ?? f.id) }))
      await saveSettings()
      await writeProfilePatch()
      return json(res, 200, publicSettings())
    }
    case 'POST /api/model': {
      const b = await readJson(req)
      if (typeof b.id !== 'string' || !b.id) return json(res, 400, { error: 'id required' })
      if (!settings.favourites.some((f) => f.id === b.id)) settings.favourites.push({ id: b.id, name: String(b.name ?? b.id) })
      settings.activeModel = b.id
      await saveSettings()
      await chain.catch(() => {})
      await closeHarness() // next prompt restarts on the new model and resumes the same session
      broadcast('model', { model: settings.activeModel })
      return json(res, 200, publicSettings())
    }
    case 'POST /api/chat': {
      const b = await readJson(req)
      if (typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'text required' })
      enqueue(b.text.trim())
      return json(res, 202, { queued: true })
    }
    case 'POST /api/stop': {
      await closeHarness(); chain = Promise.resolve(); setStatus('idle')
      broadcast('feed', { kind: 'system', text: 'activity stopped' })
      return json(res, 200, { ok: true })
    }
    case 'POST /api/clear': {
      await chain.catch(() => {})
      await closeHarness(); chain = Promise.resolve()
      await fs.rm(path.join(DSH_HOME, 'sessions'), { recursive: true, force: true })
      settings.sessionId = ''
      await saveSettings()
      setStatus('idle'); broadcast('cleared')
      ensureHarness().then(() => broadcast('ready')).catch(() => {})
      return json(res, 200, { ok: true })
    }
    case 'POST /api/stt': {
      const wav = await readBody(req)
      return json(res, 200, { text: await transcribe(wav) })
    }
    case 'POST /api/tts': {
      const b = await readJson(req)
      const text = String(b.text ?? '').slice(0, 4000)
      if (!text.trim()) return json(res, 400, { error: 'text required' })
      const file = await speak(text, settings.voice.speed)
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
      createReadStream(file).pipe(res).on('close', () => fs.rm(file, { force: true }))
      return
    }
    case 'POST /api/shutdown':
      json(res, 200, { ok: true })
      broadcast('shutdown')
      setTimeout(() => shutdown(0), 150)
      return
    default:
      return json(res, 404, { error: 'not found' })
  }
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'
  const file = path.join(WEB, rel)
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end() }
  if (!existsSync(file)) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? ''
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); return res.end() }
  const url = new URL(req.url, `http://${host}`)
  try {
    if (url.pathname.startsWith('/or/')) await proxyOpenRouter(req, res, url)
    else if (url.pathname.startsWith('/api/')) await api(req, res, url)
    else await serveStatic(req, res, url)
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) })
    else res.end()
  }
})

let closing = false
async function shutdown(code) {
  if (closing) return
  closing = true
  for (const res of clients) res.end()
  await closeHarness()
  tts?.kill()
  whisper?.kill()
  spawn('agent-browser', ['close', '--all'], { stdio: 'ignore' }).on('error', () => {}) // browser windows belong to the agent: close with the app
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {})
  server.close()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

await loadSettings()
await writeProfilePatch()
if (settings.openrouterKey) ensureHarness().then(() => broadcast('ready')).catch((e) => console.error('prewarm failed:', e.message))
server.listen(PORT, HOST, () => { console.log(`Personalised Voice AI Chat online → http://${HOST}:${PORT}`); startWhisper(); ensureTts() })
