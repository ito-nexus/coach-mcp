// Small file-backed store for OAuth client registrations and refresh tokens.
// Lives on a Docker volume so people stay signed in across restarts.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface RefreshRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // unix seconds
}

interface StoreData {
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshRecord>; // key = sha256 of the token
}

const MAX_CLIENTS = 500;

export class FileStore {
  private file: string;
  private data: StoreData;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'oauth-store.json');
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as StoreData)
      : { clients: {}, refreshTokens: {} };
    this.data.clients ??= {};
    this.data.refreshTokens ??= {};
  }

  private save(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, r] of Object.entries(this.data.refreshTokens)) if (r.expiresAt < now) delete this.data.refreshTokens[k];
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  getClient(id: string): OAuthClientInformationFull | undefined {
    return this.data.clients[id];
  }

  addClient(client: OAuthClientInformationFull): void {
    const ids = Object.keys(this.data.clients);
    if (ids.length >= MAX_CLIENTS) {
      // Drop the oldest registration; Claude re-registers automatically if needed.
      const oldest = ids.sort((a, b) => (this.data.clients[a].client_id_issued_at ?? 0) - (this.data.clients[b].client_id_issued_at ?? 0))[0];
      delete this.data.clients[oldest];
    }
    this.data.clients[client.client_id] = client;
    this.save();
  }

  getRefresh(hash: string): RefreshRecord | undefined {
    return this.data.refreshTokens[hash];
  }

  putRefresh(hash: string, rec: RefreshRecord): void {
    this.data.refreshTokens[hash] = rec;
    this.save();
  }

  deleteRefresh(hash: string): void {
    if (this.data.refreshTokens[hash]) {
      delete this.data.refreshTokens[hash];
      this.save();
    }
  }
}
