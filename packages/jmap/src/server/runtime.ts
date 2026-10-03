import { Uploads } from '../blob/uploads';
import { Concurrency } from '../http/concurrency';
import type { Settings } from './settings';

/** What one `jmap()` keeps while it serves: uploads, and requests in flight per account. */
export interface Runtime {
	readonly settings: Settings;
	readonly uploads: Uploads;
	readonly requests: Concurrency;
	readonly uploading: Concurrency;
}

export function runtimeOf(settings: Settings): Runtime {
	const { limits } = settings;
	return {
		settings,
		uploads: new Uploads(limits.uploadTtl, limits.uploadQuota),
		requests: new Concurrency(limits.maxConcurrentRequests),
		uploading: new Concurrency(limits.maxConcurrentUpload),
	};
}
