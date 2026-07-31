'use client'

import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Loader2, Send, VolumeX, Sparkles } from 'lucide-react'
import Sidebar from '@/components/Sidebar'
import {
  startRecording, stopRecording, transcribe, speak,
} from '@/lib/voice'

// Standalone voice-first companion to the text Chat page — same brain
// (/api/chat/stream), same local voice pipeline (Whisper STT, Piper TTS),
// just a push-to-talk HUD instead of a text thread. Ported over from an
// earlier prototype built on the (now retired) neuroworks-ts stack; the orb
// visual is CSS-only rings + a breathing glow (see globals.css), no gif/video.

type Turn = { role: 'user' | 'assistant'; text: string }

const STORAGE_KEY = 'neuroworks.jarvis.turns'
const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function loadTurns(): Turn[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

export default function JarvisPage() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { setTurns(loadTurns()) }, [])

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-40))) } catch { /* ignore */ }
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  function stopSpeaking() {
    try { window.speechSynthesis?.cancel() } catch { /* not supported */ }
    setSpeaking(false)
  }

  async function speakReply(text: string) {
    setSpeaking(true)
    await speak(text) // enqueues local Piper/faster-whisper-backed TTS; no-op on failure
    setSpeaking(false)
  }

  async function ask(text: string) {
    const question = text.trim()
    if (!question || busy) return
    setBusy(true)
    setInput('')
    setTurns(prev => [...prev, { role: 'user', text: question }])

    try {
      const res = await fetch(`${BASE}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let reply = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6))
            if (evt.type === 'message') reply += evt.content
          } catch { /* partial/malformed chunk, skip */ }
        }
      }

      const finalReply = reply.trim() || 'Acknowledged.'
      setTurns(prev => [...prev, { role: 'assistant', text: finalReply }])
      void speakReply(finalReply)
    } catch (e: any) {
      setTurns(prev => [...prev, { role: 'assistant', text: `Error: ${e?.message ?? String(e)}` }])
    } finally {
      setBusy(false)
    }
  }

  async function micToggle() {
    if (recording) {
      setRecording(false)
      setBusy(true)
      try {
        const blob = await stopRecording()
        const text = await transcribe(blob)
        setBusy(false)
        if (text.trim()) await ask(text)
      } catch (e: any) {
        setBusy(false)
        setTurns(prev => [...prev, { role: 'assistant', text: `Mic error: ${e?.message ?? String(e)}` }])
      }
    } else {
      stopSpeaking()
      try {
        await startRecording()
        setRecording(true)
      } catch {
        setTurns(prev => [...prev, { role: 'assistant', text: "Couldn't access the microphone — check browser permissions." }])
      }
    }
  }

  const orbState: 'listening' | 'thinking' | 'speaking' | 'idle' =
    recording ? 'listening' : busy ? 'thinking' : speaking ? 'speaking' : 'idle'

  const orbColor = {
    idle: 'rgba(167,139,250,0.5)',
    listening: 'rgba(239,68,68,0.7)',
    thinking: 'rgba(226,232,240,0.5)',
    speaking: 'rgba(0,163,255,0.7)',
  }[orbState]

  const orbLabel = {
    idle: 'Standing by',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
  }[orbState]

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto" style={{ background: '#080B12' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '3rem 1.5rem', display: 'flex', flexDirection: 'column', height: '100vh', boxSizing: 'border-box' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1.5rem' }}>
            <Sparkles size={20} style={{ color: '#A78BFA' }} />
            <div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#F8FAFC' }}>JARVIS</div>
              <div style={{ fontSize: '0.75rem', color: 'rgba(226,232,240,0.5)' }}>Voice assistant — talk or type</div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem', padding: '2rem 0' }}>
            <div style={{ position: 'relative', width: 180, height: 180, display: 'grid', placeItems: 'center' }}>
              <div className="nw-orb-ring-a" style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${orbColor}` }} />
              <div className="nw-orb-ring-b" style={{ position: 'absolute', inset: 22, borderRadius: '50%', border: `1px solid ${orbColor}`, opacity: 0.7 }} />
              <div
                className={`nw-orb-glow${orbState !== 'idle' ? ' is-active' : ''}`}
                style={{
                  position: 'absolute', inset: 44, borderRadius: '50%',
                  background: `radial-gradient(circle, ${orbColor.replace('0.5', '0.25').replace('0.7', '0.3')}, transparent 70%)`,
                  border: `1px solid ${orbColor}`, boxShadow: `0 0 40px 10px ${orbColor}`,
                }}
              />
              <span style={{ position: 'relative', zIndex: 1, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.2em', color: 'rgba(226,232,240,0.7)' }}>
                {orbLabel}
              </span>
            </div>

            <button
              type="button"
              onClick={micToggle}
              disabled={busy && !recording}
              title={recording ? 'Stop and send' : 'Talk to JARVIS'}
              style={{
                padding: '1rem', borderRadius: '50%', cursor: 'pointer',
                background: recording ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.03)',
                border: recording ? '1px solid rgba(239,68,68,0.5)' : '1px solid rgba(255,255,255,0.08)',
                color: recording ? '#F87171' : '#E2E8F0',
                transition: 'all 0.2s',
              }}
            >
              {recording ? <Square size={20} /> : busy ? <Loader2 size={20} className="animate-spin" /> : <Mic size={20} />}
            </button>
          </div>

          {turns.length > 0 && (
            <div ref={logRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.6rem', paddingBottom: '1rem' }}>
              {turns.map((t, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: t.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  {t.role === 'user' ? (
                    <div style={{ fontSize: '0.8rem', color: 'rgba(226,232,240,0.7)', background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 10, padding: '0.5rem 0.75rem', maxWidth: '85%' }}>
                      {t.text}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.875rem', color: '#F1F5F9', background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: 10, padding: '0.5rem 0.75rem', maxWidth: '85%', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <button type="button" title="Replay" onClick={() => speakReply(t.text)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#A78BFA', marginTop: 2, flexShrink: 0 }}>
                        <Sparkles size={13} />
                      </button>
                      <span>{t.text}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.75rem 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            {speaking && (
              <button type="button" onClick={stopSpeaking} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0.5rem 0.75rem', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#94A3B8', fontSize: '0.75rem', cursor: 'pointer' }}>
                <VolumeX size={13} /> Stop
              </button>
            )}
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void ask(input) }}
              placeholder="Ask JARVIS anything…"
              disabled={busy}
              style={{
                flex: 1, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10, padding: '0.65rem 0.875rem', fontSize: '0.875rem', color: '#F1F5F9',
                outline: 'none', opacity: busy ? 0.5 : 1,
              }}
            />
            <button
              type="button"
              onClick={() => ask(input)}
              disabled={busy || !input.trim()}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '0.65rem 1rem', borderRadius: 10,
                background: 'linear-gradient(135deg, #00A3FF, #006199)', border: '1px solid rgba(255,255,255,0.1)',
                color: '#fff', fontSize: '0.8rem', fontWeight: 700, cursor: busy || !input.trim() ? 'default' : 'pointer',
                opacity: busy || !input.trim() ? 0.5 : 1,
              }}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Ask
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
