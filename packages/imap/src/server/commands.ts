import { APPEND } from '../commands/append';
import type { Command } from '../commands/context';
import { COPY, MOVE } from '../commands/copy';
import { EXPUNGE, UID_EXPUNGE } from '../commands/expunge';
import { FETCH } from '../commands/fetch';
import { IDLE } from '../commands/idle';
import { LIST, LSUB } from '../commands/list';
import { AUTHENTICATE, LOGIN } from '../commands/login';
import {
	CREATE,
	DELETE,
	RENAME,
	SUBSCRIBE,
	UNSUBSCRIBE,
} from '../commands/manage';
import { SEARCH } from '../commands/search';
import { CLOSE, EXAMINE, SELECT, UNSELECT } from '../commands/select';
import {
	CAPABILITY,
	ENABLE,
	LOGOUT,
	NAMESPACE,
	NOOP,
	STARTTLS,
} from '../commands/session';
import { STATUS } from '../commands/status';
import { STORE } from '../commands/store';

/** Every command, by name (RFC 9051 §6). CHECK and LSUB are IMAP4rev1's. */
export const COMMANDS: Readonly<Record<string, Command>> = {
	CAPABILITY,
	NOOP,
	CHECK: NOOP,
	LOGOUT,
	STARTTLS,
	LOGIN,
	AUTHENTICATE,
	ENABLE,
	SELECT,
	EXAMINE,
	CREATE,
	DELETE,
	RENAME,
	SUBSCRIBE,
	UNSUBSCRIBE,
	LIST,
	LSUB,
	NAMESPACE,
	STATUS,
	APPEND,
	IDLE,
	CLOSE,
	UNSELECT,
	EXPUNGE,
	SEARCH,
	FETCH,
	STORE,
	COPY,
	MOVE,
};

/** The commands `UID` prefixes (§6.4.9). */
export const UID_COMMANDS: Readonly<Record<string, Command>> = {
	FETCH,
	STORE,
	COPY,
	MOVE,
	SEARCH,
	EXPUNGE: UID_EXPUNGE,
};
