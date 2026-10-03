// Type declarations for the Naxie dispatch SDK.

export interface NaxieOptions {
  baseUrl?: string;
  apiKey: string;
}

export interface DispatchOptions {
  callbackUrl?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface DispatchAccepted {
  jobId: string;
  status: "accepted";
  poll: string;
}

export interface DispatchResult {
  jobId: string;
  status: "pending" | "running" | "succeeded" | "failed";
  answer: string | null;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  timedOut?: boolean;
}

export class Naxie {
  constructor(opts: NaxieOptions);
  baseUrl: string;
  apiKey: string;
  dispatch(task: string, opts?: DispatchOptions): Promise<DispatchAccepted>;
  result(jobId: string): Promise<DispatchResult>;
  waitFor(jobId: string, opts?: Pick<DispatchOptions, "timeoutMs" | "intervalMs">): Promise<DispatchResult>;
  run(task: string, opts?: DispatchOptions): Promise<DispatchResult>;
}

export function verifyWebhook(secret: string, rawBody: string, signatureHeader: string): Promise<boolean>;
