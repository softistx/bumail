import { sync } from '../mailbox/sync';
import { capabilities } from '../server/capabilities';
import {
	ANY,
	AUTHENTICATED,
	bad,
	type Command,
	NOT_AUTHENTICATED,
	ok,
} from './context';

/** CAPABILITY (RFC 9051 §6.1.1). */
export const CAPABILITY: Command = {
	phases: ANY,
	bare: true,
	async run(context) {
		await context.connection.untagged(
			`CAPABILITY ${capabilities(context.connection).join(' ')}`,
		);
		await ok(context, 'CAPABILITY completed');
	},
};

/** NOOP (§6.1.2): in the selected state, what changed in the store is told. */
export const NOOP: Command = {
	phases: ANY,
	bare: true,
	async run(context) {
		if (context.connection.state.phase === 'selected')
			await sync(context.connection);
		await ok(context, `${context.name} completed`);
	},
};

/** LOGOUT (§6.1.3). */
export const LOGOUT: Command = {
	phases: ANY,
	bare: true,
	async run(context) {
		const { connection } = context;
		await connection.untagged('BYE Logging out');
		await ok(context, 'LOGOUT completed');
		await connection.close();
	},
};

/**
 * STARTTLS (§6.2.1). Whatever the client sent in clear behind it is
 * dropped, never run, and the session starts TLS as it was: not logged in.
 */
export const STARTTLS: Command = {
	phases: NOT_AUTHENTICATED,
	bare: true,
	async run(context) {
		const { connection } = context;
		if (connection.state.secure) return bad(context, 'TLS is already on');
		await ok(context, 'Begin TLS negotiation now');
		await connection.transport.drained();
		connection.input.ignore();
		connection.transport.startTls();
		connection.state.secure = true;
		connection.input.accept();
	},
};

/**
 * ENABLE (RFC 5161, RFC 9051 §6.3.1): IMAP4rev2 is turned on; anything
 * else, CONDSTORE included, is left off and not listed in ENABLED.
 */
export const ENABLE: Command = {
	phases: ['authenticated'],
	async run(context) {
		const { connection, cursor } = context;
		const enabled: string[] = [];
		do {
			const name = cursor.atom('a capability').toUpperCase();
			if (name === 'IMAP4REV2' && !enabled.includes('IMAP4rev2')) {
				connection.state.rev2 = true;
				enabled.push('IMAP4rev2');
			}
		} while (cursor.take(' '));
		cursor.end();
		await connection.untagged(['ENABLED', ...enabled].join(' '));
		await ok(context, 'ENABLE completed');
	},
};

/** NAMESPACE (RFC 2342, RFC 9051 §6.3.10): one personal namespace, `/` between levels. */
export const NAMESPACE: Command = {
	phases: AUTHENTICATED,
	bare: true,
	async run(context) {
		await context.connection.untagged('NAMESPACE (("" "/")) NIL NIL');
		await ok(context, 'NAMESPACE completed');
	},
};
