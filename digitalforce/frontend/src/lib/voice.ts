/**
 * NaxionAI — Voice
 * Mic recording -> local Whisper transcription, local TTS playback (queued so
 * overlapping speech from the live reply and daemon-pushed messages don't
 * clobber each other), and a fully offline wake-word listener (Vosk, streamed
 * over WebSocket to the backend — no cloud speech API, works in any browser).
 */

import { authHeaders } from './auth'

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// ─── Mic auto-recovery ──────────────────────────────────────────────────────
// Windows sometimes defaults to an input device that's disconnected, muted, or
// otherwise dead, in which case getUserMedia() still resolves — it just hands
// back a stream of flat silence, and every downstream feature (wake word,
// recording) quietly does nothing with no error to explain why. Probe the
// default device for real signal first; if it's silent, scan the other
// available input devices and switch to whichever one actually picks up sound.

function measureRms(stream: MediaStream, sampleMs = 200): Promise<number> {
  return new Promise((resolve) => {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    const ctx: AudioContext = new AudioContextCtor()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    let peak = 0
    const start = Date.now()
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128
        sumSquares += normalized * normalized
      }
      peak = Math.max(peak, Math.sqrt(sumSquares / data.length))
      if (Date.now() - start >= sampleMs) {
        clearInterval(timer)
        ctx.close().catch(() => {})
        resolve(peak)
      }
    }, 20)
  })
}

const SILENCE_RMS_THRESHOLD = 0.001

async function getWorkingMicStream(): Promise<MediaStream> {
  const defaultStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const defaultRms = await measureRms(defaultStream)
  if (defaultRms > SILENCE_RMS_THRESHOLD) return defaultStream
  defaultStream.getTracks().forEach(t => t.stop())

  let devices: MediaDeviceInfo[]
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: true })
  }

  let best: { stream: MediaStream; rms: number } | null = null
  for (const device of devices) {
    let candidate: MediaStream
    try {
      candidate = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: device.deviceId } } })
    } catch {
      continue
    }
    const rms = await measureRms(candidate)
    if (!best || rms > best.rms) {
      best?.stream.getTracks().forEach(t => t.stop())
      best = { stream: candidate, rms }
    } else {
      candidate.getTracks().forEach(t => t.stop())
    }
  }

  if (best && best.rms > SILENCE_RMS_THRESHOLD) return best.stream
  best?.stream.getTracks().forEach(t => t.stop())
  // Nothing louder found anywhere — fall back to the default device so the
  // caller still gets a stream rather than failing outright.
  return navigator.mediaDevices.getUserMedia({ audio: true })
}

// ─── Manual mic recording (push-button start/stop) ─────────────────────────

let mediaRecorder: MediaRecorder | null = null
let recordedChunks: BlobPart[] = []
let recordingStream: MediaStream | null = null
// getUserMedia() is async and the UI doesn't disable the mic button while it's
// pending, so two rapid clicks before the first call resolves both see no
// active recording and both start one. The second call's getUserMedia()
// result overwrites recordingStream/mediaRecorder above, orphaning the
// first call's live stream — its tracks never get stopped, so the mic stays
// open until the tab closes. Guard re-entry instead.
let startingOrRecording = false

export async function startRecording(): Promise<void> {
  if (startingOrRecording) {
    throw new Error('Already recording')
  }
  startingOrRecording = true
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recordedChunks = []
    mediaRecorder = new MediaRecorder(recordingStream)
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data)
    }
    mediaRecorder.start()
  } catch (e) {
    startingOrRecording = false
    throw e
  }
}

export function stopRecording(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder) {
      reject(new Error('Not recording'))
      return
    }
    const recorder = mediaRecorder
    recorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' })
      recordingStream?.getTracks().forEach(t => t.stop())
      recordingStream = null
      mediaRecorder = null
      startingOrRecording = false
      resolve(blob)
    }
    recorder.stop()
  })
}

// ─── Auto-recording with silence detection (used after wake-word fires) ───

