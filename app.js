// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Para conectar con SharePoint/OneDrive, rellena estos valores con tu app de Azure AD
// Instrucciones en README.md
const MSAL_CONFIG = {
  clientId: '',        // Tu Application (client) ID de Azure AD
  tenantId: 'common',  // o tu tenant ID específico
  sharePointFile: '',  // Ej: 'planificador_tareas.json' — ruta relativa en OneDrive
};
const USE_SHAREPOINT = MSAL_CONFIG.clientId !== '';

// ─── ESTADO ───────────────────────────────────────────────────────────────────
const DISCIPLINES  = ['', 'Técnico', 'Financiero', 'Comercial'];
const DAY_NAMES    = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'];
const DAY_LABELS   = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const MONTH_NAMES  = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const CAL_HEADERS  = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
const STORE_KEY    = 'planificador_v3';

let appData = { schemaVersion:2, settings:{}, tasks:[], timeBank:{ totalGainedMinutes:0, entries:[] } };
let selectedMonth   = new Date().toISOString().slice(0,7);
let selectedWeekId  = null;
let selectedDayISO  = new Date().toISOString().slice(0,10);
let curDayIdx       = 0;
let currentTab      = 'cal';
let alertQueue      = [], alertActive = false;
let prevStates      = {}, assigningTaskId = null, audioCtx = null;
let undoStack       = [];
let msalToken       = null;
let notifInterval   = null;
let notifiedFlags   = {};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function genId()    { return Date.now().toString(36)+Math.random().toString(36).substr(2,5); }
function toM(t)     { if(!t)return null; const p=(t+'').split(':').map(Number); return isNaN(p[0])||isNaN(p[1])?null:p[0]*60+p[1]; }
function fmtD(m)    { if(!m||m<=0)return'—'; const h=Math.floor(m/60),mn=m%60; return h>0?(h+'h'+(mn?' '+mn+'min':'')):(mn+' min'); }
function nowM()     { const n=new Date(); return n.getHours()*60+n.getMinutes(); }
function todayISO() { return new Date().toISOString().slice(0,10); }
function esc(s)     { return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function isoToDD(iso){ if(!iso)return''; const p=iso.split('-'); return p[2]+'/'+p[1]; }
function isoDate(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

// ─── PERSISTENCIA LOCAL ───────────────────────────────────────────────────────
function saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(appData)); } catch(e) {}
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const d = JSON.parse(raw); if (d && d.schemaVersion===2) return d; }
  } catch(e) {}
  return null;
}

// ─── SHAREPOINT via Graph API ─────────────────────────────────────────────────
async function spLogin() {
  if (!USE_SHAREPOINT) return false;
  try {
    // Usa MSAL popup (requiere incluir msal-browser en index.html)
    if (!window.msal) { showAlert('warn','MSAL no cargado. Usando almacenamiento local.'); return false; }
    const pca = new window.msal.PublicClientApplication({ auth: { clientId: MSAL_CONFIG.clientId, authority: 'https://login.microsoftonline.com/'+MSAL_CONFIG.tenantId } });
    const res = await pca.loginPopup({ scopes: ['Files.ReadWrite', 'User.Read'] });
    msalToken = res.accessToken;
    document.getElementById('sp-status').textContent = '✓ Conectado: '+res.account.username;
    document.getElementById('btn-sp-login').style.display = 'none';
    document.getElementById('btn-sp-sync').style.display = '';
    return true;
  } catch(e) { showAlert('warn','No se pudo conectar con SharePoint: '+e.message); return false; }
}

async function spLoadData() {
  if (!msalToken || !MSAL_CONFIG.sharePointFile) return null;
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/drive/root:/'+encodeURIComponent(MSAL_CONFIG.sharePointFile)+':/content', {
      headers: { Authorization: 'Bearer '+msalToken }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

async function spSaveData(data) {
  if (!msalToken || !MSAL_CONFIG.sharePointFile) return false;
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/drive/root:/'+encodeURIComponent(MSAL_CONFIG.sharePointFile)+':/content', {
      method: 'PUT',
      headers: { Authorization: 'Bearer '+msalToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(data, null, 2)
    });
    return res.ok;
  } catch(e) { return false; }
}

async function syncWithSharePoint() {
  showAlert('info','Sincronizando con SharePoint...');
  const remote = await spLoadData();
  if (remote && remote.schemaVersion===2) {
    appData = remote; saveLocal();
    renderAll(); showAlert('success','Sincronizado con SharePoint.');
  } else { showAlert('warn','No se encontró archivo en SharePoint. Se usarán datos locales.'); }
}

