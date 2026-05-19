import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryStore,
  RateLimiter,
  createRateLimiter,
  expressRateLimit,
  honoRateLimit,
} from "../dist/index.js";

class FakeRedis {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) || null;
  }

  async set(key, value) {
    this.values.set(key, value);
  }
}

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    tick: (ms) => {
      now += ms;
      return now;
    },
  };
}

test("fixed window allows requests up to the limit", async () => {
  const time = clock();
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: time.now });
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
});

test("fixed window blocks after the limit", async () => {
  const time = clock();
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: time.now });
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  const blocked = await limiter.check({ ip: "1.1.1.1" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 1);
});

test("fixed window resets after expiry", async () => {
  const time = clock();
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: time.now });
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, false);
  time.tick(1001);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
});

test("sliding window expires only old hits", async () => {
  const time = clock();
  const limiter = new RateLimiter({ strategy: "sliding-window", limit: 2, windowMs: 1000, now: time.now });
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  time.tick(500);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, false);
  time.tick(1001);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
});

test("token bucket refills over time", async () => {
  const time = clock();
  const limiter = new RateLimiter({ strategy: "token-bucket", limit: 2, windowMs: 1000, now: time.now });
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, false);
  time.tick(500);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
});

test("key can combine route, user, and ip", () => {
  const limiter = createRateLimiter({ keyParts: ["route", "user", "ip"], routeId: "checkout", getUserId: () => "u1" });
  assert.equal(limiter.buildKey({ ip: "9.9.9.9" }), "rate-limit:route:checkout:user:u1:ip:9.9.9.9");
});

test("x-forwarded-for is used before req.ip", () => {
  const limiter = createRateLimiter();
  assert.equal(
    limiter.buildKey({ ip: "10.0.0.1", headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3" } }),
    "rate-limit:ip:2.2.2.2",
  );
});

test("custom Redis-like backend is supported", async () => {
  const redis = new FakeRedis();
  const limiter = new RateLimiter({ limit: 1, redis });
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, false);
  assert.equal(redis.values.size, 1);
});

test("memory store expires values", async () => {
  const store = new MemoryStore();
  await store.set("a", "b", "EX", 1);
  assert.equal(await store.get("a"), "b");
  await store.del("a");
  assert.equal(await store.get("a"), null);
});

test("Express middleware calls next for allowed requests", async () => {
  const middleware = expressRateLimit({ limit: 1 });
  let called = false;
  const res = { setHeader() {} };
  await middleware({ ip: "1.1.1.1" }, res, () => { called = true; });
  assert.equal(called, true);
});

test("Express middleware returns 429 JSON for blocked requests", async () => {
  const middleware = expressRateLimit({ limit: 1 });
  const headers = {};
  const res = {
    statusCode: 200,
    body: null,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await middleware({ ip: "1.1.1.1" }, res, () => {});
  await middleware({ ip: "1.1.1.1" }, res, () => {});
  assert.equal(res.statusCode, 429);
  assert.equal(headers["X-RateLimit-Limit"], "1");
  assert.equal(headers["Retry-After"], "60");
  assert.equal(res.body.error, "Too many requests");
});

test("Hono middleware calls next for allowed requests", async () => {
  const middleware = honoRateLimit({ limit: 1 });
  const headers = {};
  let called = false;
  const c = { req: { path: "/a", raw: { headers: new Headers({ "x-forwarded-for": "1.1.1.1" }) } }, header(k, v) { headers[k] = v; } };
  await middleware(c, async () => { called = true; });
  assert.equal(called, true);
  assert.equal(headers["X-RateLimit-Remaining"], "0");
});

test("Hono middleware returns 429 response for blocked requests", async () => {
  const middleware = honoRateLimit({ limit: 1 });
  const c = {
    req: { path: "/a", raw: { headers: new Headers({ "x-forwarded-for": "1.1.1.1" }) } },
    header() {},
    json(body, status) { return { body, status }; },
  };
  await middleware(c, async () => {});
  const response = await middleware(c, async () => {});
  assert.equal(response.status, 429);
  assert.equal(response.body.retryAfter, 60);
});

test("constructor rejects invalid limit", () => {
  assert.throws(() => new RateLimiter({ limit: 0 }), /limit/);
});

test("constructor rejects invalid window", () => {
  assert.throws(() => new RateLimiter({ windowMs: 0 }), /windowMs/);
});

test("independent IPs do not share counters", async () => {
  const limiter = new RateLimiter({ limit: 1 });
  assert.equal((await limiter.check({ ip: "1.1.1.1" })).allowed, true);
  assert.equal((await limiter.check({ ip: "2.2.2.2" })).allowed, true);
});
