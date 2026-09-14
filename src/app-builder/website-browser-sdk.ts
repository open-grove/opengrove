// Mirrors the version 1 website SDK served by Release Control. The preview
// uses the same API contract, while Cloud endpoints explicitly remain unavailable.
export const websiteBrowserSDK = String.raw`
export class WebsiteRequestError extends Error {
 constructor(status, body) { super(body?.error || "website_request_failed"); this.status=status; this.body=body; }
}
export async function currentSession() {
 const response=await fetch("/_og/session",{credentials:"same-origin",cache:"no-store"});
 if(!response.ok)throw new WebsiteRequestError(response.status,{error:"website_session_unavailable"});
 return response.json();
}
export function login() { location.assign("/_og/login?return_to="+encodeURIComponent(location.pathname+location.search)); }
export async function logout() {
 const response=await fetch("/_og/logout",{method:"POST",credentials:"same-origin",headers:{"X-OpenGrove-Request":"1"}});
 if(!response.ok)throw new WebsiteRequestError(response.status,{error:"website_logout_failed"});
 location.reload();
}
export async function request(path, options={}) {
 if(typeof path!=="string"||!path.startsWith("/v1/"))throw new Error("website_api_path_invalid");
 const target=new URL(path,location.origin);
 if(target.origin!==location.origin||!target.pathname.startsWith("/v1/")||/[\\#%]/.test(path.split("?")[0])||path.split("?")[0].split("/").some(part=>part==="."||part===".."))throw new Error("website_api_path_invalid");
 const {expectedSubject,...fetchOptions}=options;
 const method=(fetchOptions.method||"GET").toUpperCase();
 if(method!=="GET"&&method!=="HEAD"&&(!expectedSubject||typeof expectedSubject!=="string"))throw new Error("website_subject_required");
 const headers=new Headers(fetchOptions.headers);
 if(headers.has("Authorization")||headers.has("Cookie"))throw new Error("website_credentials_not_allowed");
 headers.set("X-OpenGrove-Request","1");
 if(expectedSubject)headers.set("X-OpenGrove-Subject",expectedSubject);
 const response=await fetch("/_og/api"+target.pathname+target.search,{...fetchOptions,credentials:"same-origin",headers,redirect:"error"});
 if(!response.ok) {
  let body;try{body=await response.json();}catch{body={error:"website_request_failed"};}
  throw new WebsiteRequestError(response.status,body);
 }
 if(response.status===204)return null;
 return response.json();
}
// Bind pending changes to the identity that created them, including after an account switch.
export function draftsFor(subject) {
 if(typeof subject!=="string"||!subject)throw new Error("website_subject_required");
 const prefix="opengrove.website.draft:"+subject+":";
 async function checkedKey(key) {
  if(typeof key!=="string"||!key)throw new Error("website_draft_key_required");
  const session=await currentSession();
  if(!session.authenticated||session.user.sub!==subject)throw new Error("website_account_changed");
  return prefix+key;
 }
 return {
  async read(key){return localStorage.getItem(await checkedKey(key));},
  async save(key,value){localStorage.setItem(await checkedKey(key),value);},
  async remove(key){localStorage.removeItem(await checkedKey(key));},
 };
}
export function download(name, contents, type="application/octet-stream") {
 const blob=contents instanceof Blob?contents:new Blob([contents],{type});
 const url=URL.createObjectURL(blob), link=document.createElement("a");
 link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
`;
