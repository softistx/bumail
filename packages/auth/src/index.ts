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
export {
	type CheckDmarcOptions,
	checkDmarc,
	type DmarcInput,
} from './dmarc/check-dmarc';
export { organizationalDomain } from './dmarc/psl';
export { PSL_VERSION } from './dmarc/psl-data';
export type {
	DmarcPolicy,
	DmarcRecord,
	DmarcResult,
	DmarcResultWord,
	DmarcUri,
	SpfCheck,
} from './dmarc/result';
export { AuthError, type AuthErrorCode } from './errors';
export { type DkimRecordOptions, dkimRecord } from './records/dkim';
export { type DmarcRecordOptions, dmarcRecord } from './records/dmarc';
export { type SpfRecordOptions, spfRecord } from './records/spf';
export {
	type AuthenticationResultsInput,
	formatAuthenticationResults,
} from './results/authentication-results';
export {
	type CheckSpfOptions,
	checkSpf,
	type SpfInput,
} from './spf/check-spf';
export type { SpfResult, SpfResultWord } from './spf/result';
