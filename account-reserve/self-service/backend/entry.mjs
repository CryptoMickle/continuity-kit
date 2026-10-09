import { createSelfServiceHostedClient } from './host.mjs';
export default createSelfServiceHostedClient({ profile: __SELF_SERVICE_PROFILE__, role: __SELF_SERVICE_ROLE__, assets: __SELF_SERVICE_ASSETS__ });
