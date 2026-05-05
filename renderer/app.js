// ============================================================
// Punch — renderer logic v1.3.3
// ============================================================

const SWATCH_PALETTE = [
  '#e89b43','#e35b5b','#d96fc3','#9874e3','#5b9be3','#3fb8c4','#5cc97a','#c4cc5b',
  '#b87333','#8b6f4e','#a89c8a','#6b7280','#4a90a4','#7ba05b','#e8a87c','#c38d9e'
];
const DEFAULT_HOTKEY = 'CommandOrControl+Alt+P';
const WIDGET_SIZE = { width: 360, height: 380 };
const FULL_SIZE   = { width: 920, height: 720 };

const defaultData = () => ({
  projects: [{ id:'p_default', name:'General', color:'#e89b43', archived:false, subcategories:[] }],
  entries: [], tasks: [], accounts: [], activeTimer: null, rules: [],
  settings: {
    hotkey: DEFAULT_HOTKEY, alwaysOnTop: true,
    idleEnabled: true, idleThresholdMin: 5,
    autodetectEnabled: false, webhookUrl: '',
    accountLabel: 'Account'
  },
  nextId: 2
});

// State
let state = defaultData();
let editingProjectId = null, editingProjectSubcats = [];
let editingEntryId = null, editingTaskId = null, editingRuleId = null;
let selectedColor = SWATCH_PALETTE[0];
let tickInterval = null;
let lastDetectedWindow = null, pendingAutodetect = null;
let idleTimerSnapshot = null;
let taskFilter = 'active';
let entrySearchTerm = '';

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
async function init(){
  const loaded = await window.punch.loadData();
  if (loaded) state = mergeWithDefaults(loaded);

  try {
    const dp = await window.punch.dataPath();
    document.querySelector('#dataPathHint .mono').textContent = dp;
  } catch(_) {}

  try {
    const ver = await window.punch.getVersion();
    document.getElementById('appVersion').textContent = ver;
    checkAndShowWhatsNew(ver);
  } catch(_) {}

  const adAvail = await window.punch.autodetectAvailable();
  document.getElementById('adAvailability').textContent =
    adAvail ? '(active-win available)' : '(unavailable on this system)';
  if (!adAvail) document.getElementById('autodetectToggle').disabled = true;

  bindUI();
  applySettings();
  buildSwatches();
  renderAll();
  attachIPCListeners();
  if (state.activeTimer) startTick();
}

function mergeWithDefaults(loaded){
  const d = defaultData();
  const merged = { ...d, ...loaded };
  merged.settings = { ...d.settings, ...(loaded.settings || {}) };
  merged.projects = (loaded.projects || []).map(p => ({ archived:false, subcategories:[], ...p }));
  merged.entries  = loaded.entries  || [];
  merged.tasks    = loaded.tasks    || [];
  merged.accounts = loaded.accounts || [];
  merged.rules    = loaded.rules    || [];
  merged.nextId   = loaded.nextId   || 1;
  return merged;
}

function save(){ window.punch.saveData(state); }
function nextId(prefix){ return prefix + '_' + (state.nextId++); }

