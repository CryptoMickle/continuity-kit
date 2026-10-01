import { createDemoStore } from "./store.ts";
import type { DemoStoreEnv } from "./store.ts";
import { validateReleaseProfile } from "./profile.ts";
declare const __CONTINUITY_RELEASE_PROFILE__: unknown;
const serve = createDemoStore(
  validateReleaseProfile(__CONTINUITY_RELEASE_PROFILE__),
);
export default {
  fetch(request: Request, env: DemoStoreEnv) {
    return serve(request, env);
  },
};
