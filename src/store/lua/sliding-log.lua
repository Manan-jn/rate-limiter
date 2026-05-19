-- Sliding Window Log (exact, O(N) space per tenant)
-- KEYS[1]: sorted set key (rl:swl:{tenantId}:{route})
-- ARGV[1]: nowMs
-- ARGV[2]: windowMs
-- ARGV[3]: limit
-- Returns: {allowed (1/0), remaining, resetInMs}

local key      = KEYS[1]
local nowMs    = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local cutoff   = nowMs - windowMs

-- Evict entries older than the window
redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count = redis.call('ZCARD', key)

if count >= limit then
  local oldest = tonumber(redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2])
  local resetInMs = oldest and (oldest + windowMs - nowMs) or windowMs
  return {0, 0, math.max(0, resetInMs)}
end

-- Use a per-key sequence counter to guarantee unique members at the same timestamp.
-- Without this, concurrent requests at the same ms deduplicate in the ZSet.
local seqKey = key .. ':seq'
local seq = redis.call('INCR', seqKey)
redis.call('PEXPIRE', seqKey, windowMs * 2)
local member = nowMs .. ':' .. seq
redis.call('ZADD', key, nowMs, member)
redis.call('PEXPIRE', key, windowMs)
return {1, limit - count - 1, 0}