// ─── SAVE ─────────────────────────────────────────────────────────────────────
async function saveAll() {
  syncVisibleInputs();
  saveLocal();
  document.getElementById('btn-save').textContent = 'Guardado ✓';
  setTimeout(()=>document.getElementById('btn-save').textContent='Guardar',1500);
  if (msalToken) {
    const ok = await spSaveData(appData);
    if (ok) showAlert('success','Guardado y sincronizado con SharePoint.');
    else showAlert('warn','Guardado localmente. No se pudo sincronizar con SharePoint.');
  }
}

// ─── UNDO ─────────────────────────────────────────────────────────────────────
function pushUndo(desc) {
  undoStack.push({ desc, snap: JSON.parse(JSON.stringify(appData)) });
  if (undoStack.length > 20) undoStack.shift();
  document.getElementById('btn-undo').disabled = false;
  document.getElementById('btn-undo').title = 'Deshacer: '+desc;
}
function doUndo() {
  if (!undoStack.length) return;
  const e = undoStack.pop(); appData = e.snap; saveLocal(); renderAll();
  showAlert('info','Deshecho: '+e.desc);
  if (!undoStack.length) document.getElementById('btn-undo').disabled = true;
}

// ─── SEMANAS / FECHAS ─────────────────────────────────────────────────────────
function getWeeksOfMonth(ym) {
  const [y,m] = ym.split('-').map(Number);
  const first = new Date(y,m-1,1), last = new Date(y,m,0);
  const weeks = []; let cur = new Date(first);
  const dow = cur.getDay();
  cur.setDate(cur.getDate()+(dow===0?-6:1-dow));
  while (cur<=last) {
    const mon=new Date(cur),sun=new Date(cur); sun.setDate(sun.getDate()+6);
    weeks.push({ id:getWeekId(mon), label:isoDate(mon).slice(5).replace('-','/')+' – '+isoDate(sun).slice(5).replace('-','/'), monday:isoDate(mon), sunday:isoDate(sun) });
    cur.setDate(cur.getDate()+7);
  }
  return weeks;
}
function getWeekId(date) {
  const d=new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate()+4-(d.getDay()||7));
  const y=d.getFullYear(), w=Math.ceil((((d-new Date(y,0,1))/86400000)+1)/7);
  return y+'-W'+String(w).padStart(2,'0');
}
function getDaysOfWeek(w) {
  const days=[],start=new Date(w.monday);
  for(let i=0;i<7;i++){const d=new Date(start);d.setDate(d.getDate()+i);const iso=isoDate(d);days.push({iso,dayName:DAY_NAMES[d.getDay()],label:DAY_LABELS[d.getDay()]+' '+isoToDD(iso)});}
  return days;
}

// ─── ESTADO TAREA ─────────────────────────────────────────────────────────────
function computeStatus(t) {
  if (t.status==='Completed') return 'Completed';
  if (!t.startTime) return 'Pending';
  const sm=toM(t.startTime),em=toM(t.endTime),nm=nowM(),today=todayISO();
  if (t.date&&t.date<today&&em!==null) return 'Overdue';
  if (t.date!==today) return 'Pending';
  if (sm!==null&&sm<=nm&&(em===null||nm<em)) return 'InProgress';
  if (em!==null&&nm>=em) return 'Overdue';
  return 'Pending';
}
function statusLabel(s){ return{Pending:'Pendiente',InProgress:'▶ En curso',Completed:'✓ Hecha',Overdue:'⚠ Vencida',Unassigned:'Sin asignar'}[s]||s; }
function statusClass(s){ return{Pending:'sb-p',InProgress:'sb-a',Completed:'sb-d',Overdue:'sb-v',Unassigned:'sb-u'}[s]||'sb-p'; }
function chipClass(s){  return{Pending:'chip-p',InProgress:'chip-a',Completed:'chip-d',Overdue:'chip-v',Unassigned:'chip-u'}[s]||'chip-p'; }

// ─── RENDER ALL ───────────────────────────────────────────────────────────────
function renderAll() {
  renderMonthNav(); renderDayNav(); renderTasks(); renderUnassigned(); updateMetrics(); updateGanado();
  if (currentTab==='cal') renderCalendar();
  if (currentTab==='rep') renderReport('week');
}