export function recordCommandUntilSilence(opts: {
  maxMs?: number
  silenceMs?: number
  silenceThreshold?: number
} = {}): Promise<Blob> {
  const { maxMs = 8000, silenceMs = 1200, silenceThreshold = 0.02 } = opts

  return new Promise(async (resolve, reject) => {
    let stream: MediaStream
    try {
      stream = await getWorkingMicStream()
    } catch (e) {
      reject(e)
      return
    }

    const chunks: BlobPart[] = []
    const recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    let lastLoudAt = Date.now()
    const startedAt = Date.now()
    let stopped = false

    const finish = () => {
      if (stopped) return
      stopped = true
      clearInterval(pollTimer)
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        audioCtx.close().catch(() => {})
        resolve(new Blob(chunks, { type: 'audio/webm' }))
      }
      recorder.stop()
    }

    const pollTimer = setInterval(() => {
      analyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128
        sumSquares += normalized * normalized
      }
      const rms = Math.sqrt(sumSquares / data.length)
      if (rms > silenceThreshold) lastLoudAt = Date.now()

      const now = Date.now()
      if (now - startedAt > maxMs) finish()
      else if (now - lastLoudAt > silenceMs && now - startedAt > 400) finish()
    }, 150)

    recorder.start()
  })
}

// ─── Transcription (local Whisper via backend) ─────────────────────────────

export async function transcribe(blob: Blob): Promise<string> {
  const fd = new FormData()
  fd.append('file', blob, 'recording.webm')
  const res = await fetch(`${BASE}/api/voice/transcribe`, {
    method: 'POST',
    headers: { ...authHeaders() },
    body: fd,
  })
  if (!res.ok) throw new Error(`Transcribe failed: HTTP ${res.status}`)
  const data = await res.json()
  return (data.text as string) || ''
}

// ─── Autoplay unlock ────────────────────────────────────────────────────────
// Chrome/Edge/Safari block unmuted audio.play() until the page has seen a
// real user gesture (click/keydown/touch) — the native mic-permission prompt
// does NOT count. Naxie's replies can auto-speak with zero prior clicks (e.g.
// right after the wake-word fires), so play() silently rejects and the reply
// looks "silent" with no error anywhere. Playing a near-silent clip on the
// page's first gesture unlocks playback for the rest of the session.
let audioUnlocked = false

function unlockAudioOnFirstGesture() {
  if (typeof window === 'undefined' || audioUnlocked) return
  const unlock = () => {
    audioUnlocked = true
    const silent = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=')
    silent.play().catch(() => {})
  }
  window.addEventListener('click', unlock, { once: true, capture: true })
  window.addEventListener('keydown', unlock, { once: true, capture: true })
  window.addEventListener('touchstart', unlock, { once: true, capture: true })
}
unlockAudioOnFirstGesture()

// ─── Speech playback queue (local TTS via backend) ─────────────────────────

class AudioQueue {
  private queue: string[] = []
  private playing = false

  enqueue(blob: Blob) {
    const url = URL.createObjectURL(blob)
    this.queue.push(url)
    if (!this.playing) this.playNext()
  }

  private playNext() {
    const url = this.queue.shift()
    if (!url) {
      this.playing = false
      return
    }
    this.playing = true
    const audio = new Audio(url)
    const advance = () => {
      URL.revokeObjectURL(url)
      this.playNext()
    }
    audio.onended = advance
    audio.onerror = advance
    audio.play().catch((e) => {
      console.warn('[Voice] Playback blocked (likely no user gesture yet on this page load):', e)
      advance()
    })
  }
}

const audioQueue = new AudioQueue()

