import {
	checkDmarc,
	checkSpf,
	type DkimResult,
	type DmarcResult,
	formatAuthenticationResults,
	type SpfResult,
	verifyDkim,
} from '@bumail/auth';
import type { Resolver } from '@bumail/dns';
import type { InboundConfig } from '../config/types';

/** Milliseconds DKIM, SPF and DMARC each have, at most. */
export const CHECK_TIMEOUT_MS = 10_000;

/** What the sender's checks say, and what the server does with the message. */
export interface Verdict {
	readonly dkim: readonly DkimResult[];
	readonly spf: SpfResult | undefined;
	readonly dmarc: DmarcResult;
	/** The `Authentication-Results` field to put on top, CRLF included. */
	readonly field: string;
	/**
	 * `deliver` to INBOX, `junk` to Junk (`p=quarantine`, enforced),
	 * `reject` with 550 (`p=reject`, enforced), `defer` with 451 (DMARC
	 * could not be had, enforced).
	 */
	readonly action: 'deliver' | 'junk' | 'reject' | 'defer';
}

/** The client and envelope SPF checks: who connected, what they said. */
export interface SpfInput {
	readonly ip: string;
	readonly mailFrom: string;
	readonly helo: string;
}

/**
 * SPF for MAIL FROM (or, for a bounce, the HELO name) — begun at MAIL
 * FROM and awaited at the end of DATA. Never rejects: an address the
 * check cannot take, such as no IP at all, is no check.
 */
export function startSpf(
	input: SpfInput,
	resolver: Resolver,
): Promise<SpfResult | undefined> {
	return checkSpf(input, { resolver, timeout: CHECK_TIMEOUT_MS }).catch(
		() => undefined,
	);
}

/** What DKIM answers when it did not finish within its deadline. */
export const DKIM_TIMED_OUT: DkimResult = {
	result: 'temperror',
	reason: 'DKIM verification did not finish in time',
	testing: false,
};

/** What DKIM answers when the message could not be read back. */
function unreadable(error: unknown): DkimResult {
	const reason = error instanceof Error ? error.message : String(error);
	return {
		result: 'temperror',
		reason: `the message could not be read: ${reason}`,
		testing: false,
	};
}

/**
 * `source` as it is, and whether reading it failed: a failure of this
 * server's disk, not of the message.
 */
function watched(source: ReadableStream<Uint8Array>): {
	readonly stream: ReadableStream<Uint8Array>;
	failed(): boolean;
} {
	let failed = false;
	let cancelled = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			reader ??= source.getReader();
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (error) {
				// Only a read that fails is the disk's failure; a reader
				// that stopped early (an unsigned message, or one with no
				// signature that can be checked) is not.
				if (cancelled) return;
				failed = true;
				controller.error(error);
				return;
			}
			if (cancelled) return;
			if (chunk.done) controller.close();
			else controller.enqueue(chunk.value);
		},
		async cancel(reason) {
			cancelled = true;
			await (reader ?? source).cancel(reason);
		},
	});
	return { stream, failed: () => failed };
}

/**
 * DKIM over the message `whole` gives, given up after `ms` as one
 * `temperror`; `unread` when the message could not be read back.
 */
async function dkimOf(
	whole: () => ReadableStream<Uint8Array>,
	resolver: Resolver,
	ms: number,
): Promise<{
	dkim: readonly DkimResult[];
	timedOut: boolean;
	unread: boolean;
}> {
	let source: ReturnType<typeof watched>;
	try {
		source = watched(whole());
	} catch (error) {
		return { dkim: [unreadable(error)], timedOut: false, unread: true };
	}
	const { dkim, timedOut } = await dkimWithin(source.stream, resolver, ms);
	return { dkim, timedOut, unread: source.failed() };
}

/** DKIM over `message`, given up after `ms` as one `temperror`. */
async function dkimWithin(
	message: ReadableStream<Uint8Array>,
	resolver: Resolver,
	ms: number,
): Promise<{ dkim: readonly DkimResult[]; timedOut: boolean }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<'late'>((resolve) => {
		timer = setTimeout(() => resolve('late'), ms);
	});
	try {
		const verified = verifyDkim(message, { resolver });
		const first = await Promise.race([verified, late]);
		if (first !== 'late') return { dkim: first, timedOut: false };
		// What it still reads and looks up ends on its own, bounded by the
		// DNS; the stream is verifyDkim's, locked to its reader.
		void verified.catch(() => {});
		return { dkim: [DKIM_TIMED_OUT], timedOut: true };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * DKIM over the whole message, then DMARC over its header, with the SPF
 * result; and what `inbound.dmarc` makes of them. `enforce` refuses
 * `p=reject` and sends `p=quarantine` to Junk; `mark` only records.
 * DKIM, SPF and DMARC each have `timeoutMs` (default 10 s); a DKIM that
 * ran out, or could not read the message back (`whole` throwing, or its
 * stream failing), defers, under `enforce`, what DMARC would otherwise
 * refuse or quarantine, since a signature that would have passed may be
 * among the ones not checked. `spfIdentity` is `helo` for a bounce, whose SPF was
 * checked for the HELO name: `Authentication-Results` says
 * `smtp.helo=`, while DMARC is given it as RFC 7489 §3.1.2 counts it.
 */
export async function judge(
	message: {
		readonly header: Uint8Array;
		readonly whole: () => ReadableStream<Uint8Array>;
	},
	spf: SpfResult | undefined,
	options: {
		readonly hostname: string;
		readonly resolver: Resolver;
		readonly mode: InboundConfig['dmarc'];
		readonly spfIdentity?: 'mailfrom' | 'helo';
		readonly timeoutMs?: number;
	},
): Promise<Verdict> {
	const { resolver } = options;
	const timeout = options.timeoutMs ?? CHECK_TIMEOUT_MS;
	const { dkim, timedOut, unread } = await dkimOf(
		message.whole,
		resolver,
		timeout,
	);
	// checkSpf checks a bounce's HELO name as its MAIL FROM, which DMARC aligns.
	const forDmarc =
		spf === undefined
			? undefined
			: { result: spf, identity: 'mailfrom' as const };
	const forField =
		spf === undefined
			? undefined
			: { result: spf, identity: options.spfIdentity ?? ('mailfrom' as const) };
	// The fields, then the blank line that ends them: DMARC reads From alone.
	const header = new Uint8Array(message.header.length + 2);
	header.set(message.header);
	header.set([0x0d, 0x0a], message.header.length);
	const dmarc = await checkDmarc(
		{
			message: header,
			dkim,
			...(forDmarc === undefined ? {} : { spf: forDmarc }),
		},
		{ resolver, timeout },
	);
	const field = formatAuthenticationResults(options.hostname, {
		dkim,
		...(forField === undefined ? {} : { spf: forField }),
		dmarc,
	});
	// A signature not checked — out of time, or the message unreadable
	// here — might have passed: never a refusal for this server's failure.
	const action = actionOf(dmarc, options.mode, timedOut || unread);
	return { dkim, spf, dmarc, field, action };
}

function actionOf(
	dmarc: DmarcResult,
	mode: InboundConfig['dmarc'],
	dkimUnchecked: boolean,
): Verdict['action'] {
	if (mode === 'mark') return 'deliver';
	if (dmarc.result === 'temperror') return 'defer';
	if (dkimUnchecked && dmarc.disposition !== 'none') return 'defer';
	if (dmarc.disposition === 'reject') return 'reject';
	if (dmarc.disposition === 'quarantine') return 'junk';
	return 'deliver';
}
