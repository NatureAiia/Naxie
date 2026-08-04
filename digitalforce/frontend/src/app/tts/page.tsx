'use client'

import { useState, useRef } from 'react'
import Sidebar from '@/components/Sidebar'
import { synthesizeAudio } from '@/lib/voice'
import { 
  Volume2, Play, Download, Sparkles, 
  RotateCcw, History, Copy, Check, Mic
} from 'lucide-react'

interface HistoryItem {
  id: string
  text: string
  voiceName: string
  timestamp: string
  blobUrl: string
}

export default function TTSPage() {
  const [text, setText] = useState('')
  const [voiceId, setVoiceId] = useState('c3QefzBhE1Cx4Yl23IV3') // Rachel ElevenLabs ID default
  const [customVoiceId, setCustomVoiceId] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null)
  const [currentBlob, setCurrentBlob] = useState<Blob | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [copied, setCopied] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)

  const SAMPLE_PRESETS = [
    { label: "Greeting", text: "Hello Mark. I am Naxie, your personal AI assistant. All neural systems are online." },
    { label: "Briefing", text: "Good morning. Here is your daily summary: 3 tasks are queued, market analysis is ready, and all agent workflows are nominal." },
    { label: "Technical Alert", text: "Warning: High priority notification. System metrics indicate optimal throughput across all active tasks." }
  ]

  const VOICE_OPTIONS = [
    { id: 'c3QefzBhE1Cx4Yl23IV3', name: 'Rachel (ElevenLabs)', desc: 'Warm, natural female voice' },
    { id: 'en_US-lessac-medium', name: 'Piper Local (Lessac)', desc: 'Fast, offline medium voice' },
    { id: 'custom', name: 'Custom Voice ID', desc: 'Specify an ElevenLabs Voice ID' }
  ]

  const handleSynthesize = async () => {
    if (!text.trim()) return
    setIsGenerating(true)
    setErrorMsg(null)

    const selectedVoice = voiceId === 'custom' ? (customVoiceId || 'c3QefzBhE1Cx4Yl23IV3') : voiceId

    try {
      const blob = await synthesizeAudio(text, selectedVoice)
      const url = URL.createObjectURL(blob)

      setCurrentBlob(blob)
      setCurrentAudioUrl(url)

      // Add to local history
      const newItem: HistoryItem = {
        id: Date.now().toString(),
        text: text.trim().slice(0, 100) + (text.length > 100 ? '...' : ''),
        voiceName: VOICE_OPTIONS.find(v => v.id === voiceId)?.name || 'Custom Voice',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        blobUrl: url
      }
      setHistory(prev => [newItem, ...prev.slice(0, 15)])

      // Auto-play synthesized speech
      if (audioRef.current) {
        audioRef.current.src = url
        audioRef.current.play()
        setIsPlaying(true)
      }
    } catch (err: any) {
      console.error('TTS Synthesis error:', err)
      setErrorMsg(err?.message || 'Synthesis failed. Please check voice settings or network connection.')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleDownload = (blob: Blob | null, filename: string) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
  }

  const copyText = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#080B12', color: '#F8FAFC' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowX: 'hidden' }}>
        <main style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
          {/* Top Banner */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: '2rem', paddingBottom: '1.25rem',
            borderBottom: '1px solid rgba(255,255,255,0.05)'
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: 'linear-gradient(135deg, rgba(236,72,153,0.2), rgba(168,85,247,0.2))',
                  border: '1px solid rgba(236,72,153,0.3)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#EC4899'
                }}>
                  <Volume2 size={20} />
                </div>
                <h1 style={{ fontSize: '1.75rem', fontWeight: 600, letterSpacing: '-0.02em', color: '#F8FAFC' }}>
                  Text to Speech Studio
                </h1>
              </div>
              <p style={{ fontSize: '0.875rem', color: '#94A3B8', marginTop: 4 }}>
                Synthesize high-fidelity voice audio directly powered by ElevenLabs & local neural engines.
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '2rem' }}>
            {/* Left Column: Text Input & Synthesizer */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {/* Presets Bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.75rem', color: '#64748B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Presets:
                </span>
                {SAMPLE_PRESETS.map((preset, idx) => (
                  <button
                    key={idx}
                    onClick={() => setText(preset.text)}
                    style={{
                      padding: '0.4rem 0.75rem', borderRadius: 20,
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#CBD5E1', fontSize: '0.78rem', cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                  >
                    ✨ {preset.label}
                  </button>
                ))}
              </div>

              {/* Text Input Box */}
              <div style={{
                position: 'relative', borderRadius: 16,
                background: 'rgba(15, 23, 42, 0.65)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                backdropFilter: 'blur(16px)',
                padding: '1.25rem'
              }}>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder="Enter or paste any text here to synthesize speech..."
                  rows={8}
                  style={{
                    width: '100%', background: 'transparent', border: 'none', outline: 'none',
                    color: '#F8FAFC', fontSize: '1rem', lineHeight: 1.6, resize: 'vertical',
                    fontFamily: 'inherit'
                  }}
                />

                {/* Textbox Footer Controls */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginTop: '0.75rem', paddingTop: '0.75rem',
                  borderTop: '1px solid rgba(255,255,255,0.05)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.75rem', color: '#64748B' }}>
                    <span>{text.length} characters</span>
                    <span>•</span>
                    <span>{text.trim() ? text.trim().split(/\s+/).length : 0} words</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={copyText}
                      title="Copy text"
                      style={{
                        background: 'none', border: 'none', color: copied ? '#34D399' : '#64748B',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem'
                      }}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>

                    {text && (
                      <button
                        onClick={() => setText('')}
                        title="Clear text"
                        style={{
                          background: 'none', border: 'none', color: '#64748B',
                          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem'
                        }}
                      >
                        <RotateCcw size={14} /> Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Error Message Display */}
              {errorMsg && (
                <div style={{
                  padding: '0.85rem 1rem', borderRadius: 10,
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  color: '#FCA5A5', fontSize: '0.85rem',
                  display: 'flex', alignItems: 'center', gap: 8
                }}>
                  ⚠️ {errorMsg}
                </div>
              )}

              {/* Synthesize Action Bar */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '1.25rem', borderRadius: 16,
                background: 'rgba(15, 23, 42, 0.4)',
                border: '1px solid rgba(255,255,255,0.05)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button
                    onClick={handleSynthesize}
                    disabled={isGenerating || !text.trim()}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '0.85rem 2rem', borderRadius: 12,
                      background: !text.trim()
                        ? 'rgba(255,255,255,0.05)'
                        : 'linear-gradient(135deg, #EC4899 0%, #8B5CF6 100%)',
                      color: '#FFF', fontWeight: 600, fontSize: '0.95rem',
                      border: 'none', cursor: !text.trim() ? 'not-allowed' : 'pointer',
                      boxShadow: text.trim() ? '0 4px 20px rgba(236,72,153,0.35)' : 'none',
                      transition: 'all 0.2s', opacity: isGenerating ? 0.7 : 1
                    }}
                  >
                    {isGenerating ? (
                      <>
                        <Sparkles size={18} className="animate-spin" /> Synthesizing Speech...
                      </>
                    ) : (
                      <>
                        <Volume2 size={18} /> Synthesize & Play
                      </>
                    )}
                  </button>

                  {currentBlob && (
                    <button
                      onClick={() => handleDownload(currentBlob, `naxie_tts_${Date.now()}.mp3`)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '0.85rem 1.25rem', borderRadius: 12,
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: '#F8FAFC', fontSize: '0.875rem', fontWeight: 500,
                        cursor: 'pointer'
                      }}
                    >
                      <Download size={16} /> Download Audio
                    </button>
                  )}
                </div>
              </div>

              {/* Live Audio Player Element */}
              <audio
                ref={audioRef}
                onEnded={() => setIsPlaying(false)}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                controls
                style={{
                  width: '100%', marginTop: '0.5rem', borderRadius: 12,
                  display: currentAudioUrl ? 'block' : 'none',
                  filter: 'invert(0.9) hue-rotate(180deg)'
                }}
              />
            </div>

            {/* Right Column: Voice Selection & History */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {/* Voice Selector Box */}
              <div style={{
                padding: '1.25rem', borderRadius: 16,
                background: 'rgba(15, 23, 42, 0.65)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                backdropFilter: 'blur(16px)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1rem', color: '#EC4899', fontWeight: 600, fontSize: '0.9rem' }}>
                  <Mic size={18} /> Select Voice Model
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {VOICE_OPTIONS.map(v => (
                    <div
                      key={v.id}
                      onClick={() => setVoiceId(v.id)}
                      style={{
                        padding: '0.85rem 1rem', borderRadius: 12,
                        background: voiceId === v.id ? 'rgba(236,72,153,0.12)' : 'rgba(255,255,255,0.02)',
                        border: voiceId === v.id ? '1px solid rgba(236,72,153,0.4)' : '1px solid rgba(255,255,255,0.05)',
                        cursor: 'pointer', transition: 'all 0.2s'
                      }}
                    >
                      <div style={{ fontSize: '0.875rem', fontWeight: 600, color: voiceId === v.id ? '#F472B6' : '#F8FAFC' }}>
                        {v.name}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#94A3B8', marginTop: 2 }}>
                        {v.desc}
                      </div>
                    </div>
                  ))}

                  {voiceId === 'custom' && (
                    <input
                      type="text"
                      value={customVoiceId}
                      onChange={e => setCustomVoiceId(e.target.value)}
                      placeholder="Paste ElevenLabs Voice ID..."
                      style={{
                        marginTop: 4, width: '100%', padding: '0.65rem 0.85rem',
                        borderRadius: 8, background: 'rgba(0,0,0,0.3)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: '#FFF', fontSize: '0.8rem', outline: 'none'
                      }}
                    />
                  )}
                </div>
              </div>

              {/* Synthesis History */}
              <div style={{
                padding: '1.25rem', borderRadius: 16,
                background: 'rgba(15, 23, 42, 0.65)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                backdropFilter: 'blur(16px)', flex: 1
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1rem', color: '#94A3B8', fontWeight: 600, fontSize: '0.85rem' }}>
                  <History size={16} /> Recent Audio Clips
                </div>

                {history.length === 0 ? (
                  <div style={{ fontSize: '0.8rem', color: '#475569', textAlign: 'center', padding: '2rem 0' }}>
                    No clips synthesized yet.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                    {history.map(item => (
                      <div
                        key={item.id}
                        style={{
                          padding: '0.65rem 0.85rem', borderRadius: 8,
                          background: 'rgba(255,255,255,0.02)',
                          border: '1px solid rgba(255,255,255,0.04)',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                        }}
                      >
                        <div style={{ overflow: 'hidden', marginRight: 8 }}>
                          <div style={{ fontSize: '0.78rem', color: '#E2E8F0', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                            {item.text}
                          </div>
                          <div style={{ fontSize: '0.68rem', color: '#64748B', marginTop: 2 }}>
                            {item.voiceName} • {item.timestamp}
                          </div>
                        </div>

                        <button
                          onClick={() => {
                            setCurrentAudioUrl(item.blobUrl)
                            if (audioRef.current) {
                              audioRef.current.src = item.blobUrl
                              audioRef.current.play()
                            }
                          }}
                          style={{
                            background: 'rgba(236,72,153,0.15)', border: 'none',
                            color: '#F472B6', width: 28, height: 28, borderRadius: '50%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', flexShrink: 0
                          }}
                        >
                          <Play size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
