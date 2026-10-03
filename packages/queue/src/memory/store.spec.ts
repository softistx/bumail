import { describeQueueStore } from '../contract/queue-store.fixtures';
import { MemoryQueueStore } from './store';

describeQueueStore('MemoryQueueStore', () => new MemoryQueueStore());
