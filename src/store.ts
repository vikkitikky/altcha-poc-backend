import { createClient } from 'redis';
import { StorageUnavailable } from './errors.js';

const makeClient = (url: string) => createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 1000,
  socket: { connectTimeout: 2000, reconnectStrategy: false } });

// Each multi-key operation shares a Redis Cluster hash tag. A deployment uses one
// namespace and one dedicated, non-evicting Redis dataset across all replicas.
export class RedisStore {
  private constructor(private readonly client: ReturnType<typeof makeClient>, private readonly prefix: string) {}
  static async connect(url: string, namespace = 'native-v1') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new Error('Invalid Redis namespace');
    const client = makeClient(url);
    // Never log connection URLs, credentials, or raw client errors.
    client.on('error', () => {});
    try { await client.connect(); } catch { client.destroy(); throw new StorageUnavailable(); }
    return new RedisStore(client, `captcha:{${namespace}}:`);
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { if (!this.client.isReady) throw new Error(); return await operation(); }
    catch { throw new StorageUnavailable(); }
  }
  private get commands() { return this.client.withCommandOptions({ timeout: 2000 }); }
  async ping() { return this.run(() => this.commands.ping()); }
  async putChallenge(id: string, record: string, expires: number, image?: { id: string; digest: string }) {
    if (!image) {
      const result = await this.run(() => this.commands.set(`${this.prefix}challenge:${id}`, record, { NX: true, EXAT: expires }));
      if (result !== 'OK') throw new StorageUnavailable();
      return;
    }
    const result = await this.run(() => this.commands.eval(`
      if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'EXAT', ARGV[2])
      redis.call('HSET', KEYS[2], 'id', ARGV[3], 'digest', ARGV[4], 'state', 'pending', 'attempts', '0')
      redis.call('EXPIREAT', KEYS[2], ARGV[2])
      return 1
    `, { keys: [`${this.prefix}challenge:${id}`, `${this.prefix}image:${id}`], arguments: [record, String(expires), image.id, image.digest] }));
    if (Number(result) !== 1) throw new StorageUnavailable();
  }
  async getChallenge(id: string) { return this.run(() => this.commands.get(`${this.prefix}challenge:${id}`)); }
  async completePow(challengeId: string, tokenId: string, tokenHash: string, tokenExpires: number,
    image?: { id: string; digest: string; rateKey: string; limit: number }): Promise<number> {
    return Number(await this.run(() => this.commands.eval(`
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl <= 0 then return -1 end
      if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
      if ARGV[3] ~= '' then
        if redis.call('HGET', KEYS[4], 'id') ~= ARGV[5] then return -2 end
        if redis.call('HGET', KEYS[4], 'state') ~= 'pending' then return -3 end
        local count = redis.call('INCR', KEYS[5])
        if count == 1 then redis.call('EXPIRE', KEYS[5], 60) end
        if count > tonumber(ARGV[4]) then return -4 end
        redis.call('HSET', KEYS[4], 'attempts', '1')
        if redis.call('HGET', KEYS[4], 'digest') ~= ARGV[3] then
          redis.call('HSET', KEYS[4], 'state', 'failed')
          return -5
        end
        redis.call('HSET', KEYS[4], 'state', 'completed')
      elseif redis.call('EXISTS', KEYS[4]) == 1 then
        return -2
      end
      redis.call('SET', KEYS[2], '1', 'PX', ttl)
      redis.call('SET', KEYS[3], ARGV[1], 'EXAT', ARGV[2])
      return 1
    `, { keys: [`${this.prefix}challenge:${challengeId}`, `${this.prefix}pow-used:${challengeId}`, `${this.prefix}token:${tokenId}`,
      `${this.prefix}image:${challengeId}`, `${this.prefix}rate:image-guess:${image?.rateKey ?? 'unused'}`],
      arguments: [tokenHash, String(tokenExpires), image?.digest ?? '', String(image?.limit ?? 0), image?.id ?? ''] })));
  }
  async consumeToken(id: string, hash: string): Promise<boolean> {
    return Number(await this.run(() => this.commands.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[1])
      return 1
    `, { keys: [`${this.prefix}token:${id}`], arguments: [hash] }))) === 1;
  }
  async takeRate(key: string, limit: number, seconds: number): Promise<boolean> {
    return Number(await this.run(() => this.commands.eval(`
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return count
    `, { keys: [`${this.prefix}rate:${key}`], arguments: [String(seconds)] }))) <= limit;
  }
  async close() { if (this.client.isOpen) this.client.destroy(); }
}
