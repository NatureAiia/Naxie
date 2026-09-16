// Pluggable object-storage primitive — put/get/delete/exists behind one
// interface, backend picked by OBJECT_STORE_BACKEND (local default, s3).
// Standalone infrastructure: nothing else in the app is wired to this yet.

import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ObjectStore {
  put(key: string, data: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class ObjectStoreKeyEscape extends Error {
  constructor(key: string) { super(`object key escapes store root: ${key}`); this.name = "ObjectStoreKeyEscape"; }
}

// ── Local filesystem backend ────────────────────────────────────────────────
// Mirrors lib/local-files.ts's containment pattern: every key resolves under
// one root; a key that would escape it throws instead of touching disk.

const LOCAL_ROOT = process.env.OBJECT_STORE_LOCAL_ROOT
  ? resolve(process.env.OBJECT_STORE_LOCAL_ROOT)
  : resolve(__dirname, "../../../.neuroworks/object-store");

function resolveLocalKey(key: string): string {
  const full = resolve(LOCAL_ROOT, key.replace(/^[/\\]+/, ""));
  if (full !== LOCAL_ROOT && !full.startsWith(LOCAL_ROOT + sep)) throw new ObjectStoreKeyEscape(key);
  return full;
}

class LocalObjectStore implements ObjectStore {
  async put(key: string, data: Buffer | string): Promise<void> {
    const full = resolveLocalKey(key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }

  async get(key: string): Promise<Buffer | null> {
    const full = resolveLocalKey(key);
    if (!existsSync(full)) return null;
    return readFileSync(full);
  }

  async delete(key: string): Promise<void> {
    const full = resolveLocalKey(key);
    rmSync(full, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(resolveLocalKey(key));
  }
}

// ── S3 backend ───────────────────────────────────────────────────────────────

function isNotFound(e: any): boolean {
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

class S3ObjectStore implements ObjectStore {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const bucket = process.env.OBJECT_STORE_S3_BUCKET?.trim();
    if (!bucket) throw new Error("OBJECT_STORE_S3_BUCKET is required when OBJECT_STORE_BACKEND=s3");
    this.bucket = bucket;
    const accessKeyId = process.env.OBJECT_STORE_S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.OBJECT_STORE_S3_SECRET_ACCESS_KEY?.trim();
    this.client = new S3Client({
      region: process.env.OBJECT_STORE_S3_REGION?.trim() || "us-east-1",
      endpoint: process.env.OBJECT_STORE_S3_ENDPOINT?.trim() || undefined,
      // Absent → SDK's default provider chain (env/instance role/shared config).
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    });
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Buffer | Uint8Array>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (e: any) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e: any) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }
}

// ── Backend selection ───────────────────────────────────────────────────────
// Lazy + cached: constructing S3ObjectStore validates env, so a "local" deploy
// never pays for that check, and a "s3" deploy only pays it once.

let backend: ObjectStore | null = null;

function activeBackend(): ObjectStore {
  if (!backend) {
    const kind = (process.env.OBJECT_STORE_BACKEND ?? "local").trim().toLowerCase();
    backend = kind === "s3" ? new S3ObjectStore() : new LocalObjectStore();
  }
  return backend;
}

export const objectStore: ObjectStore = {
  put: (key, data) => activeBackend().put(key, data),
  get: key => activeBackend().get(key),
  delete: key => activeBackend().delete(key),
  exists: key => activeBackend().exists(key),
};
