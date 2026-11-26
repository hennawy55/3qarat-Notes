(() => {
  'use strict';
  window.appTranslate=value=>String(value??'');
  const SUPABASE_URL='https://cantyrqkkbqwrajghluw.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY='sb_publishable_PdO0cP98yMMPHLUrJAES0A_b9Z4JlpY';
  const API_URL=SUPABASE_URL+'/functions/v1/smartnote-auth';
  const SESSION_KEY='smartnote-supabase-auth-session-v1';
  const DATABASE_NAME='SMARTNOTE_USER_DATABASE_V2';
  let authToken='', currentUser=null;
  const TYPES=['workspaces','projects','units','notes','clients','tasks'];
  const LABELS={workspaces:'Workspace',projects:'Project',units:'Unit',notes:'Note',clients:'Client',tasks:'متابعة'};
  const TITLES={dashboard:['Dashboard','A quick overview of your real estate data'],assigned:['Assigned follow-ups','Tasks assigned to you or managed by you'],workspaces:['Workspaces','Organize your data into separate workspaces'],projects:['Projects','One place for all your projects'],units:['Units','Unit details and pricing'],notes:['Smart notes','All the information you have saved'],clients:['Clients','Client details and requirements'] ,tasks:['Follow-ups','Upcoming tasks and reminders']};
  const QUICK_ACTIONS={workspaces:['workspace','New workspace'],projects:['project','New project'],units:['unit','New unit'],notes:['note','New note'],clients:['client','New client'],tasks:['task','New follow-up']};
  const emptyDB=()=>({version:1,workspaces:[],projects:[],units:[],notes:[],clients:[],tasks:[]});
  let db=emptyDB(), editing=null, isReady=false, saveQueue=Promise.resolve(), syncInFlight=false, writesInProgress=0, localRevision=0, cloudRevision=0;
  let assignedItems=[],assignedArchivedItems=[],assignmentPeople=[],serverNotifications=[],serverNotificationCursor='',serverNotificationHasMore=false,serverNotificationUnreadCount=0,serverNotificationTotalCount=0;
  let realtimeClient=null,realtimeChannel=null,realtimeRefreshTimer=0;const realtimePendingTables=new Set();
  const localDataKey=()=>`smartnote-local-db-v1:${encodeURIComponent(currentUser?.username||'')}`;
  const pendingSyncKey=()=>`smartnote-pending-sync-v1:${encodeURIComponent(currentUser?.username||'')}`;
  const cloudRevisionKey=()=>`smartnote-supabase-cloud-revision-v1:${encodeURIComponent(currentUser?.username||'')}`;
  function cacheLocalDatabase(state=db,pending=false){if(!currentUser?.username)return;try{localStorage.setItem(localDataKey(),JSON.stringify(cloudPayload(state)));localStorage.setItem(cloudRevisionKey(),String(cloudRevision||0));if(pending)localStorage.setItem(pendingSyncKey(),'1')}catch(error){toast('Could not save a local copy: '+error.message)}}
  function readLocalDatabase(){try{const raw=localStorage.getItem(localDataKey());return raw?normalizeDatabase(JSON.parse(raw)):null}catch{return null}}
  function hasPendingSync(){try{return localStorage.getItem(pendingSyncKey())==='1'}catch{return false}}
  function clearPendingSync(){try{localStorage.removeItem(pendingSyncKey())}catch{}}
  const notifiedTaskReminders=new Set(),taskAlerts=[],browserNotifications=new Map();
  const notificationStateKey=()=>`smart-real-estate-task-notifications-v1:${encodeURIComponent(currentUser?.username||'anonymous')}`;
  let notificationAudio=null,serviceWorkerRegistration=null;
  function persist(){renderAll()}
  function uid(){return 'id_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}
  function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function dateLabel(v){if(!v)return 'No date';try{return new Date(v).toLocaleDateString(document.documentElement.lang==='en'?'en-US':'ar-EG',{year:'numeric',month:'short',day:'numeric'})}catch{return v}}
  function toast(msg){const t=document.getElementById('toast');if(!t)return;const error=msg instanceof Error?msg:null,raw=error?(error.userMessage||error.message):String(msg??'');let translated=window.appTranslate?.(raw)||raw;translated=translated.replace(/supabase/ig,document.documentElement.lang==='en'?'cloud service':'Server').replace(/سوبا\s*بيز/ig,'Server');if(document.documentElement.lang==='en'&&/[\u0600-\u06FF]/.test(translated))translated='The operation could not be completed. Please check the error code and try again.';const code=error?.errorCode||error?.code||'';let details=String(error?.details||'').replace(/supabase/ig,document.documentElement.lang==='en'?'cloud service':'Server').replace(/سوبا\s*بيز/ig,'Server');if(document.documentElement.lang==='en'&&/[\u0600-\u06FF]/.test(details))details='Additional server details are unavailable in English.';t.textContent=(code?translated+' ['+code+']':translated)+(details?' — '+details:'');t.classList.add('show');clearTimeout(t._hideTimer);t._hideTimer=setTimeout(()=>t.classList.remove('show'),error?6500:3200)}
  let startupNotificationPermissionRequested=false;
  async function requestNotificationPermissionOnStartup(){
    if(startupNotificationPermissionRequested)return;
    const native=window.smartNoteNativeNotifications;
    if(!native?.isNative)return;
    startupNotificationPermissionRequested=true;
    try{
      // FCM registration is independent from local-notification permission.
      await native.registerForPushNotifications?.();
      const status=await native.getPermissionStatus?.();
      if(status!=='granted'&&status?.granted!==true){
        const granted=await native.requestPermission();
        if(granted){await syncNativeTaskReminders();checkTaskNotifications()}
      }else{
        await syncNativeTaskReminders();
        checkTaskNotifications();
      }
    }catch(error){
      startupNotificationPermissionRequested=false;
      console.warn('Notification permission request was unavailable:',error);
    }
  }
  function unlockNotificationAudio(){if(notificationAudio){if(notificationAudio.state==='suspended')notificationAudio.resume().catch(()=>toast('Could not play the reminder sound in this browser.'));return}const AudioContextClass=window.AudioContext||window.webkitAudioContext;if(!AudioContextClass)return;try{notificationAudio=new AudioContextClass();if(notificationAudio.state==='suspended')notificationAudio.resume().catch(()=>toast('Could not play the reminder sound in this browser.'))}catch(err){toast('Could not enable reminder sound: '+err.message)}}
  function playNotificationSound(){if(!notificationAudio)return false;if(notificationAudio.state==='suspended'){notificationAudio.resume().catch(()=>toast('Could not play the reminder sound in this browser.'));return false}if(notificationAudio.state!=='running')return false;try{const now=notificationAudio.currentTime;[659,880,1175].forEach((frequency,index)=>{const oscillator=notificationAudio.createOscillator(),gain=notificationAudio.createGain(),start=now+index*.09;oscillator.type='triangle';oscillator.frequency.value=frequency;gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(.13,start+.015);gain.gain.exponentialRampToValueAtTime(.0001,start+.18);oscillator.connect(gain);gain.connect(notificationAudio.destination);oscillator.start(start);oscillator.stop(start+.2)});return true}catch(err){toast('Could not play the reminder tone: '+err.message);return false}}
  function taskDueTimestamp(task){if(!task.dueDate)return NaN;const [year,month,day]=task.dueDate.split('-').map(Number),[hour,minute]=(task.dueTime||'09:00').split(':').map(Number);return new Date(year,month-1,day,hour,minute||0).getTime()}
  function persistTaskAlertState(){try{localStorage.setItem(notificationStateKey(),JSON.stringify({alerts:taskAlerts.map(({key,taskId,title,body,taskTitle,createdAt,isRead})=>({key,taskId,title,body,taskTitle:taskTitle||get('tasks',taskId)?.title||'',createdAt,isRead:!!isRead})),notified:[...notifiedTaskReminders]}))}catch(err){toast('Could not save notification state on this device: '+err.message)}}
  function taskAlertTitleKey(title){return String(title||'').trim().toLocaleLowerCase('ar-EG')}
  function restoreTaskAlertState(){try{const saved=localStorage.getItem(notificationStateKey());if(!saved)return;const state=JSON.parse(saved);if(!state||typeof state!=='object')throw new Error('Saved reminder data is invalid');if(Array.isArray(state.notified))state.notified.filter(key=>typeof key==='string').forEach(key=>notifiedTaskReminders.add(key));if(Array.isArray(state.alerts)){const latestByTitle=new Map();state.alerts.filter(alert=>alert&&typeof alert.key==='string'&&typeof alert.taskId==='string'&&typeof alert.title==='string'&&typeof alert.body==='string').forEach(alert=>{alert.taskTitle=alert.taskTitle||get('tasks',alert.taskId)?.title||'';const titleKey=taskAlertTitleKey(alert.taskTitle||alert.body),previous=latestByTitle.get(titleKey);if(!previous||(alert.createdAt||0)>=(previous.createdAt||0))latestByTitle.set(titleKey,alert)});taskAlerts.push(...latestByTitle.values())}persistTaskAlertState();renderTaskAlerts()}catch(err){toast('Could not restore saved notifications: '+err.message)}}
  function renderTaskAlerts(){if(isReady)refreshUnifiedNotifications();}
  let notificationPollTimer=0;
  function startNotificationPolling(){clearInterval(notificationPollTimer);notificationPollTimer=setInterval(()=>{if(isReady&&navigator.onLine&&!document.hidden)refreshUnifiedNotifications(false,true)},5000)}
  function closeBrowserNotification(key){const notification=browserNotifications.get(key);if(notification){browserNotifications.delete(key);try{const result=notification.close();if(result?.catch)result.catch(err=>toast('Could not close system notification: '+err.message))}catch(err){toast('Could not close system notification: '+err.message)}return}if(!serviceWorkerRegistration||typeof serviceWorkerRegistration.getNotifications!=='function')return;try{serviceWorkerRegistration.getNotifications({tag:key}).then(notifications=>notifications.forEach(item=>item.close())).catch(err=>toast('Could not close system notification: '+err.message))}catch(err){toast('Could not close system notification: '+err.message)}}
  function recordTaskAlertDismissal(key){if(!isReady)return;const dismissed=new Set(db.taskNotificationDismissals||[]);if(dismissed.has(key))return;dismissed.add(key);db.taskNotificationDismissals=[...dismissed];localRevision++;saveDatabase(db).catch(err=>toast('Could not sync notification dismissal: '+err.message))}
  function removeTaskAlert(key){const index=taskAlerts.findIndex(alert=>alert.key===key);if(index<0)return null;const [alert]=taskAlerts.splice(index,1);recordTaskAlertDismissal(key);closeBrowserNotification(key);persistTaskAlertState();renderTaskAlerts();return alert}
  function showAlertTask(key){
    const alert=taskAlerts.find(item=>item.key===key);
    if(!alert)return;
    if(!get('tasks',alert.taskId)){toast('This follow-up no longer exists.');return}
    alert.isRead=true;closeBrowserNotification(key);persistTaskAlertState();renderTaskAlerts();
    document.getElementById('notificationPanel').hidden=true;
    document.getElementById('notificationBell').setAttribute('aria-expanded','false');
    showView('tasks');
    openForm('task',alert.taskId);
  }
  async function sendSystemTaskNotification(alert){
    const options={id:alert.key,title:alert.title||assignmentText('Follow-up reminder','Follow-up reminder'),body:alert.body||'',taskId:alert.taskId,tag:alert.key};
    try{
      const native=window.smartNoteNativeNotifications;
      if(native?.isNative&&typeof native.showInstantNotification==='function'){
        await native.showInstantNotification(options);
        return;
      }
      if(!('Notification'in window)||Notification.permission!=='granted')return;
      if(serviceWorkerRegistration?.showNotification){
        await serviceWorkerRegistration.showNotification(options.title,{body:options.body,tag:options.tag,renotify:false,data:{taskId:options.taskId}});
        return;
      }
      const notification=new Notification(options.title,{body:options.body,tag:options.tag,renotify:false});
      browserNotifications.set(alert.key,notification);
      notification.onclick=()=>{window.focus();showAlertTask(alert.key);notification.close()};
      notification.onclose=()=>browserNotifications.delete(alert.key);
    }catch(error){console.warn('Could not display task notification:',error)}
  }
  function sendTaskNotification(task,type,title,body){const key=`${task.id}:${type}:${type==='due'?taskDueTimestamp(task):task.startedAt}`;if(notifiedTaskReminders.has(key))return;notifiedTaskReminders.add(key);const titleKey=taskAlertTitleKey(task.title);taskAlerts.filter(alert=>taskAlertTitleKey(alert.taskTitle||get('tasks',alert.taskId)?.title||alert.body)===titleKey).forEach(alert=>{closeBrowserNotification(alert.key);taskAlerts.splice(taskAlerts.indexOf(alert),1)});const alert={key,taskId:task.id,title,body,taskTitle:task.title,createdAt:Date.now(),isRead:false};taskAlerts.push(alert);if(window.smartNoteNativeNotifications?.isNative||('Notification'in window&&Notification.permission==='granted'))sendSystemTaskNotification(alert).catch(err=>toast('Could not send system notification: '+err.message));persistTaskAlertState();renderTaskAlerts();if(!document.hidden)playNotificationSound()}
  function checkTaskNotifications(){const now=Date.now();if(!isReady||false)return;for(const task of db.tasks){if(task.status==='مكتملة')continue;const due=taskDueTimestamp(task);if(task.status!=='قيد التنفيذ'&&Number.isFinite(due)&&now>=due)sendTaskNotification(task,'due','The follow-up is still pending',`Follow-up due: ${task.title}`);if(task.status==='قيد التنفيذ'&&task.startedAt&&now-Date.parse(task.startedAt)>=60*60*1000)sendTaskNotification(task,'in_progress','Are you still working on this follow-up?',`One hour has passed since: ${task.title}. Open the follow-up and mark it completed when finished.`)}}
  function get(type,id){return db[type]?.find(x=>x.id===id)}
  function syncNativeTaskReminders(){if(!window.smartNoteNativeNotifications?.isNative||!isReady)return Promise.resolve();return window.smartNoteNativeNotifications.syncTaskReminders(db.tasks).catch(err=>toast('Could not schedule phone reminders: '+err.message))}
  function nameOf(type,id){return get(type,id)?.name||'Not linked'}
  function setConnection(ok,msg){document.getElementById('connectionDot').classList.toggle('online',!!ok);document.getElementById('connectionText').textContent=ok?'Connected to database':'Disconnected';document.getElementById('connectionHint').textContent=msg||(ok?'Connected to the cloud database.':'An internet and database connection is required.')}
  function showGate(message){document.getElementById('onlineGateMessage').textContent=message;document.getElementById('onlineGate').style.display='flex'}
  function hideGate(){document.getElementById('onlineGate').style.display='none'}
  function updateQuickAdd(view){const button=document.getElementById('quickAdd'),action=QUICK_ACTIONS[view];button.hidden=view==='assigned';const assignedButton=document.getElementById('assignedHeaderCreateButton');if(assignedButton)assignedButton.hidden=!(view==='assigned'&&['admin','leader'].includes(currentUser?.role));button.dataset.quickAddType=action?.[0]||'';button.innerHTML=`<i data-lucide="plus"></i> ${action?.[1]||'Add new'}`;if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}})}
  let currentView=(()=>{try{return localStorage.getItem('smartnote-language-view')||'dashboard'}catch{return 'dashboard'}})(),exitPromptArmed=false,exitPromptTimer=0;
  function showView(view){currentView=view;exitPromptArmed=false;document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));const el=document.getElementById('view-'+view)||document.getElementById(view==='searchResults'?'searchResults':'view-dashboard');el.classList.add('active');document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));document.getElementById('pageHeading').textContent=(TITLES[view]||['Search results','Full search'])[0];document.getElementById('pageSub').textContent=(TITLES[view]||['Search results','Full search'])[1];updateQuickAdd(view);if(view==='assigned')loadAssignedView()}
  const appShell=document.querySelector('.app'),sidebarToggle=document.getElementById('sidebarToggle'),SIDEBAR_STATE_KEY='aqarSidebarCollapsed';
  function setSidebarCollapsed(collapsed){appShell.classList.toggle('sidebar-collapsed',collapsed);const language=document.documentElement.lang,icon=collapsed?'panel-left-open':'panel-left-close',label=language==='en'?(collapsed?'Expand sidebar':'Collapse sidebar'):(collapsed?'Expand sidebar':'Collapse sidebar');sidebarToggle.innerHTML=`<i data-lucide="${icon}"></i>`;sidebarToggle.setAttribute('aria-label',label);sidebarToggle.title=label;try{localStorage.setItem(SIDEBAR_STATE_KEY,collapsed?'1':'0')}catch{}if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}})}
  sidebarToggle.onclick=()=>setSidebarCollapsed(!appShell.classList.contains('sidebar-collapsed'));try{setSidebarCollapsed(localStorage.getItem(SIDEBAR_STATE_KEY)==='1')}catch{setSidebarCollapsed(false)}
  window.addEventListener('app-language-change',event=>{setSidebarCollapsed(appShell.classList.contains('sidebar-collapsed'));refreshNotificationButton();const language=event.detail?.language;if(authToken&&currentUser&&['ar','en'].includes(language)){apiPost({action:'profile_language_set',language}).catch(error=>console.warn('Could not sync notification language:',error));currentUser.preferredLanguage=language;try{localStorage.setItem(SESSION_KEY,JSON.stringify({token:authToken,user:currentUser}))}catch{}}});
  document.addEventListener('click',e=>{const assignmentOpen=e.target.closest('[data-assignment-open]');if(assignmentOpen){e.preventDefault();e.stopImmediatePropagation();openAssignedDetail(assignmentOpen.dataset.assignmentOpen);return}const recordView=e.target.closest('[data-record-view]');if(recordView){showRecord(recordView.dataset.recordView,recordView.dataset.id);return}const v=e.target.closest('[data-view]');if(v){showView(v.dataset.view);return}const a=e.target.closest('[data-add]');if(a)openForm(a.dataset.add);const edit=e.target.closest('[data-edit]');if(edit)openForm(edit.dataset.edit,edit.dataset.id);const status=e.target.closest('[data-task-status]');if(status){changeTaskStatus(status.dataset.id,status.dataset.taskStatus,status);return}const del=e.target.closest('[data-delete]');if(del)deleteItem(del.dataset.delete,del.dataset.id)});
  const schemas={
    workspace:[['name','Workspace name','text',true],['description','Short description','textarea'],['color','Workspace color','color']],
    project:[['name','Project name','text',true],['developer','Developer','text'],['workspaceId','Workspace','workspace'],['location','Area / location','text'],['type','Project type','select:سكني,تجاري,إداري,ساحلي,متعدد الاستخدامات'],['delivery','Follow-up date','text'],['payment','Payment plans','textarea'],['commission','Commission','text'],['mapUrl','Map link','url'],['description','Project details','textarea']],
    unit:[['name','Unit name or code','text',true],['projectId','Project','project',true],['type','Unit type','select:شقة,فيلا,تاون هاوس,توين هاوس,دوبلكس,محل,مكتب,عيادة,أخرى'],['area','Area (m²)','number'],['floor','Floor','text'],['bedrooms','Bedrooms','number'],['price','Price','number'],['downPayment','Down payment','number'],['installments','Installment details','textarea'],['delivery','Delivery','text'],['status','Status','select:متاحة,محجوزة,مباعة,غير محدد'],['details','Additional details','textarea']],
    note:[['title','Note title','text',true],['content','Content','textarea',true],['workspaceId','Workspace','workspace'],['projectId','Linked project','project'],['unitId','Linked unit','unit'],['clientId','Linked client','client'],['tags','Tags (separate with commas)','text']],
    client:[['name','Client name','text',true],['phone','Phone number','tel'],['budget','Budget','text'],['area','Preferred area','text'],['unitType','Preferred unit type','text'],['status','Client status','select:جديد,مهتم,متابعة,تعاقد,غير مهتم'],['notes','Notes','textarea']],
    task:[['title','Follow-up title','text',true],['dueDate','Follow-up date','date'],['dueTime','Time','time'],['status','Status','select:معلقة,قيد التنفيذ,مكتملة'],['priority','Priority','select:عادية,مهمة,عاجلة'],['clientId','Client','client'],['projectId','Project','project'],['unitId','Unit','unit'],['details','Details','textarea']]
  };
  const TYPE_MAP={workspace:'workspaces',project:'projects',unit:'units',note:'notes',client:'clients',task:'tasks'};
  function optionsFor(type){return db[TYPE_MAP[type]||type]||[]}
  function fieldHTML(f,val=''){const [key,label,type,required]=f;let input='';if(['workspace','project','unit','client'].includes(type)){const arr=optionsFor(type);input=`<select name="${key}"><option value="">Not specified</option>${arr.map(x=>`<option value="${esc(x.id)}" ${val===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select>`}else if(type.startsWith('select:')){const opts=type.slice(7).split(',');input=`<select name="${key}"><option value="">Choose...</option>${opts.map(x=>`<option value="${esc(x)}" ${val===x?'selected':''}>${esc(x)}</option>`).join('')}</select>`}else if(type==='textarea'){input=`<textarea name="${key}" ${required?'required':''}>${esc(val)}</textarea>`}else{input=`<input name="${key}" type="${type}" value="${esc(val)}" ${required?'required':''} ${type==='color'?'':''}>`}return `<div class="field ${type==='textarea'?'full':''}"><label>${esc(label)}${required?' *':''}</label>${input}</div>`}
  function openForm(type,id=null){const schema=schemas[type];if(!schema)return;const collection=TYPE_MAP[type],old=id?get(collection,id):{};editing={type,id};document.getElementById('modalTitle').textContent=(id?'Updated ':'Add ')+LABELS[collection];document.getElementById('formFields').innerHTML=schema.map(f=>fieldHTML(f,old?.[f[0]]??(f[0]==='color'?'#5b8cff':''))).join('');document.getElementById('modalBackdrop').classList.add('show')}
  function closeForm(){document.getElementById('modalBackdrop').classList.remove('show');editing=null}
  let viewedRecord=null;
  const EXTRA_LABELS={id:'Record ID',createdAt:'Created',updatedAt:'Last updated',startedAt:'Started',color:'Color',mapUrl:'Map link',commission:'Commission',installments:'Installment details'};
  function detailValue(value,key,type){
    if(value===null||value===undefined||value==='')return '<span class="detail-empty">—</span>';
    if(type&&TYPE_MAP[type]){const linked=get(TYPE_MAP[type],value);return esc(linked?.name||linked?.title||value)}
    if(Array.isArray(value))return esc(value.join('، '));
    if(typeof value==='object')return esc(JSON.stringify(value));
    if(type==='color'||key==='color'){const color=String(value),safeColor=/^#[\da-f]{3,8}$/i.test(color)?color:'#777777';return `<span class="detail-color"><i style="background:${safeColor}"></i>${esc(color)}</span>`}
    if((type?.startsWith('select:')||['status','priority'].includes(key))&&window.appTranslate)return esc(window.appTranslate(value));
    if(type==='url'||key==='mapUrl'){
      try{const url=new URL(String(value),location.href);if(['http:','https:'].includes(url.protocol))return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>`}catch{}
    }
    if(['createdAt','updatedAt','startedAt'].includes(key)){const date=new Date(value);if(!Number.isNaN(date.getTime()))return esc(date.toLocaleString(document.documentElement.lang==='en'?'en-US':'ar-EG'))}
    return esc(value);
  }
  function showRecord(type,id){
    const resolvedType=TYPE_MAP[type]?type:Object.keys(TYPE_MAP).find(key=>TYPE_MAP[key]===type),collection=TYPE_MAP[resolvedType],record=collection&&get(collection,id),schema=schemas[resolvedType];if(!record||!schema)return;
    viewedRecord={type:resolvedType,id};document.getElementById('detailTitle').textContent=record.name||record.title||LABELS[collection]||'Record details';
    const fields=schema.map(([key,label,inputType])=>({key,label,value:record[key],inputType}));
    Object.keys(record).filter(key=>!['id','createdAt','updatedAt'].includes(key)&&!schema.some(field=>field[0]===key)).forEach(key=>fields.push({key,label:EXTRA_LABELS[key]||key,value:record[key]}));
    document.getElementById('detailFields').innerHTML=fields.map(field=>`<div class="detail-field"><dt>${esc(field.label)}</dt><dd>${detailValue(field.value,field.key,field.inputType)}</dd></div>`).join('');
    document.getElementById('detailBackdrop').classList.add('show');if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}});
  }
  function closeRecord(){document.getElementById('detailBackdrop').classList.remove('show');viewedRecord=null}
  document.getElementById('detailClose').onclick=closeRecord;document.getElementById('detailDismiss').onclick=closeRecord;document.getElementById('detailBackdrop').addEventListener('click',event=>{if(event.target.id==='detailBackdrop')closeRecord()});
  document.getElementById('detailEdit').onclick=()=>{if(!viewedRecord)return;const {type,id}=viewedRecord;closeRecord();openForm(type,id)};
  let confirmResolver=null;
  function confirmInApp(message){document.getElementById('confirmMessage').textContent=message;document.getElementById('confirmBackdrop').classList.add('show');return new Promise(resolve=>{confirmResolver=resolve})}
  function finishConfirm(result){document.getElementById('confirmBackdrop').classList.remove('show');if(confirmResolver){confirmResolver(result);confirmResolver=null}}
  document.getElementById('confirmAccept').onclick=()=>finishConfirm(true);document.getElementById('confirmCancel').onclick=()=>finishConfirm(false);document.getElementById('cancelConfirmClose').onclick=()=>finishConfirm(false);document.getElementById('confirmBackdrop').addEventListener('click',event=>{if(event.target.id==='confirmBackdrop')finishConfirm(false)});
  document.getElementById('closeModal').onclick=closeForm;document.getElementById('cancelModal').onclick=closeForm;document.getElementById('modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeForm()});
  document.getElementById('entityForm').addEventListener('submit',async e=>{
    e.preventDefault();if(!editing)return;if(!isReady){toast('Please sign in first.');return}
    const submit=e.target.querySelector('[type="submit"]');submit.disabled=true;submit.textContent='Saving...';
    try{
      const {type,id}=editing,collection=TYPE_MAP[type],old=id?get(collection,id):{};
      const data=Object.fromEntries(new FormData(e.target).entries());if(type==='note')data.tags=(data.tags||'').split(',').map(x=>x.trim()).filter(Boolean);
      const now=new Date().toISOString(),record={...old,...data,id:id||uid(),createdAt:old?.createdAt||now,updatedAt:now};if(type==='task'){record.status=data.status||old?.status||'معلقة';record.startedAt=record.status==='قيد التنفيذ'?(old?.status===record.status?(old.startedAt||old.updatedAt||now):now):null}if(type==='workspace'&&!record.color)record.color='#5b8cff';
      const next={...db,[collection]:id?db[collection].map(x=>x.id===id?record:x):[record,...db[collection]]};
      const result=await saveDatabase(next);db=next;localRevision++;cacheLocalDatabase(db,!navigator.onLine||!!result?.queued);renderAll();syncNativeTaskReminders();closeForm();toast(result?.queued?(result.error||new Error(navigator.onLine?'Saved locally, but syncing with the cloud failed.':'Saved on this device. It will sync when the connection returns.')):assignmentText('Saved successfully','Saved successfully'));
    }catch(err){toast('Save failed: '+err.message)}finally{submit.disabled=false;submit.textContent='Save'}
  });
  async function deleteItem(type,id){
    const collection=TYPE_MAP[type]||type;if(!await confirmInApp('Permanently delete this record from the database?'))return;
    if(!isReady){toast('Please sign in first.');return}
    const next={...db,[collection]:db[collection].filter(x=>x.id!==id)};
    try{
      const result=await saveDatabase(next);db=next;localRevision++;
      if(collection==='tasks'){
        for(let i=taskAlerts.length-1;i>=0;i--)if(taskAlerts[i].taskId===id){closeBrowserNotification(taskAlerts[i].key);taskAlerts.splice(i,1)}
        for(const key of [...notifiedTaskReminders])if(key.startsWith(id+':'))notifiedTaskReminders.delete(key);
        persistTaskAlertState();
      }
      cacheLocalDatabase(db,!navigator.onLine||!!result?.queued);renderAll();syncNativeTaskReminders();
      toast(result?.queued?(result.error||new Error(navigator.onLine?'Saved locally, but syncing with the cloud failed.':'Saved on this device. It will sync when the connection returns.')):assignmentText('Deleted successfully','Deleted successfully'))
    }catch(err){toast('Delete failed: '+err.message)}
  }
  async function changeTaskStatus(id,status,button){
    if(!isReady){toast('Please sign in first.');return}
    const task=get('tasks',id);if(!task)return;
    const nextStatus=status==='قيد التنفيذ'?'مكتملة':status==='معلقة'?'قيد التنفيذ':null;
    if(!nextStatus)return;
    const currentStatus=task.status==='قيد التنفيذ'?'قيد التنفيذ':task.status==='مكتملة'?'مكتملة':'معلقة';
    if(currentStatus!==status){toast('This follow-up was updated on another device. Wait for sync and try again.');return}
    button.disabled=true;
    const now=new Date().toISOString(),record={...task,status:nextStatus,updatedAt:now,startedAt:nextStatus==='قيد التنفيذ'?now:null};
    const next={...db,tasks:db.tasks.map(item=>item.id===id?record:item)};
    try{const result=await saveDatabase(next);db=next;localRevision++;cacheLocalDatabase(db,!navigator.onLine||!!result?.queued);renderAll();syncNativeTaskReminders();toast(!navigator.onLine||result?.queued?'Saved locally. Changes will sync when internet returns.':(nextStatus==='قيد التنفيذ'?'Follow-up started':'Follow-up completed'))}
    catch(err){button.disabled=false;toast('Could not change follow-up status: '+err.message)}
  }
  function emptyHTML(title,sub){return `<div class="empty"><b>${esc(title)}</b>${esc(sub)}</div>`}
  function actions(type,item){const statusAction=type==='task'&&item.status!=='مكتملة'?`<button class="btn small primary" data-task-status="${esc(item.status==='قيد التنفيذ'?'قيد التنفيذ':'معلقة')}" data-id="${esc(item.id)}">${item.status==='قيد التنفيذ'?'Complete':'بدء'}</button>`:'';return `<div class="card-actions"><button class="btn small" data-record-view="${type}" data-id="${esc(item.id)}"><i data-lucide="eye"></i> عرض</button><button class="btn small" data-edit="${type}" data-id="${esc(item.id)}">Updated</button>${statusAction}<button class="btn small danger" data-delete="${type}" data-id="${esc(item.id)}">حذف</button></div>`}
  function renderAll(){renderDashboard();renderWorkspaces();renderProjects();renderUnits();renderNotes();renderClients();renderTasks();refreshFilters();if(currentView==='assigned')renderAssignedView();if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}})}
  window.addEventListener('app-language-change',renderAll);
  function renderDashboard(){for(const [id,key] of [['statSpaces','workspaces'],['statProjects','projects'],['statUnits','units'],['statNotes','notes']])document.getElementById(id).textContent=db[key].length;renderRecentActions();const spaces=db.workspaces.slice(0,5);document.getElementById('dashboardSpaces').innerHTML=spaces.length?spaces.map(s=>`<div class="list-item"><div class="workspace-row"><span class="workspace-color" style="background:${esc(s.color||'#5b8cff')}"></span><strong>${esc(s.name)}</strong></div><span class="pill">${db.projects.filter(p=>p.workspaceId===s.id).length} Projects</span></div>`).join(''):emptyHTML('No workspaces yet','Create a workspace to organize your projects.');const tasks=sortedTasks(db.tasks.filter(t=>t.status!=='مكتملة')).slice(0,5);document.getElementById('dashboardTasks').innerHTML=tasks.length?tasks.map(taskCard).join(''):emptyHTML('No open follow-ups','Add a follow-up to see it here by priority.')}
  function renderRecentActions(){const entries=TYPES.flatMap(collection=>db[collection].map(record=>{const created=record.createdAt||'',updated=record.updatedAt||created;return{record,collection,updatedAt:updated,sortTime:Date.parse(updated)||Date.parse(created)||0,isUpdate:!!created&&!!record.updatedAt&&record.updatedAt!==created}})).sort((a,b)=>b.sortTime-a.sortTime).slice(0,6);const host=document.getElementById('dashboardActivity');host.innerHTML=entries.length?entries.map(({record,collection,updatedAt,isUpdate})=>{const entity=window.appTranslate(LABELS[collection]),description=document.documentElement.lang==='en'?`${isUpdate?'Updated':'Added'} ${entity.toLowerCase()}`:`${isUpdate?'Updated':'Add'} ${LABELS[collection]}`;return`<div class="list-item"><div><strong>${esc(record.name||record.title||'Untitled')}</strong><small>${esc(description)}</small></div><span class="pill">${dateLabel(updatedAt)}</span></div>`}).join(''):emptyHTML('No activity yet','Add or update a record to see it here.')}
  function renderWorkspaces(){const el=document.getElementById('workspaceList');el.innerHTML=db.workspaces.length?db.workspaces.map(s=>`<article class="entity-card"><div class="workspace-row"><span class="workspace-color" style="background:${esc(s.color||'#5b8cff')}"></span><h3>${esc(s.name)}</h3></div><p>${esc(s.description||'No description')}</p><div class="entity-meta"><span class="pill">${db.projects.filter(x=>x.workspaceId===s.id).length} Project</span><span class="pill">${db.notes.filter(x=>x.workspaceId===s.id).length} Note</span></div>${actions('workspace',s)}</article>`).join(''):emptyHTML('Create your first workspace','For example: North Coast, Cairo, General.')}
  function renderProjects(){const q=(document.getElementById('projectFilter')?.value||'').toLowerCase(),w=document.getElementById('projectWorkspaceFilter')?.value||'';const arr=db.projects.filter(p=>(!w||p.workspaceId===w)&&JSON.stringify(p).toLowerCase().includes(q));document.getElementById('projectList').innerHTML=arr.length?arr.map(p=>`<article class="entity-card"><h3>${esc(p.name)}</h3><p>${esc([p.developer,p.location,p.type?window.appTranslate(p.type):''].filter(Boolean).join(' • ')||'No additional details')}</p><div class="entity-meta"><span class="pill">${esc(nameOf('workspaces',p.workspaceId))}</span><span class="pill">${db.units.filter(u=>u.projectId===p.id).length} Units</span>${p.delivery?`<span class="pill amber">Delivery ${esc(p.delivery)}</span>`:''}</div>${p.payment?`<p class="spaced-copy">${esc(p.payment.slice(0,130))}</p>`:''}${actions('project',p)}</article>`).join(''):emptyHTML('No matching projects','Add a project or change your search.')}
  function renderUnits(){const q=(document.getElementById('unitFilter')?.value||'').toLowerCase(),p=document.getElementById('unitProjectFilter')?.value||'';const arr=db.units.filter(u=>(!p||u.projectId===p)&&JSON.stringify(u).toLowerCase().includes(q));document.getElementById('unitList').innerHTML=arr.length?arr.map(u=>`<article class="entity-card"><h3>${esc(u.name)}</h3><p>${esc(nameOf('projects',u.projectId))} • ${esc(u.type?window.appTranslate(u.type):'Unit')}</p><div class="entity-meta">${u.area?`<span class="pill">${esc(u.area)} م²</span>`:''}${u.floor?`<span class="pill">Floor ${esc(u.floor)}</span>`:''}${u.price?`<span class="pill green">${Number(u.price).toLocaleString('en-US')} EGP</span>`:''}<span class="pill">${esc(u.status||'غير محدد')}</span></div>${actions('unit',u)}</article>`).join(''):emptyHTML('No units yet','Add a unit and link it to a project.')}
  function renderNotes(){const q=(document.getElementById('noteFilter')?.value||'').toLowerCase(),w=document.getElementById('noteWorkspaceFilter')?.value||'';const arr=[...db.notes].filter(n=>(!w||n.workspaceId===w)&&JSON.stringify(n).toLowerCase().includes(q)).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));document.getElementById('noteList').innerHTML=arr.length?arr.map(n=>`<article class="entity-card"><h3>${esc(n.title)}</h3><p>${esc([nameOf('projects',n.projectId),nameOf('units',n.unitId),nameOf('clients',n.clientId)].filter(x=>x!=='Not linked').join(' • ')||'General note')}</p><div class="note-body">${esc(n.content||'')}</div>${n.tags?.length?`<div class="note-tags">${n.tags.map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}<div class="entity-meta spaced-meta"><span class="pill">${dateLabel(n.updatedAt)}</span><span class="pill">${esc(nameOf('workspaces',n.workspaceId))}</span></div>${actions('note',n)}</article>`).join(''):emptyHTML('No notes yet','Add a note and link it to a project, unit, or client.')}
  function renderClients(){const el=document.getElementById('clientList');el.innerHTML=db.clients.length?db.clients.map(c=>`<article class="entity-card"><h3>${esc(c.name)}</h3><p>${esc(c.phone||'No phone number')} • ${esc(c.area||'Area not specified')}</p><div class="entity-meta"><span class="pill">${esc(c.status||'جديد')}</span>${c.budget?`<span class="pill green">${esc(c.budget)}</span>`:''}</div>${c.notes?`<p class="spaced-copy">${esc(c.notes.slice(0,120))}</p>`:''}${actions('client',c)}</article>`).join(''):emptyHTML('No clients yet','Add client details and requirements.')}
  function taskPriorityRank(task){return {'عاجلة':0,'مهمة':1,'عادية':2}[task.priority]??3}
  function sortedTasks(tasks){return [...tasks].sort((a,b)=>taskPriorityRank(a)-taskPriorityRank(b)||(a.dueDate||'9999-12-31').localeCompare(b.dueDate||'9999-12-31')||(a.dueTime||'').localeCompare(b.dueTime||''))}
  function taskCard(t){return `<article class="entity-card"><h3>${esc(t.title)}</h3><p>${esc([nameOf('clients',t.clientId),nameOf('projects',t.projectId)].filter(x=>x!=='Not linked').join(' • ')||'General follow-up')}</p><div class="entity-meta"><span class="pill ${t.status==='مكتملة'?'green':t.status==='قيد التنفيذ'?'amber':'red'}">${esc(t.status||'معلقة')}</span><span class="pill ${t.priority==='عاجلة'?'red':t.priority==='مهمة'?'amber':''}">${esc(t.priority||'عادية')}</span><span class="pill">${dateLabel(t.dueDate)} ${esc(t.dueTime||'')}</span></div>${t.details?`<p class="spaced-copy">${esc(t.details.slice(0,110))}</p>`:''}${actions('task',t)}</article>`}
  function renderTasks(){const search=(document.getElementById('taskSearch')?.value||'').trim().toLowerCase(),priority=document.getElementById('taskPriorityFilter')?.value||'',from=document.getElementById('taskDateFrom')?.value||'',to=document.getElementById('taskDateTo')?.value||'',groups=[['معلقة','taskPendingList','taskPendingCount'],['قيد التنفيذ','taskInProgressList','taskInProgressCount'],['مكتملة','taskCompletedList','taskCompletedCount']];for(const [status,listId,countId] of groups){const tasks=sortedTasks(db.tasks.filter(task=>{const taskStatus=task.status==='مكتملة'?'مكتملة':task.status==='قيد التنفيذ'?'قيد التنفيذ':'معلقة',dueDate=task.dueDate||'';return taskStatus===status&&(!search||JSON.stringify(task).toLowerCase().includes(search))&&(!priority||task.priority===priority)&&(!from&&!to||!!dueDate&&(!from||dueDate>=from)&&(!to||dueDate<=to))}));document.getElementById(countId).textContent=String(tasks.length);document.getElementById(listId).innerHTML=tasks.length?tasks.map(taskCard).join(''):emptyHTML('No matching follow-ups','Change the filters or add a follow-up.')}}
  function refreshFilters(){const fill=(id,arr,first)=>{const el=document.getElementById(id);if(!el)return;const val=el.value;el.innerHTML=`<option value="">${first}</option>`+arr.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');el.value=val};fill('projectWorkspaceFilter',db.workspaces,'All workspaces');fill('unitProjectFilter',db.projects,'All projects');fill('noteWorkspaceFilter',db.workspaces,'All workspaces')}
  ['projectFilter','projectWorkspaceFilter','unitFilter','unitProjectFilter','noteFilter','noteWorkspaceFilter'].forEach(id=>document.getElementById(id).addEventListener('input',()=>({projectFilter:renderProjects,projectWorkspaceFilter:renderProjects,unitFilter:renderUnits,unitProjectFilter:renderUnits,noteFilter:renderNotes,noteWorkspaceFilter:renderNotes})[id]()));
  ['taskSearch','taskPriorityFilter','taskDateFrom','taskDateTo'].forEach(id=>document.getElementById(id).addEventListener('input',renderTasks));
  document.getElementById('quickAdd').onclick=event=>{const type=event.currentTarget.dataset.quickAddType;if(type)openForm(type);else document.getElementById('quickAddBackdrop').classList.add('show')};document.getElementById('quickAddClose').onclick=()=>document.getElementById('quickAddBackdrop').classList.remove('show');document.getElementById('quickAddBackdrop').addEventListener('click',event=>{if(event.target.id==='quickAddBackdrop')event.currentTarget.classList.remove('show');const button=event.target.closest('[data-quick-type]');if(button){event.currentTarget.classList.remove('show');openForm(button.dataset.quickType)}});
  document.getElementById('globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter')searchAll(e.target.value)});
  function searchAll(q){q=q.trim().toLowerCase();if(!q)return;const results=[];for(const type of TYPES)for(const x of db[type])if(JSON.stringify(x).toLowerCase().includes(q))results.push({type,item:x});document.getElementById('searchCaption').textContent=`${results.length} results for: ${q}`;document.getElementById('searchList').innerHTML=results.length?results.map(({type,item})=>`<article class="entity-card"><div class="entity-meta"><span class="pill">${LABELS[type]}</span></div><h3 class="spaced-title">${esc(item.name||item.title||'Untitled')}</h3><p>${esc(item.content||item.description||item.location||item.phone||'')}</p><div class="card-actions"><button class="btn small" data-record-view="${type}" data-id="${esc(item.id)}"><i data-lucide="eye"></i> عرض</button><button class="btn small" data-view="${type}">Open section</button></div></article>`).join(''):emptyHTML('No results','Try different search terms.');document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));document.getElementById('searchResults').classList.add('active');document.getElementById('pageHeading').textContent='Search results';document.getElementById('pageSub').textContent='Search your entire database';updateQuickAdd('');if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}})}
  const assignmentRequestsInFlight=new Map();
  async function apiPost(payload){
    const guarded=['assignment_detail','assignment_create','assignment_update','assignment_status','assignment_reassign','reassignment_request','reassignment_review','assignment_note_add','assignment_archive','assignment_restore'];
    const key=guarded.includes(payload.action)?payload.action+':'+String(payload.assignmentId||payload.requestId||'global'):'';
    if(key&&assignmentRequestsInFlight.has(key))throw new Error('Another operation is still running. Please wait.');
    const request=(async()=>{
    const response=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json','apikey':SUPABASE_PUBLISHABLE_KEY,'x-smartnote-session':authToken},body:JSON.stringify({...payload,token:authToken})});
    const raw=await response.text();let result;try{result=JSON.parse(raw)}catch{const error=new Error('The server returned an invalid response.');error.errorCode='HTTP_'+response.status;error.userMessage='The server returned an invalid response.';throw error}
    if(!response.ok||result.error||result.ok===false){const error=new Error(result.message||result.error||('HTTP_'+response.status));error.errorCode=result.code||result.dbCode||result.error||('HTTP_'+response.status);error.userMessage=result.message||result.error||'The request failed.';error.details=result.details||result.dbMessage||result.dbDetails||'';throw error}return result;
    })();
    if(key)assignmentRequestsInFlight.set(key,request);
    try{return await request}finally{if(key&&assignmentRequestsInFlight.get(key)===request)assignmentRequestsInFlight.delete(key)}
  }
  function cloudPayload(state){return {...state,spaces:state.workspaces||[]}}
  async function saveDatabase(nextState){
    const snapshot=cloudPayload(nextState);
    cacheLocalDatabase(snapshot,true);
    if(!navigator.onLine||!authToken)return {queued:true};
    writesInProgress++;
    const requestedRevision=localRevision;
    saveQueue=saveQueue.catch(()=>{}).then(()=>apiPost({action:'save',data:snapshot,revision:cloudRevision}));
    try{const result=await saveQueue;cloudRevision=Number(result.revision)||cloudRevision;if(requestedRevision===localRevision){clearPendingSync();cacheLocalDatabase(snapshot,false)}else cacheLocalDatabase(db,true);return result}catch(error){cacheLocalDatabase(db,true);return {queued:true,error}}finally{writesInProgress--}
  }
  function normalizeDatabase(data){const d=data&&typeof data==='object'?data:{};return {...emptyDB(),...d,workspaces:Array.isArray(d.workspaces)?d.workspaces:(Array.isArray(d.spaces)?d.spaces:[]),tasks:Array.isArray(d.tasks)?d.tasks.map(task=>task.status==='قيد التنفيذ'&&!task.startedAt?{...task,startedAt:task.updatedAt||task.createdAt||null}:task):[]};}
  async function syncCloud(){
    if(!isReady||!authToken||!navigator.onLine||document.hidden||editing||writesInProgress||syncInFlight)return;
    syncInFlight=true;const revision=localRevision;
    try{
      if(hasPendingSync()){
        const pendingLocalRevision=localRevision,localSnapshot=cloudPayload(db);
        try{
          const saved=await apiPost({action:'save',data:localSnapshot,revision:cloudRevision});
          cloudRevision=Number(saved.revision)||cloudRevision;
          if(pendingLocalRevision===localRevision){clearPendingSync();cacheLocalDatabase(db,false)}
        }catch(saveError){
          if(saveError.message!=='Your data changed on another device. Sync before trying again.')throw saveError;
          const latest=await apiPost({action:'load'});
          cloudRevision=Number(latest.revision)||0;
          if(pendingLocalRevision!==localRevision)throw new Error('Your data changed on another device. Sync before trying again.');
          const keepLocal=window.confirm('تم Updated بيانات هذا الحساب من جهاز آخر. اضغط موافق للاحتفاظ بالتعديلات الموجودة على هذا الجهاز ورفعها، أو Cancel لتحميل أحدث نسخة من السحابة.');
          if(pendingLocalRevision!==localRevision)throw new Error('Your data changed on another device. Sync before trying again.');
          if(keepLocal){
            const retried=await apiPost({action:'save',data:localSnapshot,revision:cloudRevision});
            cloudRevision=Number(retried.revision)||cloudRevision;
            clearPendingSync();cacheLocalDatabase(db,false);
          }else{
            db=normalizeDatabase(latest.data||{});cloudRevision=Number(latest.revision)||0;
            clearPendingSync();cacheLocalDatabase(db,false);renderAll();syncNativeTaskReminders();
          }
        }
      }
      const result=await apiPost({action:'load'});
      const remote=normalizeDatabase(result.data||{});cloudRevision=Number(result.revision)||cloudRevision;
      if(revision!==localRevision||editing||writesInProgress)return;
      const dismissed=new Set([...(db.taskNotificationDismissals||[]),...(remote.taskNotificationDismissals||[])]);remote.taskNotificationDismissals=[...dismissed];
      if(JSON.stringify(cloudPayload(remote))!==JSON.stringify(cloudPayload(db))){db=remote;cacheLocalDatabase(db,false);renderAll();syncNativeTaskReminders()}
      const existingTaskIds=new Set(db.tasks.map(task=>task.id));
      let deletedTaskAlerts=false;
      for(let i=taskAlerts.length-1;i>=0;i--)if(!existingTaskIds.has(taskAlerts[i].taskId)){closeBrowserNotification(taskAlerts[i].key);taskAlerts.splice(i,1);deletedTaskAlerts=true}
      if(deletedTaskAlerts)persistTaskAlertState();
      const removed=taskAlerts.filter(alert=>dismissed.has(alert.key));if(removed.length){removed.forEach(alert=>closeBrowserNotification(alert.key));for(let i=taskAlerts.length-1;i>=0;i--)if(dismissed.has(taskAlerts[i].key))taskAlerts.splice(i,1);persistTaskAlertState();renderTaskAlerts()}
      setConnection(true,'Automatic cloud synchronization.');
    }catch(err){setConnection(false,'Could not update data: '+err.message)}
    finally{syncInFlight=false}
  }
  function showLogin(message=''){
    isReady=false;document.getElementById('onlineGate').style.display='none';
    let gate=document.getElementById('loginGate');
    if(!gate){
      gate=document.createElement('div');gate.id='loginGate';gate.className='online-gate login-gate';gate.style.zIndex='10000';
      gate.innerHTML='<div class="online-gate-card login-card"><div class="login-brand"><span class="login-brand-mark"><i data-lucide="building-2"></i></span><span><strong>SmartNote</strong><small>Smart Real Estate Notebook</small></span></div><div class="login-heading"><h2 class="online-gate-title">Welcome back</h2><p class="online-gate-message">Sign in to access your data and workspaces.</p></div><form id="loginForm" class="login-form"><label class="login-field"><span>Username</span><span class="login-input-wrap"><i data-lucide="user-round"></i><input id="loginUsername" autocomplete="username" placeholder="أدخل اسم المستخدم" required minlength="3"></span></label><label class="login-field"><span>Password</span><span class="login-input-wrap"><i data-lucide="lock-keyhole"></i><input id="loginPassword" type="password" autocomplete="current-password" placeholder="أدخل كلمة المرور" required></span></label><p id="loginError" class="login-error" role="alert"></p><button class="btn primary login-submit" type="submit"><span>Sign in</span><i data-lucide="arrow-left"></i></button></form><p class="login-footnote"><i data-lucide="shield-check"></i> Your data is stored separately and securely</p></div>';
      document.body.appendChild(gate);
      document.getElementById('loginForm').addEventListener('submit',async e=>{
        e.preventDefault();const button=e.currentTarget.querySelector('button[type=submit]'),username=document.getElementById('loginUsername').value.trim(),password=document.getElementById('loginPassword').value;
        button.disabled=true;button.classList.add('is-loading');document.getElementById('loginError').textContent='Verifying your credentials...';
        try{const result=await apiPost({action:'login',username,password});authToken=result.token;currentUser=result.user;localStorage.setItem(SESSION_KEY,JSON.stringify({token:authToken,user:currentUser}));await afterLogin(result.data||{},result.revision)}
        catch(err){if(err.message==='Invalid username or password, or your session has expired.'||err.message==='This account is disabled.'){authToken='';currentUser=null;localStorage.removeItem(SESSION_KEY);document.getElementById('loginError').textContent='Incorrect username or password'}else{document.getElementById('loginError').textContent='Could not connect to the server: '+err.message}}
        finally{button.disabled=false;button.classList.remove('is-loading')}
      });
      if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}});
    }
    gate.style.display='flex';document.getElementById('loginError').textContent=message;
  }
  async function syncFcmDeviceToken(){
    if(!authToken||!window.smartNoteNativeNotifications?.isNative)return;
    let fcmToken='';
    try{fcmToken=localStorage.getItem('smartnote_fcm_token')||''}catch{}
    if(!fcmToken){
      const diagnostic={stage:'token_missing_after_login',at:new Date().toISOString()};
      try{localStorage.setItem('smartnote_fcm_sync_status',JSON.stringify(diagnostic))}catch{}
      console.warn('[SmartNote FCM] No token has been issued by the Android plugin yet.');
      return;
    }
    try{
      const result=await apiPost({action:'push_register',fcmToken,platform:'android'});
      if(!result.registered)throw new Error('Supabase did not confirm device registration');
      const status={ok:true,stage:'saved_in_supabase',registered:true,deviceId:result.deviceId||'',at:new Date().toISOString()};
      console.info('[SmartNote FCM] Device row confirmed by Supabase:',status.deviceId);
      try{localStorage.setItem('smartnote_fcm_sync_status',JSON.stringify(status))}catch{}
      window.dispatchEvent(new CustomEvent('smartnote-fcm-sync-result',{detail:status}));
      const test=await apiPost({action:'push_test'});
      console.info('[SmartNote FCM] Test push result:',test);
      toast(test.sent>0?'A test notification was sent to your phone':('Device registered, but the test notification could not be sent: '+String(test.reason||test.failed||'Check your Firebase configuration')));
    }catch(error){
      const status={ok:false,stage:'supabase_save_failed',error:String(error?.message||error),at:new Date().toISOString()};
      console.error('[SmartNote FCM] Supabase token save failed:',error);
      try{localStorage.setItem('smartnote_fcm_sync_status',JSON.stringify(status))}catch{}
      window.dispatchEvent(new CustomEvent('smartnote-fcm-sync-result',{detail:status}));
    }
  }
  window.addEventListener('smartnote-fcm-token',()=>syncFcmDeviceToken());
  window.addEventListener('smartnote-fcm-diagnostic',event=>{
    const d=event.detail||{};
    console.warn('[SmartNote FCM] Diagnostic:',d);
    if(d.stage==='registration_error'||d.stage==='register_exception'){
      toast('Phone notification registration failed: '+String(d.error||d.stage));
    }
  });
  window.addEventListener('smartnote-fcm-sync-result',event=>{
    const d=event.detail||{};
    if(d.ok)toast('Your device is registered to receive notifications.');
    else toast('Could not save the notification token to the cloud service: '+String(d.error||'Unknown error'));
  });
  async function afterLogin(preloadedData,preloadedRevision){
    try{const preferredLanguage=document.documentElement.lang==='ar'?'ar':'en';await apiPost({action:'profile_language_set',language:preferredLanguage});currentUser.preferredLanguage=preferredLanguage;localStorage.setItem(SESSION_KEY,JSON.stringify({token:authToken,user:currentUser}))}catch(error){console.warn('Could not save notification language:',error)}
    if(currentUser?.mustChangePassword){const oldPassword=prompt(document.documentElement.lang==='en'?'Temporary password:':'Enter the temporary password:');const newPassword=prompt(document.documentElement.lang==='en'?'Choose a new password (at least 10 characters):':'Choose a new password (at least 10 characters):');if(!oldPassword||!newPassword||newPassword.length<10){authToken='';currentUser=null;localStorage.removeItem(SESSION_KEY);showLogin(document.documentElement.lang==='en'?'Password change is required to continue.':'You must change your password to continue.');return}try{await apiPost({action:'change_password',currentPassword:oldPassword,newPassword});currentUser.mustChangePassword=false;localStorage.setItem(SESSION_KEY,JSON.stringify({token:authToken,user:currentUser}));toast(document.documentElement.lang==='en'?'Password updated.':'Password changed successfully')}catch(error){authToken='';currentUser=null;localStorage.removeItem(SESSION_KEY);showLogin(document.documentElement.lang==='en'?'Could not change password. Sign in again.':'Could not change password. Please sign in again.');return}}
    const result=preloadedData&&typeof preloadedData==='object'?{data:preloadedData,revision:preloadedRevision}:await apiPost({action:'load'});cloudRevision=Number(result.revision??preloadedRevision??0)||0;db=normalizeDatabase(result.data||{});isReady=true;localRevision=0;cacheLocalDatabase(db,hasPendingSync());renderAll();try{const saved=JSON.parse(sessionStorage.getItem('smartnote-language-switch-state')||'null');if(saved?.fields)for(const [id,value] of Object.entries(saved.fields)){const el=document.getElementById(id);if(el)el.value=value}if(saved?.view)showView(saved.view);if(saved?.scrollY)window.scrollTo(0,saved.scrollY);sessionStorage.removeItem('smartnote-language-switch-state')}catch{}syncNativeTaskReminders();syncFcmDeviceToken();
    const pendingTaskId=new URLSearchParams(window.location.search).get('openTask');
    if(pendingTaskId){if(get('tasks',pendingTaskId)){showView('tasks');openForm('task',pendingTaskId)}const cleanUrl=new URL(window.location.href);cleanUrl.searchParams.delete('openTask');window.history.replaceState({},'',cleanUrl.toString())}
    requestNotificationPermissionOnStartup();// Login gate is created only for manual login; keep automatic session restore safe.
    document.getElementById('loginGate')?.style.setProperty('display','none');hideGate();setConnection(true,'Signed in and synced with the cloud database.');
    const welcome=document.getElementById('welcomeUser');if(welcome){welcome.hidden=false;welcome.textContent=(document.documentElement.lang==='en'?'Welcome, ':'Welcome, ')+(currentUser?.username||'')}
    if(currentUser?.role==='admin') addAdminButton();
    document.getElementById('assignedHeaderCreateButton')?.addEventListener('click',createAssignedFollowup);loadAssignedView();
    ['assignedSearch','assignedAssigneeFilter','assignedPriorityFilter','assignedDateFrom','assignedDateTo'].forEach(id=>document.getElementById(id)?.addEventListener(id==='assignedSearch'?'input':'change',renderAssignedView));
    const av=document.getElementById('view-assigned');if(av&&!av.dataset.bound){av.dataset.bound='1';av.addEventListener('click',async e=>{const o=e.target.closest('[data-assignment-open]'),s=e.target.closest('[data-assignment-save]');if(o)await openAssignedDetail(o.dataset.assignmentOpen);if(s){const id=s.dataset.assignmentSave,sel=av.querySelector('[data-assignment-status="'+CSS.escape(id)+'"]');try{await apiPost({action:'assignment_status',assignmentId:id,status:sel.value});toast(assignmentText('Status updated.','Status updated'));await loadAssignedView()}catch(err){toast(err)}}})}
    refreshUnifiedNotifications();
    startRealtimeSync();
    // Assignment navigation is integrated into the primary navigation.
    if(!document.getElementById('logoutButton')){const b=document.createElement('button');b.id='logoutButton';b.className='btn small';b.textContent=window.appTranslate?.('Sign out')||(document.documentElement.lang==='en'?'Sign out':'Sign out');b.onclick=async()=>{try{await apiPost({action:'logout'})}catch(_){}stopRealtimeSync();authToken='';currentUser=null;isReady=false;localStorage.removeItem(SESSION_KEY);showLogin('You have been signed out.');document.getElementById('adminUsersButton')?.remove();b.remove()};document.querySelector('.top-actions').prepend(b)}

  }
  window.addEventListener('app-language-change',()=>{const button=document.getElementById('logoutButton');if(button)button.textContent=window.appTranslate?.('Sign out')||(document.documentElement.lang==='en'?'Sign out':'Sign out');const w=document.getElementById('welcomeUser');if(w&&currentUser)w.textContent=(document.documentElement.lang==='en'?'Welcome, ':'Welcome, ')+currentUser.username;if(currentView==='assigned')loadAssignedView();refreshUnifiedNotifications()});
  function addAdminButton(){
    if(document.getElementById('adminUsersButton'))return;
    const b=document.createElement('button');b.id='adminUsersButton';b.className='btn small';b.textContent='User management';b.onclick=openAdminPanel;document.querySelector('.top-actions').prepend(b);
  }
  async function openAdminPanel(){
    try{
      const data=await apiPost({action:'admin_list'});let panel=document.getElementById('adminPanel');
      if(!panel){
        panel=document.createElement('div');panel.id='adminPanel';panel.className='online-gate admin-gate';panel.style.zIndex='10001';
        panel.innerHTML='<section class="admin-shell"><header class="admin-header"><div><span class="admin-eyebrow">SMARTNOTE CONTROL CENTER</span><h2><i data-lucide="users-round"></i> User management</h2><p>Create accounts and manage roles and passwords.</p></div><button class="btn icon-btn" id="closeAdminPanel" type="button" aria-label="إغلاق"><i data-lucide="x"></i></button></header><form id="createUserForm" class="admin-create-form"><div class="admin-create-title"><i data-lucide="user-plus"></i><strong>Add new user</strong></div><label><span>Username</span><input id="newUsername" class="filter-input" placeholder="مثال: ahmed123" required minlength="3" autocomplete="off"></label><label><span>Password</span><input id="newPassword" class="filter-input" type="password" placeholder="10 أحرف على الأقل" required minlength="10" autocomplete="new-password"></label><label><span>Role</span><select id="newUserRole" class="filter-input"><option value="user">User</option><option value="leader">Team lead</option><option value="admin">Administrator</option></select></label><button class="btn primary" type="submit"><i data-lucide="plus"></i> Create account</button></form><div class="admin-list-heading"><div><h3>Registered accounts</h3><p id="adminUsersCount">Manage system accounts</p></div><span class="admin-count" id="adminCountBadge">0</span></div><div id="adminUsersList" class="admin-users-list"></div><footer class="admin-footer"><span>Role and password changes take effect immediately.</span><button class="btn small" id="adminAuditButton" type="button">Audit log</button><button class="btn" id="adminDone" type="button">تم</button></footer></section>';
        document.body.appendChild(panel);
        panel.querySelector('#closeAdminPanel').onclick=()=>panel.style.display='none';
        panel.querySelector('#adminDone').onclick=()=>panel.style.display='none';
        panel.querySelector('#adminAuditButton').onclick=async()=>{const button=panel.querySelector('#adminAuditButton');button.disabled=true;try{const result=await apiPost({action:'admin_audit_list'});const entries=(result.entries||[]).map(item=>'<article class="assignment-history-item"><b>'+esc(item.actorName||'System')+'</b><span>'+esc(window.appTranslate?.(item.action)||item.action)+'</span><small>'+esc(item.targetId||'—')+' · '+assignmentDate(item.createdAt)+'</small></article>').join('')||'<div class="empty-state">No audit events recorded.</div>';showAssignmentPopup(assignmentText('Audit log','Audit log'),'<div class="assignment-history">'+entries+'</div>')}catch(error){toast(error)}finally{button.disabled=false}};
        panel.addEventListener('click',e=>{if(e.target===panel)panel.style.display='none'});
        panel.querySelector('#createUserForm').onsubmit=async e=>{
          e.preventDefault();const submit=panel.querySelector('#createUserForm button[type=submit]');submit.disabled=true;
          try{await apiPost({action:'admin_create',username:panel.querySelector('#newUsername').value.trim(),password:panel.querySelector('#newPassword').value,role:panel.querySelector('#newUserRole').value});panel.querySelector('#newUsername').value='';panel.querySelector('#newPassword').value='';toast('User created successfully.');await openAdminPanel()}
          catch(err){toast(err.message==='This username is already in use.'?'This username is already taken':err.message==='Password must be between 10 and 128 characters.'?'The password must contain at least 10 characters.':err.message)}
          finally{submit.disabled=false}
        };
        panel.querySelector('#adminUsersList').addEventListener('click',async e=>{
          const button=e.target.closest('button[data-admin-action]');if(!button||button.disabled)return;
          const row=button.closest('[data-user-row]'),userId=row?.dataset.userRow;if(!userId)return;
          button.disabled=true;
          try{
            if(button.dataset.adminAction==='status'){await apiPost({action:'admin_status',userId,status:button.dataset.status});toast('Account status updated.')}
            if(button.dataset.adminAction==='role'){await apiPost({action:'admin_role',userId,role:row.querySelector('[data-role-select]').value});toast('User role updated.')}
            if(button.dataset.adminAction==='password'){const password=row.querySelector('[data-new-user-password]').value;if(password.length<10){toast('The password must contain at least 10 characters.');return}await apiPost({action:'admin_reset_password',userId,password});row.querySelector('[data-new-user-password]').value='';toast('Password changed and previous sessions signed out.')}
            if(button.dataset.adminAction==='delete'){if(!window.confirm(window.appTranslate?.('Delete this user? This action cannot be undone.')||'Delete this user? This action cannot be undone.'))return;await apiPost({action:'admin_delete',userId});toast('User deleted successfully.')}
            await openAdminPanel();
          }catch(err){toast(err.message==='You cannot change your own role.'?'You cannot change your own role here.':err.message==='Password must be between 10 and 128 characters.'?'The password must contain at least 10 characters.':err.message)}
          finally{if(button.isConnected)button.disabled=false}
        });
      }
      panel.querySelector('#adminUsersList').innerHTML=data.users.map(u=>'<article class="admin-user-card" data-user-row="'+esc(u.id)+'"><div class="admin-user-top"><div class="admin-avatar"><i data-lucide="user-round"></i></div><div class="admin-user-identity"><strong>'+esc(u.username)+'</strong><small>'+ (u.role==='admin'?'Administrator':u.role==='leader'?'Team lead':'User') +' · '+(u.status==='active'?'نشط':'Disabled')+'</small></div><span class="admin-status '+(u.status==='active'?'is-active':'is-disabled')+'">'+(u.status==='active'?'نشط':'Disabled')+'</span></div><div class="admin-user-controls"><label><span>Role</span><select class="filter-input" data-role-select><option value="user" '+(u.role==='user'?'selected':'')+'>User</option><option value="leader" '+(u.role==='leader'?'selected':'')+'>Team lead</option><option value="admin" '+(u.role==='admin'?'selected':'')+'>Administrator</option></select></label><button class="btn small" data-admin-action="role" type="button">Save role</button>'+(u.id!==currentUser?.id?'<button class="btn small" data-admin-action="status" data-status="'+(u.status==='active'?'disabled':'active')+'" type="button">'+(u.status==='active'?'Disable account':'Enable account')+'</button>':'')+'</div><div class="admin-password-row"><input class="filter-input" data-new-user-password type="password" minlength="10" placeholder="كلمة مرور جديدة (10 أحرف على الأقل)" autocomplete="new-password"><button class="btn small" data-admin-action="password" type="button"><i data-lucide="key-round"></i> Change password</button></div>'+(u.id!==currentUser?.id?'<div class="admin-user-delete"><button class="btn danger small" data-admin-action="delete" type="button">Delete user</button></div>':'')+'</article>').join('')||'<div class="admin-empty">No users yet.</div>';
      panel.querySelector('#adminUsersCount').textContent='Total accounts: '+data.users.length;
      panel.querySelector('#adminCountBadge').textContent=String(data.users.length);
      panel.style.display='flex';if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}});
    }catch(err){toast('Could not open user management: '+err.message)}
  }

  const assignmentText=(ar,en)=>document.documentElement.lang==='en'?en:ar;
  const assignmentStatusLabels={new:['New','New'],viewed:['Viewed','Viewed'],in_progress:['قيد التنفيذ','In progress'],paused:['Paused','Paused'],completed:['مكتملة','Completed'],cancelled:['Cancelled','Cancelled']};
  const assignmentPriorityLabels={low:['Low','Low'],normal:['عادية','Normal'],high:['High','High'],urgent:['عاجلة','Urgent']};
  function assignmentActionLabel(action){const labels={created:['Created','Created'],viewed:['Viewed','Viewed'],updated:['Updated','Updated'],status_changed:['Status changed','Status changed'],reassigned:['Reassign','Reassigned'],reassignment_requested:['Reassignment request','Reassignment requested'],reassignment_approved:['Approve reassignment','Reassignment approved'],reassignment_rejected:['Reject reassignment','Reassignment rejected'],note_added:['Note added','Note added'],archived:['Archived','Archived'],restored:['Restored','Restored']};const pair=labels[action]||[action||'—',action||'—'];return assignmentText(pair[0],pair[1])}
  function assignmentDate(v){if(!v)return assignmentText('No due date','No due date');const d=new Date(v);return Number.isNaN(d.getTime())?esc(v):esc(d.toLocaleString(document.documentElement.lang==='en'?'en-US':'ar-EG',{dateStyle:'medium',timeStyle:'short'}))}
  async function loadAssignedView(){if(!isReady)return;try{const manager=['admin','leader'].includes(currentUser?.role),[l,p,archived]=await Promise.all([apiPost({action:'assignment_list'}),manager?apiPost({action:'leader_users'}):Promise.resolve({users:[]}),apiPost({action:'assignment_archived_list'})]);assignedItems=l.assignments||[];assignedArchivedItems=archived.assignments||[];assignmentPeople=p.users||[];renderAssignedView()}catch(e){toast(assignmentText('Could not load assigned follow-ups: ','Could not load assigned follow-ups: ')+e.message)}}
  function renderAssignedView(){
    const t=assignmentText,search=(document.getElementById('assignedSearch')?.value||'').toLowerCase(),assignee=document.getElementById('assignedAssigneeFilter')?.value||'',priority=document.getElementById('assignedPriorityFilter')?.value||'',from=document.getElementById('assignedDateFrom')?.value||'',to=document.getElementById('assignedDateTo')?.value||'';
    const create=document.getElementById('assignedCreateButton');if(create)create.hidden=!['admin','leader'].includes(currentUser?.role);
    const assigneeSelect=document.getElementById('assignedAssigneeFilter');if(assigneeSelect){const selected=assigneeSelect.value;const people=new Map();assignedItems.forEach(a=>{if(a.assigneeId)people.set(a.assigneeId,a.assigneeName||a.assigneeId)});assignmentPeople.forEach(u=>{if(u.id)people.set(u.id,u.username||u.name||u.id)});assigneeSelect.innerHTML='<option value="">'+t('All assignees','All assignees')+'</option>'+[...people.entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>'<option value="'+esc(id)+'">'+esc(name)+'</option>').join('');assigneeSelect.value=selected}
    const dashboardHost=document.getElementById('dashboardAssignedNew');if(dashboardHost){const mine=assignedItems.filter(a=>!a.archivedAt&&a.assigneeId===currentUser?.id&&a.status==='new').sort((a,b)=>(Date.parse(b.assignedAt||b.createdAt)||0)-(Date.parse(a.assignedAt||a.createdAt)||0)).slice(0,5);dashboardHost.innerHTML=mine.length?mine.map(assignedCard).join(''):'<div class="empty-state">'+t('No new follow-ups assigned to you','No new follow-ups assigned to you')+'</div>'}
    const rows=assignedItems.filter(a=>{if(a.archivedAt||(assignee&&a.assigneeId!==assignee)||(priority&&a.priority!==priority))return false;const date=String(a.assignedAt||a.createdAt||'').slice(0,10);if(from&&date<from||to&&date>to)return false;return !search||[a.title,a.description,a.assigneeName,a.ownerLeaderName,a.createdByName].join(' ').toLowerCase().includes(search)});
    const buckets=[['new'],['viewed'],['in_progress'],['paused'],['completed'],['cancelled']],ids=[['assignedNewList','assignedNewCount'],['assignedViewedList','assignedViewedCount'],['assignedProgressList','assignedProgressCount'],['assignedPausedList','assignedPausedCount'],['assignedCompletedList','assignedCompletedCount'],['assignedCancelledList','assignedCancelledCount']];
    buckets.forEach((states,i)=>{const items=rows.filter(a=>states.includes(a.status));document.getElementById(ids[i][1]).textContent=items.length;document.getElementById(ids[i][0]).innerHTML=items.length?items.map(assignedCard).join(''):'<div class="empty-state">'+t('No follow-ups in this status','No follow-ups in this status')+'</div>'});
    const archivedSection=document.getElementById('assignedArchivedSection'),archivedHost=document.getElementById('assignedArchivedList'),archivedCount=document.getElementById('assignedArchivedCount');if(archivedSection&&archivedHost&&archivedCount){archivedSection.hidden=!assignedArchivedItems.length;archivedCount.textContent=assignedArchivedItems.length;archivedHost.innerHTML=assignedArchivedItems.length?assignedArchivedItems.map(assignedCard).join(''):'<div class="empty-state">'+t('No archived follow-ups','No archived follow-ups')+'</div>'}
    if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}});
  }
  function assignedCard(a){
    const t=assignmentText,st=assignmentStatusLabels[a.status]||[a.status,a.status],pr=assignmentPriorityLabels[a.priority]||[a.priority,a.priority];
    const kind=a.type==='client'?'<span class="pill">'+t('Client','Client')+'</span><span class="pill">'+esc(a.clientPhone||'')+'</span>':'<span class="pill">'+t('مهمة','Task')+'</span>';
    return '<article class="entity-card assigned-card"><div class="assigned-card-head"><div><h3>'+esc(a.title)+'</h3><p>'+esc(a.description||t('No description','No description'))+'</p></div><span class="pill">'+t(pr[0],pr[1])+'</span></div><div class="entity-meta"><span class="pill">'+t(st[0],st[1])+'</span><span class="pill">'+esc(t('Assignee: ','Assignee: ')+a.assigneeName)+'</span><span class="pill">'+esc(t('Assigned by: ','Owner: ')+a.ownerLeaderName)+'</span>'+kind+'</div><div class="assigned-meta"><small>'+esc(t('Follow-up date: ','Follow-up: '))+assignmentDate(a.dueAt)+'</small><small>'+esc(t('Last updated: ','Updated: '))+assignmentDate(a.updatedAt)+'</small></div><div class="card-actions"><button class="btn small primary" data-assignment-open="'+esc(a.id)+'"><i data-lucide="eye"></i> '+t('View details','View details')+'</button></div></article>';
  }
  async function createAssignedFollowup(){
    const t=assignmentText;if(!['admin','leader'].includes(currentUser?.role))return;
    if(!assignmentPeople.length){toast(t('No active users available.','No active users available'));return}
    const wrap=document.createElement('div');wrap.className='modal-backdrop show';
    const targets=assignmentPeople.map(u=>'<option value="'+esc(u.id)+'">'+esc(u.username)+'</option>').join('');
    wrap.innerHTML='<section class="modal"><div class="modal-head"><h2>'+t('Assign a new follow-up','Assign a follow-up')+'</h2><button class="btn icon-btn" type="button" data-close>×</button></div><form id="newAssignmentForm"><div class="form-grid"><label class="field full"><span>'+t('Assignment type','Assignment type')+'</span><select name="assignmentType" id="assignmentType"><option value="task">'+t('مهمة','Task')+'</option><option value="client">'+t('Client','Client')+'</option></select></label><label class="field full" data-task-field><span>'+t('Task title','Task title')+'</span><input name="title" maxlength="180"></label><label class="field full" data-client-field hidden><span>'+t('Client name','Client name')+'</span><input name="clientName" maxlength="180"></label><label class="field" data-client-field hidden><span>'+t('Follow-up phone number','Follow-up phone number')+'</span><input name="clientPhone" type="tel" inputmode="tel" maxlength="30"></label><label class="field full"><span>'+t('Details','Details')+'</span><textarea name="description" rows="3"></textarea></label><label class="field"><span>'+t('Assignee','Assignee')+'</span><select name="assigneeId" required>'+targets+'</select></label><label class="field"><span>'+t('Priority','Priority')+'</span><select name="priority"><option value="normal">'+t('عادية','Normal')+'</option><option value="high">'+t('High','High')+'</option><option value="urgent">'+t('عاجلة','Urgent')+'</option><option value="low">'+t('Low','Low')+'</option></select></label><label class="field full"><span>'+t('Follow-up date','Follow-up date')+'</span><input name="dueAt" type="datetime-local"></label></div><div class="modal-foot"><button class="btn primary" type="submit">'+t('Assign follow-up','Assign')+'</button><button class="btn" type="button" data-close>'+t('Cancel','Cancel')+'</button></div></form></section>';
    document.body.appendChild(wrap);const form=wrap.querySelector('form'),type=wrap.querySelector('#assignmentType');
    const syncType=()=>{const client=type.value==='client';wrap.querySelectorAll('[data-client-field]').forEach(x=>{x.hidden=!client;x.style.display=client?'grid':'none'});wrap.querySelectorAll('[data-task-field]').forEach(x=>{x.hidden=client;x.style.display=client?'none':'grid'});form.elements.title.required=!client;form.elements.title.disabled=client;form.elements.clientName.required=client;form.elements.clientPhone.required=client};
    type.addEventListener('change',syncType);syncType();
    wrap.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>wrap.remove());wrap.addEventListener('click',e=>{if(e.target===wrap)wrap.remove()});
    form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form).entries());if(data.assignmentType==='client')data.title=data.clientName;try{await apiPost({action:'assignment_create',...data});wrap.remove();toast(t('Follow-up assigned successfully.','Follow-up assigned'));await loadAssignedView()}catch(err){toast(err)}};
  }
  function closeAssignmentPopup(all=false){const items=[...document.querySelectorAll('.assignment-popup')];(all?items:items.slice(-1)).forEach(x=>x.remove())}
  function showAssignmentPopup(title,content){
    const wrap=document.createElement('div');wrap.className='modal-backdrop show assignment-popup';wrap.innerHTML='<section class="modal assignment-modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>'+title+'</h2><button class="btn icon-btn" type="button" data-popup-close aria-label="Close">×</button></div><div class="assignment-modal-content">'+content+'</div></section>';document.body.appendChild(wrap);wrap.addEventListener('click',e=>{if(e.target.closest('[data-popup-close]')){e.preventDefault();closeAssignmentPopup();return}if(e.target===wrap)closeAssignmentPopup()});return wrap;
  }
  function assignmentHistoryMarkup(activity){
    const t=assignmentText,labels={created:t('Created','Created'),updated:t('Updated','Updated'),reassigned:t('Directly reassigned','Directly reassigned'),viewed:t('Viewed','Viewed'),status_changed:t('Status changed','Status changed'),archived:t('Archived','Archived'),restored:t('Restored','Restored'),reassignment_requested:t('Transfer requested','Transfer requested'),reassignment_approved:t('Transfer approved','Transfer approved'),reassignment_rejected:t('Transfer rejected','Transfer rejected'),note_added:t('Note added','Note added')};
    return '<div class="assignment-history">'+((activity||[]).map(x=>'<article class="assignment-history-item"><b>'+esc(x.actorName||'')+'</b><span>'+esc(labels[x.action]||x.action||'')+'</span><small>'+assignmentDate(x.createdAt)+'</small></article>').join('')||'<div class="empty-state">'+t('No activity yet','No activity yet')+'</div>')+'</div>';
  }
  let assignmentActionInFlight=false;
  async function openAssignedDetail(id){
    if(assignmentActionInFlight)return;assignmentActionInFlight=true;
    document.querySelectorAll('[data-assignment-open]').forEach(button=>{button.disabled=true;button.setAttribute('aria-busy','true')});
    try{return await openAssignedDetailImpl(id)}finally{assignmentActionInFlight=false;document.querySelectorAll('[data-assignment-open]').forEach(button=>{button.disabled=false;button.removeAttribute('aria-busy')})}
  }
  async function openAssignedDetailImpl(id,refresh=false){
    if(!refresh)closeAssignmentPopup(true);const t=assignmentText;try{
      const res=await apiPost({action:'assignment_detail',assignmentId:id}),a=res.assignment;
      const canManage=currentUser?.role==='admin'||a.ownerLeaderId===currentUser?.id;
      const canEdit=a.createdBy===currentUser?.id||a.ownerLeaderId===currentUser?.id;
      const canDelete=currentUser?.role==='admin';
      const canChange=canManage||a.assigneeId===currentUser?.id;
      const statusOptions=Object.entries(assignmentStatusLabels).map(([k,v])=>'<option value="'+k+'" '+(a.status===k?'selected':'')+'>'+t(v[0],v[1])+'</option>').join('');
      const notes=(a.notes||[]).map(n=>'<article class="assignment-note"><header><b>'+esc(n.authorName||'')+'</b><span class="pill">'+t(n.visibility==='shared'?'Shared':'Private',n.visibility==='shared'?'Shared':'Private')+'</span><time class="assignment-note-date">'+assignmentDate(n.createdAt)+'</time></header><p>'+esc(n.body||'')+'</p></article>').join('')||'<div class="empty-state">'+t('No notes','No notes')+'</div>';
      let actions='<div class="assignment-detail-actions">';
      if(canChange){const allowedOptions=Object.entries(assignmentStatusLabels).filter(([key])=>!(a.assigneeId===currentUser?.id&&key==='new'));const statusMarkup=allowedOptions.map(([k,v])=>'<option value="'+k+'" '+(a.status===k?'selected':'')+'>'+t(v[0],v[1])+'</option>').join('');actions+='<label class="assignment-status-control"><span>'+t('Status','Status')+'</span><select class="filter-input" id="assignmentDetailStatus">'+statusMarkup+'</select><button class="btn primary" id="assignmentDetailSave">'+t('Save changes','Save changes')+'</button></label>';}
      actions+='<button class="btn" id="assignmentHistoryButton"><i data-lucide="history"></i> '+t('View activity log','View activity log')+'</button>';
      if(canManage)actions+='<button class="btn danger" id="assignmentArchiveButton"><i data-lucide="archive"></i> '+t(a.archivedAt?'Restore from archive':'Archive follow-up',a.archivedAt?'Restore from archive':'Archive follow-up')+'</button>';
      if(canEdit)actions+='<button class="btn" id="assignmentEditButton"><i data-lucide="pencil"></i> '+t('Edit follow-up','Edit follow-up')+'</button>';
      if(canDelete)actions+='<button class="btn danger" id="assignmentDeleteButton"><i data-lucide="trash-2"></i> '+t('Delete follow-up','Delete follow-up')+'</button>';
      if(canManage)actions+='<button class="btn" id="assignmentDirectReassignButton"><i data-lucide="user-round-plus"></i> '+t('Reassign','Reassign')+'</button>';
      if(!canManage&&a.assigneeId===currentUser?.id)actions+='<button class="btn" id="assignmentTransferButton"><i data-lucide="message-square-share"></i> '+t('Request reassignment','Request reassignment')+'</button>';
      actions+='</div>';
      const requests=canManage?(a.requests||[]).filter(x=>x.status==='pending').map(x=>'<article class="assignment-request"><div>'+t('Transfer request from ','Transfer from ')+esc(x.fromUserName)+' '+t('to ','to ')+esc(x.toUserName)+'<p>'+esc(x.reason)+'</p></div><button class="btn small" data-review="yes" data-request="'+esc(x.id)+'">'+t('Approve','Approve')+'</button><button class="btn small" data-review="no" data-request="'+esc(x.id)+'">'+t('رفض','Reject')+'</button></article>').join(''):'';
      const content='<div class="assignment-detail-body"><div class="assignment-detail-summary"><h3>'+esc(a.type==='client'?(a.clientName||a.title):a.title)+'</h3><p>'+esc(a.description||t('No description','No description'))+'</p></div><div class="assignment-detail-grid"><div><small>'+t('Type','Type')+'</small><b>'+t(a.type==='client'?'Client':'مهمة',a.type==='client'?'Client':'Task')+'</b></div><div><small>'+t('Created by','Created by')+'</small><b>'+esc(a.createdByName||'—')+'</b></div><div><small>'+t('Current owner','Current owner')+'</small><b>'+esc(a.ownerLeaderName||'—')+'</b></div><div><small>'+t('Assignee','Assignee')+'</small><b>'+esc(a.assigneeName||'—')+'</b></div>'+(a.type==='client'?'<div><small>'+t('Client name','Client name')+'</small><b>'+esc(a.clientName||a.title||'—')+'</b></div><div><small>'+t('Follow-up phone number','Follow-up phone')+'</small><b>'+esc(a.clientPhone||'—')+'</b></div>':'')+'<div><small>'+t('Follow-up date','Follow-up date')+'</small><b>'+assignmentDate(a.dueAt)+'</b></div><div><small>'+t('Priority','Priority')+'</small><b>'+t((assignmentPriorityLabels[a.priority]||['—','—'])[0],(assignmentPriorityLabels[a.priority]||['—','—'])[1])+'</b></div><div><small>'+t('Last updated','Last updated')+'</small><b>'+assignmentDate(a.updatedAt)+'</b></div></div>'+actions+(requests?'<section class="assignment-pending-requests"><h3>'+t('Pending reassignment requests','Pending reassignment requests')+'</h3>'+requests+'</section>':'')+'<section class="assignment-notes-section"><h3>'+t('Notes','Notes')+'</h3>'+notes+'<form id="assignedNoteForm" class="assignment-note-form"><label>'+t('Note added','Add a note')+'<textarea name="body" required></textarea></label><label>'+t('Visibility','Visibility')+'<select name="visibility"><option value="private">'+t('Private','Private')+'</option><option value="shared">'+t('Shared','Shared')+'</option></select></label><button class="btn primary" type="submit">'+t('Save note','Save note')+'</button></form></section></div>';
      const popup=refresh?document.querySelector('.assignment-popup:last-child'):showAssignmentPopup(t('Follow-up details','Follow-up details'),content);
      if(!popup)throw new Error('assignment_popup_missing');
      if(refresh){popup.querySelector('.modal-head h2').textContent=t('Follow-up details','Follow-up details');popup.querySelector('.assignment-modal-content').innerHTML=content}
      if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}});
      popup.querySelector('#assignmentEditButton')?.addEventListener('click',()=>{
        const dueValue=a.dueAt&&!Number.isNaN(Date.parse(a.dueAt))?new Date(a.dueAt).toISOString().slice(0,16):'';
        popup.querySelector('.modal-head h2').textContent=t('Edit follow-up','Edit follow-up');
        popup.querySelector('.assignment-modal-content').innerHTML='<form id="assignmentEditForm" class="assignment-transfer-form"><label>'+t('Assignment type','Assignment type')+'<select name="assignmentType"><option value="task" '+(a.type!=='client'?'selected':'')+'>'+t('مهمة','Task')+'</option><option value="client" '+(a.type==='client'?'selected':'')+'>'+t('Client','Client')+'</option></select></label><label data-edit-task><span>'+t('Task title','Task title')+'</span><input name="title" maxlength="180" value="'+esc(a.type==='client'?'':a.title||'')+'"></label><label data-edit-client><span>'+t('Client name','Client name')+'</span><input name="clientName" maxlength="180" value="'+esc(a.clientName||'')+'"></label><label data-edit-client><span>'+t('Phone number','Phone number')+'</span><input name="clientPhone" type="tel" maxlength="30" value="'+esc(a.clientPhone||'')+'"></label><label>'+t('Description','Description')+'<textarea name="description" rows="4">'+esc(a.description||'')+'</textarea></label><label>'+t('Priority','Priority')+'<select name="priority"><option value="low" '+(a.priority==='low'?'selected':'')+'>'+t('Low','Low')+'</option><option value="normal" '+(a.priority==='normal'?'selected':'')+'>'+t('عادية','Normal')+'</option><option value="high" '+(a.priority==='high'?'selected':'')+'>'+t('High','High')+'</option><option value="urgent" '+(a.priority==='urgent'?'selected':'')+'>'+t('عاجلة','Urgent')+'</option></select></label><label>'+t('Follow-up date','Follow-up date')+'<input name="dueAt" type="datetime-local" value="'+dueValue+'"></label><div class="modal-foot"><button class="btn primary" type="submit">'+t('Save changes','Save changes')+'</button><button class="btn" type="button" data-edit-cancel>'+t('Cancel','Cancel')+'</button></div></form>';
        const editForm=popup.querySelector('#assignmentEditForm'),syncEditType=()=>{const client=editForm.assignmentType.value==='client';editForm.querySelectorAll('[data-edit-client]').forEach(x=>x.hidden=!client);editForm.querySelectorAll('[data-edit-task]').forEach(x=>x.hidden=client);editForm.title.required=!client;editForm.title.disabled=client;editForm.clientName.required=client;editForm.clientPhone.required=client};editForm.assignmentType.addEventListener('change',syncEditType);syncEditType();
        popup.querySelector('[data-edit-cancel]')?.addEventListener('click',()=>openAssignedDetailImpl(id,true));
        popup.querySelector('#assignmentEditForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,submit=form.querySelector('[type="submit"]');if(submit.disabled)return;submit.disabled=true;try{await apiPost({action:'assignment_update',assignmentId:id,patch:{AssignmentType:form.assignmentType.value,Title:form.assignmentType.value==='client'?form.clientName.value.trim():form.title.value.trim(),ClientName:form.assignmentType.value==='client'?form.clientName.value.trim():'',ClientPhone:form.assignmentType.value==='client'?form.clientPhone.value.trim():'',Description:form.description.value,Priority:form.priority.value,DueAt:form.dueAt.value?new Date(form.dueAt.value).toISOString():''}});toast(t('Follow-up updated successfully','Follow-up updated successfully'));await loadAssignedView();await openAssignedDetailImpl(id,true)}catch(error){toast(error)}finally{submit.disabled=false}};
      });
      popup.querySelector('#assignmentDeleteButton')?.addEventListener('click',async()=>{if(!window.confirm(t('Delete this follow-up permanently?','Delete this follow-up permanently?')))return;const button=popup.querySelector('#assignmentDeleteButton');button.disabled=true;try{await apiPost({action:'assignment_delete',assignmentId:id});toast(t('Follow-up deleted successfully','Follow-up deleted successfully'));closeAssignmentPopup(true);await loadAssignedView()}catch(error){toast(error);button.disabled=false}});
      popup.querySelector('#assignmentHistoryButton')?.addEventListener('click',async()=>{const button=popup.querySelector('#assignmentHistoryButton');if(button.disabled)return;button.disabled=true;try{const result=await apiPost({action:'assignment_history',assignmentId:a.id});const rows=(result.history||[]).map(item=>'<article class="assignment-history-item"><b>'+esc(item.actorName||'')+'</b><span>'+esc(assignmentActionLabel(item.action))+'</span><small>'+assignmentDate(item.createdAt)+'</small></article>').join('')||'<div class="empty-state">'+t('No activity yet','No activity history')+'</div>';popup.querySelector('.modal-head h2').textContent=t('Follow-up activity','Follow-up activity');popup.querySelector('.assignment-modal-content').innerHTML='<div class="assignment-history">'+rows+'</div>'}catch(error){toast(error)}finally{button.disabled=false}});
      popup.querySelector('#assignmentDirectReassignButton')?.addEventListener('click',async()=>{
        try{
          const people=await apiPost({action:'assignment_targets',assignmentId:a.id,excludeUserId:a.assigneeId}),targets=(people.users||[]).filter(u=>u.id!==a.assigneeId&&u.id!==currentUser.id&&(currentUser.role==='admin'||u.role!=='admin'));
          if(!targets.length){toast(t('No eligible users available.','No eligible users available'));return}
          const options=targets.map(u=>'<option value="'+esc(u.id)+'">'+esc(u.username)+'</option>').join('');
          const transfer=showAssignmentPopup(t('Reassign follow-up','Reassign follow-up'),'<form id="directReassignForm" class="assignment-transfer-form"><label>'+t('New assignee','New assignee')+'<select class="filter-input" name="toUserId" required>'+options+'</select></label><div class="modal-foot"><button class="btn primary" type="submit">'+t('Confirm reassignment','Confirm reassignment')+'</button><button class="btn" type="button" data-popup-close>'+t('Cancel','Cancel')+'</button></div></form>');
          transfer.querySelector('[data-popup-close]')?.addEventListener('click',()=>closeAssignmentPopup());
          transfer.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,submit=f.querySelector('[type="submit"]');if(submit.disabled)return;submit.disabled=true;try{await apiPost({action:'assignment_reassign',assignmentId:id,toUserId:f.toUserId.value});toast(t('Follow-up reassigned successfully','Follow-up reassigned successfully'));closeAssignmentPopup(true);await loadAssignedView()}catch(err){toast(err)}finally{submit.disabled=false}};
        }catch(err){toast(err)}
      });
      popup.querySelector('#assignmentArchiveButton')?.addEventListener('click',async()=>{const button=popup.querySelector('#assignmentArchiveButton');if(button.disabled)return;button.disabled=true;try{await apiPost({action:a.archivedAt?'assignment_restore':'assignment_archive',assignmentId:id,archive:!a.archivedAt});toast(t(a.archivedAt?'Follow-up restored.':'Follow-up archived.',a.archivedAt?'Follow-up restored':'Follow-up archived'));await loadAssignedView();await openAssignedDetailImpl(id,true)}catch(error){toast(error)}finally{button.disabled=false}});
      popup.querySelector('#assignmentDetailSave')?.addEventListener('click',async()=>{const status=popup.querySelector('#assignmentDetailStatus').value;try{await apiPost({action:'assignment_status',assignmentId:id,status});toast(t('Status updated.','Status updated'));await loadAssignedView();await openAssignedDetailImpl(id,true)}catch(err){toast(err)}});
      popup.querySelector('#assignmentTransferButton')?.addEventListener('click',async()=>{
        try{const people=await apiPost({action:'reassignment_targets',assignmentId:a.id,excludeUserId:a.assigneeId}),targets=(people.users||[]).filter(u=>u.id!==currentUser.id&&u.id!==a.assigneeId&&u.role!=='admin');if(!targets.length){toast(t('No eligible users to reassign to.','No eligible users to reassign to'));return}
          const opts=targets.map(u=>'<option value="'+esc(u.id)+'">'+esc(u.username)+'</option>').join('');
          const transfer=showAssignmentPopup(t('Request reassignment','Request reassignment'),'<form id="assignmentTransferForm" class="assignment-transfer-form"><label>'+t('New assignee','New assignee')+'<select class="filter-input" name="toUserId" required>'+opts+'</select></label><label>'+t('Reason for reassignment','Reason for reassignment')+'<textarea class="filter-input" name="reason" rows="4" required></textarea></label><div class="modal-foot"><button class="btn primary" type="submit">'+t('Send request','Send request')+'</button><button class="btn" type="button" data-popup-close>'+t('Cancel','Cancel')+'</button></div></form>');
          transfer.querySelector('[data-popup-close]')?.addEventListener('click',()=>closeAssignmentPopup());
          transfer.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,submit=f.querySelector('[type="submit"]');if(submit.disabled)return;submit.disabled=true;try{await apiPost({action:'reassignment_request',assignmentId:id,toUserId:f.toUserId.value,reason:f.reason.value});toast(t('Request sent for approval','Request sent for approval'));closeAssignmentPopup(true);await loadAssignedView()}catch(err){toast(err)}finally{submit.disabled=false}};
        }catch(err){toast(err)}
      });
      popup.querySelectorAll('[data-review]').forEach(button=>button.onclick=async()=>{try{await apiPost({action:'reassignment_review',requestId:button.dataset.request,approve:button.dataset.review==='yes'});toast(t('Decision saved.','Decision saved'));await loadAssignedView();await openAssignedDetailImpl(id,true)}catch(err){toast(err)}});
      popup.querySelector('#assignedNoteForm').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;try{await apiPost({action:'assignment_note_add',assignmentId:id,body:f.body.value,visibility:f.visibility.value});toast(t('Note saved','Note saved'));await openAssignedDetailImpl(id,true)}catch(err){toast(err)}};
    }catch(err){toast(t('Could not open follow-up details: ','Could not open follow-up details: ')+err.message)}
  }
  async function announceServerNotification(notification){
    if(!notification||notification.isRead)return;
    const options={id:notification.id,title:notification.title||assignmentText('New notification','New notification'),body:notification.body||'',assignmentId:notification.assignmentId||'',notificationId:notification.id};
    try{
      if(window.smartNoteNativeNotifications?.isNative&&window.smartNoteNativeNotifications.showInstantNotification){await window.smartNoteNativeNotifications.showInstantNotification(options)}
    }catch(error){console.warn('Could not display system notification:',error)}
  }
  async function refreshUnifiedNotifications(loadOlder=false,announceNew=false){
    const t=assignmentText,previousIds=new Set(serverNotifications.map(item=>item.id));
    try{
      const result=await apiPost({action:'notification_list',cursor:loadOlder?serverNotificationCursor:''});
      serverNotifications=loadOlder?serverNotifications.concat(result.notifications||[]):(result.notifications||[]);
      serverNotificationCursor=result.nextCursor||'';serverNotificationHasMore=!!result.hasMore;if(!loadOlder){serverNotificationUnreadCount=Number(result.unreadCount||0);serverNotificationTotalCount=Number(result.totalCount||0);}
      if(announceNew&&!loadOlder){const fresh=serverNotifications.filter(item=>!previousIds.has(item.id)&&!item.isRead).reverse();for(const item of fresh)await announceServerNotification(item)}
    }catch(error){if(!loadOlder)serverNotifications=[];toast(t('Could not load notifications: ','Could not load notifications: ')+error.message)}
    renderUnifiedNotifications();
  }
  function notificationEntityLabel(n){
    if(n.kind==='local'){
      const task=get('tasks',n.taskId);if(!task)return assignmentText('متابعة','Task')+': '+(n.taskTitle||n.body||'');
      return assignmentText('متابعة','Task')+': '+(task.title||'');
    }
    const labels={assigned:['متابعة','Follow-up'],reassigned:['متابعة','Follow-up'],reassignment_request:['Transfer requested','Transfer request'],reassignment_result:['Transfer requested','Transfer request'],assignment_completed:['متابعة','Follow-up'],note_added:['Note','Note']};
    const label=labels[n.type]||['Notification','Notification'];return assignmentText(label[0],label[1])+': '+(n.assignmentTitle||n.body||n.title||'');
  }
  function notificationDateParts(value){
    const date=new Date(value);if(Number.isNaN(date.getTime()))return {date:'',time:''};
    const locale=document.documentElement.lang==='en'?'en-US':'ar-EG';
    return {date:date.toLocaleDateString(locale,{day:'numeric',month:'short',year:'numeric'}),time:date.toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit'})};
  }
  function renderUnifiedNotifications(){
    const t=assignmentText,all=[...taskAlerts.map(a=>({id:'local:'+a.key,kind:'local',title:a.title,body:a.body,taskTitle:a.taskTitle,createdAt:a.createdAt,isRead:!!a.isRead,taskId:a.taskId,key:a.key})),...serverNotifications.map(n=>({...n,kind:'server'}))].sort((a,b)=>(Date.parse(b.createdAt)||Number(b.createdAt)||0)-(Date.parse(a.createdAt)||Number(a.createdAt)||0));
    const unread=taskAlerts.filter(n=>!n.isRead).length+serverNotificationUnreadCount,list=document.getElementById('taskAlerts'),more=document.getElementById('notificationLoadMore'),markAll=document.getElementById('notificationMarkAll');
    document.getElementById('notificationCount').textContent=unread;document.getElementById('notificationCount').hidden=!unread;document.getElementById('notificationPanelCount').textContent='('+(taskAlerts.length+serverNotificationTotalCount)+')';document.getElementById('notificationBell').setAttribute('aria-label',t('Notifications: ','Notifications: ')+unread);
    if(markAll){markAll.disabled=!unread;markAll.querySelector('span').textContent=t('Mark all as read','Mark all as read')}
    const deleteAll=document.getElementById('notificationDeleteAll');if(deleteAll){deleteAll.disabled=!all.length;deleteAll.querySelector('span').textContent=t('Delete all','Delete all')}
    if(more){more.hidden=!serverNotificationHasMore;more.disabled=false;more.textContent=t('Load older notifications','Load older notifications')}
    list.innerHTML=all.length?all.map(n=>{const dt=notificationDateParts(n.createdAt),entity=notificationEntityLabel(n),shortBody=String(n.body||'').replace(/\s+/g,' ').trim();return '<article class="task-alert '+(n.isRead?'is-read':'is-unread')+'" tabindex="0" data-unified-open="'+esc(n.id)+'" data-kind="'+n.kind+'" data-assignment="'+esc(n.assignmentId||'')+'" data-task="'+esc(n.taskId||'')+'" aria-label="'+esc(t('فتح الإشعار: ','Open notification: ')+n.title)+'"><div class="unified-notice-head"><p class="notice-summary">'+esc(shortBody)+'</p><time class="notice-time" datetime="'+esc(new Date(n.createdAt).toISOString())+'"><span>'+esc(dt.date)+'</span><span>'+esc(dt.time)+'</span></time><span class="notice-actions"><button class="notice-action-btn" type="button" data-notice-read="'+esc(n.id)+'" aria-label="'+(n.isRead?t('مقروءة','Read'):t('تحديد كمقروء','Mark as read'))+'" title="'+(n.isRead?t('مقروءة','Read'):t('تحديد كمقروء','Mark as read'))+'"><i data-lucide="'+(n.isRead?'mail-open':'mail-check')+'"></i></button><button class="notice-action-btn danger" type="button" data-notice-delete="'+esc(n.id)+'" aria-label="'+t('حذف الإشعار','Delete notification')+'" title="'+t('حذف الإشعار','Delete notification')+'"><i data-lucide="trash-2"></i></button></span>'+'</div><div class="notice-entity">'+esc(entity)+'</div></article>'}).join(''):'<div class="notification-empty">'+t('No notifications yet','No notifications yet')+'</div>';
    if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}});
  }
  async function setUnifiedNotificationRead(id){
    if(id.startsWith('local:')){const alert=taskAlerts.find(x=>x.key===id.slice(6));if(alert&&!alert.isRead){alert.isRead=true;persistTaskAlertState()}}
    else{const item=serverNotifications.find(x=>x.id===id);if(item&&!item.isRead){await apiPost({action:'notification_read',notificationId:id});item.isRead=true;serverNotificationUnreadCount=Math.max(0,serverNotificationUnreadCount-1)}}
    renderUnifiedNotifications();
  }
  async function deleteUnifiedNotification(id){
    if(id.startsWith('local:')){removeTaskAlert(id.slice(6))}
    else{const existing=serverNotifications.find(x=>x.id===id);await apiPost({action:'notification_delete',notificationId:id});serverNotifications=serverNotifications.filter(x=>x.id!==id);serverNotificationTotalCount=Math.max(0,serverNotificationTotalCount-1);if(existing&&!existing.isRead)serverNotificationUnreadCount=Math.max(0,serverNotificationUnreadCount-1)}
    renderUnifiedNotifications();
  }
  async function deleteAllUnifiedNotifications(){
    const confirmed=window.confirm(assignmentText('Delete all notifications? This action cannot be undone.','Delete all notifications? This action cannot be undone.'));
    if(!confirmed)return;
    try{
      await apiPost({action:'notification_delete_all'});
      taskAlerts.splice(0,taskAlerts.length);persistTaskAlertState();
      serverNotifications=[];serverNotificationTotalCount=0;serverNotificationUnreadCount=0;serverNotificationHasMore=false;serverNotificationCursor='';
      renderUnifiedNotifications();
      toast(assignmentText('All notifications deleted','All notifications deleted'));
    }catch(err){toast(err)}
  }
  async function handleUnifiedNotificationClick(e){
    const menu=e.target.closest('[data-notice-menu]');if(menu){e.stopPropagation();const wrap=menu.closest('.notice-menu-wrap'),panel=wrap.querySelector('.notice-menu'),open=panel.hidden;document.querySelectorAll('.notice-menu').forEach(x=>{x.hidden=true;x.style.top='';x.style.left='';x.style.right=''});document.querySelectorAll('.notice-menu-toggle').forEach(x=>x.setAttribute('aria-expanded','false'));if(open){const rect=menu.getBoundingClientRect(),width=Math.min(180,window.innerWidth-24),height=86;let left=Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12)),top=rect.bottom+6;if(top+height>window.innerHeight-12)top=Math.max(12,rect.top-height-6);panel.style.position='fixed';panel.style.width=width+'px';panel.style.left=left+'px';panel.style.right='auto';panel.style.top=top+'px';panel.hidden=false;menu.setAttribute('aria-expanded','true')}return}
    const read=e.target.closest('[data-notice-read]');if(read){e.stopPropagation();try{await setUnifiedNotificationRead(read.dataset.noticeRead)}catch(err){toast(err)}return}
    const del=e.target.closest('[data-notice-delete]');if(del){e.stopPropagation();try{await deleteUnifiedNotification(del.dataset.noticeDelete)}catch(err){toast(err)}return}
    const card=e.target.closest('[data-unified-open]');if(!card)return;
    try{
      await setUnifiedNotificationRead(card.dataset.unifiedOpen);
      if(card.dataset.kind==='local'){const alert=taskAlerts.find(x=>x.key===card.dataset.unifiedOpen.replace('local:',''));document.getElementById('notificationPanel').hidden=true;if(alert){showView('tasks');openForm('task',alert.taskId)}}
      else{document.getElementById('notificationPanel').hidden=true;if(card.dataset.assignment){showView('assigned');await openAssignedDetail(card.dataset.assignment)}}
      document.getElementById('notificationBell').setAttribute('aria-expanded','false');
    }catch(err){toast(err)}
  }
  async function markAllUnifiedNotificationsRead(){
    try{
      let changed=0;for(const alert of taskAlerts){if(!alert.isRead){alert.isRead=true;changed++}}
      if(serverNotificationUnreadCount>0){await apiPost({action:'notification_read_all'});serverNotifications.forEach(item=>item.isRead=true);serverNotificationUnreadCount=0}
      if(changed)persistTaskAlertState();renderUnifiedNotifications();
    }catch(err){toast(err)}
  }
  document.getElementById('taskAlerts').addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.closest('[data-unified-open]')){event.preventDefault();handleUnifiedNotificationClick(event)}});
  async function startRealtimeSync(){
    if(!isReady||!currentUser?.id||!navigator.onLine)return;
    try{
      if(!realtimeClient){
        const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2');
        realtimeClient=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{autoRefreshToken:false,persistSession:false},realtime:{params:{eventsPerSecond:10}}});
      }
      if(realtimeChannel){try{await realtimeClient.removeChannel(realtimeChannel)}catch{}realtimeChannel=null}
      const tokenDigest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(authToken));
      const tokenTopic=Array.from(new Uint8Array(tokenDigest),byte=>byte.toString(16).padStart(2,'0')).join('');
      realtimeChannel=realtimeClient.channel('smartnote-session:'+tokenTopic,{config:{private:false,broadcast:{self:false}}});
      realtimeChannel.on('broadcast',{event:'refresh'},({payload})=>{
        if(payload?.table)realtimePendingTables.add(String(payload.table));
        clearTimeout(realtimeRefreshTimer);
        realtimeRefreshTimer=setTimeout(async()=>{
          const changed=[...realtimePendingTables];realtimePendingTables.clear();
          if(!isReady||!authToken||!navigator.onLine)return;
          const notebook=['user_database_meta'];
          if(changed.some(table=>notebook.includes(table)))await syncCloud();
          if(changed.some(table=>['assignments','assignment_activity','assignment_notes','reassignment_requests'].includes(table))){
            if(currentView==='assigned'||currentView==='dashboard')await loadAssignedView();
            if(document.querySelector('.assignment-popup'))toast(assignmentText('Follow-up updated by another user','Follow-up updated by another user'));
          }
          if(changed.includes('notifications'))await refreshUnifiedNotifications(false,true);else if(changed.some(table=>['assignments','reassignment_requests'].includes(table)))await refreshUnifiedNotifications();
          if(changed.includes('profiles')&&currentUser?.role==='admin'&&document.getElementById('adminPanel')?.style.display==='flex')await openAdminPanel();
        },220);
      }).subscribe(status=>{
        if(status==='SUBSCRIBED')setConnection(true,assignmentText('Live synchronization is active','Live synchronization is active'));
        else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')console.warn('SmartNote Realtime status:',status);
      });
    }catch(error){console.warn('Realtime unavailable; periodic sync remains active:',error);if(realtimeChannel&&realtimeClient){try{await realtimeClient.removeChannel(realtimeChannel)}catch{}realtimeChannel=null}}
  }
  function stopRealtimeSync(){
    clearTimeout(realtimeRefreshTimer);realtimePendingTables.clear();
    if(realtimeClient&&realtimeChannel){realtimeClient.removeChannel(realtimeChannel).catch(()=>{});realtimeChannel=null}
  }
  async function initializeCloud(){
    const saved=localStorage.getItem(SESSION_KEY);
    if(!navigator.onLine){
      if(saved){try{const s=JSON.parse(saved);authToken=s.token||'';currentUser=s.user||null;cloudRevision=Number(localStorage.getItem(cloudRevisionKey())||0);const cached=readLocalDatabase();if(authToken&&currentUser&&cached){db=cached;isReady=true;renderAll();hideGate();setConnection(false,'You are offline. Changes will sync when the connection returns.');return}}catch{}if(authToken&&currentUser){showLogin('No saved data is available for this account on this device. Connect to the internet once to load your data.');return}showLogin('Connect to the internet to sign in.');return}
      showLogin('Connect to the internet to sign in.');return;
    }
    if(saved){
      try{
        const s=JSON.parse(saved);authToken=s.token||'';currentUser=s.user||null;
        if(authToken){
          const session=await apiPost({action:'me'});
          currentUser=session.user||currentUser;
          localStorage.setItem(SESSION_KEY,JSON.stringify({token:authToken,user:currentUser}));
          const pendingLocal=hasPendingSync()?readLocalDatabase():null;
          cloudRevision=Number(session.revision)||0;
          if(pendingLocal)await afterLogin(pendingLocal,session.revision);
          else await afterLogin(session.data||{},session.revision)
          return;
        }
      }catch(err){
        if(err.message==='Invalid username or password, or your session has expired.'||err.message==='This account is disabled.'){
          authToken='';currentUser=null;localStorage.removeItem(SESSION_KEY);
        }else{
          // A temporary network/server error must never erase a valid locally stored session.
          const local=readLocalDatabase();
          if(authToken&&currentUser&&local){db=local;isReady=true;renderAll();hideGate();setConnection(false,'Offline mode: local data is available. Changes will sync when internet returns.');return;}
          setConnection(false,'Unable to reach the server. Retry without signing out.');
          showLogin('Unable to restore the session due to a connection problem. Retry; you will not need to enter your password.');
          return;
        }
      }
    }
    showLogin();
  }
  document.getElementById('retryConnection').onclick=initializeCloud;
  document.getElementById('notificationBell').onclick=async()=>{const panel=document.getElementById('notificationPanel'),open=panel.hidden;panel.hidden=!open;document.getElementById('notificationBell').setAttribute('aria-expanded',String(open));if(open)await refreshUnifiedNotifications()};
  document.getElementById('taskAlerts').addEventListener('click',handleUnifiedNotificationClick);
  document.addEventListener('click',event=>{if(event.target.closest('#taskAlerts'))return;document.querySelectorAll('.notice-menu').forEach(x=>{x.hidden=true;x.style.top='';x.style.left='';x.style.right=''});document.querySelectorAll('.notice-menu-toggle').forEach(x=>x.setAttribute('aria-expanded','false'))});
  window.addEventListener('resize',()=>{document.querySelectorAll('.notice-menu').forEach(x=>{x.hidden=true;x.style.top='';x.style.left='';x.style.right=''});document.querySelectorAll('.notice-menu-toggle').forEach(x=>x.setAttribute('aria-expanded','false'))});
  document.getElementById('taskAlerts').addEventListener('scroll',()=>{document.querySelectorAll('.notice-menu').forEach(x=>{x.hidden=true;x.style.top='';x.style.left='';x.style.right=''});document.querySelectorAll('.notice-menu-toggle').forEach(x=>x.setAttribute('aria-expanded','false'))},true);
  document.getElementById('notificationMarkAll')?.addEventListener('click',markAllUnifiedNotificationsRead);
  document.getElementById('notificationDeleteAll')?.addEventListener('click',deleteAllUnifiedNotifications);
  document.getElementById('notificationLoadMore')?.addEventListener('click',async event=>{const button=event.currentTarget;if(button.disabled||!serverNotificationHasMore)return;button.disabled=true;button.textContent=assignmentText('Loading...','Loading...');await refreshUnifiedNotifications(true)});
  // Alert action handlers are attached directly in renderTaskAlerts for reliable Android WebView taps.
  document.addEventListener('click',event=>{if(!event.target.closest('.notification-center')){document.getElementById('notificationPanel').hidden=true;document.getElementById('notificationBell').setAttribute('aria-expanded','false')}});
  navigator.serviceWorker?.addEventListener('message',event=>{
    if(event.data?.type==='OPEN_TASK_NOTIFICATION'&&typeof event.data.taskId==='string'){const alert=taskAlerts.find(x=>x.key===event.data.key);if(alert){alert.isRead=true;persistTaskAlertState();renderTaskAlerts()}showView('tasks');if(get('tasks',event.data.taskId))openForm('task',event.data.taskId)}
    if(event.data?.type==='OPEN_ASSIGNED_NOTIFICATION'&&typeof event.data.assignmentId==='string'){showView('assigned');openAssignedDetail(event.data.assignmentId)}
  });
  window.addEventListener('smartnote-open-assignment',event=>{const id=event.detail?.assignmentId;if(id){showView('assigned');openAssignedDetail(id)}});
  window.addEventListener('smartnote-open-task',event=>{const taskId=event.detail?.taskId;if(typeof taskId==='string'){const alert=taskAlerts.find(x=>x.key===event.detail?.key);if(alert){alert.isRead=true;persistTaskAlertState();renderTaskAlerts()}showView('tasks');if(get('tasks',taskId))openForm('task',taskId)}});
  function handleAppBack(){
    const modal=document.querySelector('.modal-backdrop.show');if(modal){modal.classList.remove('show');editing=null;return}
    const notificationPanel=document.getElementById('notificationPanel');if(notificationPanel&&!notificationPanel.hidden){notificationPanel.hidden=true;document.getElementById('notificationBell').setAttribute('aria-expanded','false');return}
    if(currentView!=='dashboard'){showView('dashboard');return}
    if(!exitPromptArmed){exitPromptArmed=true;toast(document.documentElement.lang==='en'?'Press Back again to exit the app.':'Press Back again to exit the app.');clearTimeout(exitPromptTimer);exitPromptTimer=setTimeout(()=>exitPromptArmed=false,2500);return}
    exitPromptArmed=false;window.Capacitor?.Plugins?.App?.exitApp?.();
  }
  window.addEventListener('smartnote-back-button',handleAppBack);
  window.addEventListener('keydown',event=>{if(event.key==='Escape'){handleAppBack()}});
  document.addEventListener('pointerdown',unlockNotificationAudio,{once:true});
  document.addEventListener('keydown',unlockNotificationAudio,{once:true});
  window.addEventListener('online',()=>{if(isReady&&authToken){syncCloud();startRealtimeSync()}else initializeCloud()});
  window.addEventListener('offline',()=>{setConnection(false,'Internet connection lost. Sync will resume automatically when you reconnect.')});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){syncCloud();startRealtimeSync();refreshUnifiedNotifications(false,true);checkTaskNotifications()}});
  window.addEventListener('focus',()=>{if(isReady)refreshUnifiedNotifications(false,true)});
  startNotificationPolling();
  let lastVisibleSyncAt=0;
  setInterval(()=>{if(!document.hidden&&Date.now()-lastVisibleSyncAt>=30000){lastVisibleSyncAt=Date.now();syncCloud()}},5000);
  setInterval(checkTaskNotifications,15000);
  if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('./sw.js').then(registration=>{serviceWorkerRegistration=registration}).catch(err=>toast('Could not set up phone notifications: '+err.message));
  if(window.lucide)window.lucide.createIcons({attrs:{"stroke-width":1.8}});restoreTaskAlertState();renderAll();requestNotificationPermissionOnStartup();initializeCloud();
})();
