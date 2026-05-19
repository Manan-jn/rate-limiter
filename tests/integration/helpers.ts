import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { RedisStore } from '../../src/store/redis.js';

export interface TestRedis {
  store: RedisStore;
  container: StartedTestContainer;
}

export async function startRedis(): Promise<TestRedis> {
  const container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  const url = `redis://localhost:${container.getMappedPort(6379)}`;
  const store = new RedisStore(url);
  await store.connect();
  return { store, container };
}

export async function stopRedis({ store, container }: TestRedis): Promise<void> {
  await store.disconnect();
  await container.stop();
}

export async function flushRedis({ store }: TestRedis): Promise<void> {
  await store.raw.flushdb();
}
