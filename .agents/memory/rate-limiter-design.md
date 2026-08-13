---
name: Rate-limiter design
description: How the custom post-response login rate limiter works and why express-rate-limit was replaced.
---

## Why express-rate-limit was replaced

`express-rate-limit` with `skipSuccessfulRequests: true` still increments the counter **before** the route handler runs. Once `counter >= max`, the 429 fires before credentials are checked — so even a correct password is blocked. `skipSuccessfulRequests` only prevents successful requests from adding to the count; it can't rescue a request that is already over the limit.

## Custom middleware (makeLoginLimiter in server.js)

- In-memory Map: `ip → [timestamp, …]` (failure timestamps only)
- **Pre-check**: if `failureCount(ip) >= max` → 429 with `Retry-After` header
- **Post-response** (`res.on('finish')`): if `statusCode >= 400` push timestamp; if `statusCode < 400` (success) delete IP entry → resets counter
- Each `makeLoginLimiter()` call creates an independent closure with its own Map → owner and driver endpoints share no state

## Behaviour guarantees

- A correct password never increments the counter
- A successful login resets the counter for that IP (so a user with MAX-1 failures who then provides the correct password can log in without waiting for the window)
- Once the counter hits MAX, the IP is blocked until the window expires (even correct passwords are blocked at that point — pre-check fires before credentials are checked)
- Owner and driver limiters have completely separate stores

## Configuration (env vars, read at server startup)

- `LOGIN_RATE_WINDOW_MS` — window length in ms (default: 900000 = 15 min)
- `LOGIN_RATE_MAX` — max failures before block (default: 10)

## Test runner requirements

- Server and test process must use the same `LOGIN_RATE_MAX` and `LOGIN_RATE_WINDOW_MS`
- Section order: Functionality → Security → Rate-limiter → sleep(WINDOW+500) → Brute-force
- Rate-limiter and brute-force sections exhaust the bucket; the window sleep between them resets it
- A `sleep(WINDOW+300)` is also added inside the rate-limiter section before the driver sub-tests to clear failures accumulated in Functionality/Security
- **Why:** all loopback requests share the same IP, so failures accumulate across sections
