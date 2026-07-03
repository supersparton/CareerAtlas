import * as dotenv from 'dotenv';
import * as path from 'path';
import { URL } from 'url';

// Load .env from backend folder as primary, fallback to local directory
const backendEnvPath = path.resolve(__dirname, '../../backend/.env');
dotenv.config({ path: backendEnvPath });
dotenv.config(); // fallback local .env

export const CONFIG = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  redisUsername: process.env.REDIS_USERNAME || undefined,
  redisTls: process.env.REDIS_TLS === 'true',
  debug: process.env.DEBUG === 'true',
};

export function getRedisConnectionOptions() {
  if (CONFIG.redisUrl) {
    try {
      const parsed = new URL(CONFIG.redisUrl);
      return {
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : 6379,
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        tls: parsed.protocol === 'rediss:' ? {} : undefined,
      };
    } catch (err) {
      // Fail silently and fall back to host/port fields
    }
  }

  return {
    host: CONFIG.redisHost,
    port: CONFIG.redisPort,
    username: CONFIG.redisUsername,
    password: CONFIG.redisPassword,
    tls: CONFIG.redisTls ? {} : undefined,
  };
}
