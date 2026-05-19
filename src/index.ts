export type RateLimitStrategy = "fixed-window" | "sliding-window" | "token-bucket";

export type KeyPart = "ip" | "user" | "route";

export interface RedisLike {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown> | unknown;
  del?(key: string): Promise<unknown> | unknown;
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  strategy?: RateLimitStrategy;
  keyParts?: KeyPart[];
  keyPrefix?: string;
  redis?: RedisLike | null;
  getUserId?: (request: RateLimitRequest) => string | null | undefined;
  getIp?: (request: RateLimitRequest) => string | null | undefined;
  now?: () => number;
  routeId?: string;
  message?: string;
}

export interface RateLimitRequest {
  ip?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined> | { get(name: string): string | null };
  user?: { id?: string; sub?: string } | Record<string, unknown>;
  method?: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
  strategy: RateLimitStrategy;
  key: string;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

interface SlidingState {
  hits: number[];
}

interface FixedState {
  count: number;
  windowStart: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_WINDOW_MS = 60_000;

export class MemoryStore {
  private values = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const row = this.values.get(key);
    if (!row) return null;
    if (row.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return row.value;
  }

  async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<void> {
    const ttlMs = mode === "EX" && ttlSeconds ? ttlSeconds * 1000 : DEFAULT_WINDOW_MS * 2;
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly strategy: RateLimitStrategy;
  private readonly keyParts: KeyPart[];
  private readonly keyPrefix: string;
  private readonly store: RedisLike;
  private readonly getUserId?: RateLimitOptions["getUserId"];
  private readonly getIp?: RateLimitOptions["getIp"];
  private readonly now: () => number;
  private readonly routeId?: string;

  constructor(options: RateLimitOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.strategy = options.strategy ?? "fixed-window";
    this.keyParts = options.keyParts ?? ["ip"];
    this.keyPrefix = options.keyPrefix ?? "rate-limit";
    this.store = options.redis ?? new MemoryStore();
    this.getUserId = options.getUserId;
    this.getIp = options.getIp;
    this.now = options.now ?? Date.now;
    this.routeId = options.routeId;
    if (this.limit <= 0) throw new Error("limit must be greater than 0");
    if (this.windowMs <= 0) throw new Error("windowMs must be greater than 0");
  }

  async check(request: RateLimitRequest = {}): Promise<RateLimitDecision> {
    const key = this.buildKey(request);
    if (this.strategy === "sliding-window") return this.checkSlidingWindow(key);
    if (this.strategy === "token-bucket") return this.checkTokenBucket(key);
    return this.checkFixedWindow(key);
  }

  buildKey(request: RateLimitRequest = {}): string {
    const parts = this.keyParts.map((part) => {
      if (part === "user") return `user:${this.resolveUser(request) || "anonymous"}`;
      if (part === "route") return `route:${this.routeId || request.path || request.originalUrl || request.url || "unknown"}`;
      return `ip:${this.resolveIp(request) || "unknown"}`;
    });
    return `${this.keyPrefix}:${parts.join(":")}`;
  }

  private async checkFixedWindow(key: string): Promise<RateLimitDecision> {
    const now = this.now();
    const raw = await this.store.get(key);
    const current: FixedState = raw ? JSON.parse(raw) : { count: 0, windowStart: now };
    const expired = now - current.windowStart >= this.windowMs;
    const state = expired ? { count: 0, windowStart: now } : current;
    state.count += 1;
    await this.store.set(key, JSON.stringify(state), "EX", Math.ceil(this.windowMs / 1000) + 2);
    const resetAt = state.windowStart + this.windowMs;
    return this.decision(key, state.count <= this.limit, this.limit - state.count, resetAt);
  }

  private async checkSlidingWindow(key: string): Promise<RateLimitDecision> {
    const now = this.now();
    const raw = await this.store.get(key);
    const parsed: SlidingState = raw ? JSON.parse(raw) : { hits: [] };
    const cutoff = now - this.windowMs;
    const hits = parsed.hits.filter((hit) => hit > cutoff);
    hits.push(now);
    await this.store.set(key, JSON.stringify({ hits }), "EX", Math.ceil(this.windowMs / 1000) + 2);
    const resetAt = hits[0] + this.windowMs;
    return this.decision(key, hits.length <= this.limit, this.limit - hits.length, resetAt);
  }

  private async checkTokenBucket(key: string): Promise<RateLimitDecision> {
    const now = this.now();
    const raw = await this.store.get(key);
    const refillPerMs = this.limit / this.windowMs;
    const current: BucketState = raw ? JSON.parse(raw) : { tokens: this.limit, updatedAt: now };
    const elapsed = Math.max(0, now - current.updatedAt);
    const available = Math.min(this.limit, current.tokens + elapsed * refillPerMs);
    const allowed = available >= 1;
    const tokens = allowed ? available - 1 : available;
    const missing = Math.max(0, 1 - tokens);
    const resetAt = allowed ? now + Math.ceil((this.limit - tokens) / refillPerMs) : now + Math.ceil(missing / refillPerMs);
    await this.store.set(key, JSON.stringify({ tokens, updatedAt: now }), "EX", Math.ceil(this.windowMs / 1000) + 2);
    return this.decision(key, allowed, Math.floor(tokens), resetAt);
  }

  private decision(key: string, allowed: boolean, remainingValue: number, resetAt: number): RateLimitDecision {
    const now = this.now();
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000));
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, Math.floor(remainingValue)),
      resetAt,
      retryAfter,
      strategy: this.strategy,
      key,
    };
  }

  private resolveIp(request: RateLimitRequest): string | null {
    if (this.getIp) return this.getIp(request) || null;
    const forwarded = getHeader(request, "x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
    return request.ip || null;
  }

  private resolveUser(request: RateLimitRequest): string | null {
    if (this.getUserId) return this.getUserId(request) || null;
    const user = request.user || {};
    const id = "id" in user ? user.id : "sub" in user ? user.sub : null;
    return typeof id === "string" ? id : null;
  }
}

