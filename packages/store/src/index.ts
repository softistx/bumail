export { blobIdOf, type ReadBlob, readBlob } from './contract/blob';
export { normalizeFlag, SYSTEM_FLAGS } from './contract/flags';
export type { MailStore } from './contract/mail-store';
export { isMailboxRole, MAILBOX_ROLES } from './contract/mailbox-name';
export type {
	Account,
	AccountListOptions,
	ChangesOptions,
	Content,
	Expunged,
	ExpungeResult,
	FlagChange,
	FlagOptions,
	FlagResult,
	ListOptions,
	Mailbox,
	MailboxChanges,
	MailboxEntry,
	MailboxRename,
	MailboxRole,
	Membership,
	Message,
	MessageChanges,
	MessagePage,
	MessagesResult,
	NewMailbox,
	NewMessage,
} from './contract/types';
export { StoreError, type StoreErrorCode } from './errors';
export { MemoryMailStore, type MemoryMailStoreOptions } from './memory/store';
