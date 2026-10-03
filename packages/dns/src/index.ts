export { type CacheOptions, cachedResolver } from './cache/resolver';
export { DnsError, type DnsErrorCode, isTemporary } from './errors';
export {
	type FixtureError,
	type FixtureName,
	type FixtureRecords,
	type FixtureResolver,
	fixtureResolver,
} from './fixture';
export { isNullMx } from './mx';
export { normalizeName } from './name';
export type { DnsBackend, NodeResolverOptions } from './node/backend';
export { nodeResolver } from './node/resolver';
export type {
	AddressRecord,
	MxRecord,
	PtrRecord,
	RecordType,
	Resolver,
	TxtRecord,
} from './types';
