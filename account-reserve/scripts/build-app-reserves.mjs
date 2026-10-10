import { build } from 'vite';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEditorAssets } from '../integrations/multi-app/build.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
export async function buildAppReserves(projectRoot = root, output = join(projectRoot, 'dist-self-service-apps')) {
  await mkdir(output, {recursive:true});
  await build({root:join(projectRoot,'self-service/apps'),base:'/apps/',configFile:false,
    build:{target:'es2022',outDir:join(output,'apps'),emptyOutDir:true}});
  await buildEditorAssets({outDir:join(output,'apps/editors')});
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildAppReserves());
