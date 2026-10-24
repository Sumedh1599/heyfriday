// Personalised Voice AI Chat frontend: Rive background, wake-word / conversation voice loop, streamed speech, menu, model picker.
const $ = (id) => document.getElementById(id)
const api = (path, body) =>
  fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-app': '1' }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j })
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }

// ---------------- Rive background ----------------
const RIVE_STATES = { idle: 'IDLE', listen: 'Listen', reply: 'Reply' }
let riveInst = null
let currentAnim = ''
function setAnim(key) {
  if (!riveInst || currentAnim === key) return
  const names = riveInst.animationNames ?? []
  if (!names.length) return // not loaded yet; onLoad re-applies
  const name = names.find((n) => n.toLowerCase() === RIVE_STATES[key].toLowerCase())
  if (!name) { console.warn('Rive timeline not found:', RIVE_STATES[key], names); return }
  currentAnim = key
  riveInst.stop(names)
  riveInst.play(name)
}
function initRive() {
  rive.Rive.suppressDeprecationWarnings = ['names-array', 'animation-names']
  rive.RuntimeLoader.setWasmUrl('/vendor/rive.wasm')
  riveInst = new rive.Rive({
    src: '/assets/animate.riv',
    canvas: $('bg'),
    autoplay: false,
    layout: new rive.Layout({ fit: rive.Fit.Cover, alignment: rive.Alignment.Center }),
    onLoad: () => { riveInst.resizeDrawingSurfaceToCanvas(); currentAnim = ''; updateAnim() },
    onLoadError: () => showError('The background animation could not load.', 'Check that animate.riv is at web/assets/animate.riv.'),
  })
  addEventListener('resize', () => riveInst?.resizeDrawingSurfaceToCanvas())
}

// ---------------- floating messages, cards, errors ----------------
function bubble(kind, text, ttl) {
  const b = el('div', `bubble ${kind}`, text)
  $('float').append(b)
  while ($('float').children.length > 4) $('float').firstChild.remove()
  if (ttl) fadeOut(b, ttl)
  return b
}
function fadeOut(node, ms) {
  setTimeout(() => { node.classList.add('fade'); setTimeout(() => node.remove(), 900) }, ms)
}
const readTime = (t) => Math.min(14000, 3500 + t.length * 55)

// Map raw failures to a plain problem + a fix.
const ERRORS = [
  [/no openrouter api key|no key|api key.*(missing|not set)/i, 'No OpenRouter API key is set.', 'Open the menu (top right) and paste your key from openrouter.ai/keys, then press Save.'],
  [/401|unauthori[sz]ed|invalid.*(key|credential)|user not found/i, 'OpenRouter rejected the API key.', 'Create a fresh key at openrouter.ai/keys and save it in the menu.'],
  [/402|insufficient|credits|payment required|quota/i, 'Your OpenRouter account is out of credits (or the model needs credit).', 'Add credits at openrouter.ai/credits, or pick a free ":free" model in the model picker.'],
  [/429|rate.?limit|too many requests/i, 'The model is rate limited right now.', 'Wait a few seconds and try again, or switch to another model.'],
  [/404|no endpoints|model.*(not found|unavailable)|not a valid model/i, 'That model is not available on OpenRouter.', 'Open the model picker and choose a different model.'],
  [/tool|function.?call/i, 'This model may not support tool calls, which the agent needs.', 'Pick a model marked as supporting tools in the picker.'],
  [/timeout|timed out|etimedout|econn|network|fetch failed|enotfound/i, 'The network request failed or timed out.', 'Check your internet connection and try again.'],
  [/transport|exited|runtime is gone|initialize/i, 'The background harness stopped or failed to start.', 'Press “Stop current activity” in the menu, then try again. If it keeps happening, restart Launch app.'],
  [/whisper|stt|speech recognition/i, 'Speech recognition failed.', 'Restart Launch app; make sure whisper-cpp is installed (brew install whisper-cpp).'],
  [/tts|voice output|kokoro/i, 'Speech output failed.', 'Restart Launch app and check the voice/venv folder exists.'],
  [/notallowed|permission denied|microphone|getusermedia/i, 'The microphone is blocked.', 'Allow microphone access for 127.0.0.1:3080 in your browser’s site settings and reload.'],
]
function showError(problem, fix) {
  const b = el('div', 'bubble err')
  b.append(el('b', '', problem), el('span', '', `Fix: ${fix}`))
  $('float').append(b)
  fadeOut(b, 14000)
}
function explain(raw) {
  const hit = ERRORS.find(([re]) => re.test(raw))
  if (hit) showError(hit[1], hit[2])
  else showError(`Something went wrong: ${String(raw).slice(0, 160)}`, 'Press “Stop current activity” in the menu and try again; if it repeats, restart Launch app and check the terminal output.')
}