// ------------------------------------------------------------
// Time helpers
// ------------------------------------------------------------
function pad2(n){ return String(n).padStart(2,'0'); }
function formatHMS(ms){
  const t = Math.max(0, Math.floor(ms/1000));
  return `${pad2(Math.floor(t/3600))}:${pad2(Math.floor((t%3600)/60))}:${pad2(t%60)}`;
}
function formatHM(ms){
  const t = Math.max(0, Math.floor(ms/60000));
  return `${Math.floor(t/60)}:${pad2(t%60)}`;
}
function formatTimeOfDay(ms){
  const d = new Date(ms);
  let h = d.getHours(); const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${pad2(m)} ${ampm}`;
}
function startOfDay(ms){ const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
function startOfWeek(ms){ const d=new Date(ms); d.setHours(0,0,0,0); d.setDate(d.getDate()-d.getDay()); return d.getTime(); }
function dayLabel(ms){
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
}
function toDateInput(ms){ const d=new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function toTimeInput(ms){ const d=new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fromDateTimeInputs(ds,ts){ return (!ds||!ts)?null:new Date(`${ds}T${ts}:00`).getTime(); }
function dateStamp(){ const d=new Date(); return d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate()); }

// ------------------------------------------------------------
// Lookups
// ------------------------------------------------------------
function getProject(id){ return state.projects.find(p=>p.id===id)||null; }
function getSubcat(pid, sid){
  const p=getProject(pid); if(!p||!sid) return null;
  return (p.subcategories||[]).find(s=>s.id===sid)||null;
}
function getTask(id){ return state.tasks.find(t=>t.id===id)||null; }
function getAccount(id){ return state.accounts.find(a=>a.id===id)||null; }
function accountLabel(){ return state.settings.accountLabel || 'Account'; }

function sumTaskMs(taskId){
  let total=0;
  for(const e of state.entries){ if(e.taskId===taskId) total+=Math.max(0,e.endMs-e.startMs); }
  if(state.activeTimer&&state.activeTimer.taskId===taskId) total+=Math.max(0,Date.now()-state.activeTimer.startMs);
  return total;
}

// ------------------------------------------------------------
// Mode
// ------------------------------------------------------------
function setMode(mode){
  // Exit mini mode if active
  if (isMiniMode) {
    // Show title bar before exiting mini mode
    document.querySelector('.titlebar').style.display = 'flex';
    exitMiniMode();
  }
  
  document.body.classList.toggle('widget-mode',mode==='widget');
  document.body.classList.toggle('full-mode',mode==='full');
  document.getElementById('brandTag').textContent = mode==='widget'?'widget':'full view';
  document.getElementById('btnExpand').title = mode==='widget'?'Expand to full view':'Collapse to widget';
  const tgt = mode==='widget'?WIDGET_SIZE:FULL_SIZE;
  
  // Set appropriate min size for full view
  if (mode === 'full') {
    window.punch.setMinSize(720, 600);
  } else {
    window.punch.setMinSize(320, 320);
  }
  
  window.punch.resize(tgt.width, tgt.height);
}
function toggleMode(){ setMode(document.body.classList.contains('widget-mode')?'full':'widget'); }

// ------------------------------------------------------------
// Option renderers
// ------------------------------------------------------------
function renderProjectOptions(sel, selectedId, includeBlank=false){
  sel.innerHTML='';
  if(includeBlank){ const o=document.createElement('option'); o.value=''; o.textContent='— none —'; sel.appendChild(o); }
  state.projects.filter(p=>!p.archived).forEach(p=>{
    const o=document.createElement('option'); o.value=p.id; o.textContent=p.name;
    if(p.id===selectedId) o.selected=true; sel.appendChild(o);
  });
}
function renderSubcatOptions(sel, projectId, selectedId){
  sel.innerHTML='';
  const blank=document.createElement('option'); blank.value=''; blank.textContent='— no subcategory —'; sel.appendChild(blank);
  const p=getProject(projectId); if(!p) return;
  (p.subcategories||[]).forEach(s=>{
    const o=document.createElement('option'); o.value=s.id; o.textContent=s.name;
    if(s.id===selectedId) o.selected=true; sel.appendChild(o);
  });
}
function renderAccountOptions(sel, selectedId){
  sel.innerHTML='';
  const blank=document.createElement('option'); blank.value=''; blank.textContent=`— no ${accountLabel().toLowerCase()} —`; sel.appendChild(blank);
  state.accounts.forEach(a=>{
    const o=document.createElement('option'); o.value=a.id; o.textContent=a.name;
    if(a.id===selectedId) o.selected=true; sel.appendChild(o);
  });
}

function updateAccountLabels(){
  const lbl=accountLabel();
  document.getElementById('accountLabelTitle').textContent=lbl+'s';
  const acctSel=document.getElementById('accountSel');
  if(acctSel && acctSel.options[0]) acctSel.options[0].textContent=`— no ${lbl.toLowerCase()} —`;
  const el=document.getElementById('entryAccountLabel'); if(el) el.textContent=lbl;
  const tl=document.getElementById('taskAccountLabel'); if(tl) tl.textContent=lbl;
}

// ------------------------------------------------------------
// Renders
// ------------------------------------------------------------
function renderTimerWidget(){
  const widget=document.getElementById('timerWidget');
  const btn=document.getElementById('btnTimer');
  const projSel=document.getElementById('projectSel');
  const subSel=document.getElementById('subcatSel');
  const acctSel=document.getElementById('accountSel');
  const notes=document.getElementById('notesInput');
  const badge=document.getElementById('activeTaskBadge');

  renderProjectOptions(projSel, state.activeTimer?state.activeTimer.projectId:projSel.value);
  renderSubcatOptions(subSel, projSel.value, state.activeTimer?state.activeTimer.subcategoryId:null);
  renderAccountOptions(acctSel, state.activeTimer?state.activeTimer.accountId:null);

  if(state.activeTimer){
    widget.classList.add('running');
    btn.textContent='STOP'; btn.classList.add('stop');
    document.getElementById('statusText').textContent='Running';
    document.getElementById('readout').textContent=formatHMS(Date.now()-state.activeTimer.startMs);
    notes.value=state.activeTimer.notes||'';
    if(state.activeTimer.accountId) acctSel.value=state.activeTimer.accountId;
    if(state.activeTimer.taskId){
      const t=getTask(state.activeTimer.taskId);
      badge.textContent=t?t.name:''; badge.classList.toggle('hidden',!t);
    } else badge.classList.add('hidden');
  } else {
    widget.classList.remove('running');
    btn.textContent='START'; btn.classList.remove('stop');
    document.getElementById('statusText').textContent='Stopped';
    document.getElementById('readout').textContent='00:00:00';
    badge.classList.add('hidden');
  }
}

function renderTotals(){
  const now=Date.now();
  document.getElementById('totalToday').textContent=formatHM(sumAllMs(startOfDay(now),now));
  document.getElementById('totalWeek').textContent=formatHM(sumAllMs(startOfWeek(now),now));
  document.getElementById('totalMonth').textContent=formatHM(sumAllMs(now-30*86400000,now));
}

function matchesSearch(e, term){
  if(!term) return true;
  const t = term.toLowerCase();
  const project = getProject(e.projectId); const subcat = getSubcat(e.projectId, e.subcategoryId);
  const account = e.accountId?getAccount(e.accountId):null; const task = e.taskId?getTask(e.taskId):null;
  const hay = [
    project?project.name:'',
    subcat?subcat.name:'',
    account?account.name:'',
    task?task.name:'',
    e.notes||''
  ].join(' ').toLowerCase();
  return hay.includes(t);
}

function renderEntries(){
  const list=document.getElementById('entriesList');
  list.innerHTML='';
  const searched = state.entries.filter(e => matchesSearch(e, entrySearchTerm));
  if(searched.length===0){
    list.innerHTML = entrySearchTerm
      ? `<div class="empty">No entries match "${esc(entrySearchTerm)}".</div>`
      : `<div class="empty">No entries yet. Punch in above to start logging time.</div>`;
    return;
  }
  const sorted=[...searched].sort((a,b)=>b.startMs-a.startMs);
  const groups=new Map();
  for(const e of sorted){ const k=startOfDay(e.startMs); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(e); }
  const dayKeys=[...groups.keys()].sort((a,b)=>b-a).slice(0,30);
  for(const dayKey of dayKeys){
    const dayEntries=groups.get(dayKey);
    const dayMs=dayEntries.reduce((s,e)=>s+entryDuration(e),0);
    const group=document.createElement('div'); group.className='day-group';
    group.innerHTML=`<div class="day-header"><span>${dayLabel(dayKey)}</span><span class="day-total">${formatHM(dayMs)}</span></div>`;
    for(const e of dayEntries){
      const project=getProject(e.projectId);
      const subcat=getSubcat(e.projectId,e.subcategoryId);
      const account=e.accountId?getAccount(e.accountId):null;
      const task=e.taskId?getTask(e.taskId):null;
      const color=project?project.color:'#666';
      const projectName=project?project.name:'(deleted project)';
      const subcatTag=subcat?`<span class="subcat-tag">${esc(subcat.name)}</span>`:'';
      const accountTag=account?`<span class="account-badge">${esc(account.name)}</span>`:'';
      const taskTag=task?`<span class="subcat-tag" style="color:var(--amber)">📋 ${esc(task.name)}</span>`:'';
      const row=document.createElement('div'); row.className='entry';
      row.innerHTML=`
        <div class="entry-bar" style="background:${esc(color)}"></div>
        <div class="entry-meta">
          <div class="entry-project">${esc(projectName)}${subcatTag}${accountTag}${taskTag}</div>
          <div class="entry-notes">${esc(e.notes||'')}</div>
        </div>
        <div class="entry-times">${formatTimeOfDay(e.startMs)} → ${formatTimeOfDay(e.endMs)}</div>
        <div class="entry-duration">${formatHMS(entryDuration(e))}</div>
        <div class="entry-actions">
          <button class="icon-btn green" title="Resume" data-resume-entry="${e.id}">▶</button>
          <button class="icon-btn" title="Edit" data-edit-entry="${e.id}">✎</button>
        </div>`;
      group.appendChild(row);
    }
    list.appendChild(group);
  }
  list.querySelectorAll('[data-edit-entry]').forEach(b=>b.addEventListener('click',()=>openEntryModal(b.dataset.editEntry)));
  list.querySelectorAll('[data-resume-entry]').forEach(b=>b.addEventListener('click',()=>resumeEntry(b.dataset.resumeEntry)));
}

function renderTasks(){
  const list=document.getElementById('tasksList');
  list.innerHTML='';
  let filtered=state.tasks;
  if(taskFilter==='active') filtered=state.tasks.filter(t=>!t.completed);
  else if(taskFilter==='completed') filtered=state.tasks.filter(t=>t.completed);
  if(filtered.length===0){
    const msg=taskFilter==='completed'?'No completed tasks yet.':taskFilter==='active'?'No active tasks. Click "+ New task" to add one.':'No tasks yet.';
    list.innerHTML=`<div class="empty">${msg}</div>`; return;
  }
  const byProject=new Map();
  for(const t of filtered){ if(!byProject.has(t.projectId)) byProject.set(t.projectId,[]); byProject.get(t.projectId).push(t); }
  for(const [pid,tasks] of byProject){
    const p=getProject(pid);
    const groupTotal=tasks.reduce((s,t)=>s+sumTaskMs(t.id),0);
    const header=document.createElement('div'); header.className='task-group-header';
    header.innerHTML=`
      <span class="task-group-swatch" style="background:${esc(p?p.color:'#666')}"></span>
      <span>${esc(p?p.name:'(deleted project)')}</span>
      <span class="task-group-time">${formatHM(groupTotal)} tracked</span>`;
    list.appendChild(header);
    for(const t of tasks){
      const taskMs=sumTaskMs(t.id);
      const isRunning=state.activeTimer&&state.activeTimer.taskId===t.id;
      const account=t.accountId?getAccount(t.accountId):null;
      const card=document.createElement('div'); card.className=`task-card${t.completed?' completed':''}`;
      card.innerHTML=`
        <div class="task-card-top">
          <div class="task-checkbox${t.completed?' checked':''}" data-toggle-task="${t.id}"></div>
          <div class="task-main">
            <div class="task-name">${esc(t.name)}</div>
            <div class="task-meta">
              <span class="task-time-badge${taskMs>0?' has-time':''}">${formatHM(taskMs)} logged</span>
              ${account?`<span class="account-badge">${esc(account.name)}</span>`:''}
              ${isRunning?'<span style="font-size:10px;color:var(--amber)">● Running</span>':''}
              ${t.completedAt?`<span class="task-completed-at">Done ${new Date(t.completedAt).toLocaleDateString()}</span>`:''}
            </div>
          </div>
          <div class="task-actions">
            ${!t.completed?`<button class="icon-btn amber" title="Start timer for this task" data-task-timer="${t.id}">▶</button>`:''}
            <button class="icon-btn" title="Edit" data-edit-task="${t.id}">✎</button>
          </div>
        </div>
        ${t.notes?`<div class="task-notes-block">${esc(t.notes)}</div>`:''}`;
      list.appendChild(card);
    }
  }
  list.querySelectorAll('[data-toggle-task]').forEach(el=>el.addEventListener('click',()=>toggleTaskComplete(el.dataset.toggleTask)));
  list.querySelectorAll('[data-task-timer]').forEach(el=>el.addEventListener('click',()=>startTimerForTask(el.dataset.taskTimer)));
  list.querySelectorAll('[data-edit-task]').forEach(el=>el.addEventListener('click',()=>openTaskModal(el.dataset.editTask)));
}

function renderProjects(){
  const list=document.getElementById('projectsList'); list.innerHTML='';
  if(state.projects.length===0){ list.innerHTML='<div class="empty">No projects yet.</div>'; return; }
  const weekStart=startOfWeek(Date.now());
  state.projects.forEach(p=>{
    const total=sumProjectMs(p.id,weekStart,Date.now());
    const subcats=(p.subcategories||[]);
    const subcatHtml=subcats.length
      ?`<div class="project-subcats">${subcats.map(s=>`<span class="subcat-chip">${esc(s.name)}</span>`).join('')}</div>`
      :`<div class="project-card-empty">No subcategories yet</div>`;
    const card=document.createElement('div'); card.className='project-card';
    card.innerHTML=`
      <div class="project-card-head">
        <span class="project-swatch" style="background:${esc(p.color)}"></span>
        <span class="project-card-name">${esc(p.name)}</span>
        <span class="project-card-time">${formatHM(total)} this wk</span>
      </div>${subcatHtml}`;
    card.addEventListener('click',()=>openProjectModal(p.id));
    list.appendChild(card);
  });
}

function renderAccountsList(){
  const list=document.getElementById('accountsList'); list.innerHTML='';
  if(state.accounts.length===0){
    list.innerHTML=`<div style="padding:8px 0; font-size:11px; color:var(--text-faint)">No entries yet.</div>`; return;
  }
  state.accounts.forEach(a=>{
    const row=document.createElement('div'); row.className='account-row-item';
    row.innerHTML=`
      <span class="account-item-name">${esc(a.name)}</span>
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 4px 12px; border-radius: 6px; background: ${a.billableByDefault ? 'rgba(84, 221, 125, 0.3)' : 'transparent'}; transition: background 0.15s ease;">
        <input type="checkbox" 
               data-toggle-billable="${a.id}" 
               ${a.billableByDefault ? 'checked' : ''} 
               style="width: 14px; height: 14px; cursor: pointer; accent-color: rgb(84, 221, 125);" />
        <span style="font-size: 11px; font-weight: 500; letter-spacing: 0.5px; color: ${a.billableByDefault ? 'rgb(84, 221, 125)' : 'var(--text-faint)'}; text-transform: uppercase;">Billable</span>
      </label>
      <button class="icon-btn" data-edit-account="${a.id}" title="Edit">✎</button>`;
    list.appendChild(row);
  });
  
  list.querySelectorAll('[data-toggle-billable]').forEach(checkbox=>{
    checkbox.addEventListener('change',()=>{
      const id=checkbox.dataset.toggleBillable;
      const acc=getAccount(id);
      if(!acc) return;
      acc.billableByDefault=checkbox.checked;
      save();
      renderAccountsList();
      toast(checkbox.checked ? `${acc.name} is now billable` : `${acc.name} is now non-billable`);
    });
  });
  
  list.querySelectorAll('[data-edit-account]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.editAccount;
      openAccountModal(id);
    });
  });
}

function renderRules(){
  const tbl=document.getElementById('rulesTable'); tbl.innerHTML='';
  if(state.rules.length===0){ tbl.innerHTML='<div class="empty" style="padding:18px">No autodetect rules yet.</div>'; return; }
  state.rules.forEach(r=>{
    const p=getProject(r.projectId); const s=getSubcat(r.projectId,r.subcategoryId);
    const target=p?`${p.name}${s?' / '+s.name:''}`:'(missing project)';
    const row=document.createElement('div'); row.className='rule-row';
    row.innerHTML=`
      <div><div class="rule-pattern">"${esc(r.pattern)}"</div><div class="rule-target">→ ${esc(target)}</div></div>
      <div class="rule-action ${r.action}">${r.action==='autostart'?'Auto-start':'Suggest'}</div>
      <button class="icon-btn" data-edit-rule="${r.id}" title="Edit">✎</button>`;
    tbl.appendChild(row);
  });
  tbl.querySelectorAll('[data-edit-rule]').forEach(b=>b.addEventListener('click',()=>openRuleModal(b.dataset.editRule)));
}

function renderAll(){
  renderTimerWidget(); renderTotals(); renderEntries();
  renderTasks(); renderProjects(); renderRules();
  renderAccountsList(); updateAccountLabels();
}

// ------------------------------------------------------------
// Sums
// ------------------------------------------------------------
function entryDuration(e){ return Math.max(0,e.endMs-e.startMs); }
function sumAllMs(fromMs,toMs){
  let total=0;
  for(const e of state.entries){
    if(e.endMs<fromMs||e.startMs>toMs) continue;
    const s=Math.max(e.startMs,fromMs),en=Math.min(e.endMs,toMs);
    if(en>s) total+=en-s;
  }
  if(state.activeTimer){
    const s=Math.max(state.activeTimer.startMs,fromMs),en=Math.min(Date.now(),toMs);
    if(en>s) total+=en-s;
  }
  return total;
}
function sumProjectMs(projectId,fromMs,toMs){
  let total=0;
  for(const e of state.entries){
    if(e.projectId!==projectId||e.endMs<fromMs||e.startMs>toMs) continue;
    const s=Math.max(e.startMs,fromMs),en=Math.min(e.endMs,toMs);
    if(en>s) total+=en-s;
  }
  if(state.activeTimer&&state.activeTimer.projectId===projectId){
    const s=Math.max(state.activeTimer.startMs,fromMs),en=Math.min(Date.now(),toMs);
    if(en>s) total+=en-s;
  }
  return total;
}

// ------------------------------------------------------------
// Timer
// ------------------------------------------------------------
function toggleTimer(){ if(state.activeTimer) stopTimer(); else startTimer(); }

function startTimer(opts={}){
  const projectId=opts.projectId||document.getElementById('projectSel').value||(state.projects[0]&&state.projects[0].id);
  if(!projectId){ toast('Add a project first'); return; }
  const subcategoryId=opts.subcategoryId!==undefined?opts.subcategoryId:(document.getElementById('subcatSel').value||null);
  const accountId=opts.accountId!==undefined?opts.accountId:(document.getElementById('accountSel').value||null);
  const notes=opts.notes!==undefined?opts.notes:document.getElementById('notesInput').value.trim();
  const taskId=opts.taskId||null;
  state.activeTimer={ projectId, subcategoryId, accountId, notes, taskId, startMs:Date.now() };
  document.getElementById('projectSel').value=projectId;
  renderSubcatOptions(document.getElementById('subcatSel'),projectId,subcategoryId);
  document.getElementById('subcatSel').value=subcategoryId||'';
  renderAccountOptions(document.getElementById('accountSel'),accountId);
  document.getElementById('accountSel').value=accountId||'';
  document.getElementById('notesInput').value=notes;
  save(); renderAll(); startTick(); 
  updateMiniTimer(); // Update mini mode button state
  toast('Timer started');
}

function stopTimer(){
  if(!state.activeTimer) return;
  const projectId=document.getElementById('projectSel').value||state.activeTimer.projectId;
  const subcategoryId=document.getElementById('subcatSel').value||null;
  const accountId=document.getElementById('accountSel').value||null;
  const notes=document.getElementById('notesInput').value.trim();
  const endMs=Date.now(); const duration=endMs-state.activeTimer.startMs;
  if(duration<1000){ state.activeTimer=null; save(); renderAll(); stopTick(); toast('Too short — discarded'); return; }
state.entries.push({
  id:nextId('e'), projectId, subcategoryId, accountId, notes,
  taskId:state.activeTimer.taskId||null,
  billable: false,
  startMs:state.activeTimer.startMs, endMs
});
  state.activeTimer=null;
  document.getElementById('notesInput').value='';
  save(); renderAll(); stopTick(); 
  updateMiniTimer(); // Update mini mode button state
  toast('Logged '+formatHMS(duration));
}

function resumeEntry(entryId){
  const e=state.entries.find(x=>x.id===entryId); if(!e) return;
  if(state.activeTimer) stopTimer();
  startTimer({ projectId:e.projectId, subcategoryId:e.subcategoryId||null, accountId:e.accountId||null, notes:e.notes||'', taskId:e.taskId||null });
  toast('Resumed — timer running');
}

function startTimerForTask(taskId){
  const t=getTask(taskId); if(!t) return;
  if(state.activeTimer) stopTimer();
  startTimer({ projectId:t.projectId, subcategoryId:t.subcategoryId||null, accountId:t.accountId||null, notes:t.name, taskId:t.id });
  setMode('widget');
}

function startTick(){
  stopTick();
  tickInterval=setInterval(()=>{
    if(!state.activeTimer){ stopTick(); return; }
    const elapsed = formatHMS(Date.now()-state.activeTimer.startMs);
    document.getElementById('readout').textContent=elapsed;
    updateMiniTimer();
    renderTotals();
    
    // Update tray tooltip with timer
    const project = getProject(state.activeTimer.projectId);
    window.punch.updateTrayTooltip(elapsed, project ? project.name : 'Unknown Project');
    
    // Update taskbar overlay icon with timer
    window.punch.updateTaskbarOverlay(elapsed);
  },1000);
}
function stopTick(){ 
  if(tickInterval) clearInterval(tickInterval); 
  tickInterval=null;
  // Reset tray tooltip and taskbar overlay when timer stops
  window.punch.updateTrayTooltip(null, null);
  window.punch.updateTaskbarOverlay(null);
}

function bindActiveTimerInputs(){
  const projSel=document.getElementById('projectSel');
  const subSel=document.getElementById('subcatSel');
  const acctSel=document.getElementById('accountSel');
  const notes=document.getElementById('notesInput');
  projSel.addEventListener('change',()=>{
    renderSubcatOptions(subSel,projSel.value,null);
    if(state.activeTimer){ state.activeTimer.projectId=projSel.value; state.activeTimer.subcategoryId=null; save(); }
  });
  subSel.addEventListener('change',()=>{ if(state.activeTimer){ state.activeTimer.subcategoryId=subSel.value||null; save(); } });
  acctSel.addEventListener('change',()=>{ if(state.activeTimer){ state.activeTimer.accountId=acctSel.value||null; save(); } });
  notes.addEventListener('blur',()=>{ if(state.activeTimer){ state.activeTimer.notes=notes.value.trim(); save(); } });
}

// ------------------------------------------------------------
// Quick-add subcategory
// ------------------------------------------------------------
function quickAddSubcat(projectId, onAdded){
   console.log('MODAL VERSION LOADED');
  const p = getProject(projectId);
  if (!p) {
    toast('Select a project first');
    return;
  }
  
  // Show modal
  document.getElementById('subcatProjectName').textContent = p.name;
  document.getElementById('subcatInput').value = '';
  openModal('subcatModal');
  
  // Focus input after modal opens
  setTimeout(() => document.getElementById('subcatInput').focus(), 100);
  
  // Store callback for confirm button
  window._quickAddCallback = (name) => {
    if (!name || !name.trim()) return;
    
    const sc = { id: nextId('sc'), name: name.trim() };
    p.subcategories = p.subcategories || [];
    p.subcategories.push(sc);
    save();
    
    if (onAdded) onAdded(sc.id);
    toast(`Added: ${sc.name}`);
  };
}
// ------------------------------------------------------------
// Project modal
// ------------------------------------------------------------
function buildSwatches(){
  const grid=document.getElementById('swatchGrid'); grid.innerHTML='';
  SWATCH_PALETTE.forEach(c=>{
    const s=document.createElement('div'); s.className='swatch'; s.style.background=c;
    if(c===selectedColor) s.classList.add('selected');
    s.addEventListener('click',()=>{ selectedColor=c; buildSwatches(); });
    grid.appendChild(s);
  });
}
function openProjectModal(projectId){
  editingProjectId=projectId||null;
  if(projectId){
    const p=getProject(projectId);
    document.getElementById('projectModalTitle').textContent='Edit project';
    document.getElementById('projectName').value=p.name;
    selectedColor=p.color;
    editingProjectSubcats=(p.subcategories||[]).map(s=>({...s}));
    document.getElementById('btnDeleteProject').style.display='';
  } else {
    document.getElementById('projectModalTitle').textContent='New project';
    document.getElementById('projectName').value='';
    selectedColor=SWATCH_PALETTE[Math.floor(Math.random()*SWATCH_PALETTE.length)];
    editingProjectSubcats=[];
    document.getElementById('btnDeleteProject').style.display='none';
  }
  buildSwatches(); renderSubcatEditor(); openModal('projectModal');
  setTimeout(()=>document.getElementById('projectName').focus(),50);
}
function renderSubcatEditor(){
  const ed=document.getElementById('subcatEditor'); ed.innerHTML='';
  if(editingProjectSubcats.length===0){
    ed.innerHTML='<div style="padding:6px 8px;font-size:11px;color:var(--text-faint)">No subcategories yet.</div>'; return;
  }
  editingProjectSubcats.forEach((s,idx)=>{
    const row=document.createElement('div'); row.className='subcat-row';
    row.innerHTML=`<input type="text" value="${esc(s.name)}" data-subcat-idx="${idx}" maxlength="60" /><button class="icon-btn" data-subcat-del="${idx}" title="Remove">×</button>`;
    ed.appendChild(row);
  });
  ed.querySelectorAll('[data-subcat-idx]').forEach(input=>{
    input.addEventListener('input',()=>{ editingProjectSubcats[input.dataset.subcatIdx].name=input.value; });
  });
  ed.querySelectorAll('[data-subcat-del]').forEach(btn=>{
    btn.addEventListener('click',()=>{ editingProjectSubcats.splice(Number(btn.dataset.subcatDel),1); renderSubcatEditor(); });
  });
}
function addSubcatFromInput(){
  const input=document.getElementById('newSubcatInput'); const name=input.value.trim();
  if(!name) return;
  editingProjectSubcats.push({id:nextId('sc'),name});
  input.value=''; renderSubcatEditor(); input.focus();
}
function saveProject(){
  const name=document.getElementById('projectName').value.trim();
  if(!name){ toast('Name required'); return; }
  const subcats=editingProjectSubcats.map(s=>({...s,name:s.name.trim()})).filter(s=>s.name);
  if(editingProjectId){ const p=getProject(editingProjectId); p.name=name; p.color=selectedColor; p.subcategories=subcats; }
  else { state.projects.push({id:nextId('p'),name,color:selectedColor,archived:false,subcategories:subcats}); }
  save(); closeModal('projectModal'); renderAll();
}
function deleteProject(){
  if(!editingProjectId) return;
  const p=getProject(editingProjectId); if(!p) return;
  const count=state.entries.filter(e=>e.projectId===editingProjectId).length;
  if(!confirm(count>0?`Delete "${p.name}"? ${count} entries will remain but show as "(deleted project)".`:`Delete "${p.name}"?`)) return;
  state.projects=state.projects.filter(x=>x.id!==editingProjectId);
  state.rules=state.rules.filter(r=>r.projectId!==editingProjectId);
  if(state.activeTimer&&state.activeTimer.projectId===editingProjectId){ state.activeTimer=null; stopTick(); }
  save(); closeModal('projectModal'); renderAll();
}

// ------------------------------------------------------------
// Entry modal
// ------------------------------------------------------------
function openManualEntry(){
  if(state.projects.length===0){ toast('Add a project first'); return; }
  setMode('full'); editingEntryId=null;
  document.getElementById('entryModalTitle').textContent='Manual entry';
  document.getElementById('btnDeleteEntry').style.display='none';
  const projSel=document.getElementById('entryProject');
  const subSel=document.getElementById('entrySubcat');
  const acctSel=document.getElementById('entryAccount');
  renderProjectOptions(projSel,state.projects[0].id);
  renderSubcatOptions(subSel,state.projects[0].id,null);
  renderAccountOptions(acctSel,null);
  projSel.onchange=()=>renderSubcatOptions(subSel,projSel.value,null);
  document.getElementById('entryNotes').value='';
  const now=Date.now(), ago=now-3600000;
  document.getElementById('entryStartDate').value=toDateInput(ago);
  document.getElementById('entryStartTime').value=toTimeInput(ago);
  document.getElementById('entryEndDate').value=toDateInput(now);
  document.getElementById('entryEndTime').value=toTimeInput(now);
  updateAccountLabels();
  openModal('entryModal');
}
function openEntryModal(entryId){
  const e=state.entries.find(x=>x.id===entryId); if(!e) return;
  setMode('full'); editingEntryId=entryId;
  document.getElementById('entryModalTitle').textContent='Edit entry';
  document.getElementById('btnDeleteEntry').style.display='';
  const projSel=document.getElementById('entryProject');
  const subSel=document.getElementById('entrySubcat');
  const acctSel=document.getElementById('entryAccount');
  renderProjectOptions(projSel,e.projectId);
  renderSubcatOptions(subSel,e.projectId,e.subcategoryId);
  renderAccountOptions(acctSel,e.accountId||null);
  projSel.onchange=()=>renderSubcatOptions(subSel,projSel.value,null);
  document.getElementById('entryNotes').value=e.notes||'';
  document.getElementById('entryBillable').checked = e ? (e.billable || false) : false;
  document.getElementById('entryStartDate').value=toDateInput(e.startMs);
  document.getElementById('entryStartTime').value=toTimeInput(e.startMs);
  document.getElementById('entryEndDate').value=toDateInput(e.endMs);
  document.getElementById('entryEndTime').value=toTimeInput(e.endMs);
  updateAccountLabels();
  openModal('entryModal');
}
function saveEntry(){
  const projectId=document.getElementById('entryProject').value;
  const subcategoryId=document.getElementById('entrySubcat').value||null;
  const accountId=document.getElementById('entryAccount').value||null;
  const notes=document.getElementById('entryNotes').value.trim();
  const startMs=fromDateTimeInputs(document.getElementById('entryStartDate').value,document.getElementById('entryStartTime').value);
  const endMs=fromDateTimeInputs(document.getElementById('entryEndDate').value,document.getElementById('entryEndTime').value);
  const billable = document.getElementById('entryBillable').checked;
  if(!projectId){ toast('Pick a project'); return; }
  if(!startMs||!endMs){ toast('Set start and end'); return; }
  if(endMs<=startMs){ toast('End must be after start'); return; }
  if(editingEntryId){
    const e=state.entries.find(x=>x.id===editingEntryId);
    Object.assign(e,{projectId,subcategoryId,accountId,notes,startMs,endMs});
  } else {
state.entries.push({
  id:nextId('e'),
  projectId,
  subcategoryId,
  accountId,
  notes,
  taskId:null,
  billable: billable, 
  startMs,
  endMs
});
  }
  save(); closeModal('entryModal'); renderAll();
}
function deleteEntry(){
  if(!editingEntryId) return;
  if(!confirm('Delete this entry?')) return;
  state.entries=state.entries.filter(x=>x.id!==editingEntryId);
  save(); closeModal('entryModal'); renderAll();
}

// ------------------------------------------------------------
// Task modal
// ------------------------------------------------------------
function openTaskModal(taskId){
  editingTaskId=taskId||null;
  if(state.projects.length===0){ toast('Add a project first'); return; }
  const projSel=document.getElementById('taskProject');
  const subSel=document.getElementById('taskSubcat');
  const acctSel=document.getElementById('taskAccount');
  if(taskId){
    const t=getTask(taskId);
    document.getElementById('taskModalTitle').textContent='Edit task';
    document.getElementById('taskName').value=t.name;
    document.getElementById('taskNotes').value=t.notes||'';
    renderProjectOptions(projSel,t.projectId);
    renderSubcatOptions(subSel,t.projectId,t.subcategoryId);
    renderAccountOptions(acctSel,t.accountId||null);
    document.getElementById('btnDeleteTask').style.display='';
  } else {
    document.getElementById('taskModalTitle').textContent='New task';
    document.getElementById('taskName').value='';
    document.getElementById('taskNotes').value='';
    renderProjectOptions(projSel,state.projects[0].id);
    renderSubcatOptions(subSel,state.projects[0].id,null);
    renderAccountOptions(acctSel,null);
    document.getElementById('btnDeleteTask').style.display='none';
  }
  projSel.onchange=()=>renderSubcatOptions(subSel,projSel.value,null);
  updateAccountLabels();
  openModal('taskModal');
  setTimeout(()=>document.getElementById('taskName').focus(),50);
}
function saveTask(){
  const name=document.getElementById('taskName').value.trim();
  if(!name){ toast('Task name required'); return; }
  const projectId=document.getElementById('taskProject').value;
  const subcategoryId=document.getElementById('taskSubcat').value||null;
  const accountId=document.getElementById('taskAccount').value||null;
  const notes=document.getElementById('taskNotes').value.trim();
  if(editingTaskId){ const t=getTask(editingTaskId); Object.assign(t,{name,projectId,subcategoryId,accountId,notes}); }
  else { state.tasks.push({id:nextId('t'),name,projectId,subcategoryId,accountId,notes,completed:false,completedAt:null,createdAt:Date.now()}); }
  save(); closeModal('taskModal'); renderTasks();
}
function deleteTask(){
  if(!editingTaskId) return;
  if(!confirm('Delete this task? Time logged to it stays in history.')) return;
  state.tasks=state.tasks.filter(x=>x.id!==editingTaskId);
  save(); closeModal('taskModal'); renderTasks();
}
function toggleTaskComplete(taskId){
  const t=getTask(taskId); if(!t) return;
  t.completed=!t.completed; t.completedAt=t.completed?Date.now():null;
  save(); renderTasks(); toast(t.completed?'Task marked complete':'Task reopened');
}

// ------------------------------------------------------------
// Accounts management
// ------------------------------------------------------------
function addAccount(){
  const input=document.getElementById('newAccountInput');
  const name=input.value.trim(); if(!name) return;
  state.accounts.push({id:nextId('a'),name,billableByDefault:false});
  input.value=''; save(); renderAccountsList(); renderAll();
  toast(`Added: ${name}`);
}
function setAccountLabel(){
  const val=document.getElementById('accountLabelInput').value.trim();
  if(!val) return;
  state.settings.accountLabel=val; save(); updateAccountLabels(); renderAll();
  toast(`Field renamed to "${val}"`);
}
let editingAccountId = null;

function openAccountModal(accountId) {
  editingAccountId = accountId || null;
  const acc = accountId ? getAccount(accountId) : null;
  
  document.getElementById('accountModalTitle').textContent = accountId ? 'Edit Account' : 'New Account';
  document.getElementById('accountName').value = acc ? acc.name : '';
  document.getElementById('accountBillable').checked = acc ? (acc.billableByDefault || false) : true;
  document.getElementById('btnDeleteAccount').style.display = accountId ? 'block' : 'none';
  
  openModal('accountModal');
  setTimeout(() => document.getElementById('accountName').focus(), 100);
}

function saveAccountModal() {
  const name = document.getElementById('accountName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  
  const billable = document.getElementById('accountBillable').checked;
  
  if (editingAccountId) {
    // Edit existing
    const acc = getAccount(editingAccountId);
    if (!acc) return;
    acc.name = name;
    acc.billableByDefault = billable;
  } else {
    // Create new
    state.accounts.push({id:nextId('a'), name, billableByDefault:billable});
  }
  
  save();
  renderAccountsList();
  renderAll();
  closeModal('accountModal');
  toast(editingAccountId ? 'Updated' : `Added: ${name}`);
}

function deleteAccountModal() {
  if (!editingAccountId) return;
  const acc = getAccount(editingAccountId);
  if (!acc) return;
  
  const count = state.entries.filter(e => e.accountId === editingAccountId).length;
  if (!confirm(count > 0 ? `Delete "${acc.name}"? ${count} entries will remain but show as "(no account)".` : `Delete "${acc.name}"?`)) return;
  
  state.accounts = state.accounts.filter(a => a.id !== editingAccountId);
  state.entries.forEach(e => { if (e.accountId === editingAccountId) e.accountId = null; });
  state.tasks.forEach(t => { if (t.accountId === editingAccountId) t.accountId = null; });
  if (state.activeTimer && state.activeTimer.accountId === editingAccountId) state.activeTimer.accountId = null;
  
  save();
  renderAccountsList();
  renderAll();
  closeModal('accountModal');
  toast('Deleted');
}

// ------------------------------------------------------------
// Rule modal
// ------------------------------------------------------------
function openRuleModal(ruleId){
  editingRuleId=ruleId||null;
  if(state.projects.length===0){ toast('Add a project first'); return; }
  const projSel=document.getElementById('ruleProject');
  const subSel=document.getElementById('ruleSubcat');
  if(ruleId){
    const r=state.rules.find(x=>x.id===ruleId);
    document.getElementById('ruleModalTitle').textContent='Edit rule';
    document.getElementById('rulePattern').value=r.pattern;
    renderProjectOptions(projSel,r.projectId);
    renderSubcatOptions(subSel,r.projectId,r.subcategoryId);
    document.getElementById('ruleAction').value=r.action;
    document.getElementById('btnDeleteRule').style.display='';
  } else {
    document.getElementById('ruleModalTitle').textContent='New autodetect rule';
    document.getElementById('rulePattern').value='';
    renderProjectOptions(projSel,state.projects[0].id);
    renderSubcatOptions(subSel,state.projects[0].id,null);
    document.getElementById('ruleAction').value='suggest';
    document.getElementById('btnDeleteRule').style.display='none';
  }
  projSel.onchange=()=>renderSubcatOptions(subSel,projSel.value,null);
  openModal('ruleModal');
}
function saveRule(){
  const pattern=document.getElementById('rulePattern').value.trim();
  const projectId=document.getElementById('ruleProject').value;
  const subcategoryId=document.getElementById('ruleSubcat').value||null;
  const action=document.getElementById('ruleAction').value;
  if(!pattern){ toast('Pattern required'); return; }
  if(!projectId){ toast('Pick a project'); return; }
  if(editingRuleId){ const r=state.rules.find(x=>x.id===editingRuleId); Object.assign(r,{pattern,projectId,subcategoryId,action}); }
  else { state.rules.push({id:nextId('r'),pattern,projectId,subcategoryId,action}); }
  save(); closeModal('ruleModal'); renderRules();
}
function deleteRule(){
  if(!editingRuleId) return;
  state.rules=state.rules.filter(x=>x.id!==editingRuleId);
  save(); closeModal('ruleModal'); renderRules();
}

// ------------------------------------------------------------
// CSV / JSON
// ------------------------------------------------------------
function csvEscape(v){ if(v==null) return ''; const s=String(v); return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function exportCSV(){
  const lbl=accountLabel();
  const rows=[['Date','Project','Subcategory',lbl,'Task','Notes','Start','End','Duration (HH:MM:SS)','Hours (decimal)']];
  const sorted=[...state.entries].sort((a,b)=>a.startMs-b.startMs);
  for(const e of sorted){
    const p=getProject(e.projectId); const s=getSubcat(e.projectId,e.subcategoryId);
    const a=e.accountId?getAccount(e.accountId):null; const t=e.taskId?getTask(e.taskId):null;
    const dur=entryDuration(e); const ds=new Date(e.startMs), de=new Date(e.endMs);
    rows.push([ds.toLocaleDateString(),p?p.name:'(deleted)',s?s.name:'',a?a.name:'',t?t.name:'',e.notes||'',ds.toLocaleString(),de.toLocaleString(),formatHMS(dur),(dur/3600000).toFixed(2)]);
  }
  const csv=rows.map(r=>r.map(csvEscape).join(',')).join('\r\n');
  download('punch_entries_'+dateStamp()+'.csv',csv,'text/csv');
  toast('CSV exported');
}
function exportJsonBackup(){
  download('punch_backup_'+dateStamp()+'.json',JSON.stringify(state,null,2),'application/json');
  toast('JSON backup downloaded');
}
function importJsonBackup(evt){
  const file=evt.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const data=JSON.parse(e.target.result);
      if(!data.projects||!data.entries) throw new Error('Invalid file');
      if(!confirm('This will replace ALL current data. Continue?')) return;
      state=mergeWithDefaults(data); state.activeTimer=null;
      save(); applySettings(); renderAll(); toast('Data imported');
    } catch(err){ toast('Import failed: '+err.message); }
  };
  reader.readAsText(file); evt.target.value='';
}
function download(name,content,mime){
  const blob=new Blob([content],{type:mime}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
function wipeAll(){
  if(!confirm('Erase ALL data? This cannot be undone.')) return;
  if(!confirm('Really wipe everything?')) return;
  state=defaultData(); save(); applySettings(); renderAll(); toast('All data erased');
}

// ------------------------------------------------------------
// AI Summary
// ------------------------------------------------------------
function getSummaryRange(){
  const sel=document.getElementById('summaryRange').value, now=Date.now();
  if(sel==='thisWeek') return {start:startOfWeek(now),end:now,label:'This week'};
  if(sel==='lastWeek'){ const en=startOfWeek(now)-1,st=startOfWeek(en); return {start:st,end:startOfWeek(now),label:'Last week'}; }
  if(sel==='last7') return {start:now-7*86400000,end:now,label:'Last 7 days'};
  if(sel==='last14') return {start:now-14*86400000,end:now,label:'Last 14 days'};
  if(sel==='last30') return {start:now-30*86400000,end:now,label:'Last 30 days'};
  if(sel==='custom'){
    const s=document.getElementById('rangeStart').value, e=document.getElementById('rangeEnd').value;
    if(!s||!e) return null;
    return {start:new Date(s).getTime(),end:new Date(e).getTime()+86400000-1,label:`${s} to ${e}`};
  }
  return null;
}

function buildSummaryData(range){
  const inRange=state.entries.filter(e=>e.endMs>=range.start&&e.startMs<=range.end).sort((a,b)=>a.startMs-b.startMs);
  let totalMs=0;
  for(const e of inRange){ const s=Math.max(e.startMs,range.start),en=Math.min(e.endMs,range.end); if(en>s) totalMs+=en-s; }
  // By project → subcat
  const byProject=new Map();
  for(const e of inRange){
    const dur=Math.min(e.endMs,range.end)-Math.max(e.startMs,range.start); if(dur<=0) continue;
    if(!byProject.has(e.projectId)) byProject.set(e.projectId,{totalMs:0,subcats:new Map(),entries:[]});
    const pAcc=byProject.get(e.projectId); pAcc.totalMs+=dur; pAcc.entries.push({...e,durationMs:dur});
    const subKey=e.subcategoryId||'_none';
    if(!pAcc.subcats.has(subKey)) pAcc.subcats.set(subKey,{totalMs:0,entries:[]});
    const sAcc=pAcc.subcats.get(subKey); sAcc.totalMs+=dur; sAcc.entries.push({...e,durationMs:dur});
  }
  const projects=[];
  for(const [pid,pAcc] of byProject){
    const p=getProject(pid); const subs=[];
    for(const [sid,sAcc] of pAcc.subcats){
      const sub=sid==='_none'?null:getSubcat(pid,sid);
      subs.push({name:sub?sub.name:'(no subcategory)',hours:+(sAcc.totalMs/3600000).toFixed(2),entryCount:sAcc.entries.length,notes:sAcc.entries.map(e=>e.notes).filter(Boolean)});
    }
    subs.sort((a,b)=>b.hours-a.hours);
    projects.push({name:p?p.name:'(deleted project)',hours:+(pAcc.totalMs/3600000).toFixed(2),percent:totalMs>0?+((pAcc.totalMs/totalMs)*100).toFixed(1):0,subcategories:subs});
  }
  projects.sort((a,b)=>b.hours-a.hours);

  // By account
  const lbl=accountLabel();
  const byAccount=new Map();
  for(const e of inRange){
    const dur=Math.min(e.endMs,range.end)-Math.max(e.startMs,range.start); if(dur<=0) continue;
    const key=e.accountId||'_none';
    if(!byAccount.has(key)) byAccount.set(key,{totalMs:0,projects:new Set()});
    const aAcc=byAccount.get(key); aAcc.totalMs+=dur; aAcc.projects.add(e.projectId);
  }
  const accounts=[];
  for(const [aid,aAcc] of byAccount){
    const a=aid==='_none'?null:getAccount(aid);
    const projectNames=[...aAcc.projects].map(pid=>{ const p=getProject(pid); return p?p.name:'(deleted)'; }).join(', ');
    accounts.push({name:a?a.name:`(no ${lbl.toLowerCase()})`,hours:+(aAcc.totalMs/3600000).toFixed(2),percent:totalMs>0?+((aAcc.totalMs/totalMs)*100).toFixed(1):0,projects:projectNames});
  }
  accounts.sort((a,b)=>b.hours-a.hours);

  const completedTasks=state.tasks.filter(t=>t.completed&&t.completedAt>=range.start&&t.completedAt<=range.end).map(t=>{
    const p=getProject(t.projectId); const a=t.accountId?getAccount(t.accountId):null;
    return {name:t.name,project:p?p.name:'(deleted)',account:a?a.name:null,hoursLogged:+(sumTaskMs(t.id)/3600000).toFixed(2)};
  });

  return {
    period:{label:range.label,start:new Date(range.start).toISOString(),end:new Date(range.end).toISOString()},
    totals:{hours:+(totalMs/3600000).toFixed(2),formatted:formatHM(totalMs),entryCount:inRange.length},
    accountLabel:lbl, projects, accounts, completedTasks,
    entries:inRange.map(e=>{
      const p=getProject(e.projectId), s=getSubcat(e.projectId,e.subcategoryId);
      const a=e.accountId?getAccount(e.accountId):null, t=e.taskId?getTask(e.taskId):null;
      return {date:new Date(e.startMs).toLocaleDateString(),project:p?p.name:'(deleted)',subcategory:s?s.name:null,account:a?a.name:null,task:t?t.name:null,notes:e.notes||null,start:new Date(e.startMs).toISOString(),end:new Date(e.endMs).toISOString(),hours:+(entryDuration(e)/3600000).toFixed(2)};
    })
  };
}

function buildMarkdownSummary(data,opts){
  let md='';
  if(opts.includePromptHeader){
    md+=`> **Instruction for AI:** Below is structured time-tracking data for the period.\n`;
    md+=`> Generate a weekly summary in a clear, columnist-style stock-market-recap tone —\n`;
    md+=`> focus on performance drivers and meaningful shifts in where time was spent.\n`;
    md+=`> Do not over-emphasize minor variations. Use short paragraphs with varied sentence\n`;
    md+=`> structure rather than bullet lists. Avoid filler affirmations and the words\n`;
    md+=`> "key", "despite", or "let's take a step back". End with a concise, prescriptive\n`;
    md+=`> takeaway about where to focus next week.\n\n---\n\n`;
  }
  md+=`# Time Tracking Summary\n\n**Period:** ${data.period.label}  \n**Total tracked:** ${data.totals.formatted} (${data.totals.hours}h across ${data.totals.entryCount} entries)\n\n`;
  const hasRealAccounts = data.accounts.some(a => a.name !== `(no ${data.accountLabel.toLowerCase()})`);
  if(hasRealAccounts){
    md+=`## By ${data.accountLabel}\n\n`;
    for(const a of data.accounts){
      md+=`### ${a.name} — ${a.hours}h (${a.percent}%)\n`;
      if(a.projects) md+=`Projects: ${a.projects}\n\n`;
    }
  }
  md+=`## By Project\n\n`;
  if(data.projects.length===0){ md+=`_No entries in this period._\n\n`; }
  else {
    for(const p of data.projects){
      md+=`### ${p.name} — ${p.hours}h (${p.percent}%)\n`;
      for(const s of p.subcategories){
        md+=`- **${s.name}:** ${s.hours}h (${s.entryCount} ${s.entryCount===1?'entry':'entries'})\n`;
        if(s.notes.length){ for(const n of s.notes.slice(0,8)) md+=`  - "${n}"\n`; if(s.notes.length>8) md+=`  - …and ${s.notes.length-8} more\n`; }
      }
      md+=`\n`;
    }
  }
  if(data.completedTasks.length>0){
    md+=`## Tasks Completed This Period\n\n`;
    for(const t of data.completedTasks){
      const acct=t.account?` — ${t.account}`:'';
      md+=`- **${t.name}** (${t.project}${acct}) — ${t.hoursLogged}h logged\n`;
    }
    md+=`\n`;
  }
  if(opts.includeFullEntries&&data.entries.length>0){
    md+=`## All Entries\n\n| Date | Project | Subcategory | ${data.accountLabel} | Task | Notes | Hours |\n|------|---------|-------------|------|------|-------|-------|\n`;
    for(const e of data.entries){
      const notes=(e.notes||'').replace(/\|/g,'\\|');
      md+=`| ${e.date} | ${e.project} | ${e.subcategory||''} | ${e.account||''} | ${e.task||''} | ${notes} | ${e.hours} |\n`;
    }
    md+=`\n`;
  }
  md+=`---\n*Generated by Punch on ${new Date().toLocaleString()}*\n`;
  return md;
}

