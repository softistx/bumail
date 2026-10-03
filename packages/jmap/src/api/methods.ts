import { emailChanges, emailGet } from '../email/get';
import { emailImport } from '../email/import';
import { emailQuery } from '../email/query';
import { emailSet } from '../email/set';
import { mailboxChanges, mailboxGet } from '../mailbox/get';
import { mailboxQuery } from '../mailbox/query';
import { mailboxSet } from '../mailbox/set';
import { threadGet } from '../thread/get';
import type { Method } from './dispatch';
import { CORE, MAIL } from './request';

/** Every method this server answers, by name. */
export const METHODS: ReadonlyMap<string, Method> = new Map<string, Method>([
	['Core/echo', { capability: CORE, handler: async (args) => args }],
	['Mailbox/get', { capability: MAIL, handler: mailboxGet }],
	['Mailbox/changes', { capability: MAIL, handler: mailboxChanges }],
	['Mailbox/query', { capability: MAIL, handler: mailboxQuery }],
	['Mailbox/set', { capability: MAIL, handler: mailboxSet }],
	['Email/get', { capability: MAIL, handler: emailGet }],
	['Email/changes', { capability: MAIL, handler: emailChanges }],
	['Email/query', { capability: MAIL, handler: emailQuery }],
	['Email/set', { capability: MAIL, handler: emailSet }],
	['Email/import', { capability: MAIL, handler: emailImport }],
	['Thread/get', { capability: MAIL, handler: threadGet }],
]);