// ─── CALENDARIO ───────────────────────────────────────────────────────────────
function renderCalendar() {
  const grid=document.getElementById('cal-grid'); grid.innerHTML='';
  CAL_HEADERS.forEach(d=>{const el=document.createElement('div');el.className='cal-hdr';el.textContent=d;grid.appendChild(el);});
  const [y,m]=selectedMonth.split('-').map(Number);
  const first=new Date(y,m-1,1),today=todayISO();
  let cur=new Date(first);
  const dow=cur.getDay(); cur.setDate(cur.getDate()+(dow===0?-6:1-dow));
  const byDate={};
  (appData.tasks||[]).forEach(t=>{if(!t||t.schedulingStatus==='Unassigned'||!t.date)return;if(!byDate[t.date])byDate[t.date]=[];byDate[t.date].push(t);});
  let cells=0;
  while(cells<42){
    const iso=isoDate(cur),inMonth=cur.getMonth()===m-1;
    const cell=document.createElement('div');
    cell.className='cal-cell'+(iso===today?' today':'')+(iso===selectedDayISO?' selected':'')+(!inMonth?' other':'');
    cell.onclick=(function(d){return function(){goToDay(d);};})(iso);
    const num=document.createElement('div');num.className='cal-num';num.textContent=cur.getDate();cell.appendChild(num);
    const tasks=(byDate[iso]||[]).sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||''));
    tasks.slice(0,3).forEach(t=>{
      const chip=document.createElement('div');const st=computeStatus(t);
      chip.className='cal-chip '+chipClass(st);chip.textContent=t.title||'(sin nombre)';
      chip.title=(t.startTime?t.startTime+' ':'')+statusLabel(st);cell.appendChild(chip);
    });
    if(tasks.length>3){const more=document.createElement('div');more.className='cal-more';more.textContent='+'+( tasks.length-3)+' más';cell.appendChild(more);}
    grid.appendChild(cell);cur.setDate(cur.getDate()+1);cells++;
  }
}

function goToDay(iso){
  selectedDayISO=iso;
  const ym=iso.slice(0,7);
  if(ym!==selectedMonth){selectedMonth=ym;}
  const weeks=getWeeksOfMonth(selectedMonth);
  const w=weeks.find(wk=>wk.monday<=iso&&iso<=wk.sunday);
  if(w){selectedWeekId=w.id;const days=getDaysOfWeek(w);curDayIdx=days.findIndex(d=>d.iso===iso);if(curDayIdx<0)curDayIdx=0;}
  switchTabName('plan');
}

// ─── NAV ──────────────────────────────────────────────────────────────────────
function changeMonth(d){
  const [y,m]=selectedMonth.split('-').map(Number);
  const nd=new Date(y,m-1+d,1);
  selectedMonth=nd.getFullYear()+'-'+String(nd.getMonth()+1).padStart(2,'0');
  const weeks=getWeeksOfMonth(selectedMonth);
  selectedWeekId=weeks.length?weeks[0].id:null;
  if(weeks.length){const days=getDaysOfWeek(weeks[0]);selectedDayISO=days[0].iso;curDayIdx=0;}
  renderAll();
}
function goToToday(){
  selectedMonth=new Date().toISOString().slice(0,7);
  const today=todayISO(),weeks=getWeeksOfMonth(selectedMonth);
  const tw=weeks.find(w=>w.monday<=today&&today<=w.sunday);
  selectedWeekId=tw?tw.id:(weeks.length?weeks[0].id:null);
  const dow=new Date().getDay(); curDayIdx=dow===0?6:dow-1; selectedDayISO=today;
  renderAll();
}

function renderMonthNav(){
  const [y,m]=selectedMonth.split('-').map(Number);
  document.getElementById('month-label').textContent=MONTH_NAMES[m-1]+' '+y;
  const weeks=getWeeksOfMonth(selectedMonth);
  const tabs=document.getElementById('week-tabs'); tabs.innerHTML='';
  weeks.forEach((w,i)=>{
    const btn=document.createElement('button');
    btn.className='wtab'+(w.id===selectedWeekId?' active':'');
    btn.textContent='S'+(i+1);btn.title=w.label;
    btn.onclick=()=>{selectedWeekId=w.id;curDayIdx=0;const days=getDaysOfWeek(w);selectedDayISO=days[0].iso;renderAll();};
    tabs.appendChild(btn);
  });
}

