import { readFile } from 'node:fs/promises';
const status=process.argv[2];
if(!['building','built','failed'].includes(status))throw new Error('Unknown build status.');
try{
  const {id}=JSON.parse(await readFile('build-work/release-id.json','utf8'));
  const response=await fetch(new URL('/internal/status',process.env.BLOG_ADMIN_URL),{method:'POST',headers:{Authorization:`Bearer ${process.env.BLOG_BUILD_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({id,status}),signal:AbortSignal.timeout(15_000)});
  if(!response.ok)console.warn(`Could not update build status (${response.status}).`);
}catch{console.warn('Build status could not be reported; Pages will still show the deployment result.');}
