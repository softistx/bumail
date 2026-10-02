import { describeMailStore } from '../contract/mail-store.fixtures';
import { MemoryMailStore } from './store';

describeMailStore('MemoryMailStore', () => new MemoryMailStore());
