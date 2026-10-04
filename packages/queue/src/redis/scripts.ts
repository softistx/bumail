/**
 * The Lua scripts a Redis store runs: each operation that writes is one
 * script, so Redis runs it whole, with no other command between its
 * steps. The fixed keys come as `KEYS`; an item's own keys are its
 * prefix (`ARGV[1]`), `item:` or `message:`, and its id.
 *
 * An item is a hash, `<prefix>item:<id>`; its message a string,
 * `<prefix>message:<id>`, written from the bytes given, as they are. Its
 * member in the sorted sets is its sequence number, sixteen digits, `:`,
 * and its id: Redis orders members of one score by their bytes, so items
 * equally due come oldest first. Times travel as the strings JavaScript
 * writes for them and are only compared here (`tonumber`), never written
 * back from Lua, so none loses a digit.
 */

/** What every script starts with. */
const PRELUDE = `
local prefix = ARGV[1]
local function itemKey(member) return prefix .. 'item:' .. string.sub(member, 18) end
local function seqOf(member) return tonumber(string.sub(member, 1, 16)) end
`;

/** A script, and the SHA-1 `EVALSHA` names it by. */
export interface Script {
	readonly source: string;
	readonly sha: string;
}

const script = (body: string): Script => {
	const source = PRELUDE + body;
	const sha = new Bun.CryptoHasher('sha1').update(source).digest('hex');
	return { source, sha };
};

/**
 * KEYS schema; ARGV prefix, version. Writes the version on a new queue;
 * returns the one found.
 */
export const SCHEMA = script(`
local found = redis.call('GET', KEYS[1])
if found then return found end
redis.call('SET', KEYS[1], ARGV[2])
return ARGV[2]
`);

/**
 * KEYS items, ready, seq; ARGV prefix, id, from, recipients, size,
 * created, message, max (or ''). `{'full', n}` when `max` items are
 * there already, else `{'ok'}`.
 */
export const ADD = script(`
local max = tonumber(ARGV[8])
if max then
	local n = redis.call('ZCARD', KEYS[1])
	if n >= max then return {'full', tostring(n)} end
end
local member = string.format('%016d', redis.call('INCR', KEYS[3])) .. ':' .. ARGV[2]
redis.call('HSET', prefix .. 'item:' .. ARGV[2], 'id', ARGV[2], 'from', ARGV[3],
	'recipients', ARGV[4], 'size', ARGV[5], 'created', ARGV[6], 'next', ARGV[6],
	'attempts', '0', 'delay', '0', 'rev', '0', 'member', member)
redis.call('SET', prefix .. 'message:' .. ARGV[2], ARGV[7])
redis.call('ZADD', KEYS[1], ARGV[6], member)
redis.call('ZADD', KEYS[2], ARGV[6], member)
return {'ok'}
`);

/**
 * KEYS ready, leases; ARGV prefix, owner, now, expiry. The earliest due,
 * then the oldest, of the items no lease holds and of those whose lease
 * expired, leased to the owner; its fields, or false. The expired leases
 * are read whole: there are only as many as the leases a crashed or
 * stalled worker left behind.
 */
export const CLAIM = script(`
local now = tonumber(ARGV[3])
local best, bestNext
local first = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[3], 'LIMIT', 0, 1)[1]
if first then
	best = first
	bestNext = tonumber(redis.call('HGET', itemKey(first), 'next'))
end
for _, member in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])) do
	local nextAt = tonumber(redis.call('HGET', itemKey(member), 'next'))
	if nextAt <= now and (best == nil or nextAt < bestNext
		or (nextAt == bestNext and seqOf(member) < seqOf(best))) then
		best = member
		bestNext = nextAt
	end
end
if best == nil then return false end
redis.call('ZREM', KEYS[1], best)
redis.call('ZADD', KEYS[2], ARGV[4], best)
redis.call('HSET', itemKey(best), 'owner', ARGV[2], 'expires', ARGV[4])
return redis.call('HGETALL', itemKey(best))
`);

/** KEYS leases; ARGV prefix, id, owner, expiry. 1 while the owner holds the lease, else 0. */
export const RENEW = script(`
local key = prefix .. 'item:' .. ARGV[2]
if redis.call('HGET', key, 'owner') ~= ARGV[3] then return 0 end
redis.call('HSET', key, 'expires', ARGV[4])
redis.call('ZADD', KEYS[1], ARGV[4], redis.call('HGET', key, 'member'))
return 1
`);

/**
 * KEYS items, ready, leases; ARGV prefix, id, owner, rev, then 'drop',
 * or 'record' and recipients, next, attempts, delay. 0 when the owner
 * does not hold the lease; -1 when another outcome was recorded since
 * the item was read at `rev`, to read it again; 1 once recorded, the
 * lease let go of, or the item and its message dropped.
 */
export const COMPLETE = script(`
local key = prefix .. 'item:' .. ARGV[2]
if redis.call('HGET', key, 'owner') ~= ARGV[3] then return 0 end
if redis.call('HGET', key, 'rev') ~= ARGV[4] then return -1 end
local member = redis.call('HGET', key, 'member')
redis.call('ZREM', KEYS[3], member)
if ARGV[5] == 'drop' then
	redis.call('ZREM', KEYS[1], member)
	redis.call('ZREM', KEYS[2], member)
	redis.call('DEL', key, prefix .. 'message:' .. ARGV[2])
	return 1
end
redis.call('HSET', key, 'recipients', ARGV[6], 'next', ARGV[7],
	'attempts', ARGV[8], 'delay', ARGV[9])
redis.call('HINCRBY', key, 'rev', 1)
redis.call('HDEL', key, 'owner', 'expires')
redis.call('ZADD', KEYS[1], ARGV[7], member)
redis.call('ZADD', KEYS[2], ARGV[7], member)
return 1
`);

/**
 * KEYS items, ready, leases; ARGV prefix, id, at, owner (or ''). With an
 * owner, only while it holds the lease, which it lets go of; without,
 * the lease stays. 1 when moved, else 0.
 */
export const RESCHEDULE = script(`
local key = prefix .. 'item:' .. ARGV[2]
local member = redis.call('HGET', key, 'member')
if not member then return 0 end
local owner = redis.call('HGET', key, 'owner')
if ARGV[4] ~= '' then
	if owner ~= ARGV[4] then return 0 end
	redis.call('HDEL', key, 'owner', 'expires')
	redis.call('ZREM', KEYS[3], member)
	owner = false
end
redis.call('HSET', key, 'next', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[3], member)
if not owner then redis.call('ZADD', KEYS[2], ARGV[3], member) end
return 1
`);

/** KEYS items, ready, leases; ARGV prefix, id. The item's fields as it stood, or false; dropped with its message. */
export const CANCEL = script(`
local key = prefix .. 'item:' .. ARGV[2]
local fields = redis.call('HGETALL', key)
if #fields == 0 then return false end
local member = redis.call('HGET', key, 'member')
redis.call('ZREM', KEYS[1], member)
redis.call('ZREM', KEYS[2], member)
redis.call('ZREM', KEYS[3], member)
redis.call('DEL', key, prefix .. 'message:' .. ARGV[2])
return fields
`);

/** KEYS items; ARGV prefix, first, last. A page of items, each its fields, in one read. */
export const LIST = script(`
local out = {}
for _, member in ipairs(redis.call('ZRANGE', KEYS[1], ARGV[2], ARGV[3])) do
	out[#out + 1] = redis.call('HGETALL', itemKey(member))
end
return out
`);
