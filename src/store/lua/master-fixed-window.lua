-- Master Fixed Window script — denylist + allowlist + TIME + algorithm in one RTT
-- KEYS[1]: denylist set
-- KEYS[2]: allowlist set
-- KEYS[3]: window counter key
-- ARGV[1]: clientKey
-- ARGV[2]: limit
-- ARGV[3]: windowSec

local clientKey = ARGV[1]
local limit     = tonumber(ARGV[2])
local windowSec = tonumber(ARGV[3])

if redis.call('SISMEMBER', KEYS[1], clientKey) == 1 then return {'denied', 0, 0} end
if redis.call('SISMEMBER', KEYS[2], clientKey) == 1 then return {'allowed', 0, 0} end

local count = redis.call('INCR', KEYS[3])
if count == 1 then redis.call('EXPIRE', KEYS[3], windowSec) end
local ttl = redis.call('TTL', KEYS[3])

if count > limit then return {'limited', 0, ttl} end
return {'ok', limit - count, ttl}
