import {build} from 'vite';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export async function buildPaymentBrowser(outDir=fileURLToPath(new URL('../artifacts/payments-browser',import.meta.url))){
 await build({root:fileURLToPath(new URL('.',import.meta.url)),configFile:false,base:'/payments/',build:{target:'es2022',outDir:resolve(outDir),emptyOutDir:true}});
 return resolve(outDir);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildPaymentBrowser();