function generateSummary(){
  const range=getSummaryRange(); if(!range){ toast('Set both dates'); return null; }
  const data=buildSummaryData(range);
  const opts={includePromptHeader:document.getElementById('includePromptHeader').checked,includeFullEntries:document.getElementById('includeFullEntries').checked};
  const md=buildMarkdownSummary(data,opts);
  document.getElementById('summaryOutput').value=md;
  return {data,md,opts};
}
async function copyMarkdown(){ const r=generateSummary(); if(!r) return; await navigator.clipboard.writeText(r.md); toast('Markdown copied'); }
async function copyJson(){ const range=getSummaryRange(); if(!range){ toast('Set both dates'); return; } await navigator.clipboard.writeText(JSON.stringify(buildSummaryData(range),null,2)); toast('JSON copied'); }
async function sendToWebhook(){
  const url=state.settings.webhookUrl; if(!url){ toast('Set webhook URL in Settings'); return; }
  const range=getSummaryRange(); if(!range){ toast('Set both dates'); return; }
  const data=buildSummaryData(range);
  const opts={includePromptHeader:document.getElementById('includePromptHeader').checked,includeFullEntries:document.getElementById('includeFullEntries').checked};
  toast('Sending…');
  const res=await window.punch.postWebhook(url,{type:'punch_summary',generatedAt:new Date().toISOString(),summary:data,markdown:buildMarkdownSummary(data,opts)});
  if(res.ok) toast('Sent (HTTP '+res.status+')'); else toast('Failed: '+(res.error||'HTTP '+res.status));
}