export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  return new RateLimiter(options);
}

export function expressRateLimit(options: RateLimitOptions = {}) {
  const limiter = createRateLimiter(options);
  const message = options.message ?? "Too many requests";
  return async function rateLimitMiddleware(req: RateLimitRequest, res: any, next: (error?: unknown) => void) {
    try {
      const decision = await limiter.check(req);
      setExpressHeaders(res, decision);
      if (!decision.allowed) {
        if (typeof res.status === "function") res.status(429);
        if (typeof res.json === "function") return res.json({ error: message, retryAfter: decision.retryAfter });
        if (typeof res.end === "function") return res.end(message);
        return undefined;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function honoRateLimit(options: RateLimitOptions = {}) {
  const limiter = createRateLimiter(options);
  const message = options.message ?? "Too many requests";
  return async function rateLimitMiddleware(c: any, next: () => Promise<void>) {
    const request: RateLimitRequest = {
      path: c.req?.path,
      url: c.req?.url,
      headers: c.req?.raw?.headers,
      user: c.get ? c.get("user") : undefined,
    };
    const decision = await limiter.check(request);
    setHonoHeaders(c, decision);
    if (!decision.allowed) {
      return c.json ? c.json({ error: message, retryAfter: decision.retryAfter }, 429) : new Response(message, { status: 429 });
    }
    return next();
  };
}

function setExpressHeaders(res: any, decision: RateLimitDecision): void {
  if (typeof res.setHeader !== "function") return;
  res.setHeader("X-RateLimit-Limit", String(decision.limit));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
  if (!decision.allowed) res.setHeader("Retry-After", String(decision.retryAfter));
}

function setHonoHeaders(c: any, decision: RateLimitDecision): void {
  if (typeof c.header !== "function") return;
  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
  if (!decision.allowed) c.header("Retry-After", String(decision.retryAfter));
}

function getHeader(request: RateLimitRequest, name: string): string | null {
  const headers = request.headers;
  if (!headers) return null;
  if (typeof (headers as any).get === "function") return (headers as any).get(name);
  const value = (headers as Record<string, string | string[] | undefined>)[name]
    || (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}
