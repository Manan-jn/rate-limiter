-- Sliding Window Counter (approximate, O(1) space)
-- KEYS[1]: previous window key
-- KEYS[2]: current window key
-- ARGV[1]: limit
-- ARGV[2]: windowMs
-- ARGV[3]: nowMs (from Redis TIME — never Date.now())
-- Returns: {allowed (1/0), remaining, resetInMs}

local prevKey   = KEYS[1]
local curKey    = KEYS[2]
local limit     = tonumber(ARGV[1])
local windowMs  = tonumber(ARGV[2])
local nowMs     = tonumber(ARGV[3])

local prevCount = tonumber(redis.call('GET', prevKey)) or 0
local curCount  = tonumber(redis.call('GET', curKey)) or 0

local elapsed   = nowMs % windowMs
local weight    = (windowMs - elapsed) / windowMs
local estimated = prevCount * weight + curCount

if estimated >= limit then
  local resetInMs = windowMs - elapsed
  return {0, 0, resetInMs}
end

redis.call('INCR', curKey)
redis.call('PEXPIRE', curKey, windowMs * 2)
return {1, math.floor(limit - estimated - 1), 0}
