export { ImapError, type ImapErrorCode } from './errors';
export type { Credentials } from './protocol/sasl';
export { decodeUtf7, encodeUtf7 } from './protocol/utf7';
export type {
	AuthResult,
	ImapServerOptions,
	ImapSession,
	TlsOptions,
} from './server/options';
export { createImapServer, type ImapServer } from './server/server';
