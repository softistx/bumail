import type { Checker, Table } from './checker';
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

/** The most the spool may hold: 1 TiB. */
const MAX_SPOOL_BYTES = 1024 * 1024 * MiB;

/** How many of `maxMessageSize` the spool holds at most, by default. */
export const SPOOL_BUDGET_MESSAGES = 20;

/**
 * `[inbound]`: mail from other servers, on `ports.mx`. `spoolBytes`, what
 * the messages waiting to be checked may hold on disk at once, is at
 * least `maxMessageSize`; default 20 times it.
 */
export function checkInbound(checker: Checker, raw: unknown): InboundConfig {
	const table = checker.table(raw, 'inbound', [
		'dmarc',
		'maxMessageSize',
		'maxConnections',
		'maxConnectionsPerClient',
		'spoolBytes',
	]);
	const maxMessageSize =
		checker.integer(table, 'maxMessageSize', 'inbound', 1, MAX_MESSAGE_SIZE) ??
		25 * MiB;
	let spoolBytes = checker.integer(
		table,
		'spoolBytes',
		'inbound',
		1,
		MAX_SPOOL_BYTES,
	);
	if (spoolBytes !== undefined && spoolBytes < maxMessageSize) {
		checker.add(
			'inbound.spoolBytes',
			`must be at least inbound.maxMessageSize (${maxMessageSize})`,
		);
		spoolBytes = undefined;
	}
	return {
		dmarc:
			checker.oneOf(table, 'dmarc', 'inbound', ['enforce', 'mark'] as const) ??
			'enforce',
		maxMessageSize,
		maxConnections:
			checker.integer(table, 'maxConnections', 'inbound', 1, MAX_CONNECTIONS) ??
			1000,
		maxConnectionsPerClient: perClient(checker, table, 'inbound'),
		spoolBytes: spoolBytes ?? SPOOL_BUDGET_MESSAGES * maxMessageSize,
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
		'maxConnectionsPerClient',
		'handshakeTimeout',
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
		maxConnectionsPerClient: perClient(checker, table, 'submission'),
		handshakeTimeout:
			checker.integer(table, 'handshakeTimeout', 'submission', 1, 300) ?? 10,
	};
}

/** `maxConnectionsPerClient`: from 1 to `MAX_CONNECTIONS`, default 10. */
function perClient(
	checker: Checker,
	table: Table | undefined,
	section: string,
): number {
	return (
		checker.integer(
			table,
			'maxConnectionsPerClient',
			section,
			1,
			MAX_CONNECTIONS,
		) ?? 10
	);
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
