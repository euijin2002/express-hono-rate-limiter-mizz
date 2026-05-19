# Multi-Strategy Rate Limiter

Framework-agnostic rate limiting middleware for Express and Hono. It supports
fixed-window, sliding-window, and token-bucket strategies, with an in-memory
store by default and a Redis-like backend when you pass one.

## Install

```bash
npm install
npm run verify
```

The package exports both ESM and CommonJS builds:

```bash
npm run build
```

## Express Usage

```ts
import express from "express";
import { expressRateLimit } from "multi-strategy-rate-limiter";

const app = express();

app.use(expressRateLimit({
  strategy: "fixed-window",
  limit: 100,
  windowMs: 60_000,
  keyParts: ["route", "user", "ip"],
  getUserId: (req) => req.user?.id,
}));
```

Blocked requests receive:

- HTTP `429`
- `Retry-After`
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

## Hono Usage

```ts
import { Hono } from "hono";
import { honoRateLimit } from "multi-strategy-rate-limiter";

const app = new Hono();

app.use("*", honoRateLimit({
  strategy: "sliding-window",
  limit: 60,
  windowMs: 60_000,
}));
```

## Redis Setup

Pass a Redis-compatible object with `get` and `set`. This works with `ioredis`
without making the package depend on Redis at install time.

```ts
import Redis from "ioredis";
import { expressRateLimit } from "multi-strategy-rate-limiter";

const redis = new Redis(process.env.REDIS_URL);

app.use(expressRateLimit({
  redis,
  strategy: "token-bucket",
  limit: 100,
  windowMs: 60_000,
}));
```

If no Redis client is provided, the middleware automatically uses the in-memory
store. That is useful for local development and single-process apps.

## Per-Route, Per-User, Per-IP Limits

```ts
expressRateLimit({
  routeId: "checkout",
  keyParts: ["route", "user", "ip"],
  getUserId: (req) => req.user?.id,
});
```

## Strategies

- `fixed-window`: simple counter per window. Good default.
- `sliding-window`: keeps recent hit timestamps for smoother limiting.
- `token-bucket`: allows short bursts while refilling over time.

## Tests

```bash
npm run verify
```

The test suite covers:

- all three strategies
- in-memory store
- Redis-like backend
- Express adapter
- Hono adapter
- per-route/per-user/per-IP keying
- forwarded IP handling
- invalid configuration
- independent requester counters

## Notes

This package does not read cookies, sessions, passwords, or external account
state. Request identity is derived only from request metadata and explicit
callbacks supplied by the application.