// ------------------------------------------------------------
// Settings & Update checker
// ------------------------------------------------------------
function applySettings(){
  const s=state.settings;
  document.getElementById('hotkeyInput').value=s.hotkey;
  document.getElementById('aotToggle').checked=!!s.alwaysOnTop;
  document.body.classList.toggle('aot-on',!!s.alwaysOnTop);
  document.getElementById('idleToggle').checked=!!s.idleEnabled;
  document.getElementById('idleThreshold').value=s.idleThresholdMin;
  document.getElementById('autodetectToggle').checked=!!s.autodetectEnabled;
  document.getElementById('webhookUrl').value=s.webhookUrl||'';
  document.getElementById('accountLabelInput').value=s.accountLabel||'Account';
  window.punch.setAlwaysOnTop(!!s.alwaysOnTop);
  window.punch.setHotkey(s.hotkey);
  if(s.idleEnabled) window.punch.startIdlePoll(s.idleThresholdMin*60); else window.punch.stopIdlePoll();
  if(s.autodetectEnabled) window.punch.startAutodetect(); else window.punch.stopAutodetect();
}
async function applyHotkey(){
  const accel=document.getElementById('hotkeyInput').value.trim(); if(!accel) return;
  const ok=await window.punch.setHotkey(accel);
  if(ok){ state.settings.hotkey=accel; save(); document.getElementById('hotkeyStatus').textContent='✓ registered'; setTimeout(()=>document.getElementById('hotkeyStatus').textContent='',3000); }
  else { document.getElementById('hotkeyStatus').textContent='✗ failed (in use?)'; }
}
async function testWebhook(){
  const url=document.getElementById('webhookUrl').value.trim(); if(!url){ toast('Enter a URL'); return; }
  state.settings.webhookUrl=url; save(); toast('Pinging…');
  const res=await window.punch.postWebhook(url,{type:'punch_test',generatedAt:new Date().toISOString()});
  if(res.ok) toast('OK (HTTP '+res.status+')'); else toast('Failed: '+(res.error||'HTTP '+res.status));
}