const cards = new Map()
function card(c) {
  let n = cards.get(c.id)
  if (!n) {
    n = el('div', 'card')
    n.append(el('h4'), el('pre'))
    $('cards').prepend(n)
    cards.set(c.id, n)
    while ($('cards').children.length > 5) {
      const last = $('cards').lastChild
      cards.forEach((v, k) => { if (v === last) cards.delete(k) })
      last.remove()
    }
  }
  n.className = `card ${c.status}`
  n.children[0].textContent = c.title
  n.children[1].textContent = c.body
  clearTimeout(n._t)
  if (c.status !== 'running') n._t = setTimeout(() => { n.classList.add('fade'); setTimeout(() => { n.remove(); cards.delete(c.id) }, 900) }, 14000)
}

const history = (kind, text) => {
  const m = el('div', kind === 'item' ? 'item' : `msg ${kind}`, text)
  $('chat').append(m)
  while ($('chat').children.length > 80) $('chat').firstChild.remove()
  $('chat').scrollTop = $('chat').scrollHeight
}

// ---------------- state ----------------
let state = null
let mode = 'standby' // standby | listening | working | replying
let serverWorking = false
let buffer = ''
let micOn = false
let listenTimer = 0
let sendTimer = 0
let inflight = 0
let live = null // live caption bubble

const LABELS = { standby: 'STANDBY', listening: 'LISTENING', working: 'PROCESSING', replying: 'REPLYING' }
function updateAnim() {
  if (!state) return
  const hearing = vad.speaking || buffer
  if (mode === 'replying') return setAnim('reply')
  if (mode === 'listening' && (!state.voice.alwaysOn || hearing)) return setAnim('listen')
  setAnim('idle')
}
function setMode(next) {
  mode = next
  $('stateLabel').textContent = state?.voice.alwaysOn && next === 'listening' ? 'CONVERSATION' : LABELS[next]
  updateAnim()
}
function restState() {
  if (serverWorking) return setMode('working')
  setMode(state.voice.alwaysOn ? 'listening' : 'standby')
}
function caption(text) {
  if (!text) { live?.remove(); live = null; return }
  if (!live || !live.isConnected) live = bubble('user live', '')
  live.textContent = text
}

// ---------------- server events ----------------
function connectEvents() {
  const es = new EventSource('/api/events')
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data)
    switch (ev.type) {
      case 'status':
        serverWorking = ev.status === 'working'
        $('statusDot').className = `dot ${serverWorking ? 'working' : ''}`
        if (!serverWorking && !speechRunning && !speechQueue.length && (mode === 'working' || mode === 'replying')) restState()
        break
      case 'model': $('modelLabel').textContent = ev.model; $('modelBtnLabel').textContent = ev.model; break
      case 'user': history('user', ev.text); break
      case 'feed': history('item', `${ev.kind === 'tool' ? '⚙ ' : ''}${ev.text}`); break
      case 'card': card(ev); break
      case 'say': // stream: speak each committed assistant message immediately; code and diagrams are shown, never read
        history('bot', ev.text)
        handleSay(ev.text)
        break
      case 'reply': if (ev.ms) console.info(`turn took ${(ev.ms / 1000).toFixed(1)}s`); break
      case 'error': explain(ev.text); history('err', ev.text); break
      case 'cleared': $('chat').replaceChildren(); $('cards').replaceChildren(); cards.clear(); bubble('user', 'Data cleared. Fresh session.', 3000); break
      case 'shutdown':
        es.close(); micStop(); $('statusDot').className = 'dot offline'; $('stateLabel').textContent = 'OFFLINE'
        bubble('err', 'The app has shut down. Run Launch app to start it again.')
        break
    }
  }
  es.onerror = () => { $('statusDot').className = 'dot offline' }
}

