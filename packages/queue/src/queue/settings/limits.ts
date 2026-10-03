import type { QueueOptions } from '../options';
import { HOUR, MINUTE, numberOf } from './numbers';

export interface RetrySettings {
	readonly first: number;
	readonly factor: number;
	readonly max: number;
	readonly jitter: number;
	readonly giveUpAfter: number;
}

export interface LimitSettings {
	readonly maxMessageSize: number;
	readonly maxRecipients: number;
	readonly maxItems: number | undefined;
	readonly maxReplyText: number;
	readonly maxDsnReturn: number;
}

export function retryOf(options: QueueOptions): RetrySettings {
	const r = options.retry ?? {};
	const first = numberOf('retry.first', r.first, 30 * MINUTE, 1);
	return {
		first,
		factor: numberOf('retry.factor', r.factor, 2, 1, 100, false),
		max: numberOf('retry.max', r.max, Math.max(first, 4 * HOUR), first),
		jitter: numberOf('retry.jitter', r.jitter, 0.1, 0, 1, false),
		giveUpAfter: numberOf('retry.giveUpAfter', r.giveUpAfter, 120 * HOUR, 0),
	};
}

export function limitsOf(options: QueueOptions): LimitSettings {
	const l = options.limits ?? {};
	return {
		maxMessageSize: numberOf(
			'limits.maxMessageSize',
			l.maxMessageSize,
			25 * 1024 * 1024,
			1,
		),
		maxRecipients: numberOf('limits.maxRecipients', l.maxRecipients, 100, 1),
		maxItems:
			l.maxItems === undefined
				? undefined
				: numberOf('limits.maxItems', l.maxItems, 0, 1),
		maxReplyText: numberOf('limits.maxReplyText', l.maxReplyText, 512, 64, 900),
		maxDsnReturn: numberOf('limits.maxDsnReturn', l.maxDsnReturn, 64 * 1024, 0),
	};
}
