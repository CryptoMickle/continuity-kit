import { createRedisDemoStore } from "./redis-handler.ts";
import { validateReleaseProfile } from "./profile.ts";
declare const __CONTINUITY_RELEASE_PROFILE__: unknown;
const serve = createRedisDemoStore(
  validateReleaseProfile(__CONTINUITY_RELEASE_PROFILE__),
);
export default { fetch: serve };