// ---------------- displayed (not spoken) blocks: code and flowcharts ----------------
let blockSeq = 0
if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
async function showBlock(lang, code) {
  const n = el('div', 'card block')
  const head = el('h4', '', lang === 'mermaid' ? 'Diagram' : `Code${lang ? ` · ${lang}` : ''}`)
  const x = el('button', 'x', '✕')
  x.onclick = () => n.remove()
  head.append(x)
  const body = el('div')
  n.append(head, body)
  $('cards').prepend(n)
  while ($('cards').children.length > 6) $('cards').lastChild.remove()
  const asCode = (msg) => { body.replaceChildren(el('pre', '', code)); if (msg) body.append(el('pre', '', msg)) }
  if (lang === 'mermaid' && window.mermaid) {
    try { const { svg } = await mermaid.render(`mmd${++blockSeq}`, code); body.innerHTML = svg } catch (e) { asCode('(diagram could not be rendered)') }
  } else asCode()
}
const FENCE = /```([\w+-]*)[^\S\n]*\n?([\s\S]*?)```/g
let lastSpoken = new Set()
let muteSay = false // set when the user interrupts: the rest of that turn is shown, not spoken
function handleSay(text) {
  const blocks = [...text.matchAll(FENCE)]
  blocks.forEach((m) => showBlock((m[1] || '').toLowerCase(), m[2].trim()))
  const spoken = text.replace(FENCE, ' ')
  const words = new Set(norm(clean(spoken)).split(' ').filter((w) => w.length > 3))
  const dup = lastSpoken.size && words.size && [...words].filter((w) => lastSpoken.has(w)).length / Math.min(words.size, lastSpoken.size) >= 0.6
  if (dup) { const t = clean(spoken); if (t) bubble('bot', t, readTime(t)); return } // same report said twice: show, don't repeat aloud
  if (words.size) lastSpoken = words
  if (muteSay) { const t = clean(spoken); if (t) bubble('bot', t, readTime(t)); return }
  enqueueSpeech(spoken)
}

// ---------------- streamed text-to-speech ----------------
const clean = (t) => t.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' link ').replace(/^\s*\|.*$/gm, ' ').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim()
function sentences(text) {
  const out = text.match(/[^.!?\n]+[.!?]+["')\]]*|[^.!?\n]+$/g) ?? [text]
  const merged = []
  for (const s of out.map((x) => x.trim()).filter(Boolean)) {
    if (merged.length && merged[merged.length - 1].length < 24) merged[merged.length - 1] += ` ${s}`
    else merged.push(s)
  }
  return merged
}
const speechQueue = []
let speechRunning = false
let currentAudio = null
let currentResolve = null
function fetchSpeech(text) {
  return fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app': '1' }, body: JSON.stringify({ text }) })
    .then((r) => { if (!r.ok) throw new Error('voice output (tts) failed'); return r.blob() })
    .catch((e) => { explain(e.message); return null })
}
function enqueueSpeech(text) {
  const t = clean(text)
  if (!t) return
  for (const s of sentences(t)) speechQueue.push({ promise: fetchSpeech(s) }) // synthesis starts now, in parallel
  bubble('bot', t, readTime(t))
  if (!speechRunning) playQueue()
}
async function playQueue() {
  speechRunning = true
  setMode('replying')
  while (speechQueue.length) {
    const blob = await speechQueue.shift().promise
    if (!blob) continue
    const url = URL.createObjectURL(blob)
    await new Promise((resolve) => {
      const a = new Audio(url)
      currentAudio = a
      currentResolve = resolve
      a.onended = a.onerror = resolve
      a.play().catch(resolve)
    })
    URL.revokeObjectURL(url)
  }
  currentAudio = null
  speechRunning = false
  if (mode === 'replying') restState() // not when the user interrupted into listening
}
function stopSpeech() {
  speechQueue.length = 0
  currentAudio?.pause()
  currentResolve?.()
}

// ---------------- voice input (VAD → whisper.cpp) ----------------
const SR = 16000
const CHUNK = 320 // 20 ms @ 16 kHz
let audioCtx, micStream, vadNode
const vad = { speaking: false, voiced: 0, silent: 0, chunks: [], pre: [], noise: 0.004 }
let pending = new Float32Array(0)

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVEfmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true))
  return buf
}
function downsample(input, from) {
  if (from === SR) return input
  const ratio = from / SR
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let k = a; k < b && k < input.length; k++) sum += input[k]
    out[i] = sum / (b - a) // box filter: cheap anti-aliasing before decimation
  }
  return out
}

