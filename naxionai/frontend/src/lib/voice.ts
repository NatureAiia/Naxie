/**
 * NAXIONAI — Voice
 * Mic recording -> local Whisper transcription, local TTS playback (queued so
 * overlapping speech from the live reply and daemon-pushed messages don't
 * clobber each other), and a browser-based wake-word listener.
 *
 * NOTE: the wake-word listener uses the browser's SpeechRecognition API. In
 * Chrome/Edge this is NOT purely local — it streams audio to the browser
 * vendor's cloud recognition service just to detect the wake phrase. The
 * actual command (after the wake word fires) goes through our own
 * /api/voice/transcribe endpoint, which IS fully local (faster-whisper).
 */

import { authHeaders } from './auth'

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// ─── Manual mic recording (push-button start/stop) ─────────────────────────

let mediaRecorder: MediaRecorder | null = null
let recordedChunks: BlobPart[] = []
let recordingStream: MediaStream | null = null

export async function startRecording(): Promise<void> {
  recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  recordedChunks = []
  mediaRecorder = new MediaRecorder(recordingStream)
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data)
  }
  mediaRecorder.start()
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
    audio.play().catch(advance)
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
  } catch {
    // Voice is best-effort — never let a TTS failure break the chat flow.
  }
}

// ─── Wake-word listener (browser SpeechRecognition, see note above) ───────

export function isWakeWordSupported(): boolean {
  if (typeof window === 'undefined') return false
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
}

let recognition: any = null
let wakeActive = false

export function startWakeWordListener(phrase: string, onDetected: () => void) {
  if (!isWakeWordSupported()) return
  const SpeechRecognitionCtor =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  wakeActive = true
  const normalizedPhrase = phrase.trim().toLowerCase()

  const start = () => {
    if (!wakeActive) return
    recognition = new SpeechRecognitionCtor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase()
        if (transcript.includes(normalizedPhrase)) {
          stopWakeWordListener()
          onDetected()
          return
        }
      }
    }

    // The API auto-stops after a period of silence — restart while wake mode is on.
    recognition.onend = () => {
      if (wakeActive) start()
    }
    recognition.onerror = () => {
      // Swallow — onend will fire next and restart if still active.
    }

    try {
      recognition.start()
    } catch {
      // Already running — ignore.
    }
  }

  start()
}

export function stopWakeWordListener() {
  wakeActive = false
  if (recognition) {
    try {
      recognition.onend = null
      recognition.stop()
    } catch {
      // Ignore.
    }
    recognition = null
  }
}
