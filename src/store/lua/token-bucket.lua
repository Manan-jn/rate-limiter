-- Token Bucket
-- KEYS[1]: hash key (rl:tb:{tenantId}:{route})
-- ARGV[1]: nowMs (Redis server time in ms)
-- ARGV[2]: rateMs (tokens per millisecond, e.g. 10/s = 0.01)
-- ARGV[3]: burst (max token capacity)
-- ARGV[4]: cost (tokens consumed per request, usually 1)
-- Returns: {allowed (1/0), remaining_tokens_floor, retryAfterMs}

local key   = KEYS[1]
local nowMs = tonumber(ARGV[1])
local rateMs = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost  = tonumber(ARGV[4])

local data  = redis.call('HMGET', key, 'tokens', 'last')
local tokens = tonumber(data[1]) or burst
local last   = tonumber(data[2]) or nowMs

-- Refill based on elapsed time, capped at burst
tokens = math.min(burst, tokens + (nowMs - last) * rateMs)

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', key, 'tokens', tokens, 'last', nowMs)
  redis.call('PEXPIRE', key, math.ceil(burst / rateMs * 2))
  return {1, math.floor(tokens), 0}
else
  local retryMs = math.ceil((cost - tokens) / rateMs)
  redis.call('HMSET', key, 'tokens', tokens, 'last', nowMs)
  redis.call('PEXPIRE', key, math.ceil(burst / rateMs * 2))
  return {0, 0, retryMs}
end
