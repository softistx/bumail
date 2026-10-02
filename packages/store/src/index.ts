export { blobIdOf } from './contract/blob';
export { normalizeFlag, SYSTEM_FLAGS } from './contract/flags';
export type { MailStore } from './contract/mail-store';
export { MAILBOX_ROLES } from './contract/mailbox-name';
export type {
	Account,
	ChangesOptions,
	Content,
	Expunged,
	FlagChange,
	FlagOptions,
	FlagResult,
	ListOptions,
	Mailbox,
	MailboxChanges,
	MailboxEntry,
	MailboxRole,
	Membership,
	Message,
	MessageChanges,
	NewMailbox,
	NewMessage,
} from './contract/types';
export { StoreError, type StoreErrorCode } from './errors';
export { MemoryMailStore, type MemoryMailStoreOptions } from './memory/store';
