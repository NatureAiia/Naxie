import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { showToast } from "../components/Card";

// WebRTC connection mechanics for an OpenAI Realtime live call — lifted out
// of VoiceDiscussion.tsx (the report-discussion "Start live call" feature)
// so Naxie.tsx's own live call can reuse the exact same plumbing instead of
// re-implementing mic capture / RTCPeerConnection / data channel / SDP
// exchange. UI-specific state (a turn list, a typed-prompt input) stays with
// each caller — this hook only owns the connection itself.

export type RealtimeCallState = "off" | "connecting" | "on";

export function useRealtimeCall(opts: {
  // Mints the short-lived session this call connects with — callers differ
  // only in what they pass the server (a jobId for report-context, nothing
  // for Naxie's own persona), so this is the one thing left caller-specific.
  mintSession: () => Promise<{ clientSecret: string; model: string; baseUrl: string }>;
  // Called once per finalized spoken reply's transcript (not on every delta).
  onTranscript?: (text: string) => void;
}) {
  const [live, setLive] = useState<RealtimeCallState>("off");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const connectTimerRef = useRef<any>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const liveReplyRef = useRef<string>("");
  const callModelRef = useRef<string>("gpt-realtime");
  const mintSessionRef = useRef(opts.mintSession);
  const onTranscriptRef = useRef(opts.onTranscript);
  mintSessionRef.current = opts.mintSession;
  onTranscriptRef.current = opts.onTranscript;

  function onCallEvent(raw: string) {
    let ev: any;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        liveReplyRef.current += ev.delta ?? "";
        break;
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const text = (ev.transcript ?? liveReplyRef.current).trim();
        liveReplyRef.current = "";
        if (text) onTranscriptRef.current?.(text);
        break;
      }
      case "response.done": {
        const u = ev.response?.usage;
        const inTok = Number(u?.input_tokens ?? u?.total_input_tokens ?? 0);
        const outTok = Number(u?.output_tokens ?? u?.total_output_tokens ?? 0);
        if (inTok > 0 || outTok > 0) {
          api.voiceReportUsage(callModelRef.current, inTok, outTok).catch(() => {});
        }
        break;
      }
      case "error":
        showToast(`Call: ${ev.error?.message ?? "provider error"}`, "error");
        break;
    }
  }

  async function startCall() {
    if (live !== "off") return;
    setLive("connecting");
    // Safety: never hang in "connecting" forever — bail after 25s if the peer
    // connection hasn't reached a connected state.
    connectTimerRef.current = setTimeout(() => {
      if (pcRef.current && pcRef.current.connectionState !== "connected") {
        endCall(); showToast("Live call didn't connect in time — try again.", "error");
      }
    }, 25000);
    try {
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error("Microphone blocked — allow mic access in your browser, then try again.");
      }
      liveStreamRef.current = mic;

      const sess = await mintSessionRef.current();
      callModelRef.current = sess.model || "gpt-realtime";
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const remote = remoteAudioRef.current ?? new Audio();
      remote.autoplay = true;
      remoteAudioRef.current = remote;
      pc.ontrack = (e) => { remote.srcObject = e.streams[0]; remote.play().catch(() => {}); };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") setLive("on");
        else if (st === "failed" || st === "disconnected" || st === "closed") {
          if (pcRef.current === pc) { endCall(); showToast("Live call dropped.", "error"); }
        }
      };

      mic.getTracks().forEach(t => pc.addTrack(t, mic));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (e) => onCallEvent(typeof e.data === "string" ? e.data : "");

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const base = (sess.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const r = await fetch(`${base}/realtime/calls?model=${encodeURIComponent(sess.model)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sess.clientSecret}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new Error(`Call setup failed (${r.status})${detail ? `: ${detail.slice(0, 120)}` : ""}`);
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
      setLive("on");
    } catch (e: any) {
      endCall();
      showToast(e?.message ?? String(e), "error");
    }
  }

  // Send a typed prompt INTO the live call over the data channel.
  function sendToCall(text: string): boolean {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return false;
    try {
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }));
      dc.send(JSON.stringify({ type: "response.create" }));
      return true;
    } catch { return false; }
  }

  function endCall() {
    if (connectTimerRef.current) { clearTimeout(connectTimerRef.current); connectTimerRef.current = null; }
    try { dcRef.current?.close(); } catch { /* ignore */ }
    dcRef.current = null;
    liveStreamRef.current?.getTracks().forEach(t => t.stop());
    liveStreamRef.current = null;
    if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = null; }
    try { pcRef.current?.close(); } catch { /* ignore */ }
    pcRef.current = null;
    liveReplyRef.current = "";
    setLive("off");
  }

  useEffect(() => () => endCall(), []);

  return { live, startCall, endCall, sendToCall };
}
