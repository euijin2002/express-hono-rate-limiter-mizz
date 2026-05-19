var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  MemoryStore: () => MemoryStore,
  RateLimiter: () => RateLimiter,
  createRateLimiter: () => createRateLimiter,
  expressRateLimit: () => expressRateLimit,
  honoRateLimit: () => honoRateLimit
});
module.exports = __toCommonJS(index_exports);
var DEFAULT_LIMIT = 100;
var DEFAULT_WINDOW_MS = 6e4;
var MemoryStore = class {
  values = /* @__PURE__ */ new Map();
  async get(key) {
    const row = this.values.get(key);
    if (!row) return null;
    if (row.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return row.value;
  }
  async set(key, value, mode, ttlSeconds) {
    const ttlMs = mode === "EX" && ttlSeconds ? ttlSeconds * 1e3 : DEFAULT_WINDOW_MS * 2;
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  async del(key) {
    this.values.delete(key);
  }
};
var RateLimiter = class {
  limit;
  windowMs;
  strategy;
  keyParts;
  keyPrefix;
  store;
  getUserId;
  getIp;
  now;
  routeId;
  constructor(options = {}) {
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
  async check(request = {}) {
    const key = this.buildKey(request);
    if (this.strategy === "sliding-window") return this.checkSlidingWindow(key);
    if (this.strategy === "token-bucket") return this.checkTokenBucket(key);
    return this.checkFixedWindow(key);
  }
  buildKey(request = {}) {
    const parts = this.keyParts.map((part) => {
      if (part === "user") return `user:${this.resolveUser(request) || "anonymous"}`;
      if (part === "route") return `route:${this.routeId || request.path || request.originalUrl || request.url || "unknown"}`;
      return `ip:${this.resolveIp(request) || "unknown"}`;
    });
    return `${this.keyPrefix}:${parts.join(":")}`;
  }
  async checkFixedWindow(key) {
    const now = this.now();
    const raw = await this.store.get(key);
    const current = raw ? JSON.parse(raw) : { count: 0, windowStart: now };
    const expired = now - current.windowStart >= this.windowMs;
    const state = expired ? { count: 0, windowStart: now } : current;
    state.count += 1;
    await this.store.set(key, JSON.stringify(state), "EX", Math.ceil(this.windowMs / 1e3) + 2);
    const resetAt = state.windowStart + this.windowMs;
    return this.decision(key, state.count <= this.limit, this.limit - state.count, resetAt);
  }
  async checkSlidingWindow(key) {
    const now = this.now();
    const raw = await this.store.get(key);
    const parsed = raw ? JSON.parse(raw) : { hits: [] };
    const cutoff = now - this.windowMs;
    const hits = parsed.hits.filter((hit) => hit > cutoff);
    hits.push(now);
    await this.store.set(key, JSON.stringify({ hits }), "EX", Math.ceil(this.windowMs / 1e3) + 2);
    const resetAt = hits[0] + this.windowMs;
    return this.decision(key, hits.length <= this.limit, this.limit - hits.length, resetAt);
  }
  async checkTokenBucket(key) {
    const now = this.now();
    const raw = await this.store.get(key);
    const refillPerMs = this.limit / this.windowMs;
    const current = raw ? JSON.parse(raw) : { tokens: this.limit, updatedAt: now };
    const elapsed = Math.max(0, now - current.updatedAt);
    const available = Math.min(this.limit, current.tokens + elapsed * refillPerMs);
    const allowed = available >= 1;
    const tokens = allowed ? available - 1 : available;
    const missing = Math.max(0, 1 - tokens);
    const resetAt = allowed ? now + Math.ceil((this.limit - tokens) / refillPerMs) : now + Math.ceil(missing / refillPerMs);
    await this.store.set(key, JSON.stringify({ tokens, updatedAt: now }), "EX", Math.ceil(this.windowMs / 1e3) + 2);
    return this.decision(key, allowed, Math.floor(tokens), resetAt);
  }
  decision(key, allowed, remainingValue, resetAt) {
    const now = this.now();
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1e3));
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, Math.floor(remainingValue)),
      resetAt,
      retryAfter,
      strategy: this.strategy,
      key
    };
  }
  resolveIp(request) {
    if (this.getIp) return this.getIp(request) || null;
    const forwarded = getHeader(request, "x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
    return request.ip || null;
  }
  resolveUser(request) {
    if (this.getUserId) return this.getUserId(request) || null;
    const user = request.user || {};
    const id = "id" in user ? user.id : "sub" in user ? user.sub : null;
    return typeof id === "string" ? id : null;
  }
};
function createRateLimiter(options = {}) {
  return new RateLimiter(options);
}
function expressRateLimit(options = {}) {
  const limiter = createRateLimiter(options);
  const message = options.message ?? "Too many requests";
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const decision = await limiter.check(req);
      setExpressHeaders(res, decision);
      if (!decision.allowed) {
        if (typeof res.status === "function") res.status(429);
        if (typeof res.json === "function") return res.json({ error: message, retryAfter: decision.retryAfter });
        if (typeof res.end === "function") return res.end(message);
        return void 0;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
function honoRateLimit(options = {}) {
  const limiter = createRateLimiter(options);
  const message = options.message ?? "Too many requests";
  return async function rateLimitMiddleware(c, next) {
    const request = {
      path: c.req?.path,
      url: c.req?.url,
      headers: c.req?.raw?.headers,
      user: c.get ? c.get("user") : void 0
    };
    const decision = await limiter.check(request);
    setHonoHeaders(c, decision);
    if (!decision.allowed) {
      return c.json ? c.json({ error: message, retryAfter: decision.retryAfter }, 429) : new Response(message, { status: 429 });
    }
    return next();
  };
}
function setExpressHeaders(res, decision) {
  if (typeof res.setHeader !== "function") return;
  res.setHeader("X-RateLimit-Limit", String(decision.limit));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1e3)));
  if (!decision.allowed) res.setHeader("Retry-After", String(decision.retryAfter));
}
function setHonoHeaders(c, decision) {
  if (typeof c.header !== "function") return;
  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1e3)));
  if (!decision.allowed) c.header("Retry-After", String(decision.retryAfter));
}
function getHeader(request, name) {
  const headers = request.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const value = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MemoryStore,
  RateLimiter,
  createRateLimiter,
  expressRateLimit,
  honoRateLimit
});
