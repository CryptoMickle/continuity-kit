import { readFile } from 'node:fs/promises';
import { upstreamSource, integrationScript, integrationHtml } from './upstream-build.mjs';

export default {
  build: { target: 'es2022' },
  plugins: [{
    name: 'reviewed-textarea-integration',
    resolveId(id) { if (id === 'virtual:textarea-upstream') return '\0textarea-upstream'; },
    async load(id) { if (id === '\0textarea-upstream') return integrationScript(await upstreamSource()); },
    transformIndexHtml: {
      order: 'pre',
      async handler() {
        return integrationHtml(await upstreamSource(), await readFile(new URL('./controls.html', import.meta.url), 'utf8'));
      },
    },
  }],
};
