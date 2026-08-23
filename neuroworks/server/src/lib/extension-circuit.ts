type Circuit = {
  failures: number;
  success: number;
  openedAt?: string;
  until?: string;
  state: "closed" | "open" | "half-open";
};

const thresholds = {
  failuresToOpen: 3,
  openMs: 5 * 60 * 1000, // 5m
  halfOpenAfterMs: 5 * 60 * 1000,
};

const store = new Map<string, Circuit>();

function get(id: string): Circuit {
  return store.get(id) ?? { failures: 0, success: 0, state: "closed" };
}

export function isThrottled(id: string): boolean {
  const c = store.get(id);
  if (!c || c.state !== "open") return false;
  const until = c.until ? new Date(c.until).getTime() : 0;
  if (Date.now() < until) return true;
  // half-open: allow one probe
  c.state = "half-open";
  return false;
}

export function recordCircuit(id: string, ok: boolean) {
  const c = get(id);
  if (ok) {
    c.success++;
    c.failures = 0;
    if (c.state === "half-open" || c.state === "open") {
      c.state = "closed";
      delete c.openedAt;
      delete c.until;
    }
  } else {
    c.failures++;
    c.success = 0;
    if (c.failures >= thresholds.failuresToOpen && c.state === "closed") {
      c.state = "open";
      c.openedAt = new Date().toISOString();
      c.until = new Date(Date.now() + thresholds.openMs).toISOString();
    } else if (c.state === "half-open") {
      // probe failed -> re-open
      c.state = "open";
      c.openedAt = new Date().toISOString();
      c.until = new Date(Date.now() + thresholds.openMs).toISOString();
    }
  }
  store.set(id, c);
}

export function getCircuitState(id: string): Circuit {
  const c = get(id);
  // auto-transition half-open if window passed
  if (c.state === "open" && c.until && Date.now() >= new Date(c.until).getTime()) {
    c.state = "half-open";
  }
  return { ...c };
}

export function getAllCircuits(): Record<string, Circuit> {
  const out: Record<string, Circuit> = {};
  for (const [k, v] of store) out[k] = getCircuitState(k);
  return out;
}
