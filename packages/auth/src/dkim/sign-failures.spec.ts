import { describe, expect, test } from 'bun:test';
import { MimeError } from '@bumail/mime';
import { AuthError } from '../errors';
import { keyPair, unsigned } from './dkim.fixtures';
import { signDkim } from './sign';

async function refusal(promise: Promise<unknown>): Promise<AuthError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AuthError) return error;
		throw error;
	}
	throw new Error('expected an AuthError');
}

/** A stream that hands over `text`, then fails with "connection reset". */
function failingAfter(text: string): ReadableStream<Uint8Array> {
	let sent = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent) controller.error(new Error('connection reset'));
			else controller.enqueue(new TextEncoder().encode(text));
			sent = true;
		},
	});
}

describe('signDkim: what it cannot read or write is an AuthError', () => {
	test('a field @bumail/mime cannot fold is INVALID_OPTION, the MimeError kept as cause', async () => {
		const { privateKey } = await keyPair('ed25519-sha256');
		const error = await refusal(
			signDkim(unsigned(), {
				domain: 'example.com',
				selector: 'sel',
				privateKey,
				headers: ['from', `x-${'a'.repeat(1000)}`],
			}),
		);
		expect(error.code).toBe('INVALID_OPTION');
		expect(error.message).toBe(
			'signDkim(): the DKIM-Signature field cannot be written: The value of DKIM-Signature holds a word too long for a header line (RFC 5322 §2.1.1: 998)',
		);
		expect(error.cause).toBeInstanceOf(MimeError);
	});

	test('a stream that fails in the header or in the body is INVALID_MESSAGE, its error kept as cause', async () => {
		const { privateKey } = await keyPair('ed25519-sha256');
		const options = { domain: 'example.com', selector: 'sel', privateKey };
		const message = unsigned();
		for (const cut of [
			message.indexOf('Subject'),
			message.indexOf('Hi.') + 2,
		]) {
			const error = await refusal(
				signDkim(failingAfter(message.slice(0, cut)), options),
			);
			expect(error.code).toBe('INVALID_MESSAGE');
			expect(error.message).toBe(
				'signDkim(): the message could not be read: Error: connection reset',
			);
			expect((error.cause as Error).message).toBe('connection reset');
		}
	});
});
