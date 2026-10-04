import { describeQueueStore } from '../contract/queue-store.fixtures';
import { describeUnreadableMessage } from '../queue/unreadable.fixtures';
import { MemoryQueueStore } from './store';

describeQueueStore('MemoryQueueStore', () => new MemoryQueueStore());
describeUnreadableMessage('MemoryQueueStore', () => new MemoryQueueStore());
