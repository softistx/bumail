export { foldHeader } from './build/fold';
export {
	type AddressInput,
	type Attachment,
	buildMessage,
	type Envelope,
	envelopeOf,
	type MessageOptions,
} from './build/message';
export { Base64Decoder, decodeBase64, encodeBase64 } from './encoding/base64';
export { charsetLabel, decodeCharset } from './encoding/charset';
export {
	decodeQuotedPrintable,
	encodeQuotedPrintable,
	QuotedPrintableDecoder,
} from './encoding/quoted-printable';
export {
	createTransferDecoder,
	decodeTransfer,
	type TransferDecoder,
} from './encoding/transfer';
export { MimeError, type MimeErrorCode } from './errors';
export {
	type Address,
	formatMailbox,
	type Group,
	type Mailbox,
	mailboxesOf,
	parseAddressList,
} from './headers/addresses';
export { formatDate, parseDate } from './headers/date';
export { decodeEncodedWords, encodeHeaderValue } from './headers/encoded-words';
export {
	type HeaderField,
	MessageHeaders,
	parseHeaderBlock,
} from './headers/fields';
export {
	type ContentDisposition,
	type ContentType,
	parseContentDisposition,
	parseContentType,
} from './headers/parameters';
export {
	extractContent,
	type MessageContent,
	MimePart,
	parseMessage,
} from './parse/message';
export {
	type MimeEvent,
	MimeParser,
	type MimeParserOptions,
	type PartInfo,
	parseMimeStream,
} from './parse/stream';
