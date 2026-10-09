import { createHostedWorkClient } from './host-worker.mjs';
export default createHostedWorkClient({ profile: __WORK_RELEASE_PROFILE__, role: __WORK_CLIENT_ROLE__, assets: __WORK_CLIENT_ASSETS__, redisOrigin: __WORK_REDIS_ORIGIN__ });
