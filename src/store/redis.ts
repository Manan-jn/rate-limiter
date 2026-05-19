import { Redis } from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class RedisStore implements Store {
  private client: Redis;
  private subscriber: Redis | null = null;
  private scripts = new Map<string, string>(); // name → SHA1

  constructor(url: string) {
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,  // fail fast when disconnected
      lazyConnect: true,
    });
    this.client.on('error', (err: Error) => {
      console.error('[RedisStore] connection error:', err.message);
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.loadScripts();
  }

  async disconnect(): Promise<void> {
    await this.subscriber?.quit();
    await this.client.quit();
  }

  // Load all Lua scripts from ./lua/ and register their SHA1 hashes.
  // Uses EVALSHA on every call — sends the hash, not the full script.
  private async loadScripts(): Promise<void> {
    const luaDir = path.join(__dirname, 'lua');
    if (!fs.existsSync(luaDir)) return;
    for (const file of fs.readdirSync(luaDir)) {
      if (!file.endsWith('.lua')) continue;
      const name = file.replace('.lua', '');
      const source = fs.readFileSync(path.join(luaDir, file), 'utf-8');
      const sha = (await this.client.call('SCRIPT', 'LOAD', source)) as string;
      this.scripts.set(name, sha);
    }
  }

  async evalsha<T>(name: string, keys: string[], args: (string | number)[]): Promise<T> {
    const sha = this.scripts.get(name);
    if (!sha) throw new Error(`Unknown Lua script: ${name}`);
    return this.client.evalsha(sha, keys.length, ...keys, ...args.map(String)) as Promise<T>;
  }

  // Always use Redis server time — never Date.now() — to avoid clock skew across workers.
  async nowMs(): Promise<number> {
    const [sec, mic] = (await this.client.time()) as unknown as [string, string];
    return Number(sec) * 1000 + Math.floor(Number(mic) / 1000);
  }

  // Expose client for admin ops (HSET, SMEMBERS, PUBLISH, etc.)
  get raw(): Redis {
    return this.client;
  }

  // Create a dedicated subscriber connection (separate from command client).
  // Subscriber connections must NOT have enableOfflineQueue:false or lazyConnect:true
  // because subscribe() is called immediately after creation.
  async createSubscriber(): Promise<Redis> {
    const sub = this.client.duplicate({
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    sub.on('error', (err: Error) => {
      console.error('[RedisStore subscriber] connection error:', err.message);
    });
    // Wait for connection before returning so caller can subscribe immediately
    await new Promise<void>((resolve, reject) => {
      sub.once('ready', resolve);
      sub.once('error', reject);
    });
    this.subscriber = sub;
    return sub;
  }
}
