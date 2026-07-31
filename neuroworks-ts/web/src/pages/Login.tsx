import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogIn, Loader2, AlertTriangle, UserPlus, CheckCircle2 } from "lucide-react";
import { api, setToken } from "../lib/api";
import { BrandMark } from "../components/BrandMark";
import { Button, showToast } from "../components/Card";
import { KineticGridBackground } from "../components/KineticGridBackground";

// Login page — the identity layer. Signing in attributes activity to a person
// and is tracked (login history on the Users page). The app itself is loopback-
// only; this isn't a hard network gate. First login for an account with no
// password set claims that password.
//
// "Request access" is the self-signup path: the account lands as PENDING and
// cannot sign in until an admin approves it on the Admin page (where the
// approver also sets the access layer + department).

export function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedUp, setSignedUp] = useState(false);
  // First-run: no accounts exist yet → this signup creates the workspace owner.
  const [bootstrap, setBootstrap] = useState(false);

  useEffect(() => {
    api.authState()
      .then(s => { if (s.needsBootstrap) { setBootstrap(true); setMode("signup"); } })
      .catch(() => { /* offline / not ready — fall back to normal login */ });
  }, []);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !email.trim()) return;
    setErr(null); setBusy(true);
    try {
      if (mode === "signup") {
        if (!name.trim()) { setErr("Your name is required."); return; }
        const r = await api.signup({ name: name.trim(), email: email.trim(), password, department: department.trim() || undefined, title: bootstrap ? "Owner" : undefined });
        if (r.firstUser && r.token) {
          // Owner account — signed in immediately, straight into the app.
          setToken(r.token);
          showToast(`Welcome, ${r.user.name} — you're the workspace owner`, "success");
          navigate("/chat");
          return;
        }
        setSignedUp(true);
      } else {
        const r = await api.login(email.trim(), password);
        setToken(r.token);
        showToast(`Signed in as ${r.user.name}`, "success");
        navigate("/chat");
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally { setBusy(false); }
  }

  const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2.5 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

  return (
    <div className="relative min-h-screen grid place-items-center bg-ink-950 px-4 overflow-hidden">
      <KineticGridBackground />
      <div className="relative z-10 w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <BrandMark size={40} />
          <div className="mt-3 text-xl font-semibold text-cream-50 tracking-tight">NeuroWorks</div>
          <div className="text-[11px] text-cream-300/60 uppercase tracking-wider mt-1">
            {mode === "login" ? "Sign in to your workspace" : bootstrap ? "Create the workspace owner account" : "Request access to the workspace"}
          </div>
          {bootstrap && (
            <div className="text-[11px] text-cream-300/50 mt-2 text-center max-w-xs">
              This is a fresh workspace. The first account you create becomes the
              <span className="text-violet-300"> owner (superadmin)</span> and signs in right away.
            </div>
          )}
        </div>

        {signedUp ? (
          <div className="bg-ink-900 border border-leaf-500/30 rounded-2xl p-6 text-center space-y-3">
            <CheckCircle2 size={28} className="text-leaf-400 mx-auto" />
            <div className="text-sm text-cream-100 font-medium">Request received</div>
            <div className="text-[12px] text-cream-300/70">
              An administrator will approve your access. Once approved, sign in with the
              email and password you just chose.
            </div>
            <Button variant="subtle" onClick={() => { setSignedUp(false); setMode("login"); }} className="w-full justify-center">
              <LogIn size={14} /> Back to sign in
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-ink-900 border border-ink-800 rounded-2xl p-6 space-y-4">
            {mode === "signup" && (
              <>
                <div>
                  <label className="block text-[11px] text-cream-300/70 mb-1">Full name</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder="Thandi Moyo" autoFocus className={FIELD} />
                </div>
                <div>
                  <label className="block text-[11px] text-cream-300/70 mb-1">Department (optional)</label>
                  <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="Marketing" className={FIELD} />
                </div>
              </>
            )}
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" autoFocus={mode === "login"} className={FIELD} />
            </div>
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete={mode === "signup" ? "new-password" : "current-password"} className={FIELD} />
              {mode === "login" && <div className="text-[10px] text-cream-300/40 mt-1">First sign-in for a new account sets its password.</div>}
              {mode === "signup" && <div className="text-[10px] text-cream-300/40 mt-1">{bootstrap ? "Min 4 characters — this is your owner password." : "Min 4 characters — you'll use this once your access is approved."}</div>}
            </div>
            {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
            <Button onClick={() => submit()} disabled={busy || !email.trim() || (mode === "signup" && !name.trim())} className="w-full justify-center">
              {busy ? <Loader2 size={15} className="animate-spin" /> : mode === "login" ? <LogIn size={15} /> : <UserPlus size={15} />}
              {mode === "login" ? " Sign in" : bootstrap ? " Create owner account" : " Request access"}
            </Button>
            {!bootstrap && (
              <button
                type="button"
                onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(null); }}
                className="w-full text-center text-[11px] text-violet-400 hover:text-violet-300"
              >
                {mode === "login" ? "New here? Request access" : "Already have an account? Sign in"}
              </button>
            )}
          </form>
        )}

        <div className="text-center text-[11px] text-cream-300/40 mt-4">
          Local workspace · 127.0.0.1 · activity is attributed to your account
        </div>
      </div>
    </div>
  );
}