function renderUpdateStatus(status){
  const el=document.getElementById('updateStatus');
  const banner=document.getElementById('updateBanner');
  const bannerText=document.getElementById('updateBannerText');
  const bannerBtn=document.getElementById('btnUpdateBannerAction');
  el.className='update-status';
  banner.classList.add('hidden');

  switch(status.state){
    case 'checking':
      el.textContent='Checking for updates…';
      break;
    case 'current':
      el.classList.add('current');
      el.textContent='✓ You\'re on the latest version';
      break;
    case 'available':
      el.classList.add('available');
      el.innerHTML=`⬇ Update available: v${esc(status.version)} <button class="btn btn-primary" id="btnStartDownload" style="margin-left:auto">Download</button>`;
      document.getElementById('btnStartDownload').addEventListener('click',()=>window.punch.downloadUpdate());
      banner.classList.remove('hidden');
      bannerText.textContent=`Update ready to download: v${status.version}`;
      bannerBtn.textContent='Download';
      bannerBtn.onclick=()=>window.punch.downloadUpdate();
      break;
    case 'downloading':
      el.innerHTML=`Downloading update… <div class="update-progress"><div class="update-progress-bar" style="width:${status.percent||0}%"></div></div> <span class="mono">${status.percent||0}%</span>`;
      banner.classList.remove('hidden');
      bannerText.textContent=`Downloading: ${status.percent||0}%`;
      bannerBtn.textContent='…';
      bannerBtn.onclick=null;
      break;
    case 'ready':
      el.classList.add('available');
      el.innerHTML=`✓ Update v${esc(status.version)} downloaded. <button class="btn btn-primary" id="btnInstall" style="margin-left:auto">Restart &amp; install</button>`;
      document.getElementById('btnInstall').addEventListener('click',()=>window.punch.installUpdate());
      banner.classList.remove('hidden');
      bannerText.textContent=`Ready to install: v${status.version}`;
      bannerBtn.textContent='Install';
      bannerBtn.onclick=()=>window.punch.installUpdate();
      break;
    case 'error':
      el.classList.add('error');
      el.textContent='Update error: '+(status.message||'unknown');
      break;
    case 'dev':
      el.textContent='Dev mode — updates disabled (package the app to enable)';
      break;
  }
}

