-- Master Token Bucket — denylist + allowlist + TIME + algorithm in one RTT
-- KEYS[1]: denylist, KEYS[2]: allowlist, KEYS[3]: bucket hash
-- ARGV[1]: clientKey, ARGV[2]: rateMs, ARGV[3]: burst, ARGV[4]: cost

local clientKey = ARGV[1]
local rateMs    = tonumber(ARGV[2])
local burst     = tonumber(ARGV[3])
local cost      = tonumber(ARGV[4])

if redis.call('SISMEMBER', KEYS[1], clientKey) == 1 then return {'denied', 0, 0} end
if redis.call('SISMEMBER', KEYS[2], clientKey) == 1 then return {'allowed', 0, 0} end

local t     = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data   = redis.call('HMGET', KEYS[3], 'tokens', 'last')
local tokens = tonumber(data[1]) or burst
local last   = tonumber(data[2]) or nowMs

tokens = math.min(burst, tokens + (nowMs - last) * rateMs)

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', KEYS[3], 'tokens', tokens, 'last', nowMs)
  redis.call('PEXPIRE', KEYS[3], math.ceil(burst / rateMs * 2))
  return {'ok', math.floor(tokens), 0}
else
  local retryMs = math.ceil((cost - tokens) / rateMs)
  redis.call('HMSET', KEYS[3], 'tokens', tokens, 'last', nowMs)
  redis.call('PEXPIRE', KEYS[3], math.ceil(burst / rateMs * 2))
  return {'limited', 0, retryMs}
end
