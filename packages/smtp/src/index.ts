export { SmtpError, type SmtpErrorCode } from './errors';
export {
	type Command,
	type PathCommand,
	parseCommand,
	parsePathCommand,
} from './protocol/command';
export { type DataChunk, DataReader } from './protocol/data';
export { type Path, parsePath } from './protocol/path';
export { formatReply, type Reply, reply } from './protocol/reply';
export {
	type Credentials,
	decodeLoginStep,
	decodePlain,
} from './protocol/sasl';
export type {
	Envelope,
	HookResult,
	ReceivedMessage,
	Session,
	SmtpHooks,
	SmtpServerOptions,
	TlsOptions,
} from './server/options';
export { createSmtpServer, type SmtpServer } from './server/server';
