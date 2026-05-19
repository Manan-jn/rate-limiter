-- Master Sliding Window Counter script
-- Collapses denylist check + allowlist check + TIME + rate-limit into ONE Redis round-trip.
--
-- KEYS[1]: denylist set     (rl:deny:{tenantId})
-- KEYS[2]: allowlist set    (rl:allow:{tenantId})
-- KEYS[3]: prev window key  (rl:swc:{tenantId}:{route}:{clientKey}:{prevWindow})
-- KEYS[4]: cur window key   (rl:swc:{tenantId}:{route}:{clientKey}:{curWindow})
--
-- ARGV[1]: clientKey
-- ARGV[2]: limit
-- ARGV[3]: windowMs
--
-- Returns: {status, remaining, resetInMs}
--   status: "denied" | "allowed" | "ok" | "limited"

local clientKey = ARGV[1]
local limit     = tonumber(ARGV[2])
local windowMs  = tonumber(ARGV[3])

-- 1. Denylist check
if redis.call('SISMEMBER', KEYS[1], clientKey) == 1 then
  return {'denied', 0, 0}
end

-- 2. Allowlist check
if redis.call('SISMEMBER', KEYS[2], clientKey) == 1 then
  return {'allowed', 0, 0}
end

-- 3. Get Redis server time (avoids separate TIME round-trip)
local t     = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- 4. Sliding window counter logic
local prevCount = tonumber(redis.call('GET', KEYS[3])) or 0
local curCount  = tonumber(redis.call('GET', KEYS[4])) or 0
local elapsed   = nowMs % windowMs
local weight    = (windowMs - elapsed) / windowMs
local estimated = prevCount * weight + curCount

if estimated >= limit then
  local resetInMs = windowMs - elapsed
  return {'limited', 0, resetInMs}
end

redis.call('INCR', KEYS[4])
redis.call('PEXPIRE', KEYS[4], windowMs * 2)
return {'ok', math.floor(limit - estimated - 1), 0}