const barge = { run: 0, ring: [] }
function bargeChunk(chunk) { // user talking over the reply: stop reading and take over
  let sum = 0
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
  const rms = Math.sqrt(sum / chunk.length)
  barge.ring.push(chunk); if (barge.ring.length > 25) barge.ring.shift()
  barge.run = rms > Math.max(0.06, vad.noise * 10) ? barge.run + 1 : 0
  if (barge.run >= 8) { // ~160 ms of clearly loud speech (echo-cancelled mic)
    barge.run = 0
    stopSpeech(); muteSay = true
    buffer = ''
    setMode('listening')
    armListenTimeout()
    vad.speaking = true; vad.silent = 0; vad.voiced = 0; vad.chunks = [...barge.ring]; barge.ring = []
    caption('…'); updateAnim()
  }
}
function onAudio(frame) {
  if (mode === 'replying' && state.voice.bargeIn) {
    const merged = new Float32Array(pending.length + frame.length)
    merged.set(pending); merged.set(frame, pending.length)
    let off = 0
    for (; off + CHUNK <= merged.length && mode === 'replying'; off += CHUNK) bargeChunk(merged.slice(off, off + CHUNK))
    pending = mode === 'replying' ? merged.slice(off) : new Float32Array(0)
    return
  }
  if (mode === 'replying' || mode === 'working') { // ignore mic while the assistant talks or thinks
    vad.speaking = false; vad.chunks = []; vad.pre = []; vad.voiced = 0; pending = new Float32Array(0); return
  }
  const merged = new Float32Array(pending.length + frame.length)
  merged.set(pending); merged.set(frame, pending.length)
  let off = 0
  for (; off + CHUNK <= merged.length; off += CHUNK) vadChunk(merged.slice(off, off + CHUNK))
  pending = merged.slice(off)
}
function vadChunk(chunk) {
  let sum = 0
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
  const rms = Math.sqrt(sum / chunk.length)
  const voiced = rms > Math.max(0.015, vad.noise * 3.2)
  if (!voiced) vad.noise = vad.noise * 0.98 + rms * 0.02
  if (!vad.speaking) {
    vad.pre.push(chunk); if (vad.pre.length > 20) vad.pre.shift()
    vad.voiced = voiced ? vad.voiced + 1 : 0
    if (vad.voiced >= 3) {
      vad.speaking = true; vad.silent = 0; vad.chunks = [...vad.pre]; vad.pre = []
      clearTimeout(sendTimer) // user kept talking: cancel pending auto-send
      if (mode === 'listening') caption(buffer ? `${buffer} …` : '…')
      updateAnim()
    }
    return
  }
  vad.chunks.push(chunk)
  vad.silent = voiced ? 0 : vad.silent + 1
  if (vad.silent >= 30 || vad.chunks.length > 750) { // 0.6 s of silence ends a phrase
    const segment = vad.chunks
    const endedAt = Date.now() - vad.silent * 20
    const long = segment.length - vad.silent >= 15
    vad.speaking = false; vad.voiced = 0; vad.chunks = []
    updateAnim()
    if (long) transcribeSegment(segment, endedAt)
    else if (!buffer) caption('')
  }
}