// ------------------------------------------------------------
// Autodetect
// ------------------------------------------------------------
function onWindowChanged(info){
  lastDetectedWindow=info;
  if(!state.settings.autodetectEnabled) return;
  const haystack=`${info.appName} ${info.title}`.toLowerCase();
  const match=state.rules.find(r=>haystack.includes(r.pattern.toLowerCase()));
  const adEl=document.getElementById('autodetectStatus');
  if(!match){ adEl.classList.add('hidden'); pendingAutodetect=null; return; }
  const project=getProject(match.projectId); if(!project){ adEl.classList.add('hidden'); return; }
  const subcat=getSubcat(match.projectId,match.subcategoryId);
  const target=`${project.name}${subcat?' / '+subcat.name:''}`;
  if(match.action==='autostart'&&!state.activeTimer){
    startTimer({projectId:match.projectId,subcategoryId:match.subcategoryId||null,notes:info.title||''});
    adEl.classList.remove('hidden'); document.getElementById('adText').textContent=`Auto-started: ${target}`;
    document.getElementById('btnAdApply').classList.add('hidden');
  } else if(match.action==='suggest'){
    pendingAutodetect=match; adEl.classList.remove('hidden');
    document.getElementById('adText').textContent=`${info.appName||'Window'} → ${target}`;
    document.getElementById('btnAdApply').classList.remove('hidden');
  }
}
function applyAutodetect(){
  if(!pendingAutodetect) return; const r=pendingAutodetect;
  if(state.activeTimer){ state.activeTimer.projectId=r.projectId; state.activeTimer.subcategoryId=r.subcategoryId||null; save(); renderAll(); toast('Re-assigned'); }
  else { startTimer({projectId:r.projectId,subcategoryId:r.subcategoryId||null}); }
  document.getElementById('autodetectStatus').classList.add('hidden'); pendingAutodetect=null;
}

