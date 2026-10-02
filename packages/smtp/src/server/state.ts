import type { Envelope } from './options';

/** A mail transaction in progress (RFC 5321 §3.3). */
export interface Transaction {
	from?: string;
	to: string[];
	smtputf8: boolean;
	body: Envelope['body'];
}

/** What the next line from the client is. */
export type Waiting =
	| 'command'
	| 'data'
	| 'auth-plain'
	| 'auth-login-user'
	| 'auth-login-password';

/** The state of a session the commands change. */
export interface State {
	helo?: string | undefined;
	esmtp: boolean;
	user?: string | undefined;
	secure: boolean;
	transaction: Transaction;
	waiting: Waiting;
	loginUser?: string | undefined;
	errors: number;
	authFailures: number;
}

export const emptyTransaction = (): Transaction => ({
	to: [],
	smtputf8: false,
	body: '7BIT',
});
