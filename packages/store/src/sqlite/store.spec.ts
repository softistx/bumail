import { describeMailStore } from '../contract/mail-store.fixtures';
import { temporaryStores } from './directories.fixtures';

const { open } = temporaryStores();

describeMailStore(
	'SqliteMailStore',
	() => open(),
	(maxTombstones) => open(undefined, { maxTombstones }),
);