// ------------------------------------------------------------
// Idle
// ------------------------------------------------------------
function onIdleStart(info){ if(!state.activeTimer) return; idleTimerSnapshot={idleSinceMs:info.idleSinceMs,activeTimerStartMs:state.activeTimer.startMs}; }
function onIdleEnd(){
  if(!idleTimerSnapshot||!state.activeTimer){ idleTimerSnapshot=null; return; }
  if(state.activeTimer.startMs!==idleTimerSnapshot.activeTimerStartMs){ idleTimerSnapshot=null; return; }
  document.getElementById('idleDuration').textContent=formatHMS(Date.now()-idleTimerSnapshot.idleSinceMs);
  openModal('idleModal');
}
function idleKeep(){ idleTimerSnapshot=null; closeModal('idleModal'); toast('Time kept'); }
function idleDiscard(){
  if(!idleTimerSnapshot||!state.activeTimer){ closeModal('idleModal'); return; }
  const idleMs=Date.now()-idleTimerSnapshot.idleSinceMs;
  state.activeTimer.startMs+=idleMs;
  if(state.activeTimer.startMs>Date.now()){ state.activeTimer=null; stopTick(); toast('Discarded idle time and stopped timer'); }
  else toast('Discarded '+formatHMS(idleMs)+' of idle time');
  save(); renderAll(); idleTimerSnapshot=null; closeModal('idleModal');
}
function idleStop(){
  if(!idleTimerSnapshot||!state.activeTimer){ closeModal('idleModal'); return; }
  const endMs=idleTimerSnapshot.idleSinceMs;
  if(endMs>state.activeTimer.startMs){
    state.entries.push({id:nextId('e'),projectId:state.activeTimer.projectId,subcategoryId:state.activeTimer.subcategoryId||null,accountId:state.activeTimer.accountId||null,notes:state.activeTimer.notes||'',taskId:state.activeTimer.taskId||null,startMs:state.activeTimer.startMs,endMs});
  }
  state.activeTimer=null; stopTick(); save(); renderAll(); idleTimerSnapshot=null; closeModal('idleModal'); toast('Stopped at idle start');
}

// ------------------------------------------------------------
// IPC
// ------------------------------------------------------------
function attachIPCListeners(){
  window.punch.onToggleTimer(()=>toggleTimer());
  window.punch.onFocusNotes(()=>{ setTimeout(()=>{ document.getElementById('notesInput').focus(); document.getElementById('notesInput').select(); },100); });
  window.punch.onOpenFull(()=>setMode('full'));
  window.punch.onWindowChanged(onWindowChanged);
  window.punch.onIdleStart(onIdleStart);
  window.punch.onIdleEnd(onIdleEnd);
  window.punch.onUpdateStatus(renderUpdateStatus);
}

