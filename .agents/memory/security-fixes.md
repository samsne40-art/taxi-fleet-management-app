---
name: Security fixes
description: What was changed, why, and non-obvious constraints for future work.
---

# Security fixes applied

## Rate limiter — test ordering constraint
`express-rate-limit` uses in-memory state (cleared on server restart). When running combined security + functionality tests:
- Brute-force section MUST run LAST, after all functionality login calls.
- Functionality tests MUST use unique phone/plate/taxi values per run (use `Date.now()` suffix) so re-runs don't collide on UNIQUE constraints.
- The rate limiter is configured with `skipSuccessfulRequests: true` so correct-password logins don't count toward the limit.
- Each endpoint (`/api/owner/login`, `/api/driver/login`) gets its own limiter instance via `makeLoginLimiter()` factory — they do NOT share state.

**Why:** Shared limiter instance + same IP exhausts the limit across endpoints. `skipSuccessfulRequests: true` prevents legitimate users from being locked out by their own correct credentials.

## Socket.io authentication — engine-level middleware
Authentication is enforced at the Engine.IO level (`io.engine.use()`), not just `io.use()`. This is required because the polling transport returns HTTP 200 on the initial handshake BEFORE `io.use()` can fire. Only `io.engine.use()` can block the HTTP handshake response.

```js
io.engine.use((req, res, next) => {
  const isHandshake = req._query.sid === undefined;
  if (!isHandshake) return next();
  sessionMiddleware(req, res, () => {
    if (req.session?.userId) return next();
    res.writeHead(401, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  });
});
```

**Why:** `io.use()` alone would still return HTTP 200 on the polling handshake, allowing the socket to be created before the auth rejection is sent.

## Room join guard — session identity
`join_owner_room` and `join_driver_room` compare the requested ID against `socket.request.session.{userId, role}`. Silently ignore wrong-role or wrong-ID joins (no error emitted — don't confirm room names exist).

## CORS — ALLOWED_ORIGINS env var
`origin: true` (reflect any origin) was replaced with an explicit allowlist from `ALLOWED_ORIGINS` env var. If unset, cross-origin is blocked (`origin: false`). This applies to both Express cors() and Socket.io Server constructor.

## Helmet
`contentSecurityPolicy: false` and `crossOriginEmbedderPolicy: false` are disabled because the frontends use inline `<script>` tags and styles. All other Helmet headers are active.

## SOS resolve — ownership check
Fix: `WHERE id = ? AND driver_id IN (SELECT id FROM drivers WHERE owner_id = ?)`. Returns 404 (not 403) when the SOS doesn't belong to the owner — consistent with other resource-not-found responses.

## Driver assign — dual ownership check
1. `WHERE id = ? AND owner_id = ?` on the driver SELECT (returns 404 if not theirs).
2. `WHERE id = ? AND owner_id = ?` on the taxi SELECT if taxi_id provided (returns 403 if not theirs).
3. UPDATE also includes `AND owner_id = ?` as belt-and-suspenders.

## Messaging IDOR
`SELECT id FROM drivers WHERE id = ? AND owner_id = ?` before INSERT. Returns 403.

## Error leakage
`e.message` in 500 responses replaced with generic messages. Raw `e` logged server-side with `console.error('[context]', e)`.

## Uniform auth error
Driver login: "no driver registered" and "wrong password" both return `'Incorrect phone number or password.'`. The "no password set" path also uses the same message.
