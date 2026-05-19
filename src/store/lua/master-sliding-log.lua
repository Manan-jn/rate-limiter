-- Master Sliding Window Log — denylist + allowlist + TIME + algorithm in one RTT
-- KEYS[1]: denylist, KEYS[2]: allowlist, KEYS[3]: ZSet key, KEYS[4]: seq key
-- ARGV[1]: clientKey, ARGV[2]: windowMs, ARGV[3]: limit

local clientKey = ARGV[1]
local windowMs  = tonumber(ARGV[2])
local limit     = tonumber(ARGV[3])

if redis.call('SISMEMBER', KEYS[1], clientKey) == 1 then return {'denied', 0, 0} end
if redis.call('SISMEMBER', KEYS[2], clientKey) == 1 then return {'allowed', 0, 0} end

local t     = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cutoff = nowMs - windowMs

redis.call('ZREMRANGEBYSCORE', KEYS[3], 0, cutoff)
local count = redis.call('ZCARD', KEYS[3])

if count >= limit then
  local oldest = tonumber(redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')[2])
  local resetInMs = oldest and (oldest + windowMs - nowMs) or windowMs
  return {'limited', 0, math.max(0, resetInMs)}
end

local seq    = redis.call('INCR', KEYS[4])
local member = nowMs .. ':' .. seq
redis.call('PEXPIRE', KEYS[4], windowMs * 2)
redis.call('ZADD', KEYS[3], nowMs, member)
redis.call('PEXPIRE', KEYS[3], windowMs)
return {'ok', limit - count - 1, 0}