// ------------------------------------------------------------
// Modal / util
// ------------------------------------------------------------
function openModal(id){ document.getElementById(id).classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
let toastTimer;
function toast(msg){
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2200);
}
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ------------------------------------------------------------
// UI bindings
// ------------------------------------------------------------
function bindUI(){
  document.getElementById('btnPin').addEventListener('click',()=>{
    state.settings.alwaysOnTop=!state.settings.alwaysOnTop; save(); applySettings();
    document.getElementById('btnPin').classList.toggle('active',state.settings.alwaysOnTop);
  });
  document.getElementById('btnExpand').addEventListener('click',toggleMode);
  document.getElementById('btnMinimize').addEventListener('click',()=>window.punch.minimize());
  document.getElementById('btnClose').addEventListener('click',()=>window.punch.hide());
  document.getElementById('btnPin').classList.toggle('active',state.settings.alwaysOnTop);
  document.getElementById('btnMiniMode').addEventListener('click', toggleMiniMode);
  document.getElementById('miniStopBtn').addEventListener('click', toggleTimer);
  document.getElementById('btnTimer').addEventListener('click',toggleTimer);
  bindActiveTimerInputs();
  document.getElementById('btnAdApply').addEventListener('click',applyAutodetect);
document.getElementById('miniTimer').addEventListener('click', exitMiniMode);
  document.getElementById('btnQuickAddSubcat').addEventListener('click',()=>{
    const pid=document.getElementById('projectSel').value;
    quickAddSubcat(pid,(id)=>{ renderSubcatOptions(document.getElementById('subcatSel'),pid,id); document.getElementById('subcatSel').value=id; if(state.activeTimer){ state.activeTimer.subcategoryId=id; save(); } });
  });
  document.getElementById('btnEntryQuickAddSubcat').addEventListener('click',()=>{
    const pid=document.getElementById('entryProject').value;
    quickAddSubcat(pid,(id)=>{ renderSubcatOptions(document.getElementById('entrySubcat'),pid,id); document.getElementById('entrySubcat').value=id; });
  });

  // Modal handlers for quick-add subcategory
  document.getElementById('subcatConfirm').addEventListener('click', () => {
    const name = document.getElementById('subcatInput').value.trim();
    if (window._quickAddCallback) {
      window._quickAddCallback(name);
      delete window._quickAddCallback;
    }
    closeModal('subcatModal');
  });

  document.getElementById('subcatCancel').addEventListener('click', () => {
    closeModal('subcatModal');
    delete window._quickAddCallback;
  });

  document.getElementById('subcatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('subcatConfirm').click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      document.getElementById('subcatCancel').click();
    }
  });

  document.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      document.querySelector(`.tab-pane[data-pane="${t.dataset.tab}"]`).classList.add('active');
    });
  });
  document.querySelectorAll('.task-filter').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.task-filter').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active'); taskFilter=btn.dataset.filter; renderTasks();
    });
  });

  // Entry search
  document.getElementById('entrySearch').addEventListener('input',(e)=>{ entrySearchTerm=e.target.value.trim(); renderEntries(); });

  document.getElementById('btnManualEntry').addEventListener('click',openManualEntry);
  document.getElementById('btnExportCSV').addEventListener('click',exportCSV);
  document.getElementById('btnAddTask').addEventListener('click',()=>openTaskModal());
  document.getElementById('btnSaveTask').addEventListener('click',saveTask);
  document.getElementById('btnDeleteTask').addEventListener('click',deleteTask);
  document.getElementById('btnAddProject').addEventListener('click',()=>openProjectModal());
  document.getElementById('btnSaveProject').addEventListener('click',saveProject);
  document.getElementById('btnDeleteProject').addEventListener('click',deleteProject);
  document.getElementById('btnAddSubcat').addEventListener('click',addSubcatFromInput);
  document.getElementById('newSubcatInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); addSubcatFromInput(); } });
  document.getElementById('btnSaveEntry').addEventListener('click',saveEntry);
  document.getElementById('btnDeleteEntry').addEventListener('click',deleteEntry);
  document.getElementById('btnSaveRule').addEventListener('click',saveRule);
  document.getElementById('btnDeleteRule').addEventListener('click',deleteRule);
  document.getElementById('btnAddRule').addEventListener('click',()=>openRuleModal());
  document.getElementById('btnIdleKeep').addEventListener('click',idleKeep);
  document.getElementById('btnIdleDiscard').addEventListener('click',idleDiscard);
  document.getElementById('btnSaveAccount').addEventListener('click', saveAccountModal);
document.getElementById('btnDeleteAccount').addEventListener('click', deleteAccountModal);
  document.getElementById('btnIdleStop').addEventListener('click',idleStop);

  document.getElementById('summaryRange').addEventListener('change',(e)=>{
    document.getElementById('customRangeRow').classList.toggle('hidden',e.target.value!=='custom');
  });
  document.getElementById('btnGenerate').addEventListener('click',generateSummary);
  document.getElementById('btnCopyMd').addEventListener('click',copyMarkdown);
  document.getElementById('btnCopyJson').addEventListener('click',copyJson);
  document.getElementById('btnSendWebhook').addEventListener('click',sendToWebhook);

  document.getElementById('btnSetHotkey').addEventListener('click',applyHotkey);
  document.getElementById('hotkeyInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') applyHotkey(); });
  document.getElementById('aotToggle').addEventListener('change',(e)=>{ state.settings.alwaysOnTop=e.target.checked; save(); applySettings(); });
  document.getElementById('idleToggle').addEventListener('change',(e)=>{ state.settings.idleEnabled=e.target.checked; save(); applySettings(); });
  document.getElementById('idleThreshold').addEventListener('change',(e)=>{
    const v=Math.max(1,Math.min(120,parseInt(e.target.value)||5));
    state.settings.idleThresholdMin=v; e.target.value=v; save(); applySettings();
  });
  document.getElementById('autodetectToggle').addEventListener('change',(e)=>{ state.settings.autodetectEnabled=e.target.checked; save(); applySettings(); });
  document.getElementById('webhookUrl').addEventListener('blur',(e)=>{ state.settings.webhookUrl=e.target.value.trim(); save(); });
  document.getElementById('btnTestWebhook').addEventListener('click',testWebhook);

  // Accounts
  document.getElementById('btnAddAccount').addEventListener('click',addAccount);
  document.getElementById('newAccountInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') addAccount(); });
  document.getElementById('btnSetAccountLabel').addEventListener('click',setAccountLabel);
  document.getElementById('accountLabelInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') setAccountLabel(); });

  // Updates
  document.getElementById('btnCheckUpdate').addEventListener('click',()=>window.punch.checkForUpdate());
  document.getElementById('btnShowShortcuts').addEventListener('click',()=>openModal('shortcutsModal'));

  // Data
  document.getElementById('btnExportJson').addEventListener('click',exportJsonBackup);
  document.getElementById('btnImportJson').addEventListener('click',()=>document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change',importJsonBackup);
  document.getElementById('btnOpenDataDir').addEventListener('click',()=>window.punch.openDataDir());
  document.getElementById('btnWipe').addEventListener('click',wipeAll);

  // Modal close
  document.querySelectorAll('.modal-overlay').forEach(o=>{
    o.addEventListener('click',(e)=>{ if(e.target===o) closeModal(o.id); });
  });
  document.querySelectorAll('[data-close]').forEach(b=>{
    b.addEventListener('click',()=>closeModal(b.dataset.close));
  });

  // Keyboard
  document.addEventListener('keydown',(e)=>{
    const tag=(e.target.tagName||'').toLowerCase();
    const inField=tag==='input'||tag==='textarea'||tag==='select';
    const modal=document.querySelector('.modal-overlay.open');
    if(e.key==='Escape'&&modal){ closeModal(modal.id); return; }
    if(inField||modal) return;
    if(e.code==='Space'){ e.preventDefault(); toggleTimer(); }
  });
}

// ------------------------------------------------------------
// Mini Mode
// ------------------------------------------------------------
let isMiniMode = false;

function enterMiniMode() {
  isMiniMode = true;
  
  console.log('Entering mini mode - resizing to 180x80');
  
  // Hide title bar
  document.querySelector('.titlebar').style.display = 'none';
  
  // Set mini mode constraints
  window.punch.setMinSize(180, 80);
  
  // Hide main widget content
  document.getElementById('timerWidget').style.display = 'none';
  
  // Show mini mode view
  document.getElementById('miniModeView').style.display = 'block';
  
  // Resize window
  window.punch.resize(180, 80);
  
  // Update mini timer display
  updateMiniTimer();
}


function exitMiniMode() {
  isMiniMode = false;
  
  // Show title bar
  document.querySelector('.titlebar').style.display = 'flex';
  
  // Set widget mode constraints
  window.punch.setMinSize(320, 320);
  
  // Show main widget content
  document.getElementById('timerWidget').style.display = 'block';
  
  // Hide mini mode view
  document.getElementById('miniModeView').style.display = 'none';
  
  // Resize back to widget size
  window.punch.resize(360, 380);
}

function toggleMiniMode() {
  if (isMiniMode) {
    exitMiniMode();
  } else {
    enterMiniMode();
  }
}

function updateMiniTimer() {
  if (!isMiniMode) return;
  
  const timerEl = document.getElementById('miniTimer');
  const projectEl = document.getElementById('miniProject');
  const btn = document.getElementById('miniStopBtn');
  
  if (state.activeTimer) {
    const elapsed = Date.now() - state.activeTimer.startMs;
    timerEl.textContent = formatHMS(elapsed);
    
    // Show project name
    const project = getProject(state.activeTimer.projectId);
    projectEl.textContent = project ? project.name : 'No project';
    
    // Update button to show STOP state
    btn.textContent = '■';
    btn.style.background = 'rgba(220, 38, 38, 0.15)';
    btn.style.borderColor = 'rgba(220, 38, 38, 0.4)';
    btn.style.color = 'rgb(220, 38, 38)';
    btn.title = 'Stop timer';
  } else {
    timerEl.textContent = '00:00:00';
    projectEl.textContent = 'No active timer';
    
    // Update button to show START state
    btn.textContent = '▶';
    btn.style.background = 'rgba(232, 155, 67, 0.15)';
    btn.style.borderColor = 'rgba(232, 155, 67, 0.4)';
    btn.style.color = 'rgb(232, 155, 67)';
    btn.title = 'Start timer';
  }
}

// ------------------------------------------------------------
// What's New Modal
// ------------------------------------------------------------
const WHATS_NEW_CONTENT = {
'1.3.4': `
  <h3>🐛 Hotfix</h3>
  <ul>
    <li>Fixed taskbar timer display (was broken in v1.3.2)</li>
    <li>Fixed mini mode button state updates</li>
  </ul>
`,

  '1.3.2': `
  <h3>🐛 Hotfixes</h3>
  <ul>
    <li>Fixed taskbar icon timer display</li>
     <li>Hopefully Ronnies bitchass get's it together</li>
    <li>call me hellen keller cause Im a fuckin miracle worker</li>
    <li>Fixed mini mode button not updating when stopping timer</li>
    <li>Fixed update installation requiring manual app close</li>
  </ul>
`,
  '1.3.1': `
    <h3>🔧 Installer Improvements</h3>
    <ul>
      <li>Updates now install in-place instead of creating duplicate launchers</li>
      <li>No more admin permission prompts when updating</li>
      <li>Fixed app failing to launch from packaged installer</li>
    </ul>
    
    <h3>📢 What's New Popup</h3>
    <ul>
      <li>You're looking at it! See what's changed with each update</li>
      <li>Only shows once per version, then dismisses for good</li>
    </ul>
  `,
  '1.3.0': `
    <h3>💰 Billable Hours Tracking</h3>
    <ul>
      <li>Mark accounts as billable by default</li>
      <li>Toggle billable status on individual entries</li>
      <li>Green indicators show billable time at a glance</li>
    </ul>
    
    <h3>🪟 Mini Mode Widget</h3>
    <ul>
      <li>Ultra-compact 180×80px timer display</li>
      <li>Draggable, always-on-top</li>
      <li>Click timer to expand back to full controls</li>
      <li>Start/Stop button with visual indicators</li>
    </ul>
    
    <h3>⏱️ Live Taskbar Timer</h3>
    <ul>
      <li>Your taskbar icon becomes a real-time countdown clock</li>
      <li>Shows MM:SS in vertical stacked layout</li>
      <li>Bright amber branding for easy visibility</li>
      <li>Automatically restores when timer stops</li>
    </ul>
  `
};

function checkAndShowWhatsNew(currentVersion) {
  const lastSeenVersion = localStorage.getItem('lastSeenVersion');
  
  if (lastSeenVersion !== currentVersion && WHATS_NEW_CONTENT[currentVersion]) {
    showWhatsNewModal(currentVersion);
  }
}

function showWhatsNewModal(version) {
  const modal = document.getElementById('whatsNewModal');
  const versionEl = document.getElementById('whatsNewVersion');
  const contentEl = document.getElementById('whatsNewContent');
  
  versionEl.textContent = `v${version}`;
  contentEl.innerHTML = WHATS_NEW_CONTENT[version];
  
  modal.style.display = 'flex';
  
  // Mark as seen
  localStorage.setItem('lastSeenVersion', version);
}

document.getElementById('btnCloseWhatsNew').addEventListener('click', () => {
  document.getElementById('whatsNewModal').style.display = 'none';
});

// Boot
init().catch(err=>{ console.error('init failed',err); alert('Failed to initialize Punch: '+err.message); });