function renderDayNav(){
  const nav=document.getElementById('day-nav');nav.innerHTML='';
  if(!selectedWeekId)return;
  const week=getWeeksOfMonth(selectedMonth).find(w=>w.id===selectedWeekId);
  if(!week)return;
  const today=todayISO();
  getDaysOfWeek(week).forEach((d,i)=>{
    const btn=document.createElement('button');
    btn.className='dbt'+(i===curDayIdx?' active':'')+(d.iso===today?' today':'');
    btn.textContent=d.label;
    btn.onclick=()=>{curDayIdx=i;selectedDayISO=d.iso;renderDayNav();renderTasks();updateMetrics();};
    nav.appendChild(btn);
  });
}

// ─── TAREAS ───────────────────────────────────────────────────────────────────
function getTasksForDay(dayISO){
  const dn=DAY_NAMES[new Date(dayISO+'T00:00:00').getDay()];
  return(appData.tasks||[]).filter(t=>t&&t.schedulingStatus!=='Unassigned'&&(t.date===dayISO||(!t.date&&t.day===dn)));
}

function renderTasks(){
  const list=document.getElementById('task-list');list.innerHTML='';
  const tasks=getTasksForDay(selectedDayISO).sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||''));
  if(!tasks.length){list.innerHTML='<div class="empty">Sin tareas para este día.<br>Pulsa + para añadir.</div>';return;}
  tasks.forEach(t=>{
    const st=computeStatus(t);
    const sm=toM(t.startTime),em=toM(t.endTime);
    const dur=(sm!==null&&em!==null&&em>sm)?em-sm:(t.durationMinutes||null);
    const row=document.createElement('div');row.className='trow s-'+st;row.dataset.id=t.id;
    row.innerHTML=
      '<div class="trow-top">'+
        '<div class="trow-times">'+
          '<input class="t-start" type="time" value="'+(t.startTime||'')+'" onchange="onTC(this)" placeholder="Inicio">'+
          '<span class="trow-arrow">→</span>'+
          '<input class="t-end" type="time" value="'+(t.endTime||'')+'" onchange="onTC(this)" placeholder="Fin">'+
          '<span class="dur-badge">'+fmtD(dur)+'</span>'+
        '</div>'+
        '<span class="sbadge '+statusClass(st)+'" onclick="toggleDone(\''+t.id+'\')">'+statusLabel(st)+'</span>'+
      '</div>'+
      '<div class="trow-bot">'+
        '<input class="t-title" type="text" placeholder="Nombre de la tarea" value="'+esc(t.title||'')+'">'+
        '<div class="trow-meta">'+
          '<select class="t-discipline">'+DISCIPLINES.map(d=>'<option value="'+d+'"'+(t.discipline===d?' selected':'')+'>'+esc(d||'Disciplina')+'</option>').join('')+'</select>'+
          '<input class="t-project" type="text" placeholder="Proyecto" value="'+esc(t.project||'')+'">'+
          '<button class="btn-del" onclick="delTask(\''+t.id+'\')">🗑</button>'+
        '</div>'+
      '</div>';
    list.appendChild(row);
  });
}

function onTC(input){
  const row=input.closest('.trow');
  const sm=toM(row.querySelector('.t-start').value),em=toM(row.querySelector('.t-end').value);
  const badge=row.querySelector('.dur-badge');
  if(badge)badge.textContent=fmtD((sm!==null&&em!==null&&em>sm)?em-sm:null);
}

