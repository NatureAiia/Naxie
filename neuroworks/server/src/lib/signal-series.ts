// Shim for Omnis Signal series — minimal type-only stub to satisfy omnis-extract.ts
// Full pipeline deferred; email feed kind in omnisignal.ts is stubbed.
export type Observation = {
  feedId: string;
  messageId: string;
  receivedAt: string;
  observedAt: string;
  asset: string;
  metric: string;
  value: number | null;
  unit?: string;
  changePct?: number | null;
  direction?: "up" | "down" | "flat";
  signal?: string;
  horizon?: string;
  confidence: number;
};
export function observationsForFeed(_feedId: string, _limit: number): Observation[] { return []; }
export function appendObservations(_rows: Observation[]): void {}
export function hasMessage(_id: string): boolean { return false; }
