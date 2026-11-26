import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const db=createClient(Deno.env.get("PROJECT_URL")!,Deno.env.get("SERVICE_ROLE_KEY")!,{auth:{autoRefreshToken:false,persistSession:false}});
const ITER=600000,DAYS=30,BOOTSTRAP=Deno.env.get("SMARTNOTE_BOOTSTRAP_SECRET")||"";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info, x-smartnote-session, x-smartnote-bootstrap","Access-Control-Allow-Methods":"POST, OPTIONS"};
const out=(status:number,data:Record<string,unknown>)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");
const unhex=(s:string)=>new Uint8Array((s.match(/.{2}/g)||[]).map(x=>parseInt(x,16)));
const random=(n:number)=>{const b=crypto.getRandomValues(new Uint8Array(n));return hex(b);};
const hash=async(s:string)=>hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))));
async function derive(password:string,salt:string,iterations=ITER){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);return hex(new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:unhex(salt),iterations},k,256)));}
function equal(a:string,b:string){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
const uname=(v:unknown)=>typeof v==="string"?v.trim().toLowerCase():"";
const validName=(s:string)=>/^[a-z0-9_.-]{3,40}$/.test(s);
const validPassword=(s:unknown):s is string=>typeof s==="string"&&s.length>=10&&s.length<=256;
async function audit(actor:string|null,action:string,target:string,details:Record<string,unknown>={}){await db.from("audit_log").insert({actor_id:actor,actor_name:"",action,target_id:target,details,outcome:"success"});}
async function createAccount(username:string,password:string,role="user",mustChange=true){
 const key=uname(username);if(!validName(key)||!validPassword(password)||!["admin","leader","user"].includes(role))return {error:"invalid_account_data"};
 const id=crypto.randomUUID(),salt=random(16),passwordHash=await derive(password,salt);
 const {error:pe}=await db.from("profiles").insert({id,username:key,role,status:"active",must_change_password:mustChange});
 if (pe) {
  console.error("PROFILE INSERT ERROR:", pe);
  return { error: pe.code === "23505" ? "username_exists" : "profile_create_failed" };
}
 const {error:ae}=await db.from("auth_accounts").insert({user_id:id,username_key:key,password_hash:passwordHash,password_salt:salt,password_iterations:ITER});
 if(ae){await db.from("profiles").delete().eq("id",id);return {error:"account_create_failed"};}
 return {id,username:key,role,status:"active",must_change_password:mustChange};
}
async function session(req:Request,bodyToken=""){
 const token=req.headers.get("x-smartnote-session")||bodyToken||"";
 if(!/^[a-f0-9]{64}$/i.test(token))return null;
 const {data:s,error:se}=await db.from("auth_sessions").select("id,user_id,expires_at").eq("token_hash",await hash(token)).is("revoked_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
 if(se){console.error("SESSION LOOKUP ERROR:",se);throw new Error("session_lookup_failed");}
 if(!s)return null;
 const {data:p,error:pe}=await db.from("profiles").select("id,username,role,status,must_change_password,preferred_language").eq("id",s.user_id).maybeSingle();
 if(pe){console.error("PROFILE LOOKUP ERROR:",pe);throw new Error("profile_lookup_failed");}
 if(!p||p.status!=="active")return null;
 const {error:ue}=await db.from("auth_sessions").update({last_seen_at:new Date().toISOString()}).eq("id",s.id);
 if(ue){console.error("SESSION TOUCH ERROR:",ue);throw new Error("session_update_failed");}
 return {s,p};
}

async function readNotebook(userId:string){
 const tables=["workspaces","projects","units","notes","clients","tasks"] as const;
 const results:any[]=await Promise.all([
  ...tables.map(t=>db.from(t).select("data").eq("user_id",userId)),
  db.from("task_notification_dismissals").select("notification_key").eq("user_id",userId)
 ]);
 for(let i=0;i<results.length;i++){if(results[i].error){console.error("NOTEBOOK LOAD ERROR:",tables[i]||"dismissals",results[i].error);throw new Error("database_load_failed");}}
 const data:Record<string,unknown>={};
 tables.forEach((t,i)=>{data[t]=((results[i].data||[]) as Array<{data:unknown}>).map(row=>row.data)});
 data.taskNotificationDismissals=((results[6].data||[]) as Array<{notification_key:string}>).map(row=>row.notification_key);
 return data;
}

async function login(u:string,pw:string){
 const key=uname(u);
 if(!validName(key)||typeof pw!=="string"||pw.length<1||pw.length>256)return out(400,{ok:false,error:"invalid_credentials"});
 const now=Date.now();
 const {data:attempt,error:attemptError}=await db.from("auth_login_attempts").select("*").eq("username_key",key).maybeSingle();
 if(attemptError){console.error("LOGIN ATTEMPT LOOKUP ERROR:",attemptError);return out(500,{ok:false,error:"login_unavailable"});}
 if(attempt?.locked_until&&Date.parse(attempt.locked_until)>now)return out(429,{ok:false,error:"too_many_attempts"});
 const {data:a,error:accountError}=await db.from("auth_accounts").select("*").eq("username_key",key).maybeSingle();
 if(accountError){console.error("ACCOUNT LOOKUP ERROR:",accountError);return out(500,{ok:false,error:"login_unavailable"});}
 const candidate=await derive(pw,a?.password_salt||"4a9c2e7b8d1f6035a4c9e2b7d8f10365",a?.password_iterations||ITER);
 if(!a||!equal(candidate,a.password_hash)){
  const {data:rateData,error:rateError}=await db.rpc("record_smartnote_login_failure",{p_username_key:key});
  if(rateError||!Array.isArray(rateData)||!rateData[0]){
   console.error("LOGIN RATE LIMIT RPC ERROR:",rateError||"empty_result");
   return out(500,{ok:false,error:"login_unavailable"});
  }
  const locked=!!rateData[0].locked_until&&Date.parse(rateData[0].locked_until)>Date.now();
  return out(locked?429:401,{ok:false,error:locked?"too_many_attempts":"invalid_credentials"});
 }
 const {data:user,error:profileError}=await db.from("profiles").select("id,username,role,status,must_change_password,preferred_language").eq("id",a.user_id).maybeSingle();
 if(profileError){console.error("LOGIN PROFILE LOOKUP ERROR:",profileError);return out(500,{ok:false,error:"login_unavailable"});}
 if(!user||user.status!=="active")return out(403,{ok:false,error:"inactive_user"});
 const {error:clearError}=await db.from("auth_login_attempts").delete().eq("username_key",key);
 if(clearError){console.error("LOGIN ATTEMPT RESET ERROR:",clearError);return out(500,{ok:false,error:"login_unavailable"});}
 const token=random(32),expires=new Date(now+DAYS*86400000).toISOString();
 const {error:sessionError}=await db.from("auth_sessions").insert({user_id:a.user_id,token_hash:await hash(token),expires_at:expires});
 if(sessionError){console.error("SESSION CREATE ERROR:",sessionError);return out(500,{ok:false,error:"session_create_failed"});}
 const {data:meta,error:revisionError}=await db.from("user_database_meta").select("revision").eq("user_id",a.user_id).maybeSingle();
 if(revisionError)return out(500,{ok:false,error:"database_revision_failed"});
 return out(200,{ok:true,token,expiresAt:expires,user:{id:user.id,username:user.username,role:user.role,status:user.status,mustChangePassword:!!user.must_change_password,preferredLanguage:user.preferred_language||"en"},data:await readNotebook(a.user_id),revision:Number(meta?.revision||0)});
}

async function needData<T=any>(q:PromiseLike<any>,code="database_operation_failed"):Promise<T>{const r=await q;if(r.error){console.error(code,r.error);throw new Error(code);}return r.data as T;}
async function profileFor(id:string){return await needData<any>(db.from("profiles").select("id,username,role,status,must_change_password").eq("id",id).maybeSingle(),"profile_lookup_failed");}
async function activity(assignmentId:string,u:any,action:string,details:Record<string,unknown>={}){await needData(db.from("assignment_activity").insert({assignment_id:assignmentId,actor_id:u.id,actor_name:u.username,action,details}),"activity_write_failed");}
const b64url=(value:string)=>btoa(value).replaceAll("=","").replaceAll("+","-").replaceAll("/","_");
let fcmAccessToken="",fcmAccessTokenExpires=0;
function firebaseAccount(){
 const raw=Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")||"";
 if(raw){const account=JSON.parse(raw);return {project_id:account.project_id,client_email:account.client_email,private_key:account.private_key};}
 const project_id=Deno.env.get("FIREBASE_PROJECT_ID")||"my-time-77e94";
 const client_email=Deno.env.get("FIREBASE_CLIENT_EMAIL")||"";
 const private_key=Deno.env.get("FIREBASE_PRIVATE_KEY")||"";
 if(!client_email||!private_key)throw new Error("firebase_service_account_secrets_missing");
 return {project_id,client_email,private_key};
}
async function firebaseAccessToken(){
 const account=firebaseAccount();if(fcmAccessToken&&Date.now()<fcmAccessTokenExpires-60000)return fcmAccessToken;
 const now=Math.floor(Date.now()/1000),enc=(s:string)=>b64url(s);
 const unsigned=enc(JSON.stringify({alg:"RS256",typ:"JWT"}))+"."+enc(JSON.stringify({iss:account.client_email,scope:"https://www.googleapis.com/auth/firebase.messaging",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
 const pem=String(account.private_key||"").replace(/\\\\n/g,"\\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\s/g,"");
 const binary=Uint8Array.from(atob(pem),c=>c.charCodeAt(0));
 const key=await crypto.subtle.importKey("pkcs8",binary,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
 const signature=new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned)));
 const jwt=unsigned+"."+b64url(String.fromCharCode(...signature));
 const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:jwt})});
 const result=await response.json();if(!response.ok){console.error("FIREBASE OAUTH ERROR:",response.status,result);throw new Error("firebase_oauth_failed:"+String(result.error_description||result.error||response.status));}
 fcmAccessToken=result.access_token;fcmAccessTokenExpires=Date.now()+Number(result.expires_in||3600)*1000;return fcmAccessToken;
}
async function sendPush(userId:string,assignmentId:string,title:string,body:string){
 const {data:devices,error}=await db.from("push_devices").select("fcm_token").eq("user_id",userId);
 if(error)throw new Error("push_devices_lookup_failed:"+error.message);
 if(!devices?.length)return {sent:0,failed:0,reason:"no_registered_devices"};
 const account=firebaseAccount(),access=await firebaseAccessToken();
 const results=await Promise.all(devices.map(async(device:any)=>{
  const response=await fetch("https://fcm.googleapis.com/v1/projects/"+account.project_id+"/messages:send",{method:"POST",headers:{Authorization:"Bearer "+access,"Content-Type":"application/json"},body:JSON.stringify({message:{token:device.fcm_token,notification:{title,body},data:{assignmentId:String(assignmentId||""),type:"follow_up"},android:{priority:"high",notification:{channel_id:"smartnote-reminders",sound:"default"}}}})});
  if(!response.ok){const errorBody=await response.text();console.error("FCM DELIVERY FAILED:",response.status,errorBody.slice(0,1000));if(response.status===404||response.status===400)await db.from("push_devices").delete().eq("fcm_token",device.fcm_token);return false;}
  return true;
 }));
 return {sent:results.filter(Boolean).length,failed:results.filter(x=>!x).length};
}
function localizedNotification(type:string,title:string,body:string,language:string){
 if(language!=="en")return {title,body};
 const titleMap:Record<string,string>={assigned:"New follow-up",completed:"Follow-up completed",reassigned:"Follow-up reassigned",reassignment_request:"Reassignment request",reassignment_result:"Reassignment request update"};
 let nextBody=body;
 if(type==="assigned")nextBody=body.replace(" — تم إسناد متابعة إليك"," — A follow-up has been assigned to you");
 else if(type==="completed")nextBody=body.replace(" — تم إغلاقها"," — This follow-up has been closed");
 else if(type==="reassigned")nextBody=body.replace(" — تم إسنادها إلى "," — It has been reassigned to ");
 else if(type==="reassignment_result"){
  if(body==="تم تغيير المسؤول قبل مراجعة الطلب.")nextBody="The assignee changed before the request was reviewed.";
  else {const match=body.match(/^طلب إعادة إسناد المتابعة (.+) إلى المستخدم (.+) (تم قبوله|تم رفضه)$/);if(match)nextBody=`Reassignment request for follow-up ${match[1]} to user ${match[2]} was ${match[3]==="تم قبوله"?"approved":"rejected"}`;else if(body.includes("تمت الموافقة"))nextBody="The reassignment request was approved.";else if(body.includes("تم رفض"))nextBody="The reassignment request was rejected.";}
 }
 return {title:titleMap[type]||title,body:nextBody};
}
async function notify(userId:string,assignmentId:string,type:string,title:string,body:string){
 if(!userId)return;
 const profile=await needData<any>(db.from("profiles").select("preferred_language").eq("id",userId).maybeSingle(),"notification_language_lookup_failed");
 const message=localizedNotification(type,title,body,profile?.preferred_language||"en");
 await needData(db.from("notifications").insert({user_id:userId,assignment_id:assignmentId||null,type,title:message.title,body:message.body}),"notification_write_failed");
 await sendPush(userId,assignmentId,message.title,message.body);
}
async function getAssignment(id:string){return await needData<any>(db.from("assignments").select("*").eq("id",id).maybeSingle(),"assignment_lookup_failed");}
function assignmentDto(a:any){const type=String(a.assignment_type||"task"),clientName=String(a.client_name||"");let title=String(a.title||"");if(type==="client")title=clientName||title.replace(/^متابعة عميل\s*:\s*/,"");return {id:String(a.id),title,description:String(a.description||""),type,clientName,clientPhone:String(a.client_phone||""),status:String(a.status||"new"),priority:String(a.priority||"normal"),dueAt:String(a.due_at||""),createdAt:String(a.created_at||""),assignedAt:String(a.assigned_at||""),updatedAt:String(a.updated_at||""),createdBy:String(a.created_by||""),createdByName:String(a.created_by_name||""),ownerLeaderId:String(a.owner_leader_id||""),ownerLeaderName:String(a.owner_leader_name||""),assigneeId:String(a.assignee_id||""),assigneeName:String(a.assignee_name||""),archivedAt:String(a.archived_at||""),viewedAt:String(a.viewed_at||"")};}
function canManageAssignment(u:any,a:any){return u.role==="admin"||a.owner_leader_id===u.id;}
function canSeeAssignment(u:any,a:any){return canManageAssignment(u,a)||a.assignee_id===u.id;}
function assertAssignment(u:any,a:any,manage=false){if(!a||!canSeeAssignment(u,a)||(manage&&!canManageAssignment(u,a)))throw new Error("forbidden");}
async function eligibleUsers(u:any,exclude=""){let q=db.from("profiles").select("id,username,role,status").eq("status","active").neq("id",u.id).order("username");if(u.role!=="admin")q=q.neq("role","admin");if(exclude)q=q.neq("id",exclude);return (await needData<any[]>(q,"users_lookup_failed")).map(p=>({id:p.id,username:p.username,role:p.role}));}
async function getAssignmentDetail(u:any,id:string){let a=await getAssignment(id);assertAssignment(u,a);if(!a.viewed_at&&a.assignee_id===u.id){const now=new Date().toISOString();const marked=await needData<any>(db.from("assignments").update({viewed_at:now,status:a.status==="new"?"viewed":a.status,updated_at:now}).eq("id",id).is("viewed_at",null).select("*").maybeSingle(),"assignment_view_failed");if(marked)await activity(id,u,"viewed",{});}a=await getAssignment(id);const [notes,requests]=await Promise.all([needData<any[]>(db.from("assignment_notes").select("id,author_id,author_name,visibility,body,created_at").eq("assignment_id",id).order("created_at").limit(200),"notes_lookup_failed"),needData<any[]>(db.from("reassignment_requests").select("*").eq("assignment_id",id).order("requested_at",{ascending:false}).limit(100),"requests_lookup_failed")]);return {...assignmentDto(a),notes:notes.filter(n=>n.visibility==="shared"||n.author_id===u.id).map(n=>({id:n.id,authorId:n.author_id,authorName:n.author_name,visibility:n.visibility,body:n.body,createdAt:n.created_at})),requests:requests.filter(r=>u.role==="admin"||r.from_user_id===u.id||a.owner_leader_id===u.id).map(r=>({id:r.id,fromUserName:r.from_user_name,toUserName:r.to_user_name,reason:r.reason,status:r.status,requestedAt:r.requested_at}))};}
async function assignmentAction(action:string,b:any,u:any){
 const id=typeof b.assignmentId==="string"?b.assignmentId:"";
 if(action==="leader_users"){if(!["admin","leader"].includes(u.role))throw new Error("forbidden");return {ok:true,users:await eligibleUsers(u)};}
 if(action==="assignment_list"||action==="assignment_archived_list"){let q=db.from("assignments").select("*").order("updated_at",{ascending:false}).limit(1000);q=action==="assignment_archived_list"?q.not("archived_at","is",null):q.is("archived_at",null);if(u.role!=="admin")q=action==="assignment_archived_list"?q.eq("owner_leader_id",u.id):q.or("owner_leader_id.eq."+u.id+",assignee_id.eq."+u.id);const rows=await needData<any[]>(q,"assignment_list_failed");return {ok:true,assignments:rows.filter(a=>canSeeAssignment(u,a)).map(assignmentDto)};}
 if(action==="assignment_targets"||action==="reassignment_targets"){const a=await getAssignment(id);assertAssignment(u,a,action==="assignment_targets");if(action==="reassignment_targets"&&a.assignee_id!==u.id)throw new Error("forbidden");return {ok:true,users:await eligibleUsers(u,String(b.excludeUserId||a.assignee_id))};}
 if(action==="assignment_create"){if(!["admin","leader"].includes(u.role))throw new Error("forbidden");const type=b.assignmentType==="client"?"client":"task",name=String(b.clientName||"").trim().slice(0,180),phone=String(b.clientPhone||"").trim().slice(0,30),title=type==="client"?name:String(b.title||"").trim().slice(0,180);if(!title)throw new Error("invalid_title");if(type==="client"&&(!name||!phone))throw new Error("invalid_client_phone");const target=await profileFor(String(b.assigneeId||""));if(!target||target.status!=="active"||target.id===u.id||(u.role==="leader"&&target.role==="admin"))throw new Error("user_not_found");const dueAt=b.dueAt?new Date(b.dueAt).toISOString():null;const row={title,description:String(b.description||"").slice(0,5000),status:"new",priority:["low","normal","high","urgent"].includes(b.priority)?b.priority:"normal",due_at:dueAt,created_by:u.id,created_by_name:u.username,owner_leader_id:u.id,owner_leader_name:u.username,assignee_id:target.id,assignee_name:target.username,assignment_type:type,client_name:type==="client"?name:"",client_phone:type==="client"?phone:""};const a=await needData<any>(db.from("assignments").insert(row).select("*").single(),"assignment_create_failed");await activity(a.id,u,"created",{assignee:target.username});await notify(target.id,a.id,"assigned","متابعة جديدة",title+" — تم إسناد متابعة إليك");return {ok:true,assignment:assignmentDto(a)};}
 if(action==="assignment_detail")return {ok:true,assignment:await getAssignmentDetail(u,id)};
 if(action==="assignment_history"){const a=await getAssignment(id);assertAssignment(u,a);const rows=await needData<any[]>(db.from("assignment_activity").select("actor_name,action,details,created_at").eq("assignment_id",id).order("created_at").limit(200),"history_lookup_failed");return {ok:true,history:rows.map(r=>({actorName:r.actor_name,action:r.action,details:r.details||{},createdAt:r.created_at}))};}
 if(action==="assignment_status"){const a=await getAssignment(id);assertAssignment(u,a);const status=String(b.status||"");if(!["new","viewed","in_progress","paused","completed","cancelled"].includes(status))throw new Error("invalid_status");if(u.id===a.assignee_id&&status==="new")throw new Error("assignee_cannot_set_new");if(a.status===status)return {ok:true,assignment:assignmentDto(a)};const previous=a.status,patch:any={status,updated_at:new Date().toISOString()};if(!a.viewed_at&&a.assignee_id===u.id)patch.viewed_at=patch.updated_at;const changed=await needData<any>(db.from("assignments").update(patch).eq("id",id).select("*").single(),"assignment_status_failed");if(patch.viewed_at)await activity(id,u,"viewed",{});await activity(id,u,"status_changed",{status,previousStatus:previous});if((previous==="completed"||previous==="cancelled")&&status!=="completed"&&status!=="cancelled"){const label=previous==="completed"?"مكتملة":"ملغاة",body="تم إعادة فتح المتابعة بعد أن كانت "+label;await needData(db.from("assignment_notes").insert({assignment_id:id,author_id:u.id,author_name:u.username,visibility:"shared",body}),"reopen_note_failed");await activity(id,u,"note_added",{visibility:"shared",automatic:true,reason:"reopened",previousStatus:previous});}if(status==="completed")await notify(a.owner_leader_id,id,"completed","تم إغلاق المتابعة",a.title+" — تم إغلاقها");return {ok:true,assignment:assignmentDto(changed)};}
 if(action==="assignment_update"){const a=await getAssignment(id);if(!a||!(a.created_by===u.id||a.owner_leader_id===u.id))throw new Error("forbidden");const patch=b.patch&&typeof b.patch==="object"?b.patch:{},update:any={updated_at:new Date().toISOString()};const nextType=patch.AssignmentType==="client"?"client":patch.AssignmentType==="task"?"task":String(a.assignment_type||"task");if(nextType==="client"){const name=String(patch.ClientName??patch.Title??a.client_name??"").trim().slice(0,180),phone=String(patch.ClientPhone??a.client_phone??"").trim().slice(0,30);if(!name||!phone)throw new Error("invalid_client_phone");update.assignment_type="client";update.client_name=name;update.client_phone=phone;update.title=name;}else{const title=String(patch.Title??a.title??"").trim().slice(0,180);if(!title)throw new Error("invalid_title");update.assignment_type="task";update.client_name="";update.client_phone="";update.title=title;}for(const [src,dst] of [["Description","description"],["Priority","priority"],["DueAt","due_at"]] as const){if(Object.prototype.hasOwnProperty.call(patch,src)){if(src==="Priority"&&!["low","normal","high","urgent"].includes(String(patch[src])))throw new Error("invalid_priority");update[dst]=src==="DueAt"?(patch[src]?new Date(String(patch[src])).toISOString():null):String(patch[src]||"").slice(0,src==="Description"?5000:180);}}const changed=await needData<any>(db.from("assignments").update(update).eq("id",id).select("*").single(),"assignment_update_failed");await activity(id,u,"updated",patch);return {ok:true,assignment:assignmentDto(changed)};}
 if(action==="assignment_delete"){if(u.role!=="admin")throw new Error("admin_required");const a=await getAssignment(id);if(!a)throw new Error("assignment_not_found");for(const table of ["notifications","assignment_notes","assignment_activity","reassignment_requests"]){await needData(db.from(table).delete().eq("assignment_id",id),"assignment_delete_related_failed");}await needData(db.from("assignments").delete().eq("id",id),"assignment_delete_failed");return {ok:true,deleted:true};}
 if(action==="assignment_reassign"){const a=await getAssignment(id);assertAssignment(u,a,true);const target=await profileFor(String(b.toUserId||""));if(!target||target.status!=="active"||target.id===u.id||(u.role!=="admin"&&target.role==="admin"))throw new Error("user_not_found");if(target.id===a.assignee_id)throw new Error("same_assignee");const now=new Date().toISOString();const changed=await needData<any>(db.from("assignments").update({assignee_id:target.id,assignee_name:target.username,assigned_at:now,updated_at:now,viewed_at:null,status:a.status==="viewed"?"new":a.status}).eq("id",id).select("*").single(),"assignment_reassign_failed");const pending=await needData<any[]>(db.from("reassignment_requests").select("id,from_user_id").eq("assignment_id",id).eq("status","pending"),"reassignment_lookup_failed");for(const r of pending){await needData(db.from("reassignment_requests").update({status:"stale",reviewed_at:now,reviewed_by_id:u.id,reviewed_by_name:u.username}).eq("id",r.id),"reassignment_update_failed");await notify(r.from_user_id,id,"reassignment_result","انتهى طلب إعادة الإسناد","تم تغيير المسؤول قبل مراجعة الطلب.");}await activity(id,u,"reassigned",{from:a.assignee_name,to:target.username});await notify(target.id,id,"assigned","متابعة جديدة",a.title+" — تم إسناد متابعة إليك");await notify(a.assignee_id,id,"reassigned","تم إعادة إسناد المتابعة",a.title+" — تم إسنادها إلى "+target.username);return {ok:true,assignment:assignmentDto(changed)};}
 if(action==="assignment_archive"||action==="assignment_restore"){const a=await getAssignment(id);assertAssignment(u,a,true);const archived=action==="assignment_archive";await needData(db.from("assignments").update({archived_at:archived?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq("id",id),"assignment_archive_failed");await activity(id,u,archived?"archived":"restored",{});return {ok:true,archived,restored:!archived};}
 if(action==="reassignment_request"){const a=await getAssignment(id);assertAssignment(u,a);if(a.assignee_id!==u.id)throw new Error("forbidden");const target=await profileFor(String(b.toUserId||"")),reason=String(b.reason||"").trim().slice(0,2000);if(!target||target.status!=="active"||target.role==="admin")throw new Error("user_not_found");if(target.id===u.id)throw new Error("same_assignee");if(!reason)throw new Error("invalid_reason");const pending=await needData<any[]>(db.from("reassignment_requests").select("id").eq("assignment_id",id).eq("status","pending"),"requests_lookup_failed");if(pending.length)throw new Error("request_pending");const req=await needData<any>(db.from("reassignment_requests").insert({assignment_id:id,from_user_id:u.id,from_user_name:u.username,to_user_id:target.id,to_user_name:target.username,reason,status:"pending"}).select("*").single(),"reassignment_request_failed");await activity(id,u,"reassignment_requested",{to:target.username,reason});await notify(a.owner_leader_id,id,"reassignment_request","طلب إعادة إسناد",a.title+" — "+reason);return {ok:true,request:{id:req.id,status:req.status}};}
 if(action==="reassignment_review"){const req=await needData<any>(db.from("reassignment_requests").select("*").eq("id",String(b.requestId||"")).maybeSingle(),"request_lookup_failed");if(!req)throw new Error("user_not_found");const a=await getAssignment(req.assignment_id);assertAssignment(u,a,true);if(a.owner_leader_id!==u.id&&u.role!=="admin")throw new Error("forbidden");if(req.status!=="pending")throw new Error("request_not_pending");if(req.from_user_id!==a.assignee_id){await needData(db.from("reassignment_requests").update({status:"stale",reviewed_at:new Date().toISOString(),reviewed_by_id:u.id,reviewed_by_name:u.username}).eq("id",req.id),"request_update_failed");throw new Error("request_stale");}const approve=b.approve===true,target=approve?await profileFor(req.to_user_id):null;if(approve&&(!target||target.status!=="active"))throw new Error("user_not_found");const now=new Date().toISOString();if(approve)await needData(db.from("assignments").update({assignee_id:target.id,assignee_name:target.username,assigned_at:now,updated_at:now,viewed_at:null,status:a.status==="viewed"?"new":a.status}).eq("id",a.id),"assignment_reassign_failed");await needData(db.from("reassignment_requests").update({status:approve?"approved":"rejected",reviewed_at:now,reviewed_by_id:u.id,reviewed_by_name:u.username}).eq("id",req.id),"request_update_failed");await activity(a.id,u,approve?"reassignment_approved":"reassignment_rejected",{requestId:req.id,to:approve?target.username:""});if(approve)await notify(target.id,a.id,"assigned","متابعة محولة إليك",a.title);await notify(req.from_user_id,a.id,"reassignment_result","نتيجة طلب إعادة الإسناد","طلب إعادة إسناد المتابعة "+a.title+" إلى المستخدم "+req.to_user_name+" "+(approve?"تم قبوله":"تم رفضه"));return {ok:true,request:{id:req.id,status:approve?"approved":"rejected"}};}
 if(action==="assignment_note_add"){const a=await getAssignment(id);assertAssignment(u,a);const body=String(b.body||"").trim().slice(0,5000);if(!body)throw new Error("invalid_note");const visibility=b.visibility==="shared"?"shared":"private";const note=await needData<any>(db.from("assignment_notes").insert({assignment_id:id,author_id:u.id,author_name:u.username,visibility,body}).select("*").single(),"note_create_failed");await activity(id,u,"note_added",{visibility});return {ok:true,note:{id:note.id,visibility:note.visibility,body:note.body,createdAt:note.created_at}};}
 return null;
}
async function notificationAction(action:string,b:any,u:any){
 if(action==="profile_language_set"){const language=b.language==="ar"?"ar":b.language==="en"?"en":"";if(!language)return out(400,{ok:false,error:"invalid_language"});const {error}=await db.from("profiles").update({preferred_language:language}).eq("id",u.id);if(error)throw new Error("profile_language_update_failed");return {ok:true,language};}
 if(action==="push_register"){
  const token=typeof b.fcmToken==="string"?b.fcmToken.trim():"";
  if(token.length<40||token.length>4096)return out(400,{ok:false,error:"invalid_push_token",stage:"validate_token"});
  const {data,error}=await db.from("push_devices").upsert({user_id:u.id,fcm_token:token,platform:"android",updated_at:new Date().toISOString()},{onConflict:"fcm_token"}).select("id,user_id").single();
  if(error){
   console.error("FCM DEVICE UPSERT ERROR:",{code:error.code,message:error.message,details:error.details,hint:error.hint});
   return out(500,{ok:false,error:"push_device_register_failed",stage:"database_upsert",dbCode:error.code||"",dbMessage:error.message||"",dbDetails:error.details||""});
  }
  return {ok:true,registered:true,deviceId:data.id};
 }
 if(action==="push_test"){const result=await sendPush(u.id,"","SmartNote","تم اختبار إشعارات التطبيق بنجاح");return {ok:true,test:true,...result};}
 if(action==="push_unregister"){const token=typeof b.token==="string"?b.token.trim():"";if(token)await needData(db.from("push_devices").delete().eq("user_id",u.id).eq("fcm_token",token),"push_device_unregister_failed");return {ok:true,unregistered:true};}
 if(action==="notification_list"){const all=await needData<any[]>(db.from("notifications").select("id,assignment_id,type,title,body,is_read,created_at").eq("user_id",u.id).order("created_at",{ascending:false}).order("id",{ascending:false}).limit(5000),"notifications_lookup_failed");const unreadCount=all.filter(n=>!n.is_read).length,totalCount=all.length;let rows=all;if(b.cursor){const [time,...rest]=String(b.cursor).split("|"),lastId=rest.join("|");rows=all.filter(n=>n.created_at<time||(n.created_at===time&&n.id<lastId));}const page=rows.slice(0,100),hasMore=rows.length>100,last=page[page.length-1];return {ok:true,notifications:page.map(n=>({id:n.id,assignmentId:n.assignment_id||"",type:n.type,title:n.title,body:n.body,isRead:n.is_read,createdAt:n.created_at})),nextCursor:hasMore&&last?last.created_at+"|"+last.id:"",hasMore,unreadCount,totalCount};}
 if(action==="notification_read"){const rows=await needData<any[]>(db.from("notifications").update({is_read:true,read_at:new Date().toISOString()}).eq("id",String(b.notificationId||"")).eq("user_id",u.id).select("id"),"notification_update_failed");if(!rows.length)throw new Error("notification_not_found");return {ok:true,read:true};}
 if(action==="notification_read_all"){const {error}=await db.from("notifications").update({is_read:true,read_at:new Date().toISOString()}).eq("user_id",u.id).eq("is_read",false);if(error)throw new Error("notification_update_failed");return {ok:true,readAll:true};}
 if(action==="notification_delete"){const rows=await needData<any[]>(db.from("notifications").delete().eq("id",String(b.notificationId||"")).eq("user_id",u.id).select("id"),"notification_delete_failed");if(!rows.length)throw new Error("notification_not_found");return {ok:true,deleted:true};}
 if(action==="notification_delete_all"){const {error}=await db.from("notifications").delete().eq("user_id",u.id);if(error)throw new Error("notification_delete_failed");return {ok:true,deletedAll:true};}
 return null;
}

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});if(req.method!=="POST")return out(405,{ok:false,error:"method_not_allowed"});
 try{
  const b=await req.json();let action=typeof b.action==="string"?b.action:"";
  const aliases:Record<string,string>={admin_list:"admin_list_users",admin_create:"admin_create_user",admin_status:"admin_set_status",admin_role:"admin_set_role",admin_delete:"admin_delete_user"};action=aliases[action]||action;if(action==="admin_reset_password"&&b.newPassword===undefined)b.newPassword=b.password;
  if(action==="login")return await login(b.username,b.password);
  if(action==="bootstrap_admin"){
   const supplied=req.headers.get("x-smartnote-bootstrap")||"";
   if(!BOOTSTRAP||!equal(supplied,BOOTSTRAP))return out(403,{ok:false,error:"bootstrap_forbidden"});
   const {count}=await db.from("profiles").select("id",{count:"exact",head:true}).eq("role","admin");
   if((count||0)>0)return out(409,{ok:false,error:"admin_already_exists"});
   const result=await createAccount(b.username,b.password,"admin",true);
   if(result.error)return out(400,{ok:false,error:result.error});
   await audit(result.id,"bootstrap_admin_created",result.id);
   return out(201,{ok:true,user:result,notice:"Remove SMARTNOTE_BOOTSTRAP_SECRET from Edge Function secrets after successful bootstrap."});
  }
  const auth=await session(req,typeof b.token==="string"?b.token:"");if(!auth)return out(401,{ok:false,error:"session_invalid"});
  if(action==="me"){const {data:meta,error:revisionError}=await db.from("user_database_meta").select("revision").eq("user_id",auth.p.id).maybeSingle();if(revisionError)throw new Error("database_revision_failed");return out(200,{ok:true,user:{id:auth.p.id,username:auth.p.username,role:auth.p.role,status:auth.p.status,mustChangePassword:!!auth.p.must_change_password,preferredLanguage:auth.p.preferred_language||"en"},expiresAt:auth.s.expires_at,data:await readNotebook(auth.p.id),revision:Number(meta?.revision||0)});}
  if(action==="load"){const {data:meta,error}=await db.from("user_database_meta").select("revision").eq("user_id",auth.p.id).maybeSingle();if(error)throw new Error("database_revision_failed");return out(200,{ok:true,data:await readNotebook(auth.p.id),revision:Number(meta?.revision||0)});}
  const assignmentResponse=await assignmentAction(action,b,auth.p);if(assignmentResponse)return out(200,assignmentResponse);const notificationResponse=await notificationAction(action,b,auth.p);if(notificationResponse)return out(200,notificationResponse);
   if(action==="save"){if(!b.data||typeof b.data!=="object"||Array.isArray(b.data))return out(400,{ok:false,error:"invalid_database_payload"});const {data:revision,error}=await db.rpc("replace_smartnote_database",{p_user_id:auth.p.id,p_data:b.data,p_expected_revision:Number.isInteger(Number(b.revision))?Number(b.revision):null});if(error){if(String(error.message||"").includes("data_conflict"))return out(409,{ok:false,error:"data_conflict"});console.error("NOTEBOOK SAVE ERROR:",error);return out(500,{ok:false,error:"database_save_failed"});}return out(200,{ok:true,saved:true,revision:Number(revision||0)});}
  if(action==="logout"){
   const {error}=await db.from("auth_sessions").update({revoked_at:new Date().toISOString()}).eq("id",auth.s.id);
   if(error){console.error("LOGOUT ERROR:",error);return out(500,{ok:false,error:"logout_failed"});}
   return out(200,{ok:true});
  }
  if(action==="change_password"){
   const old=typeof b.currentPassword==="string"?b.currentPassword:(typeof b.oldPassword==="string"?b.oldPassword:""),next=b.newPassword;
   if(!validPassword(next))return out(400,{ok:false,error:"weak_password"});
   const {data:a,error:lookupError}=await db.from("auth_accounts").select("password_hash,password_salt,password_iterations").eq("user_id",auth.p.id).maybeSingle();
   if(lookupError){console.error("CHANGE PASSWORD LOOKUP ERROR:",lookupError);return out(500,{ok:false,error:"password_change_failed"});}
   if(!a||!equal(await derive(old,a.password_salt,a.password_iterations),a.password_hash))return out(401,{ok:false,error:"invalid_credentials"});
   const salt=random(16);
   const {error:passwordError}=await db.from("auth_accounts").update({password_hash:await derive(next,salt),password_salt:salt,password_iterations:ITER,password_changed_at:new Date().toISOString()}).eq("user_id",auth.p.id);
   if(passwordError){console.error("PASSWORD UPDATE ERROR:",passwordError);return out(500,{ok:false,error:"password_change_failed"});}
   const {error:profileError}=await db.from("profiles").update({must_change_password:false}).eq("id",auth.p.id);
   if(profileError){console.error("PASSWORD PROFILE UPDATE ERROR:",profileError);return out(500,{ok:false,error:"password_changed_profile_update_failed",password_changed:true,reauthenticate:true});}
   const {error:revokeError}=await db.from("auth_sessions").update({revoked_at:new Date().toISOString()}).eq("user_id",auth.p.id).is("revoked_at",null);
   if(revokeError){console.error("PASSWORD SESSION REVOKE ERROR:",revokeError);return out(500,{ok:false,error:"password_changed_session_revoke_failed",password_changed:true,reauthenticate:true});}
   return out(200,{ok:true,reauthenticate:true});
  }
  if(auth.p.role!=="admin")return out(403,{ok:false,error:"admin_required"});
  if(action==="admin_audit_list"){const {data,error}=await db.from("audit_log").select("id,actor_name,action,target_id,details,created_at,outcome").order("created_at",{ascending:false}).limit(200);if(error)return out(500,{ok:false,error:"audit_list_failed"});return out(200,{ok:true,entries:(data||[]).map(x=>({id:x.id,actorName:x.actor_name,action:x.action,targetId:x.target_id,details:x.details,createdAt:x.created_at,outcome:x.outcome}))});}
   if(action==="admin_list_users"){
   const {data,error}=await db.from("profiles").select("id,username,role,status,must_change_password,created_at,updated_at").order("created_at",{ascending:false});
   if(error)return out(500,{ok:false,error:"list_failed"});return out(200,{ok:true,users:data});
  }
  if(action==="admin_create_user"){
   const result=await createAccount(b.username,b.password,b.role||"user",true);if(result.error)return out(400,{ok:false,error:result.error});
   await audit(auth.p.id,"admin_create_user",result.id,{username:result.username,role:result.role});return out(201,{ok:true,user:result});
  }
  if(action==="admin_set_status"){
   const id=typeof b.userId==="string"?b.userId:"",status=b.status;
   if(!id||!["active","disabled"].includes(status))return out(400,{ok:false,error:"invalid_status"});
   if(id===auth.p.id&&status==="disabled")return out(400,{ok:false,error:"cannot_disable_self"});
   const {data:target,error:targetError}=await db.from("profiles").select("id,role").eq("id",id).maybeSingle();if(targetError){console.error("STATUS TARGET LOOKUP ERROR:",targetError);return out(500,{ok:false,error:"status_update_failed"});}if(!target)return out(404,{ok:false,error:"user_not_found"});
   if(target.role==="admin"&&status==="disabled"){const {count,error:countError}=await db.from("profiles").select("id",{count:"exact",head:true}).eq("role","admin").eq("status","active");if(countError){console.error("ACTIVE ADMIN COUNT ERROR:",countError);return out(500,{ok:false,error:"status_update_failed"});}if((count||0)<=1)return out(400,{ok:false,error:"last_active_admin"});}
   const {error}=await db.from("profiles").update({status}).eq("id",id);if(error)return out(500,{ok:false,error:"status_update_failed"});
   if(status==="disabled"){
    const {data:linkedAssignments,error:linkedError}=await db.from("assignments").select("id").or("created_by.eq."+id+",owner_leader_id.eq."+id+",assignee_id.eq."+id).limit(1);if(linkedError)return out(500,{ok:false,error:"delete_failed"});if((linkedAssignments||[]).length)return out(400,{ok:false,error:"user_has_assignments"});
   const {error:revokeError}=await db.from("auth_sessions").update({revoked_at:new Date().toISOString()}).eq("user_id",id).is("revoked_at",null);
    if(revokeError){console.error("STATUS SESSION REVOKE ERROR:",revokeError);return out(500,{ok:false,error:"status_updated_session_revoke_failed",status_updated:true});}
   }
   await audit(auth.p.id,"admin_set_status",id,{status});return out(200,{ok:true});
  }
  if(action==="admin_set_role"){
   const id=typeof b.userId==="string"?b.userId:"",role=b.role;if(!id||!["admin","leader","user"].includes(role))return out(400,{ok:false,error:"invalid_role"});if(id===auth.p.id)return out(400,{ok:false,error:"cannot_change_own_role"});
   const {data:target,error:targetError}=await db.from("profiles").select("id,role").eq("id",id).maybeSingle();if(targetError){console.error("ROLE TARGET LOOKUP ERROR:",targetError);return out(500,{ok:false,error:"role_update_failed"});}if(!target)return out(404,{ok:false,error:"user_not_found"});
   if(role==="user"){const {data:owned,error:ownedError}=await db.from("assignments").select("id").eq("owner_leader_id",id).limit(1);if(ownedError)return out(500,{ok:false,error:"role_update_failed"});if((owned||[]).length)return out(400,{ok:false,error:"user_manages_assignments"});}
   if(target.role==="admin"&&role!=="admin"){const {count,error:countError}=await db.from("profiles").select("id",{count:"exact",head:true}).eq("role","admin").eq("status","active");if(countError){console.error("ACTIVE ADMIN COUNT ERROR:",countError);return out(500,{ok:false,error:"role_update_failed"});}if((count||0)<=1)return out(400,{ok:false,error:"last_active_admin"});}
   const {error}=await db.from("profiles").update({role}).eq("id",id);if(error)return out(500,{ok:false,error:"role_update_failed"});
   await audit(auth.p.id,"admin_set_role",id,{role});return out(200,{ok:true});
  }
  if(action==="admin_reset_password"){
   const id=typeof b.userId==="string"?b.userId:"",pw=b.newPassword;if(!id||!validPassword(pw))return out(400,{ok:false,error:"weak_password_or_user"});
   const {data:target}=await db.from("profiles").select("id").eq("id",id).maybeSingle();if(!target)return out(404,{ok:false,error:"user_not_found"});
   const salt=random(16),{error}=await db.from("auth_accounts").update({password_hash:await derive(pw,salt),password_salt:salt,password_iterations:ITER,password_changed_at:new Date().toISOString()}).eq("user_id",id);
   if(error)return out(500,{ok:false,error:"password_reset_failed"});
   const {error:profileError}=await db.from("profiles").update({must_change_password:true}).eq("id",id);
   if(profileError){console.error("RESET PASSWORD PROFILE ERROR:",profileError);return out(500,{ok:false,error:"password_reset_profile_update_failed",password_reset:true});}
   const {error:revokeError}=await db.from("auth_sessions").update({revoked_at:new Date().toISOString()}).eq("user_id",id).is("revoked_at",null);
   if(revokeError){console.error("RESET PASSWORD SESSION REVOKE ERROR:",revokeError);return out(500,{ok:false,error:"password_reset_session_revoke_failed",password_reset:true});}
   await audit(auth.p.id,"admin_reset_password",id);return out(200,{ok:true});
  }
  if(action==="admin_delete_user"){
   const id=typeof b.userId==="string"?b.userId:"";if(!id||id===auth.p.id)return out(400,{ok:false,error:"invalid_user"});
   const {data:target,error:targetError}=await db.from("profiles").select("id,role").eq("id",id).maybeSingle();if(targetError){console.error("DELETE TARGET LOOKUP ERROR:",targetError);return out(500,{ok:false,error:"delete_failed"});}if(!target)return out(404,{ok:false,error:"user_not_found"});
   if(target.role==="admin"){const {count,error:countError}=await db.from("profiles").select("id",{count:"exact",head:true}).eq("role","admin");if(countError){console.error("ADMIN COUNT ERROR:",countError);return out(500,{ok:false,error:"delete_failed"});}if((count||0)<=1)return out(400,{ok:false,error:"last_admin"});}
   const {error:revokeError}=await db.from("auth_sessions").update({revoked_at:new Date().toISOString()}).eq("user_id",id).is("revoked_at",null);
   if(revokeError){console.error("DELETE SESSION REVOKE ERROR:",revokeError);return out(500,{ok:false,error:"delete_failed"});}
   const {error}=await db.from("profiles").delete().eq("id",id);if(error)return out(500,{ok:false,error:"delete_failed"});
   await audit(auth.p.id,"admin_delete_user",id);return out(200,{ok:true});
  }
  return out(400,{ok:false,error:"unknown_action"});
 }catch(error){
  console.error("SMARTNOTE REQUEST ERROR:",error);
  const message=String((error as any)?.message||error||"unknown_error");
  return out(500,{ok:false,error:message==="push_device_register_failed"?"push_device_register_failed":"internal_error",message});
 }
});