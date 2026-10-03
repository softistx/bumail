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
export { type SignDkimOptions, signDkim } from './dkim/sign';
export { RECOMMENDED_HEADERS } from './dkim/sign-headers';
export { type VerifyDkimOptions, verifyDkim } from './dkim/verify';
export { AuthError, type AuthErrorCode } from './errors';
export {
	type CheckSpfOptions,
	checkSpf,
	type SpfInput,
} from './spf/check-spf';
export type { SpfResult, SpfResultWord } from './spf/result';