async function transcribeSegment(chunks, endedAt) {
  const samples = new Float32Array(chunks.length * CHUNK)
  chunks.forEach((c, i) => samples.set(c, i * CHUNK))
  inflight++
  let text = ''
  try {
    const res = await fetch('/api/stt', { method: 'POST', headers: { 'x-app': '1' }, body: encodeWav(samples) })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error || 'speech recognition (stt) failed')
    text = (j.text || '').trim()
  } catch (e) { explain(e.message) }
  inflight--
  handleHeard(text, endedAt)
}

// --- wake word / trigger word matching ---
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim()
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
function findWord(tokens, word) {
  const w = norm(word)
  if (!w) return -1
  const tol = w.length >= 6 ? 2 : w.length >= 5 ? 1 : 0
  return tokens.findIndex((t) => t === w || (tol && lev(t, w) <= tol))
}

function handleHeard(raw, endedAt) {
  if (!raw) { if (!buffer) caption(''); return }
  const { wakeWord, sendWord, alwaysOn } = state.voice
  let tokens = norm(raw).split(' ').filter(Boolean)

  if (mode === 'standby') { // wake-word mode, asleep
    const i = findWord(tokens, wakeWord)
    if (i < 0) { caption(''); return }
    beep(880)
    buffer = ''
    setMode('listening')
    tokens = tokens.slice(i + 1)
  } else if (mode === 'listening') {
    if (alwaysOn && findWord(tokens, wakeWord) === 0) tokens = tokens.slice(1)
  } else return

  armListenTimeout()
  const j = findWord(tokens, sendWord)
  if (j >= 0) { // explicit trigger word: send now
    buffer = `${buffer} ${tokens.slice(0, j).join(' ')}`.trim()
    return sendBuffer()
  }
  buffer = `${buffer} ${tokens.join(' ')}`.trim()
  caption(buffer || '…')
  updateAnim()
  scheduleAutoSend(endedAt)
}
function scheduleAutoSend(endedAt) { // Siri-style: a pause ends the request
  clearTimeout(sendTimer)
  if (!buffer) return
  const wait = Math.max(0, state.voice.pause * 1000 - (Date.now() - endedAt))
  sendTimer = setTimeout(() => {
    if (mode !== 'listening') return
    if (vad.speaking || inflight > 0) scheduleAutoSend(Date.now())
    else sendBuffer()
  }, wait)
}
function armListenTimeout() {
  clearTimeout(listenTimer)
  if (state.voice.alwaysOn) return
  listenTimer = setTimeout(() => { if (mode === 'listening') { buffer = ''; beep(330); caption(''); setMode('standby') } }, 60000)
}
function sendBuffer() {
  clearTimeout(listenTimer); clearTimeout(sendTimer)
  const text = buffer.trim()
  buffer = ''
  caption('')
  if (!text) return restState()
  beep(660)
  submit(text)
}
function submit(text) {
  muteSay = false; lastSpoken = new Set()
  stopSpeech()
  setMode('working')
  bubble('user', text, readTime(text))
  api('/api/chat', { text }).catch((e) => { explain(e.message); restState() })
}

function beep(freq) {
  if (!audioCtx) return
  const o = audioCtx.createOscillator(), g = audioCtx.createGain()
  o.frequency.value = freq; g.gain.value = 0.05
  o.connect(g).connect(audioCtx.destination)
  o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15); o.stop(audioCtx.currentTime + 0.16)
}

