/**
 * The demo's settings, from the environment, with defaults that run on a
 * laptop: everything on 127.0.0.1, the store in a fresh temporary
 * directory, the smarthost a local Mailpit.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DOMAIN = 'example.test';
export const HOSTNAME = 'localhost';
export const USER = 'alice';
export const ADDRESS = `${USER}@${DOMAIN}`;
/**
 * Where `RCPT TO:<postmaster>` goes (RFC 5321 §4.5.1): `@bumail/smtp`
 * hands it over as the recipient `'postmaster'`, with no domain, and the
 * demo's one user reads it.
 */
export const POSTMASTER = ADDRESS;

/** A recipient as delivered: the bare `postmaster` to its mailbox, the rest as given. */
export function routed(recipient: string): string {
	return recipient === 'postmaster' ? POSTMASTER : recipient;
}
export const DKIM_SELECTOR = 'demo';

export interface DemoConfig {
	/** The address every server binds. */
	readonly bind: string;
	readonly ports: {
		readonly mx: number;
		readonly submission: number;
		readonly imap: number;
		readonly imaps: number;
	};
	readonly smarthost: { readonly host: string; readonly port: number };
	/** Where the sqlite store lives. */
	readonly directory: string;
	/** Whether `directory` was made for this run, and goes when it stops. */
	readonly temporary: boolean;
	/** Alice's password, for IMAP and submission. */
	readonly password: string;
}

function env(name: string): string | undefined {
	const value = Bun.env[name];
	return value === undefined || value === '' ? undefined : value;
}

function port(name: string, fallback: number): number {
	const value = Number(env(name) ?? fallback);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`${name} must be a port number, not ${env(name)}`);
	}
	return value;
}

export function readConfig(): DemoConfig {
	const given = env('DEMO_DIR');
	return {
		bind: env('DEMO_BIND') ?? '127.0.0.1',
		ports: {
			mx: port('DEMO_MX_PORT', 2525),
			submission: port('DEMO_SUBMISSION_PORT', 2587),
			imap: port('DEMO_IMAP_PORT', 1143),
			imaps: port('DEMO_IMAPS_PORT', 1993),
		},
		smarthost: {
			host: env('SMARTHOST_HOST') ?? 'localhost',
			port: port('SMARTHOST_PORT', 1025),
		},
		directory: given ?? mkdtempSync(join(tmpdir(), 'bumail-demo-')),
		temporary: given === undefined,
		password:
			env('DEMO_PASSWORD') ??
			crypto.randomUUID().replaceAll('-', '').slice(0, 16),
	};
}