export async function synthesizeAudio(text: string, voiceId?: string): Promise<Blob> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Text is empty')
  const res = await fetch(`${BASE}/api/voice/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ text: trimmed, voice: voiceId }),
  })
  if (!res.ok) throw new Error(`TTS failed with HTTP ${res.status}`)
  return await res.blob()
}

export async function speak(text: string, voiceId?: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  try {
    const blob = await synthesizeAudio(trimmed, voiceId)
    audioQueue.enqueue(blob)
  } catch (e) {
    // Voice is best-effort — never let a TTS failure break the chat flow,
    // but still surface it so silent failures are debuggable.
    console.warn('[Voice] speak() failed:', e)
  }
}

// ─── Wake-word listener (offline Vosk, streamed over WebSocket) ───────────
// Fully local/free — no cloud speech API and no per-request cost. The mic is
// captured client-side (ScriptProcessorNode; still universally supported
// despite being deprecated in favor of AudioWorklet), downsampled to 16kHz
// mono PCM16, and streamed to the backend's /api/voice/ws/wake endpoint,
// where a small Vosk model checks it against the configured wake phrase.
// Works in any browser with mic + WebSocket support — including Firefox,
// where the old SpeechRecognition-based approach didn't work at all.

export function isWakeWordSupported(): boolean {
  if (typeof window === 'undefined') return false
  return !!((navigator as any).mediaDevices?.getUserMedia && ((window as any).AudioContext || (window as any).webkitAudioContext) && (window as any).WebSocket)
}

function floatTo16BitPCM(float32: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(float32.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

function downsampleTo16k(float32: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return float32
  const ratio = inputRate / 16000
  const newLength = Math.round(float32.length / ratio)
  const result = new Float32Array(newLength)
  let offsetResult = 0
  let offsetBuffer = 0
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
    let accum = 0
    let count = 0
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32.length; i++) {
      accum += float32[i]
      count++
    }
    result[offsetResult] = count ? accum / count : 0
    offsetResult++
    offsetBuffer = nextOffsetBuffer
  }
  return result
}

let wakeActive = false
let wakeSocket: WebSocket | null = null
let wakeAudioCtx: AudioContext | null = null
let wakeStream: MediaStream | null = null
let wakeProcessor: ScriptProcessorNode | null = null

export function startWakeWordListener(phrase: string, onDetected: () => void) {
  if (!isWakeWordSupported()) return
  wakeActive = true

  const wsBase = BASE.replace(/^http/, 'ws')
  const socket = new WebSocket(`${wsBase}/api/voice/ws/wake?phrase=${encodeURIComponent(phrase.trim().toLowerCase())}`)
  wakeSocket = socket

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'wake') {
        stopWakeWordListener()
        onDetected()
      } else if (msg.type === 'error') {
        console.warn('[WakeWord] Server error:', msg.message)
      }
    } catch {
      // Ignore malformed messages.
    }
  }
  socket.onerror = (e) => {
    console.warn('[WakeWord] WebSocket error:', e)
  }

  socket.onopen = async () => {
    if (!wakeActive) return
    try {
      wakeStream = await getWorkingMicStream()
    } catch (e) {
      console.warn('[WakeWord] Mic permission denied or unavailable:', e)
      stopWakeWordListener()
      return
    }
    if (!wakeActive) return

    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    const audioCtx: AudioContext = new AudioContextCtor()
    wakeAudioCtx = audioCtx
    const source = audioCtx.createMediaStreamSource(wakeStream)
    // bufferSize 4096 @ typical 44.1/48kHz ≈ ~85-95ms per chunk — small enough
    // for responsive wake detection without flooding the socket.
    const processor = audioCtx.createScriptProcessor(4096, 1, 1)
    wakeProcessor = processor

    processor.onaudioprocess = (e) => {
      if (!wakeActive || socket.readyState !== WebSocket.OPEN) return
      const input = e.inputBuffer.getChannelData(0)
      const downsampled = downsampleTo16k(input, audioCtx.sampleRate)
      socket.send(floatTo16BitPCM(downsampled))
    }

    source.connect(processor)
    processor.connect(audioCtx.destination)
  }
}

export function stopWakeWordListener() {
  wakeActive = false
  try { wakeSocket?.close() } catch { /* ignore */ }
  wakeSocket = null
  try { wakeProcessor?.disconnect() } catch { /* ignore */ }
  wakeProcessor = null
  try { wakeAudioCtx?.close() } catch { /* ignore */ }
  wakeAudioCtx = null
  wakeStream?.getTracks().forEach(t => t.stop())
  wakeStream = null
}

// ─── Double-clap listener (acoustic, no speech recognition at all) ────────
// A second, independent hands-free trigger for when saying the wake phrase
// isn't convenient (or Vosk keeps mishearing it) — two claps in quick
// succession fire the same "listen for a command" flow as the wake word.
// Runs entirely client-side: an adaptive noise-floor EMA marks a sample as a
// "spike" only once it's well above the room's recent ambient level, so it
// self-calibrates to a quiet office vs. a noisy room without any tuning.

const CLAP_SPIKE_RATIO = 7.0        // a spike must be this many times the noise floor
const CLAP_SPIKE_HOLDOFF_MS = 120   // ignore further spikes this long (debounces one clap's decay tail)
const CLAP_MIN_GAP_MS = 50          // two spikes closer than this are one clap, not a pair
const CLAP_MAX_GAP_MS = 350         // two spikes further apart than this aren't a deliberate double-clap
const CLAP_ACTION_COOLDOWN_MS = 450 // after firing, ignore all input for this long
const CLAP_NOISE_EMA_ALPHA = 0.05   // how fast the noise floor adapts to the room

let clapActive = false
let clapStream: MediaStream | null = null
let clapAudioCtx: AudioContext | null = null
let clapRaf: number | null = null

export function isClapDetectSupported(): boolean {
  if (typeof window === 'undefined') return false
  return !!((navigator as any).mediaDevices?.getUserMedia && ((window as any).AudioContext || (window as any).webkitAudioContext))
}

export async function startClapListener(onDoubleClap: () => void) {
  if (!isClapDetectSupported()) return
  clapActive = true

  let stream: MediaStream
  try {
    stream = await getWorkingMicStream()
  } catch (e) {
    console.warn('[Clap] Mic permission denied or unavailable:', e)
    clapActive = false
    return
  }
  if (!clapActive) {
    stream.getTracks().forEach(t => t.stop())
    return
  }
  clapStream = stream

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  const audioCtx: AudioContext = new AudioContextCtor()
  clapAudioCtx = audioCtx
  const source = audioCtx.createMediaStreamSource(stream)
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const data = new Uint8Array(analyser.frequencyBinCount)

  let noiseFloor: number | null = null
  let lastSpikeAt = 0
  let pendingFirstClapAt = 0
  let cooldownUntil = 0

  const poll = () => {
    if (!clapActive) return
    clapRaf = requestAnimationFrame(poll)

    const now = Date.now()
    if (now < cooldownUntil) return

    analyser.getByteTimeDomainData(data)
    let sumSquares = 0
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128
      sumSquares += normalized * normalized
    }
    const rms = Math.sqrt(sumSquares / data.length)

    const isSpike = noiseFloor !== null && rms > noiseFloor * CLAP_SPIKE_RATIO
    if (isSpike && now - lastSpikeAt > CLAP_SPIKE_HOLDOFF_MS) {
      lastSpikeAt = now
      const gap = now - pendingFirstClapAt
      if (pendingFirstClapAt && gap >= CLAP_MIN_GAP_MS && gap <= CLAP_MAX_GAP_MS) {
        pendingFirstClapAt = 0
        cooldownUntil = now + CLAP_ACTION_COOLDOWN_MS
        onDoubleClap()
      } else {
        pendingFirstClapAt = now
      }
    } else if (!isSpike) {
      if (pendingFirstClapAt && now - pendingFirstClapAt > CLAP_MAX_GAP_MS) pendingFirstClapAt = 0
      noiseFloor = noiseFloor === null ? Math.max(rms, 0.0003) : noiseFloor * (1 - CLAP_NOISE_EMA_ALPHA) + rms * CLAP_NOISE_EMA_ALPHA
    }
  }
  clapRaf = requestAnimationFrame(poll)
}

export function stopClapListener() {
  clapActive = false
  if (clapRaf !== null) {
    cancelAnimationFrame(clapRaf)
    clapRaf = null
  }
  try { clapAudioCtx?.close() } catch { /* ignore */ }
  clapAudioCtx = null
  clapStream?.getTracks().forEach(t => t.stop())
  clapStream = null
}