async function micStart() {
  if (micOn) return
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  audioCtx ??= new AudioContext()
  await audioCtx.resume()
  const worklet = `class P extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('p',P)`
  await audioCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' })))
  const src = audioCtx.createMediaStreamSource(micStream)
  vadNode = new AudioWorkletNode(audioCtx, 'p')
  const from = audioCtx.sampleRate
  vadNode.port.onmessage = (e) => onAudio(downsample(e.data, from))
  const mute = audioCtx.createGain(); mute.gain.value = 0
  src.connect(vadNode).connect(mute).connect(audioCtx.destination)
  micOn = true
}
function micStop() {
  micStream?.getTracks().forEach((t) => t.stop())
  vadNode?.disconnect()
  micOn = false
}

// ---------------- menu & settings ----------------
function toggleMenu(force) {
  const open = force ?? $('menu').hidden
  $('menu').hidden = !open
  $('menuBtn').setAttribute('aria-expanded', String(open))
}
function applyUi() {
  const v = state.voice
  $('brandName').textContent = v.wakeWord.toUpperCase()
  $('typeForm').hidden = !v.showChat
  $('history').hidden = !v.showChat
  document.body.classList.toggle('chat-on', v.showChat)
  if (mode === 'standby' || mode === 'listening') restState()
}
function paintSettings() {
  const v = state.voice
  $('keyHint').textContent = state.hasKey ? `Key saved locally (${state.keyHint})` : 'No key saved'
  $('speed').value = v.speed; $('speedOut').textContent = `${Number(v.speed).toFixed(2)}×`
  $('pause').value = v.pause; $('pauseOut').textContent = `${Number(v.pause).toFixed(1)} s`
  $('wakeWord').value = v.wakeWord; $('sendWord').value = v.sendWord
  $('bargeIn').checked = v.bargeIn; $('showChat').checked = v.showChat; $('alwaysOn').checked = v.alwaysOn
  $('modelLabel').textContent = state.activeModel; $('modelBtnLabel').textContent = state.activeModel
  applyUi()
}
const saveVoice = async (patch) => { Object.assign(state, await api('/api/settings', { voice: patch })); paintSettings() }

// ---------------- model picker ----------------
let allModels = []
let tab = 'fav'
async function openModal() {
  $('modal').hidden = false
  $('modelSearch').value = ''
  $('modelSearch').focus()
  paintModels()
  if (!allModels.length) {
    try { allModels = await api('/api/models'); paintModels() } catch (e) { $('modelList').replaceChildren(el('div', 'empty', `Could not load models: ${e.message}. Check your internet connection.`)) }
  }
}
function paintModels() {
  const q = $('modelSearch').value.trim().toLowerCase()
  const favIds = new Set(state.favourites.map((f) => f.id))
  const known = new Map(allModels.map((m) => [m.id, m]))
  let list = tab === 'fav' ? state.favourites.map((f) => known.get(f.id) ?? { id: f.id, name: f.name }) : allModels
  if (q) list = list.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q))
  list = list.slice(0, 200)
  if (!list.length) { $('modelList').replaceChildren(el('div', 'empty', tab === 'fav' ? 'No favourites yet — star models in “All OpenRouter”.' : 'No matches.')); return }
  $('modelList').replaceChildren(...list.map((m) => {
    const row = el('div', `model${m.id === state.activeModel ? ' active' : ''}`)
    const star = el('button', `star${favIds.has(m.id) ? ' on' : ''}`, favIds.has(m.id) ? '★' : '☆')
    star.title = 'Toggle favourite'
    star.onclick = async (e) => {
      e.stopPropagation()
      const favs = favIds.has(m.id) ? state.favourites.filter((f) => f.id !== m.id) : [...state.favourites, { id: m.id, name: m.name }]
      Object.assign(state, await api('/api/favourites', { favourites: favs }))
      paintModels()
    }
    const meta = el('div', 'meta')
    meta.append(el('div', 'name', m.name), el('div', 'sub', [m.id, m.context ? `${Math.round(m.context / 1000)}k ctx` : '', m.prompt !== undefined ? `$${m.prompt.toFixed(2)}/M in` : '', m.tools === false ? 'no tools' : ''].filter(Boolean).join(' · ')))
    row.append(star, meta)
    row.onclick = async () => {
      Object.assign(state, await api('/api/model', { id: m.id, name: m.name }))
      paintSettings(); paintModels(); $('modal').hidden = true; toggleMenu(false)
      bubble('user', `Model: ${m.name}`, 3000)
    }
    return row
  }))
}

