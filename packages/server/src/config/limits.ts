import type { Checker } from './checker';
import type {
	InboundConfig,
	JmapConfig,
	PortsConfig,
	SubmissionConfig,
} from './types';
import { checkHttpsUrl } from './urls';

const MiB = 1024 * 1024;
const MAX_MESSAGE_SIZE = 1024 * MiB;
const MAX_CONNECTIONS = 100_000;

/** `[inbound]`: mail from other servers, on `ports.mx`. */
export function checkInbound(checker: Checker, raw: unknown): InboundConfig {
	const table = checker.table(raw, 'inbound', [
		'dmarc',
		'maxMessageSize',
		'maxConnections',
	]);
	return {
		dmarc:
			checker.oneOf(table, 'dmarc', 'inbound', ['enforce', 'mark'] as const) ??
			'enforce',
		maxMessageSize:
			checker.integer(
				table,
				'maxMessageSize',
				'inbound',
				1,
				MAX_MESSAGE_SIZE,
			) ?? 25 * MiB,
		maxConnections:
			checker.integer(table, 'maxConnections', 'inbound', 1, MAX_CONNECTIONS) ??
			1000,
	};
}

/** `[submission]`: mail from the server's own users, on `ports.submissions` and `ports.submission`. */
export function checkSubmission(
	checker: Checker,
	raw: unknown,
): SubmissionConfig {
	const table = checker.table(raw, 'submission', [
		'maxMessageSize',
		'maxRecipients',
		'maxConnections',
	]);
	return {
		maxMessageSize:
			checker.integer(
				table,
				'maxMessageSize',
				'submission',
				1,
				MAX_MESSAGE_SIZE,
			) ?? 25 * MiB,
		maxRecipients:
			checker.integer(table, 'maxRecipients', 'submission', 1, 10_000) ?? 100,
		maxConnections:
			checker.integer(
				table,
				'maxConnections',
				'submission',
				1,
				MAX_CONNECTIONS,
			) ?? 1000,
	};
}

/**
 * `[jmap]`: `origin`, where clients reach it, an `https:` origin.
 * Default `https://<hostname>`, with `ports.https` when it is not 443.
 */
export function checkJmap(
	checker: Checker,
	raw: unknown,
	hostname: string,
	ports: PortsConfig,
): JmapConfig {
	const table = checker.table(raw, 'jmap', ['origin']);
	const value = checker.string(table, 'origin', 'jmap');
	const port =
		ports.https === 443 || ports.https === 0 ? '' : `:${ports.https}`;
	const fallback = `https://${hostname}${port}`;
	if (value === undefined) return { origin: fallback };
	return {
		origin: checkHttpsUrl(checker, value, 'jmap.origin', true) ?? fallback,
	};
}
