// Owner resolution for agent-driven business-finance calls. Primitives run
// without an HTTP caller, so there is no callerOf(req) email — resolve the
// single operator via the users directory with the "local" fallback that
// routes/business-finance.ts uses for a login-less shell. Kept in its own
// module (not inside business-finance.ts) so the finance store module never
// imports the users subsystem — tests stay hermetic.

export async function financeOwner(): Promise<string> {
  try {
    const { lookupUser } = await import("./users.js");
    const email = lookupUser("operator")?.email?.trim().toLowerCase();
    if (email) return email;
  } catch { /* fall through to local */ }
  return "local";
}