function renderUnassigned(){
  const list=document.getElementById('unassigned-list');list.innerHTML='';
  const tasks=(appData.tasks||[]).filter(t=>t&&t.schedulingStatus==='Unassigned');
  document.getElementById('unassigned-count').textContent=tasks.length;
  if(!tasks.length){list.innerHTML='<div class="empty">Sin tareas sin asignar.</div>';return;}
  tasks.forEach(t=>{
    const row=document.createElement('div');row.className='urow';row.dataset.id=t.id;
    row.innerHTML=
      '<div class="urow-main">'+
        '<input class="t-title" type="text" placeholder="Tarea..." value="'+esc(t.title||'')+'">'+
        '<button class="btn-assign-sm" onclick="openAssignModal(\''+t.id+'\')">Asignar →</button>'+
        '<button class="btn-del" onclick="delTask(\''+t.id+'\')">🗑</button>'+
      '</div>'+
      '<div class="urow-meta">'+
        '<select class="t-discipline">'+DISCIPLINES.map(d=>'<option value="'+d+'"'+(t.discipline===d?' selected':'')+'>'+esc(d||'Disciplina')+'</option>').join('')+'</select>'+
        '<input class="t-project" type="text" placeholder="Proyecto" value="'+esc(t.project||'')+'">'+
      '</div>';
    list.appendChild(row);
  });
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
function syncVisibleInputs(){
  document.querySelectorAll('#task-list .trow').forEach(row=>{
    const t=appData.tasks.find(x=>x.id===row.dataset.id);if(!t)return;
    t.startTime=row.querySelector('.t-start').value||null;
    t.endTime=row.querySelector('.t-end').value||null;
    t.title=row.querySelector('.t-title').value.trim();
    t.discipline=row.querySelector('.t-discipline').value;
    t.project=row.querySelector('.t-project').value.trim();
    const sm=toM(t.startTime),em=toM(t.endTime);
    t.durationMinutes=(sm!==null&&em!==null&&em>sm)?em-sm:null;
    t.updatedAt=new Date().toISOString();
  });
  document.querySelectorAll('#unassigned-list .urow').forEach(row=>{
    const t=appData.tasks.find(x=>x.id===row.dataset.id);if(!t)return;
    t.title=row.querySelector('.t-title').value.trim();
    t.discipline=row.querySelector('.t-discipline').value;
    t.project=row.querySelector('.t-project').value.trim();
    t.updatedAt=new Date().toISOString();
  });
}

function addTask(){
  syncVisibleInputs();pushUndo('Añadir tarea');
  const dn=DAY_NAMES[new Date(selectedDayISO+'T00:00:00').getDay()];
  appData.tasks.push({id:genId(),title:'',discipline:'',project:'',status:'Pending',schedulingStatus:'Assigned',date:selectedDayISO,month:selectedDayISO.slice(0,7),weekId:selectedWeekId,day:dn,startTime:null,endTime:null,durationMinutes:null,notes:'',completedAt:null,timeGainedMinutes:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  renderTasks();updateMetrics();
  setTimeout(()=>{const rows=document.querySelectorAll('#task-list .trow');if(rows.length)rows[rows.length-1].querySelector('.t-title').focus();},50);
}

function addUnassigned(){
  syncVisibleInputs();pushUndo('Añadir tarea sin asignar');
  appData.tasks.push({id:genId(),title:'',discipline:'',project:'',status:'Pending',schedulingStatus:'Unassigned',date:null,month:null,weekId:null,day:null,startTime:null,endTime:null,durationMinutes:null,notes:'',completedAt:null,timeGainedMinutes:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  renderUnassigned();updateMetrics();
}

function delTask(id){
  syncVisibleInputs();
  const t=appData.tasks.find(x=>x.id===id);
  pushUndo('Eliminar "'+(t?t.title||'tarea':'tarea')+'"');
  appData.tasks=appData.tasks.filter(x=>x.id!==id);
  saveLocal();renderTasks();renderUnassigned();updateMetrics();
  if(currentTab==='cal')renderCalendar();
  showAlert('info','Eliminada. Pulsa Deshacer para recuperar.');
}

function toggleDone(id){
  syncVisibleInputs();
  const t=appData.tasks.find(x=>x.id===id);if(!t)return;
  pushUndo((t.status==='Completed'?'Desmarcar':'Completar')+' "'+t.title+'"');
  if(t.status==='Completed'){
    t.status='Pending';t.completedAt=null;
    if(t.timeGainedMinutes>0){appData.timeBank.totalGainedMinutes=Math.max(0,(appData.timeBank.totalGainedMinutes||0)-t.timeGainedMinutes);t.timeGainedMinutes=0;}
  }else{
    const em=toM(t.endTime),nm=nowM();
    t.completedAt=new Date().toISOString();t.status='Completed';
    if(em!==null&&em>nm&&t.date===todayISO()){
      const g=em-nm;t.timeGainedMinutes=g;
      appData.timeBank.totalGainedMinutes=(appData.timeBank.totalGainedMinutes||0)+g;
      appData.timeBank.entries=appData.timeBank.entries||[];
      appData.timeBank.entries.push({taskId:t.id,title:t.title,gainedMinutes:g,at:t.completedAt});
      showAlert('success','¡'+fmtD(g)+' ganados!');
    }else{t.timeGainedMinutes=0;showAlert('success','"'+t.title+'" completada.');}
  }
  t.updatedAt=new Date().toISOString();
  saveLocal();renderTasks();updateMetrics();updateGanado();
  if(currentTab==='cal')renderCalendar();
}

// ─── ASIGNAR ──────────────────────────────────────────────────────────────────
function openAssignModal(id){
  syncVisibleInputs();assigningTaskId=id;
  document.getElementById('assign-date').value=selectedDayISO;
  document.getElementById('assign-start').value='';
  document.getElementById('assign-end').value='';
  document.getElementById('modal-assign').classList.add('show');
}
function closeModal(id){document.getElementById(id).classList.remove('show');}
function confirmAssign(){
  if(!assigningTaskId)return;
  const t=appData.tasks.find(x=>x.id===assigningTaskId);if(!t)return;
  const date=document.getElementById('assign-date').value;
  if(!date){showAlert('warn','Selecciona una fecha.');return;}
  syncVisibleInputs();pushUndo('Asignar "'+t.title+'"');
  const start=document.getElementById('assign-start').value,end=document.getElementById('assign-end').value;
  t.schedulingStatus='Assigned';t.date=date;t.month=date.slice(0,7);
  t.weekId=getWeekId(new Date(date));t.day=DAY_NAMES[new Date(date+'T00:00:00').getDay()];
  t.startTime=start||null;t.endTime=end||null;
  const sm=toM(start),em=toM(end);t.durationMinutes=(sm!==null&&em!==null&&em>sm)?em-sm:null;
  t.updatedAt=new Date().toISOString();
  closeModal('modal-assign');saveLocal();renderTasks();renderUnassigned();updateMetrics();
  if(currentTab==='cal')renderCalendar();
  showAlert('success','"'+t.title+'" asignada al '+isoToDD(date)+'.');
}

// ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
function updateMetrics(){
  const tasks=appData.tasks||[];let p=0,a=0,d=0,v=0,u=0;
  tasks.forEach(t=>{
    if(t.schedulingStatus==='Unassigned'){u++;return;}
    const st=computeStatus(t);
    if(st==='Completed')d++;else if(st==='InProgress')a++;else if(st==='Overdue')v++;else p++;
  });
  document.getElementById('m-p').textContent=p;document.getElementById('m-a').textContent=a;
  document.getElementById('m-d').textContent=d;document.getElementById('m-v').textContent=v;
  document.getElementById('m-u').textContent=u;
}
function updateGanado(){
  const m=appData.timeBank?appData.timeBank.totalGainedMinutes||0:0;
  document.getElementById('ganado-val').textContent=fmtD(m)||'0 min';
  document.getElementById('m-g').textContent=m;
}

// ─── ALERTAS ──────────────────────────────────────────────────────────────────
function showAlert(type,msg){alertQueue.push({type,msg});if(!alertActive)processQ();}
function closeAlert(){document.getElementById('alert-box').classList.remove('show');alertActive=false;setTimeout(processQ,200);}
function processQ(){
  if(!alertQueue.length){alertActive=false;return;}
  alertActive=true;const{type,msg}=alertQueue.shift();
  const box=document.getElementById('alert-box');
  document.getElementById('alert-msg').textContent=msg;
  box.className='alert ab-'+type+' show';
  beep(type);
  setTimeout(()=>{box.classList.remove('show');setTimeout(processQ,200);},4000);
}
function beep(type){
  try{
    if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    const s={success:[659,880],warn:[600,500],danger:[800,600],info:[440,550]};
    const f=s[type]||s.info;let t=audioCtx.currentTime;
    f.forEach((fr,i)=>{const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=fr;o.type='sine';g.gain.setValueAtTime(0,t+i*.18);g.gain.linearRampToValueAtTime(.15,t+i*.18+.02);g.gain.linearRampToValueAtTime(0,t+i*.18+.13);o.start(t+i*.18);o.stop(t+i*.18+.17);});
  }catch(e){}
}

// ─── NOTIFICACIONES PROGRAMADAS ───────────────────────────────────────────────
function startNotifLoop(){
  if(notifInterval)clearInterval(notifInterval);
  checkNotifs();notifInterval=setInterval(checkNotifs,60000);
}
function checkNotifs(){
  const today=todayISO(),nm=nowM();
  const todayPfx=today+'_';
  Object.keys(notifiedFlags).forEach(k=>{if(!k.startsWith(todayPfx))delete notifiedFlags[k];});
  (appData.tasks||[]).filter(t=>t&&t.schedulingStatus==='Assigned'&&t.date===today&&t.status!=='Completed'&&t.startTime).forEach(t=>{
    const sm=toM(t.startTime),em=toM(t.endTime);if(sm===null)return;
    const diff=sm-nm;
    const fire=(sfx,title,body)=>{const k=today+'_'+t.id+'_'+sfx;if(!notifiedFlags[k]){notifiedFlags[k]=true;sendNotif(title,body);}};
    if(diff>=9&&diff<=10)fire('10m','⏰ En 10 minutos','"'+t.title+'" comienza a las '+t.startTime);
    if(diff>=4&&diff<=5) fire('5m', '⏰ En 5 minutos', '"'+t.title+'" comienza a las '+t.startTime);
    if(diff>=0&&diff<=1) fire('go', '▶ Tarea iniciada','"'+t.title+'" comienza ahora');
    if(em!==null){const de=em-nm;
      if(de>=4&&de<=5)fire('e5','⚠ Quedan 5 minutos','"'+t.title+'" termina a las '+t.endTime);
      if(de>=0&&de<=1)fire('end','🔔 Fin de tarea','"'+t.title+'" ha terminado');
    }
  });
}
async function sendNotif(title,body){
  showAlert('info',title+' — '+body);
  if('Notification' in window&&Notification.permission==='granted'){
    try{new Notification(title,{body,icon:'./icons/icon-192.png',vibrate:[200,100,200]});}catch(e){}
  }
}
async function requestNotifPermission(){
  if(!('Notification' in window))return;
  if(Notification.permission==='default') await Notification.requestPermission();
  if(Notification.permission==='granted') showAlert('success','Notificaciones activadas.');
  else showAlert('warn','Notificaciones denegadas. Las alertas visuales siguen activas.');
}

// ─── AUTO ESTADOS ─────────────────────────────────────────────────────────────
function checkStateChanges(){
  const today=todayISO();
  (appData.tasks||[]).filter(t=>t&&t.schedulingStatus==='Assigned'&&t.date===today).forEach(t=>{
    const st=computeStatus(t),prev=prevStates[t.id];
    if(prev!==st){
      if(st==='InProgress'&&prev==='Pending')showAlert('info','▶ "'+t.title+'" ha comenzado');
      if(st==='Overdue'&&(prev==='InProgress'||prev==='Pending'))showAlert('warn','⚠ "'+t.title+'" ha vencido');
      prevStates[t.id]=st;
    }
  });
  if(selectedDayISO===today){renderTasks();updateMetrics();}
  if(currentTab==='cal')renderCalendar();
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(tab){
  currentTab=tab;
  ['cal','plan','rep','unassigned'].forEach(id=>{
    const el=document.getElementById('panel-'+id);
    if(el)el.style.display=id===tab?'block':'none';
  });
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  if(tab==='cal')renderCalendar();
  if(tab==='rep')renderReport('week');
}
function switchTabName(tab){ switchTab(tab); }

// ─── REPORT ───────────────────────────────────────────────────────────────────
function renderReport(mode){
  const el=document.getElementById('rep-content');
  const tasks=(appData.tasks||[]).filter(t=>t&&t.schedulingStatus==='Assigned');
  const unassigned=(appData.tasks||[]).filter(t=>t&&t.schedulingStatus==='Unassigned');
  document.querySelectorAll('.rep-tab').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  if(mode==='week')      el.innerHTML=repByTask(tasks.filter(t=>t.weekId===selectedWeekId),'Semana '+selectedWeekId)+repUnassigned(unassigned);
  else if(mode==='month')el.innerHTML=repByTask(tasks.filter(t=>t.month===selectedMonth),'Mes: '+MONTH_NAMES[parseInt(selectedMonth.split('-')[1])-1])+repUnassigned(unassigned);
  else if(mode==='disc') el.innerHTML=repByGroup(tasks,t=>t.discipline||'Sin disciplina','Por disciplina');
  else if(mode==='proj') el.innerHTML=repByGroup(tasks,t=>t.project||'Sin proyecto','Por proyecto');
}
function repByTask(tasks,title){
  const tot={},dm={},cm={};let grand=0;
  tasks.forEach(t=>{if(!t.title)return;const d=t.durationMinutes||0;tot[t.title]=(tot[t.title]||0)+d;grand+=d;cm[t.title]=(cm[t.title]||0)+1;if(computeStatus(t)==='Completed')dm[t.title]=(dm[t.title]||0)+1;});
  const entries=Object.entries(tot).sort((a,b)=>b[1]-a[1]);
  if(!entries.length)return'<div class="empty">Sin tareas con horario.</div>';
  const mx=entries[0][1]||1;
  let h='<div class="rep-title">'+title+'</div>';
  entries.forEach(([n,m])=>{const pct=grand>0?Math.round(m/grand*100):0,bw=Math.round(m/mx*100),done=dm[n]||0,total=cm[n]||0;h+='<div class="rep-row"><div class="rep-name">'+esc(n)+'<div class="rep-bar-w"><div class="rep-bar" style="width:'+bw+'%"></div></div></div><div class="rep-val">'+fmtD(m)+'</div><div class="rep-pct">'+pct+'%</div><div class="rep-prog" style="color:'+(done===total&&total>0?'#3B6D11':'#6B7E93')+'">'+done+'/'+total+'</div></div>';});
  h+='<div class="rep-total"><span>Total</span><span>'+fmtD(grand)+'</span></div>';
  return h;
}
function repByGroup(tasks,fn,title){
  const tot={},cm={},dm={};let grand=0;
  tasks.forEach(t=>{const k=fn(t),d=t.durationMinutes||0;tot[k]=(tot[k]||0)+d;grand+=d;cm[k]=(cm[k]||0)+1;if(computeStatus(t)==='Completed')dm[k]=(dm[k]||0)+1;});
  const entries=Object.entries(tot).sort((a,b)=>b[1]-a[1]);
  if(!entries.length)return'<div class="empty">Sin datos.</div>';
  const mx=entries[0][1]||1;
  let h='<div class="rep-title">'+title+'</div>';
  entries.forEach(([n,m])=>{const pct=grand>0?Math.round(m/grand*100):0,bw=Math.round(m/mx*100);h+='<div class="rep-row"><div class="rep-name">'+esc(n)+'<div class="rep-bar-w"><div class="rep-bar" style="width:'+bw+'%"></div></div></div><div class="rep-val">'+fmtD(m)+'</div><div class="rep-pct">'+pct+'%</div><div class="rep-prog">'+(dm[n]||0)+'/'+cm[n]+'</div></div>';});
  h+='<div class="rep-total"><span>Total</span><span>'+fmtD(grand)+'</span></div>';
  return h;
}
function repUnassigned(tasks){
  if(!tasks.length)return'';
  let h='<div class="rep-title">Sin asignar ('+tasks.length+')</div>';
  tasks.forEach(t=>{h+='<div class="rep-row"><div class="rep-name">'+esc(t.title||'(sin nombre)')+'</div><div class="rep-val" style="color:#6B3FA0">'+esc(t.discipline||'—')+'</div><div class="rep-pct">'+esc(t.project||'—')+'</div><div class="rep-prog">'+(t.durationMinutes?fmtD(t.durationMinutes):'—')+'</div></div>';});
  return h;
}

function exportCSV(){
  syncVisibleInputs();
  let csv='Mes,Semana,Fecha,Día,Tarea,Disciplina,Proyecto,Estado,Inicio,Fin,Duración min,Completada,Min ganados\n';
  (appData.tasks||[]).forEach(t=>{if(!t)return;const st=t.schedulingStatus==='Unassigned'?'Sin asignar':computeStatus(t);const dur=t.durationMinutes||'';csv+=[t.month||'',t.weekId||'',t.date||'',t.day||'','"'+(t.title||'').replace(/"/g,'""')+'"','"'+(t.discipline||'').replace(/"/g,'""')+'"','"'+(t.project||'').replace(/"/g,'""')+'"',st,t.startTime||'',t.endTime||'',dur,t.completedAt||'',t.timeGainedMinutes||0].join(',')+'\n';});
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'}));a.download='report_'+todayISO()+'.csv';a.click();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init(){
  const saved=loadLocal();
  if(saved)appData=saved;
  else if(appData.settings&&appData.settings.lastSelectedMonth)selectedMonth=appData.settings.lastSelectedMonth;

  const today=todayISO(),weeks=getWeeksOfMonth(selectedMonth);
  const tw=weeks.find(w=>w.monday<=today&&today<=w.sunday);
  selectedWeekId=tw?tw.id:(weeks.length?weeks[0].id:null);
  const dow=new Date().getDay();curDayIdx=dow===0?6:dow-1;selectedDayISO=today;

  // Registrar Service Worker
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js').catch(e=>console.log('SW error:',e));
  }

  // Pedir permiso de notificaciones
  requestNotifPermission();

  updateGanado();renderAll();updateClock();
  checkStateChanges();startNotifLoop();
  setInterval(()=>{checkStateChanges();updateClock();},30000);

  const n=new Date();
  const months=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  document.getElementById('hdr-sub').textContent=DAY_LABELS[n.getDay()]+' '+n.getDate()+' '+months[n.getMonth()]+' '+n.getFullYear();
}

function updateClock(){
  const n=new Date();
  document.getElementById('clock').textContent=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
}

init();
