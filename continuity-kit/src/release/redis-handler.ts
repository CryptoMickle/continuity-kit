import { createDemoStore } from "./store.ts";
import { createRedisObjectStore } from "./redis-store.ts";
import type { RedisStoreOptions } from "./redis-store.ts";
import type { DemoObjectStore } from "./object-store.ts";
import { validateReleaseProfile } from "./profile.ts";
import type { ReleaseProfile } from "./profile.ts";

export interface RedisStoreEnv {
  CONTINUITY_UPLOAD_TOKEN?: string;
  CONTINUITY_REDIS_REST_URL?: string;
  CONTINUITY_REDIS_REST_TOKEN?: string;
}

/** Uses the same HTTP policy as D1. Provider credentials stay on the server. */
export function createRedisDemoStore(
  input: ReleaseProfile,
  options: RedisStoreOptions = {},
) {
  const profile = validateReleaseProfile(input);
  const serve = createDemoStore(profile);
  let backend: DemoObjectStore | undefined;
  let providerUrl: string | undefined;
  let providerToken: string | undefined;
  return (request: Request, env: RedisStoreEnv) => {
    // Lazy initialization keeps denied requests, preflights and the presenter
    // capability check independent of provider credentials or network calls.
    // Reuse just the server adapter/cooldown, never user content or auth results.
    // Configuration changes replace it; there is no unbounded per-token cache.
    const objects = () => {
      if (
        backend &&
        providerUrl === env.CONTINUITY_REDIS_REST_URL &&
        providerToken === env.CONTINUITY_REDIS_REST_TOKEN
      )
        return backend;
      const next = createRedisObjectStore(
        {
          url: env.CONTINUITY_REDIS_REST_URL ?? "",
          token: env.CONTINUITY_REDIS_REST_TOKEN ?? "",
          namespace: profile.deploymentId,
        },
        options,
      );
      providerUrl = env.CONTINUITY_REDIS_REST_URL;
      providerToken = env.CONTINUITY_REDIS_REST_TOKEN;
      backend = next;
      return next;
    };
    return serve(request, {
      CONTINUITY_UPLOAD_TOKEN: env.CONTINUITY_UPLOAD_TOKEN,
      OBJECTS: {
        read: (...args) => objects().read(...args),
        putImmutable: (...args) => objects().putImmutable(...args),
      },
    });
  };
}
