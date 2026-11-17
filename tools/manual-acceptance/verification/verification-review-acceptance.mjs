import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {session,close} from './showcase-api.mjs';

const root='/home/crestha/bos-runtimes/p4v-setup';
const protectedCase='a8d58892-3fe0-47aa-b3a6-c364ab41cd2e';
const reason='Please upload the full PAN certificate. दर्ता विवरण अस्पष्ट छ.';
const results={startedAt:new Date().toISOString(),checks:[],userCaseWrites:0};
async function request(who,path,method='GET',body,expected=200,key=randomUUID()){
 assert(!(method!=='GET'&&path.includes(protectedCase)),'Acceptance test must never write the user case');
 const s=await session(who);
 const r=await fetch(`http://127.0.0.1:3001/v1/${path}`,{method,headers:{authorization:`Bearer ${s.accessToken}`,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const d=await r.json();assert((Array.isArray(expected)?expected:[expected]).includes(r.status),`${who} ${method} ${path}: ${r.status} ${JSON.stringify(d)}`);return d;
}
function checked(name){results.checks.push(name);console.log(`PASS ${name}`);}
async function upload(caseId,filename){
 const bytes=readFileSync(`${root}/public/demo-files/${filename}`);
 const declared=await request('sales','documents','POST',{ownerType:'verification_case',ownerId:caseId,filename,declaredMime:'application/pdf',sizeBytes:bytes.length},201);
 const s=await session('sales');
 const r=await fetch(`http://127.0.0.1:3001${declared.uploadPath}`,{method:'PUT',headers:{authorization:`Bearer ${s.accessToken}`,'content-type':'application/pdf','content-length':String(bytes.length)},body:bytes});assert.equal(r.status,200);
 for(let attempt=0;attempt<120;attempt++){
  const d=await request('sales',`documents/${declared.documentId}`);
  const v=d.versions.find(v=>v.id===declared.versionId);
  if(v?.status==='clean')return declared;
  assert(!['infected','rejected','scan_failed'].includes(v?.status),`Acceptance fixture scan failed: ${v?.status}`);
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 throw Error(`Scan timeout for ${filename}`);
}
try{
 const directory=await request('sales','test-memos/directory');
 const customer=await request('sales','customers','POST',{legalName:`Verification review acceptance ${randomUUID().slice(0,8)}`,address:{line1:'Synthetic acceptance fixture',city:'Kathmandu',country:'NP'}},201);
 assert.equal(customer.ownerUserId,directory.currentUserId);checked('Normal Sales form payload establishes readable ownership');
 let c=await request('sales','verification-cases','POST',{partyId:customer.id},201);
 const id=c.id,base=`verification-cases/${id}`;results.caseId=id;results.customerId=customer.id;
 const files={registration_certificate:'registration-certificate.pdf',pan_vat_certificate:'pan-certificate.pdf',authorised_signatory_id:'signatory-id.pdf'};
 const evidence={};
 for(const[key,filename]of Object.entries(files)){
  evidence[key]=await upload(id,filename);
  c=await request('sales',`${base}/checklist`,'PATCH',{key,documentId:evidence[key].documentId,expectedVersion:c.version});
 }
 c=await request('sales',`${base}/submit`,'POST',{expectedVersion:c.version});assert.equal(c.status,'submitted');
 assert(c.checklist.filter(i=>i.required).every(i=>i.status==='provided'));checked('Real clean uploads produce provided items, not preaccepted fixtures');
 if(process.argv.includes('--prepare-browser')){
  results.result='prepared for browser acceptance';writeFileSync(`${root}/verification-browser-fixture.json`,JSON.stringify(results,null,2));console.log(`Browser fixture ready: https://app.bos.test/verification/${id}`);
 }else{
  await request('founder',`${base}/decision`,'POST',{decision:'approve',comment:'Must remain blocked before item decisions.',expectedVersion:c.version},409);checked('Final approval cannot bulk-accept provided documents');
  c=await request('founder',`${base}/checklist/registration_certificate/decision`,'POST',{decision:'approve',expectedVersion:c.version});
  assert.equal(c.checklist.find(i=>i.key==='registration_certificate').status,'accepted');checked('A provided clean document can be individually approved');
  const previousVersion=c.version;
  await request('founder',`${base}/checklist/pan_vat_certificate/decision`,'POST',{decision:'reject',comment:'   ',expectedVersion:c.version},400);
  assert.equal((await request('founder',base)).version,previousVersion);checked('Whitespace rejection reason refuses without changing the case');
  const key=randomUUID(),body={decision:'reject',comment:reason,expectedVersion:c.version};
  c=await request('founder',`${base}/checklist/pan_vat_certificate/decision`,'POST',body,200,key);
  assert.equal(c.status,'submitted');assert.equal(c.checklist.find(i=>i.key==='pan_vat_certificate').status,'rejected');
  assert.deepEqual(await request('founder',`${base}/checklist/pan_vat_certificate/decision`,'POST',body,200,key),c);checked('Same decision key replays once without duplicate version increments');
  await request('founder',`${base}/checklist/pan_vat_certificate/decision`,'POST',{...body,comment:'Different reason'},422,key);
  const salesView=await request('sales',base);assert(JSON.stringify(salesView).includes(reason));
  const history=await request('sales',`${base}/review-history?limit=20`);assert(JSON.stringify(history).includes(reason));checked('Same Sales creator sees the exact rejection reason and history');
  await request('sales',`${base}/checklist/authorised_signatory_id/decision`,'POST',{decision:'approve',expectedVersion:c.version},403);checked('Creator has no document-review privilege');
  c=await request('founder',`${base}/decision`,'POST',{decision:'reject',comment:'PAN certificate needs replacement. Correct the file and resubmit.',expectedVersion:c.version});assert.equal(c.status,'rejected');
  const sameEvidence=await request('sales',`${base}/checklist`,'PATCH',{key:'pan_vat_certificate',documentId:evidence.pan_vat_certificate.documentId,expiresOn:'2027-12-01',expectedVersion:c.version},[200,409]);
  if(!sameEvidence.error){c=sameEvidence;await request('sales',`${base}/submit`,'POST',{expectedVersion:c.version},409);}else c=await request('sales',base);
  checked('Reattaching the same rejected version or changing expiry does not bypass correction');
  const replacement=await upload(id,'pan-certificate.pdf');
  c=await request('sales',`${base}/checklist`,'PATCH',{key:'pan_vat_certificate',documentId:replacement.documentId,expectedVersion:c.version});
  assert.equal(c.status,'draft');assert(JSON.stringify(await request('sales',`${base}/review-history?limit=20`)).includes(reason));checked('Replacement preserves the old rejection reason');
  c=await request('sales',`${base}/submit`,'POST',{expectedVersion:c.version});
  assert(c.checklist.filter(i=>i.documentId).every(i=>i.status==='provided'));checked('Resubmission starts a fresh review round');
  for(const key of Object.keys(files))c=await request('founder',`${base}/checklist/${key}/decision`,'POST',{decision:'approve',expectedVersion:c.version});
  c=await request('founder',`${base}/decision`,'POST',{decision:'approve',comment:'All supplied identity evidence reviewed and accepted.',expectedVersion:c.version});assert.equal(c.status,'approved');
  const reviewed=c.checklist.find(i=>i.key==='pan_vat_certificate');assert(JSON.stringify(reviewed).includes(replacement.versionId));checked('Final approval uses the replacement version after explicit item reviews');
  assert(JSON.stringify(await request('sales',`${base}/review-history?limit=20`)).includes(reason));checked('Approved case retains prior rejection history for Sales');
  results.result='pass';results.finishedAt=new Date().toISOString();writeFileSync(`${root}/verification-review-acceptance-result.json`,JSON.stringify(results,null,2));
 }
}finally{await close(true);}
