import {createHostedClient} from './host-worker.mjs';
export default createHostedClient({profile:__ACCOUNT_RELEASE_PROFILE__,role:__ACCOUNT_CLIENT_ROLE__,assets:__ACCOUNT_CLIENT_ASSETS__,redisOrigin:__ACCOUNT_REDIS_ORIGIN__});
