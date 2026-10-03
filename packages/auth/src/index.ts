export type {
	Canonicalization,
	CanonicalizationPair,
} from './dkim/canon';
export type { MessageInput } from './dkim/message';
export { importDkimPrivateKey } from './dkim/private-key';
export type {
	DkimAlgorithm,
	DkimResult,
	DkimResultWord,
} from './dkim/result';
export {
	RECOMMENDED_HEADERS,
	type SignDkimOptions,
	signDkim,
} from './dkim/sign';
export { type VerifyDkimOptions, verifyDkim } from './dkim/verify';
export { AuthError, type AuthErrorCode } from './errors';
