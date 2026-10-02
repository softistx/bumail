export { blobIdOf } from './contract/blob';
export { normalizeFlag, SYSTEM_FLAGS } from './contract/flags';
export type {
	Account,
	Changes,
	FlagChange,
	Mailbox,
	MailboxRole,
	MailStore,
	Message,
	NewMailbox,
	NewMessage,
	Removed,
} from './contract/types';
export { StoreError, type StoreErrorCode } from './errors';
export { MemoryMailStore } from './memory/store';
