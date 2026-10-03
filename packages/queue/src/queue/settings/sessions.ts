import { invalid } from '../../errors';
import type { QueueOptions } from '../options';
import { MAX_TIMER, numberOf } from './numbers';

/** The longest wait `sendMail` takes, in seconds: its timer's own limit. */
const MAX_SECONDS = Math.floor(MAX_TIMER / 1000);

function checkSeconds(name: string, value: unknown): void {
	if (value === undefined) return;
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > MAX_SECONDS
	) {
		throw invalid(
			`${name} must be a number of seconds above 0 and at most ${MAX_SECONDS}, not ${value}`,
		);
	}
}

export function checkTls(name: string, tls: unknown): void {
	if (
		tls !== undefined &&
		tls !== 'opportunistic' &&
		tls !== 'required' &&
		tls !== 'none'
	) {
		throw invalid(
			`${name} must be 'opportunistic', 'required' or 'none', not ${tls}`,
		);
	}
}

/** What every session takes, whatever its route: the MX port and TLS, the timeouts. */
export function checkSessions(options: QueueOptions): void {
	numberOf('mxPort', options.mxPort, 25, 1, 65535);
	checkTls('mxTls', options.mxTls);
	const timeouts = options.timeouts;
	if (timeouts !== undefined) {
		if (typeof timeouts !== 'object' || timeouts === null) {
			throw invalid('timeouts must be an object of seconds');
		}
		for (const [step, value] of Object.entries(timeouts)) {
			checkSeconds(`timeouts.${step}`, value);
		}
	}
	checkSeconds('deadline', options.deadline);
}