// ---------------- wiring ----------------
async function init() {
  state = await api('/api/state')
  initRive()
  paintSettings()
  connectEvents()
  restState()
  if (!state.hasKey) { toggleMenu(true); showError('No OpenRouter API key is set.', 'Paste your key in the menu and press Save.') }

  $('menuBtn').onclick = () => toggleMenu()
  $('keySave').onclick = async () => {
    const key = $('keyInput').value.trim()
    if (!key) return
    Object.assign(state, await api('/api/settings', { openrouterKey: key }))
    $('keyInput').value = ''
    paintSettings(); bubble('user', 'API key saved locally.', 3000)
  }
  $('speed').oninput = () => { $('speedOut').textContent = `${Number($('speed').value).toFixed(2)}×` }
  $('pause').oninput = () => { $('pauseOut').textContent = `${Number($('pause').value).toFixed(1)} s` }
  $('voiceSave').onclick = async () => {
    await saveVoice({ speed: Number($('speed').value), pause: Number($('pause').value), wakeWord: $('wakeWord').value, sendWord: $('sendWord').value })
    bubble('user', 'Voice settings saved.', 3000)
  }
  $('bargeIn').onchange = () => saveVoice({ bargeIn: $('bargeIn').checked })
  $('showChat').onchange = () => saveVoice({ showChat: $('showChat').checked })
  $('alwaysOn').onchange = async () => { await saveVoice({ alwaysOn: $('alwaysOn').checked }); buffer = ''; restState() }
  $('modelBtn').onclick = openModal
  $('modalClose').onclick = () => { $('modal').hidden = true }
  $('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').hidden = true }
  $('modelSearch').oninput = paintModels
  $('tabFav').onclick = () => { tab = 'fav'; $('tabFav').classList.add('active'); $('tabAll').classList.remove('active'); paintModels() }
  $('tabAll').onclick = () => { tab = 'all'; $('tabAll').classList.add('active'); $('tabFav').classList.remove('active'); paintModels() }
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('modal').hidden = true; toggleMenu(false) } })

  $('stopBtn').onclick = async () => { stopSpeech(); buffer = ''; caption(''); await api('/api/stop', {}); restState(); toggleMenu(false) }
  $('clearBtn').onclick = async () => {
    if (!confirm('Clear the conversation and saved session history? Files the agent created in memory/ are kept.')) return
    stopSpeech(); buffer = ''; caption('')
    await api('/api/clear', {}).catch((e) => explain(e.message))
    restState(); toggleMenu(false)
  }
  $('shutdownBtn').onclick = async () => {
    if (!confirm('Shut down the app and stop all activity?')) return
    stopSpeech()
    await api('/api/shutdown', {}).catch(() => {})
  }
  $('typeForm').onsubmit = (e) => {
    e.preventDefault()
    const t = $('typeInput').value.trim()
    if (t) { $('typeInput').value = ''; submit(t) }
  }
  $('activateBtn').onclick = async () => {
    $('activate').hidden = true
    audioCtx ??= new AudioContext()
    try {
      await micStart()
      const v = state.voice
      bubble('user', v.alwaysOn ? 'Conversation mode: just start talking.' : `Say “${v.wakeWord}”, then speak. Pause for ${v.pause}s to send.`, 6000)
    } catch (e) { explain(`microphone: ${e.name || ''} ${e.message}`) }
  }
}
init().catch((e) => { document.body.append(el('pre', 'msg err', `Failed to reach the app server: ${e.message}\nRun Launch app from the project folder.`)) })
