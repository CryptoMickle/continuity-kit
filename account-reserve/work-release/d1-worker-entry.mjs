import { createHostedD1WorkClient } from './d1-host-worker.mjs';
export default createHostedD1WorkClient({profile:__WORK_RELEASE_PROFILE__,role:__WORK_CLIENT_ROLE__,assets:__WORK_CLIENT_ASSETS__});
