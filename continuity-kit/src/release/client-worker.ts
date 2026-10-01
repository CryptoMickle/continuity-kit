import { createClientHost } from "./client-host.ts";
import type { ClientAsset, ClientHostEnv } from "./client-host.ts";
import { validateReleaseProfile } from "./profile.ts";

declare const __CONTINUITY_RELEASE_PROFILE__: unknown;
declare const __CONTINUITY_CLIENT_ROLE__: "primary" | "recovery";
declare const __CONTINUITY_CLIENT_ASSETS__: Record<string, ClientAsset>;

const serve = createClientHost(
  validateReleaseProfile(__CONTINUITY_RELEASE_PROFILE__),
  __CONTINUITY_CLIENT_ROLE__,
  __CONTINUITY_CLIENT_ASSETS__,
);
export default {
  fetch(request: Request, env: ClientHostEnv) {
    return serve(request, env);
  },
};
