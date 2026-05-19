-- Fixed Window Counter
-- KEYS[1]: window key (rl:fw:{tenantId}:{route}:{windowTs})
-- ARGV[1]: limit (integer)
-- ARGV[2]: window size in seconds
-- Returns: {allowed (1/0), remaining, ttl_seconds}

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, window)
end
local ttl = redis.call('TTL', key)

if count > limit then
  return {0, 0, ttl}
end
return {1, limit - count, ttl}
