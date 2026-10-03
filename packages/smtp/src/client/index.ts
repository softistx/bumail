export {
	type RecipientReply,
	SmtpError,
	type SmtpErrorCode,
	type SmtpErrorDetails,
} from '../errors';
export type { Reply } from '../protocol/reply';
export { type MailHost, resolveMx } from './mx';
export type {
	HostDestination,
	MessageSource,
	MxDestination,
	MxResolver,
	SendMailAuth,
	SendMailEnvelope,
	SendMailOptions,
	SendMailResult,
	SendMailTimeouts,
	TlsMode,
} from './options';
export { sendMail } from './send';
