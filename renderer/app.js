// ============================================================
// Punch — renderer logic v1.5.0
// ============================================================

const SWATCH_PALETTE = [
  '#e89b43','#e35b5b','#d96fc3','#9874e3','#5b9be3','#3fb8c4','#5cc97a','#c4cc5b',
  '#b87333','#8b6f4e','#a89c8a','#6b7280','#4a90a4','#7ba05b','#e8a87c','#c38d9e'
];
const DEFAULT_HOTKEY = 'CommandOrControl+Alt+P';
const WIDGET_SIZE = { width: 360, height: 380 };
const FULL_SIZE   = { width: 920, height: 720 };

// Bumped to 5 with nudge behavior cleanup: nudge.type, nudge.nextDueAt,
// nudge.logAsTimeEntry, and timed_break_* focus event types. Strictly
// additive — migration is handled defensively by normalizeNudgeShape.
const CURRENT_SCHEMA_VERSION = 5;

const defaultProductivitySettings = () => ({
  workingHours: { start: '09:00', end: '17:00', days: [1,2,3,4,5] }, // Mon–Fri
  nudgePauseUntil: null,            // ms epoch; null = not paused
  presentationModeEnabled: false,
  mentalBreakSeeded: false,         // one-time flag so we only auto-seed once
  defaultRespectWorkingHours: true,
  bringToFrontForNudges: true       // restore/focus Punch when a nudge fires
});

// Focus Signals settings — privacy-first defaults. Tracking is opt-in;
// title capture is opt-in even after tracking is on. The 30s interval
// keeps the active-win poll well below noticeable CPU impact while still
// catching the productivity-meaningful "I just spent 8 minutes in Outlook"
// signal we care about.
const defaultFocusSettings = () => ({
  enableWindowTracking: false,
  trackWindowTitles: false,
  windowTrackingIntervalSeconds: 30,
  enableSuggestedFocus: true,
  enableDistractionLogging: true,
  // Focus v1 — activity rules + unlogged work detection
  enableActivityRules: true,
  enableUnloggedWorkDetection: true,
  defaultUnloggedPromptMinutes: 30
});

const defaultData = () => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  projects: [{ id:'p_default', name:'General', color:'#e89b43', archived:false, subcategories:[] }],
  entries: [], tasks: [], accounts: [], activeTimer: null, rules: [],
  nudges: [], nudgeEvents: [], dailyCloseouts: [],
  focusEvents: [], activityRules: [],
  settings: {
    hotkey: DEFAULT_HOTKEY, alwaysOnTop: true,
    idleEnabled: true, idleThresholdMin: 5,
    autodetectEnabled: false, webhookUrl: '',
    accountLabel: 'Account',
    productivity: defaultProductivitySettings(),
    focus: defaultFocusSettings()
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
let taskProjectFilter = 'all';
let entrySearchTerm = '';
let logBillableFilter = 'all';
let logSearchTerm = '';
let logProjectFilter = 'all';
let logTaskFilter = 'all';
let logMissingNotesOnly = false;

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

  // One-time productivity init. autoCarryForward bumps overdue active tasks
  // so they appear on today's plan even if the user never opens End Day.
  // maybeSeedMentalBreakNudge adds the disabled preset the first time a
  // user opens v1.5.0 — discoverable in Settings, off by default.
  autoCarryForwardOverdueTasks();
  maybeSeedMentalBreakNudge();
  // Forward-schedule every enabled nudge so a stale nextDueAt from a
  // previous session never causes an instant pop at app open. Must run
  // BEFORE startNudgeScheduler so the first tick already sees fresh values.
  initializeNudgeScheduleOnStartup();

  renderAll();
  attachIPCListeners();
  startNudgeScheduler();
  applyFocusSettings();
  if (state.activeTimer) startTick();
}

function mergeWithDefaults(loaded){
  const d = defaultData();
  // Run any version-specific migrations first, then apply defensive defaults.
  loaded = migrateData(loaded);
  const merged = { ...d, ...loaded };
  // Settings is nested — merge top-level keys *and* the productivity namespace.
  const loadedSettings = loaded.settings || {};
  merged.settings = { ...d.settings, ...loadedSettings };
  merged.settings.productivity = {
    ...d.settings.productivity,
    ...(loadedSettings.productivity || {})
  };
  // Working hours nested object — be safe if older data has a partial shape.
  merged.settings.productivity.workingHours = {
    ...d.settings.productivity.workingHours,
    ...((loadedSettings.productivity && loadedSettings.productivity.workingHours) || {})
  };
  // Focus settings — privacy-first defaults applied for any pre-v3 load.
  merged.settings.focus = {
    ...d.settings.focus,
    ...(loadedSettings.focus || {})
  };
  merged.projects = (loaded.projects || []).map(p => ({ archived:false, subcategories:[], ...p }));
  merged.entries  = (loaded.entries  || []).map(e => ({
    taskId: null,
    billable: false,
    notes: '',
    subcategoryId: null,
    accountId: null,
    ...e
  }));
  merged.tasks    = (loaded.tasks    || []).map(normalizeTaskShape);
  merged.accounts = loaded.accounts || [];
  merged.rules    = loaded.rules    || [];
  merged.nudges        = (loaded.nudges || []).map(normalizeNudgeShape);
  merged.nudgeEvents   = loaded.nudgeEvents || [];
  merged.dailyCloseouts = loaded.dailyCloseouts || [];
  merged.focusEvents   = loaded.focusEvents || [];
  merged.activityRules = loaded.activityRules || [];
  merged.nextId   = loaded.nextId   || 1;
  merged.schemaVersion = CURRENT_SCHEMA_VERSION;
  return merged;
}

// Versioned migrations. New installs already match CURRENT_SCHEMA_VERSION via
// defaultData(), so this is a no-op for them. v1 → v2 adds nudges/closeouts
// and a productivity settings namespace — those are all populated by the
// defensive defaults in mergeWithDefaults, so the migration step itself
// just stamps the version. Future migrations that need to reshape data
// (e.g. moving a field) will live here as `if (fromVersion < N) { … }` blocks.
function migrateData(loaded){
  if(!loaded || typeof loaded !== 'object') return loaded;
  const fromVersion = loaded.schemaVersion || 1;
  if(fromVersion >= CURRENT_SCHEMA_VERSION) return loaded;
  // (Future shape transforms go here, ordered by version.)
  return loaded;
}

// Normalize a task to the current schema, preserving existing fields.
// Tasks created in earlier versions only had {completed, completedAt}; later versions
// add status, updatedAt, dueDate, estimatedMinutes, priority. completed stays in sync
// with status for backward compatibility (anything reading state.tasks[i].completed
// directly still works).
//
// projectIds is the canonical list of every project this task belongs to. projectId
// is kept as an alias for projectIds[0] so older code paths that read it keep working.
function normalizeTaskShape(t){
  const completed = !!t.completed;
  const status = t.status || (t.archived ? 'archived' : completed ? 'completed' : 'active');
  // Build projectIds. Prefer existing array; otherwise lift the legacy single projectId.
  let projectIds = Array.isArray(t.projectIds) ? t.projectIds.slice() : [];
  if(t.projectId && !projectIds.includes(t.projectId)){
    projectIds.unshift(t.projectId);
  }
  // Drop dupes while preserving order.
  projectIds = projectIds.filter((id,i) => id && projectIds.indexOf(id) === i);
  const primary = projectIds[0] || null;
  return {
    subcategoryId: null,
    accountId: null,
    notes: '',
    completedAt: null,
    createdAt: t.createdAt || Date.now(),
    dueDate: null,
    estimatedMinutes: null,
    priority: null,
    // Productivity / carry-forward fields. carryForwardCount is a "how many
    // times has this slipped" signal that future reporting can surface; both
    // auto carry-forward (next-day app open) and the End Day "Carry to
    // tomorrow" action increment it. dailyPriorityRank is reserved for a
    // future Focus tab ordering feature — keep it nullable for now.
    carryForwardCount: 0,
    lastCarriedForwardAt: null,
    dailyPriorityRank: null,
    ...t,
    projectIds,
    projectId: primary, // keep alias in sync
    status,
    completed: status === 'completed',
    updatedAt: t.updatedAt || t.createdAt || Date.now()
  };
}

// Normalize a nudge to the current schema. Per-entity defaults follow the
// same defensive-spread pattern as tasks so older data loads cleanly.
//
// v5 additions: type, nextDueAt, logAsTimeEntry. type is inferred from
// timedDurationMinutes for pre-v5 data (anything with a duration becomes
// a timed_break; everything else is a plain reminder). nextDueAt is left
// null on load and gets seeded by initializeNudgeScheduleOnStartup so the
// scheduler is forward-looking from the moment the app opens, not catching
// up on missed sessions.
function normalizeNudgeShape(n){
  const hasDuration = typeof n.timedDurationMinutes === 'number' && n.timedDurationMinutes > 0;
  const inferredType = n.type
    || (hasDuration ? 'timed_break' : 'reminder');
  return {
    id: n.id,
    name: n.name || 'Untitled nudge',
    message: n.message || '',
    category: n.category || 'Custom',
    type: inferredType,                 // 'reminder' | 'timed_break' | 'action_prompt'
    intervalMinutes: typeof n.intervalMinutes === 'number' ? n.intervalMinutes : 60,
    activeDays: Array.isArray(n.activeDays) ? n.activeDays : [1,2,3,4,5],
    activeStartTime: n.activeStartTime || '09:00',
    activeEndTime: n.activeEndTime || '17:00',
    defaultSnoozeMinutes: typeof n.defaultSnoozeMinutes === 'number' ? n.defaultSnoozeMinutes : 15,
    enabled: n.enabled !== false, // default true
    respectWorkingHours: n.respectWorkingHours !== false,
    allowWhenActiveOutsideHours: !!n.allowWhenActiveOutsideHours,
    timedDurationMinutes: typeof n.timedDurationMinutes === 'number' ? n.timedDurationMinutes : null,
    logAsTimeEntry: !!n.logAsTimeEntry, // future-ready; UI does not expose this yet
    // Action prompt config — always starts a timer for the given project/task.
    actionProjectId: n.actionProjectId || null,
    actionTaskId: n.actionTaskId || null,
    createdAt: n.createdAt || Date.now(),
    updatedAt: n.updatedAt || Date.now(),
    lastTriggeredAt: n.lastTriggeredAt || null,
    nextDueAt: typeof n.nextDueAt === 'number' ? n.nextDueAt : null,
    archivedAt: n.archivedAt || null,
    snoozeUntil: n.snoozeUntil || null // per-nudge snooze state
  };
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
function startOfMonth(ms){ const d=new Date(ms); d.setDate(1); d.setHours(0,0,0,0); return d.getTime(); }
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

function taskStatus(t){
  if(!t) return null;
  return t.status || (t.completed ? 'completed' : 'active');
}
function isTaskActive(t){ return taskStatus(t)==='active'; }

// Canonical list of every project a task belongs to. Falls back to the legacy
// single projectId for any task object that hasn't been normalized yet.
function taskProjectIds(t){
  if(!t) return [];
  if(Array.isArray(t.projectIds) && t.projectIds.length) return t.projectIds;
  return t.projectId ? [t.projectId] : [];
}
function taskBelongsToProject(t, projectId){
  if(!t || !projectId) return false;
  return taskProjectIds(t).includes(projectId);
}
function taskPrimaryProject(t){
  return taskProjectIds(t)[0] || null;
}

function getTasksForProject(projectId, { includeCompleted=false, includeArchived=false } = {}){
  return state.tasks.filter(t => {
    if(!taskBelongsToProject(t, projectId)) return false;
    const s = taskStatus(t);
    if(s==='archived' && !includeArchived) return false;
    if(s==='completed' && !includeCompleted) return false;
    return true;
  });
}

function isThisWeek(ms){
  if(!ms) return false;
  const start = startOfWeek(Date.now());
  const end = start + 7*86400000;
  return ms >= start && ms < end;
}

function countActiveTasksByProject(projectId){
  return state.tasks.filter(t => taskBelongsToProject(t, projectId) && isTaskActive(t)).length;
}
function countTasksCompletedThisWeekByProject(projectId){
  return state.tasks.filter(t => taskBelongsToProject(t, projectId) && taskStatus(t)==='completed' && isThisWeek(t.completedAt)).length;
}

// Sum time logged for a task, restricted to entries whose projectId matches the
// given project. Used by the Tasks screen so a task that belongs to two projects
// shows correct per-project totals instead of double-counting its overall time.
function sumTaskMsForProject(taskId, projectId){
  let total = 0;
  for(const e of state.entries){
    if(e.taskId === taskId && e.projectId === projectId) total += Math.max(0, e.endMs - e.startMs);
  }
  if(state.activeTimer && state.activeTimer.taskId === taskId && state.activeTimer.projectId === projectId){
    total += Math.max(0, Date.now() - state.activeTimer.startMs);
  }
  return total;
}

// Sum time logged today for a task. Clips to today's window so an entry that
// started yesterday and stopped this morning only counts the post-midnight slice.
function sumTaskMsToday(taskId){
  const todayStart = startOfDay(Date.now());
  let total = 0;
  for(const e of state.entries){
    if(e.taskId !== taskId) continue;
    if(e.endMs <= todayStart) continue;
    const s = Math.max(e.startMs, todayStart);
    if(e.endMs > s) total += e.endMs - s;
  }
  if(state.activeTimer && state.activeTimer.taskId === taskId){
    const s = Math.max(state.activeTimer.startMs, todayStart);
    const now = Date.now();
    if(now > s) total += now - s;
  }
  return total;
}

// Build the ordered list of items for the Today's Plan section. An item shows
// up if the task is active AND it's either overdue, due today, or has had time
// logged today. Sort: overdue → due today → in-progress; within each bucket by
// due date asc, then created desc.
function getTodaysPlanItems(){
  const todayStart = startOfDay(Date.now());
  const tomorrow = todayStart + 86400000;

  const taskIdsWithTimeToday = new Set();
  for(const e of state.entries){
    if(!e.taskId) continue;
    if(e.endMs > todayStart) taskIdsWithTimeToday.add(e.taskId);
  }
  if(state.activeTimer && state.activeTimer.taskId){
    taskIdsWithTimeToday.add(state.activeTimer.taskId);
  }

  const items = [];
  for(const t of state.tasks){
    if(taskStatus(t) !== 'active') continue;
    let type = null, sortKey = 999;
    if(t.dueDate && t.dueDate < todayStart){ type = 'overdue'; sortKey = 0; }
    else if(t.dueDate && t.dueDate >= todayStart && t.dueDate < tomorrow){ type = 'due-today'; sortKey = 1; }
    else if(taskIdsWithTimeToday.has(t.id)){ type = 'in-progress'; sortKey = 2; }
    if(!type) continue;
    items.push({ task: t, type, sortKey, loggedTodayMs: sumTaskMsToday(t.id) });
  }
  items.sort((a,b) => {
    if(a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    const aDue = a.task.dueDate || Infinity;
    const bDue = b.task.dueDate || Infinity;
    if(aDue !== bDue) return aDue - bDue;
    return (b.task.createdAt||0) - (a.task.createdAt||0);
  });
  return items;
}

function renderTodaysPlan(){
  const wrap = document.getElementById('todaysPlan');
  if(!wrap) return;
  // No tasks at all → don't show the section. Once the user has at least one
  // task we always render the section (with an "all clear" empty state when
  // nothing qualifies for today) so the feature stays discoverable.
  if(state.tasks.length === 0){
    wrap.innerHTML = '';
    wrap.classList.add('empty-hidden');
    return;
  }
  wrap.classList.remove('empty-hidden');

  const items = getTodaysPlanItems();
  let html = `<div class="todays-plan-header">
    <span class="todays-plan-title">Today's plan</span>
    <span class="todays-plan-count">${items.length ? items.length + ' item' + (items.length===1?'':'s') : ''}</span>
  </div>`;

  if(items.length === 0){
    html += `<div class="todays-plan-empty">
      All clear for today.
      <button class="link-btn" data-plan-action="new">+ New task</button>
      ·
      <button class="link-btn" data-plan-action="view">View all tasks</button>
    </div>`;
  } else {
    html += '<div class="todays-plan-list">';
    for(const item of items){
      const t = item.task;
      const p = getProject(taskPrimaryProject(t));
      const isRunning = state.activeTimer && state.activeTimer.taskId === t.id;
      const typeBadge = {
        'overdue': '<span class="plan-type-badge type-overdue">Overdue</span>',
        'due-today': '<span class="plan-type-badge type-due-today">Due today</span>',
        'in-progress': '<span class="plan-type-badge type-in-progress">In progress</span>'
      }[item.type] || '';
      const dueText = t.dueDate ? esc(formatDueDate(t.dueDate)) : '';
      const estText = t.estimatedMinutes ? `est ${formatHM(t.estimatedMinutes*60000)}` : '';
      const loggedText = item.loggedTodayMs > 0 ? `${formatHM(item.loggedTodayMs)} today` : '';
      const prio = t.priority ? `<span class="task-priority-badge prio-${esc(t.priority)}">${esc(t.priority)}</span>` : '';
      html += `
        <div class="plan-item${isRunning?' running':''}">
          <div class="plan-checkbox" data-plan-toggle="${esc(t.id)}" title="Mark complete"></div>
          <div class="plan-bar" style="background:${esc(p ? p.color : '#666')}"></div>
          <div class="plan-main">
            <div class="plan-name">${esc(t.name)}</div>
            <div class="plan-meta">
              ${typeBadge}
              ${p ? `<span class="plan-project">${esc(p.name)}</span>` : ''}
              ${item.type !== 'in-progress' && dueText ? `<span class="plan-due">${dueText}</span>` : ''}
              ${prio}
              ${estText ? `<span class="plan-est">${estText}</span>` : ''}
              ${loggedText ? `<span class="plan-logged">${loggedText}</span>` : ''}
              ${isRunning ? '<span class="task-running-badge">● Running</span>' : ''}
            </div>
          </div>
          <div class="plan-actions">
            <button class="icon-btn" title="Edit" data-plan-edit="${esc(t.id)}">✎</button>
            <button class="icon-btn amber" title="${isRunning ? 'Stop timer' : 'Start timer for this task'}" data-plan-timer="${esc(t.id)}">${isRunning ? '■' : '▶'}</button>
          </div>
        </div>`;
    }
    html += '</div>';
  }

  wrap.innerHTML = html;

  wrap.querySelectorAll('[data-plan-toggle]').forEach(el => {
    el.addEventListener('click', () => toggleTaskComplete(el.dataset.planToggle));
  });
  wrap.querySelectorAll('[data-plan-timer]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.planTimer;
      if(state.activeTimer && state.activeTimer.taskId === id) stopTimer();
      else startTimerForTask(id);
    });
  });
  wrap.querySelectorAll('[data-plan-edit]').forEach(el => {
    el.addEventListener('click', () => openTaskModal(el.dataset.planEdit));
  });
  wrap.querySelectorAll('[data-plan-action]').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.planAction;
      if(action === 'new'){
        openTaskModal(null);
      } else if(action === 'view'){
        document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(x=>x.classList.remove('active'));
        document.querySelector('.tab[data-tab="tasks"]').classList.add('active');
        document.querySelector('.tab-pane[data-pane="tasks"]').classList.add('active');
      }
    });
  });
}

function formatDueDate(ms){
  if(!ms) return '';
  const d = new Date(ms);
  const today = startOfDay(Date.now());
  const dueDay = startOfDay(ms);
  const diffDays = Math.round((dueDay - today) / 86400000);
  if(diffDays < 0) return `Overdue · ${d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}`;
  if(diffDays === 0) return 'Due today';
  if(diffDays === 1) return 'Due tomorrow';
  if(diffDays < 7) return `Due ${d.toLocaleDateString(undefined,{weekday:'short'})}`;
  return `Due ${d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}`;
}

function dueDateClass(ms){
  if(!ms) return '';
  const today = startOfDay(Date.now());
  const dueDay = startOfDay(ms);
  if(dueDay < today) return 'due-overdue';
  if(dueDay === today) return 'due-today';
  return '';
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

// Populate the timer's task dropdown. If a projectId is passed we filter to tasks
// that belong to that project (a task can belong to multiple projects); if no
// projectId is passed we show every active task across all projects. The currently
// selected task is preserved even if it doesn't match the filter, so that switching
// projects mid-edit doesn't silently drop the user's choice.
function renderTaskOptions(sel, projectId, selectedId){
  sel.innerHTML='';
  const blank=document.createElement('option'); blank.value=''; blank.textContent='— no task —'; sel.appendChild(blank);
  const list = state.tasks.filter(t => isTaskActive(t) && (!projectId || taskBelongsToProject(t, projectId)));
  if(selectedId && !list.some(t => t.id === selectedId)){
    const t = getTask(selectedId);
    if(t) list.unshift(t);
  }
  list.sort((a,b)=>{
    const aDue = a.dueDate || Infinity;
    const bDue = b.dueDate || Infinity;
    if(aDue !== bDue) return aDue - bDue;
    return a.name.localeCompare(b.name);
  });
  for(const t of list){
    const o=document.createElement('option');
    o.value = t.id;
    let label = t.name;
    // Show "ProjectName · TaskName" when we're not filtering to a specific project,
    // or when the task doesn't belong to the currently-selected project (kept in
    // the list because it was previously selected).
    if(!projectId || !taskBelongsToProject(t, projectId)){
      const p = getProject(taskPrimaryProject(t));
      if(p) label = `${p.name} · ${t.name}`;
    }
    o.textContent = label;
    if(t.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

// Render the timer's project dropdown with an "— any project —" option at the
// top. Used only by the timer; modals that require a real project keep using
// the plain renderProjectOptions.
function renderTimerProjectOptions(sel, selectedId){
  sel.innerHTML = '';
  const any = document.createElement('option');
  any.value = '';
  any.textContent = '— any project —';
  sel.appendChild(any);
  state.projects.filter(p => !p.archived).forEach(p => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    if(p.id === selectedId) o.selected = true;
    sel.appendChild(o);
  });
  if(!selectedId) any.selected = true;
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
  const taskSel=document.getElementById('taskSel');
  const subSel=document.getElementById('subcatSel');
  const acctSel=document.getElementById('accountSel');
  const notes=document.getElementById('notesInput');
  const badge=document.getElementById('activeTaskBadge');

  renderTimerProjectOptions(projSel, state.activeTimer?state.activeTimer.projectId:projSel.value);
  renderTaskOptions(taskSel, projSel.value, state.activeTimer?state.activeTimer.taskId:taskSel.value);
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
  const mEl = document.getElementById('totalMonth');
  if(mEl) mEl.textContent=formatHM(sumAllMs(now-30*86400000,now));
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
  // Today tab is the daily hub: when not searching, scope the list to today
  // so the Today log feels focused. Searching opens the full multi-day view —
  // users can pull historical entries back into context without leaving the
  // tab. The Log tab still has the unfiltered multi-day view.
  const todayStart = startOfDay(Date.now());
  const filterPool = entrySearchTerm
    ? state.entries
    : state.entries.filter(e => e.endMs > todayStart);
  const searched = filterPool.filter(e => matchesSearch(e, entrySearchTerm));
  if(searched.length===0){
    if(entrySearchTerm){
      list.innerHTML = `<div class="empty">No entries match "${esc(entrySearchTerm)}".</div>`;
    } else if(state.entries.length === 0){
      list.innerHTML = `<div class="empty">No entries yet. Punch in above to start logging time.</div>`;
    } else {
      list.innerHTML = `<div class="empty">No entries today yet. Punch in above to start logging time.</div>`;
    }
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

function renderTaskProjectFilter(){
  const sel = document.getElementById('taskProjectFilter');
  if(!sel) return;
  const current = taskProjectFilter;
  sel.innerHTML = '';
  const all = document.createElement('option'); all.value='all'; all.textContent='All projects'; sel.appendChild(all);
  state.projects.filter(p=>!p.archived).forEach(p=>{
    const o=document.createElement('option'); o.value=p.id; o.textContent=p.name; sel.appendChild(o);
  });
  sel.value = current;
}

function renderTasks(){
  renderTaskProjectFilter();
  const list=document.getElementById('tasksList');
  list.innerHTML='';
  const weekStart = startOfWeek(Date.now());
  const weekEnd = weekStart + 7*86400000;

  let filtered = state.tasks.slice();
  // Project filter (use multi-project aware membership check)
  if(taskProjectFilter !== 'all'){
    filtered = filtered.filter(t => taskBelongsToProject(t, taskProjectFilter));
  }
  // Status / time filter
  if(taskFilter === 'active') filtered = filtered.filter(t => taskStatus(t) === 'active');
  else if(taskFilter === 'completed') filtered = filtered.filter(t => taskStatus(t) === 'completed');
  else if(taskFilter === 'archived') filtered = filtered.filter(t => taskStatus(t) === 'archived');
  else if(taskFilter === 'thisWeek'){
    filtered = filtered.filter(t => {
      const s = taskStatus(t);
      if(s === 'archived') return false;
      if(t.dueDate && t.dueDate >= weekStart && t.dueDate < weekEnd) return true;
      if(s === 'completed' && t.completedAt && t.completedAt >= weekStart && t.completedAt < weekEnd) return true;
      for(const e of state.entries){
        if(e.taskId === t.id && e.endMs >= weekStart && e.startMs < weekEnd) return true;
      }
      return false;
    });
  }
  if(taskFilter === 'all') filtered = filtered.filter(t => taskStatus(t) !== 'archived');

  if(filtered.length===0){
    const messages = {
      active: 'No active tasks. Click "+ New task" to add one.',
      completed: 'No completed tasks yet.',
      archived: 'No archived tasks.',
      thisWeek: 'Nothing scheduled, completed, or logged this week.',
      all: 'No tasks yet.'
    };
    list.innerHTML=`<div class="empty">${messages[taskFilter] || 'No tasks match the current filters.'}</div>`;
    return;
  }
  // Group by project membership — a task in multiple projects appears under each.
  // Pre-seed groups in state.projects order so the display is stable.
  const byProject = new Map();
  for(const p of state.projects) byProject.set(p.id, []);
  for(const t of filtered){
    for(const pid of taskProjectIds(t)){
      if(!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(t);
    }
  }
  for(const [pid, list0] of byProject){ if(list0.length === 0) byProject.delete(pid); }

  for(const [pid,tasks] of byProject){
    const p=getProject(pid);
    // Group total = sum of time logged TO THIS PROJECT for tasks in this group.
    // Using sumTaskMsForProject avoids double-counting when a task spans projects.
    const groupTotal = tasks.reduce((s,t)=>s+sumTaskMsForProject(t.id, pid), 0);
    const header=document.createElement('div'); header.className='task-group-header';
    header.innerHTML=`
      <span class="task-group-swatch" style="background:${esc(p?p.color:'#666')}"></span>
      <span>${esc(p?p.name:'(deleted project)')}</span>
      <span class="task-group-time">${formatHM(groupTotal)} tracked</span>`;
    list.appendChild(header);
    const sortedTasks = tasks.slice().sort((a,b)=>{
      const aDue = a.dueDate || Infinity;
      const bDue = b.dueDate || Infinity;
      if(aDue !== bDue) return aDue - bDue;
      return (b.createdAt||0) - (a.createdAt||0);
    });
    for(const t of sortedTasks){
      const taskMs=sumTaskMs(t.id);
      const isRunning=state.activeTimer&&state.activeTimer.taskId===t.id;
      const account=t.accountId?getAccount(t.accountId):null;
      // Subcategory is project-scoped; only show it inside the task's primary
      // project group (where the subcategoryId actually maps to a real subcat).
      const showSubcat = pid === taskPrimaryProject(t);
      const subcat = showSubcat ? getSubcat(pid, t.subcategoryId) : null;
      const status = taskStatus(t);
      const isCompleted = status === 'completed';
      const isArchived = status === 'archived';
      const dueBadge = t.dueDate ? `<span class="task-due-badge ${dueDateClass(t.dueDate)}">${esc(formatDueDate(t.dueDate))}</span>` : '';
      const estBadge = t.estimatedMinutes ? `<span class="task-estimate-badge">est ${formatHM(t.estimatedMinutes*60000)}</span>` : '';
      const prioBadge = t.priority ? `<span class="task-priority-badge prio-${esc(t.priority)}">${esc(t.priority)}</span>` : '';
      const subBadge = subcat ? `<span class="subcat-tag">${esc(subcat.name)}</span>` : '';
      const archivedBadge = isArchived ? '<span class="task-archived-badge">Archived</span>' : '';
      // Show a hint when this card represents a task that lives in multiple
      // projects, so the user knows the same task appears elsewhere too.
      const otherProjectIds = taskProjectIds(t).filter(id => id !== pid);
      const multiBadge = otherProjectIds.length > 0
        ? `<span class="task-multi-badge" title="${esc(otherProjectIds.map(id => { const op = getProject(id); return op ? op.name : ''; }).filter(Boolean).join(', '))}">+${otherProjectIds.length} project${otherProjectIds.length===1?'':'s'}</span>`
        : '';
      const card=document.createElement('div'); card.className=`task-card${isCompleted?' completed':''}${isArchived?' archived':''}${isRunning?' running':''}`;
      card.innerHTML=`
        <div class="task-card-top">
          <div class="task-checkbox${isCompleted?' checked':''}" data-toggle-task="${t.id}"></div>
          <div class="task-main">
            <div class="task-name">${esc(t.name)}</div>
            <div class="task-meta">
              <span class="task-time-badge${taskMs>0?' has-time':''}">${formatHM(taskMs)} logged</span>
              ${dueBadge}
              ${estBadge}
              ${prioBadge}
              ${subBadge}
              ${account?`<span class="account-badge">${esc(account.name)}</span>`:''}
              ${multiBadge}
              ${archivedBadge}
              ${isRunning?'<span class="task-running-badge">● Running</span>':''}
              ${t.completedAt?`<span class="task-completed-at">Done ${new Date(t.completedAt).toLocaleDateString()}</span>`:''}
            </div>
          </div>
          <div class="task-actions">
            ${!isCompleted && !isArchived?`<button class="icon-btn amber" title="${isRunning?'Stop timer':'Start timer for this task'}" data-task-timer="${t.id}" data-task-project="${esc(pid)}">${isRunning?'■':'▶'}</button>`:''}
            <button class="icon-btn" title="Edit" data-edit-task="${t.id}">✎</button>
          </div>
        </div>
        ${t.notes?`<div class="task-notes-block">${esc(t.notes)}</div>`:''}`;
      list.appendChild(card);
    }
  }
  list.querySelectorAll('[data-toggle-task]').forEach(el=>el.addEventListener('click',()=>toggleTaskComplete(el.dataset.toggleTask)));
  list.querySelectorAll('[data-task-timer]').forEach(el=>el.addEventListener('click',()=>{
    const id=el.dataset.taskTimer;
    const pid=el.dataset.taskProject || null;
    if(state.activeTimer && state.activeTimer.taskId===id) stopTimer();
    else startTimerForTask(id, pid);
  }));
  list.querySelectorAll('[data-edit-task]').forEach(el=>el.addEventListener('click',()=>openTaskModal(el.dataset.editTask)));
}

function renderProjects(){
  const list=document.getElementById('projectsList'); list.innerHTML='';
  if(state.projects.length===0){ list.innerHTML='<div class="empty">No projects yet.</div>'; return; }
  const weekStart=startOfWeek(Date.now());
  state.projects.forEach(p=>{
    const total=sumProjectMs(p.id,weekStart,Date.now());
    const activeTasks = countActiveTasksByProject(p.id);
    const completedThisWeek = countTasksCompletedThisWeekByProject(p.id);
    const subcats=(p.subcategories||[]);
    const subcatHtml=subcats.length
      ?`<div class="project-subcats">${subcats.map(s=>`<span class="subcat-chip">${esc(s.name)}</span>`).join('')}</div>`
      :`<div class="project-card-empty">No subcategories yet</div>`;
    const statsHtml = `
      <div class="project-stats">
        <span class="project-stat"><span class="project-stat-num">${activeTasks}</span> active task${activeTasks===1?'':'s'}</span>
        <span class="project-stat"><span class="project-stat-num">${completedThisWeek}</span> done this wk</span>
        <button class="project-view-tasks" data-view-tasks="${p.id}">View tasks →</button>
      </div>`;
    const card=document.createElement('div'); card.className='project-card';
    card.innerHTML=`
      <div class="project-card-head">
        <span class="project-swatch" style="background:${esc(p.color)}"></span>
        <span class="project-card-name">${esc(p.name)}</span>
        <span class="project-card-time">${formatHM(total)} this wk</span>
      </div>
      ${statsHtml}
      ${subcatHtml}`;
    // Click opens edit modal, EXCEPT clicks on the View-tasks button.
    card.addEventListener('click',(ev)=>{
      if(ev.target.closest('[data-view-tasks]')) return;
      openProjectModal(p.id);
    });
    list.appendChild(card);
  });
  list.querySelectorAll('[data-view-tasks]').forEach(btn=>{
    btn.addEventListener('click',(ev)=>{
      ev.stopPropagation();
      taskProjectFilter = btn.dataset.viewTasks;
      taskFilter = 'active';
      // Switch to Tasks tab
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x=>x.classList.remove('active'));
      document.querySelector('.tab[data-tab="tasks"]').classList.add('active');
      document.querySelector('.tab-pane[data-pane="tasks"]').classList.add('active');
      // Reset filter buttons to match
      document.querySelectorAll('.task-filter').forEach(x=>{
        x.classList.toggle('active', x.dataset.filter === 'active');
      });
      renderTasks();
    });
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
  renderTimerWidget(); renderTotals(); renderDailySnapshot();
  renderTodaysPlan(); renderEntries();
  renderTasks(); renderProjects(); renderSubcategoriesAdmin(); renderRules();
  renderAccountsList(); updateAccountLabels(); renderLog();
  renderNudgeManager(); renderNudgePauseStatus();
  renderSuggestedFocusCard();
  renderActivityRulesList();
}

// ------------------------------------------------------------
// Settings → Workspace Setup → Subcategories admin
// ------------------------------------------------------------
// Subcategories live on the project (project.subcategories[]); previously
// they were only editable from inside the Project edit modal. This admin
// surface lists them grouped by project so they can be added/removed
// without opening each project individually.
function renderSubcategoriesAdmin(){
  const wrap = document.getElementById('subcategoriesAdmin');
  if(!wrap) return;
  const projects = state.projects.filter(p => !p.archived);
  if(projects.length === 0){
    wrap.innerHTML = '<div class="empty" style="padding:14px">Add a project above first — subcategories belong to a project.</div>';
    return;
  }
  wrap.innerHTML = projects.map(p => {
    const subs = p.subcategories || [];
    const chips = subs.map(s => `
      <span class="subcat-admin-chip" data-subcat-id="${esc(s.id)}">
        ${esc(s.name)}
        <button class="subcat-admin-chip-del" data-subcat-del="${esc(p.id)}:${esc(s.id)}" title="Delete subcategory">×</button>
      </span>`).join('');
    const empty = subs.length === 0
      ? '<span class="subcat-admin-empty">No subcategories yet</span>'
      : '';
    return `
      <div class="subcat-admin-group" data-subcat-group="${esc(p.id)}">
        <div class="subcat-admin-head">
          <span class="subcat-admin-swatch" style="background:${esc(p.color)}"></span>
          <span class="subcat-admin-name">${esc(p.name)}</span>
          <span class="subcat-admin-count">${subs.length} subcat${subs.length===1?'':'s'}</span>
        </div>
        <div class="subcat-admin-chips">
          ${chips}
          ${empty}
          <button class="subcat-admin-add" data-subcat-add="${esc(p.id)}">+ add</button>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('[data-subcat-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [projectId, subId] = btn.dataset.subcatDel.split(':');
      const p = getProject(projectId); if(!p) return;
      const sub = (p.subcategories || []).find(s => s.id === subId);
      if(!sub) return;
      if(!confirm(`Delete subcategory "${sub.name}" from ${p.name}? Existing entries that reference it will keep the name in their record.`)) return;
      p.subcategories = (p.subcategories || []).filter(s => s.id !== subId);
      save();
      renderSubcategoriesAdmin();
      // Refresh dropdowns that show subcats — the timer widget + open modals.
      renderTimerWidget();
    });
  });

  wrap.querySelectorAll('[data-subcat-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const projectId = btn.dataset.subcatAdd;
      quickAddSubcat(projectId, () => {
        renderSubcategoriesAdmin();
        renderTimerWidget();
      });
    });
  });
}

// ------------------------------------------------------------
// Today — Daily snapshot
// ------------------------------------------------------------
// Cheap to compute; called from renderAll + after timer ticks since the
// elapsed totals shift while a timer is running. Reuses existing selectors
// so it stays consistent with the End Day modal.
function renderDailySnapshot(){
  const now = Date.now();
  const completedToday = getCompletedTasksForDate(now).length;
  const openTasks = getIncompleteTasksForDate(now).length;
  const missingNotes = getMissingNoteEntries(now).length;

  const completedEl = document.getElementById('snapCompleted');
  const openEl = document.getElementById('snapOpen');
  const missingEl = document.getElementById('snapMissingNotes');
  if(completedEl) completedEl.textContent = String(completedToday);
  if(openEl){
    openEl.textContent = String(openTasks);
    openEl.classList.toggle('warn', openTasks >= 5);
  }
  if(missingEl){
    missingEl.textContent = String(missingNotes);
    missingEl.classList.toggle('warn', missingNotes > 0);
  }
  renderNudgeStatusPill();
}

function renderNudgeStatusPill(){
  const el = document.getElementById('snapNudgePill');
  if(!el) return;
  const p = state.settings.productivity || {};
  el.classList.remove('active','paused','presentation');
  if(p.presentationModeEnabled){
    el.classList.add('presentation');
    el.textContent = 'Nudges: presentation';
  } else if(p.nudgePauseUntil && p.nudgePauseUntil > Date.now()){
    el.classList.add('paused');
    const t = new Date(p.nudgePauseUntil);
    const sameDay = startOfDay(p.nudgePauseUntil) === startOfDay(Date.now());
    const label = sameDay
      ? t.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })
      : t.toLocaleDateString([], { month:'short', day:'numeric' });
    el.textContent = `Nudges: paused · until ${label}`;
  } else {
    el.classList.add('active');
    el.textContent = 'Nudges: active';
  }
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
  const taskId=opts.taskId!==undefined?opts.taskId:(document.getElementById('taskSel').value||null);
  state.activeTimer={ projectId, subcategoryId, accountId, notes, taskId, startMs:Date.now() };
  document.getElementById('projectSel').value=projectId;
  renderTaskOptions(document.getElementById('taskSel'),projectId,taskId);
  document.getElementById('taskSel').value=taskId||'';
  renderSubcatOptions(document.getElementById('subcatSel'),projectId,subcategoryId);
  document.getElementById('subcatSel').value=subcategoryId||'';
  renderAccountOptions(document.getElementById('accountSel'),accountId);
  document.getElementById('accountSel').value=accountId||'';
  document.getElementById('notesInput').value=notes;
  save(); renderAll(); startTick();
  updateMiniTimer(); // Update mini mode button state
  toast('Timer started');
  recordFocusEvent('timer_started', getActiveWorkContext());
}

function stopTimer(){
  if(!state.activeTimer) return;
  // Read fields from the current UI state so that manual overrides (e.g. user
  // changed Project after picking a task) are honoured. projectId stays on the
  // entry so historical reports remain stable even if the task is later edited.
  const projectId=document.getElementById('projectSel').value||state.activeTimer.projectId;
  const subcategoryId=document.getElementById('subcatSel').value||null;
  const accountId=document.getElementById('accountSel').value||null;
  const taskId=document.getElementById('taskSel').value||state.activeTimer.taskId||null;
  const notes=document.getElementById('notesInput').value.trim();
  const endMs=Date.now(); const duration=endMs-state.activeTimer.startMs;
  if(duration<1000){ state.activeTimer=null; save(); renderAll(); stopTick(); toast('Too short — discarded'); return; }
  state.entries.push({
    id:nextId('e'), projectId, subcategoryId, accountId, notes,
    taskId,
    billable: false,
    startMs:state.activeTimer.startMs, endMs,
    createdAt: Date.now()
  });
  const stoppedContext = {
    projectId, taskId,
    entryId: state.entries[state.entries.length-1].id,
    timerRunning: false
  };
  state.activeTimer=null;
  document.getElementById('notesInput').value='';
  document.getElementById('taskSel').value='';
  save(); renderAll(); stopTick();
  updateMiniTimer(); // Update mini mode button state
  toast('Logged '+formatHMS(duration));
  recordFocusEvent('timer_stopped', stoppedContext, { durationMs: duration });
}

function resumeEntry(entryId){
  const e=state.entries.find(x=>x.id===entryId); if(!e) return;
  if(state.activeTimer) stopTimer();
  startTimer({ projectId:e.projectId, subcategoryId:e.subcategoryId||null, accountId:e.accountId||null, notes:e.notes||'', taskId:e.taskId||null });
  toast('Resumed — timer running');
}

function startTimerForTask(taskId, projectIdOverride){
  const t=getTask(taskId); if(!t) return;
  if(state.activeTimer) stopTimer();
  // If the caller passed a specific project (e.g. user clicked ▶ from a particular
  // project group on the Tasks screen), honor it — but only if the task actually
  // belongs to that project. Otherwise fall back to the task's primary project.
  const projectId = (projectIdOverride && taskBelongsToProject(t, projectIdOverride))
    ? projectIdOverride
    : taskPrimaryProject(t);
  // Subcategory is project-scoped and only meaningful under the task's primary.
  const subcategoryId = projectId === taskPrimaryProject(t) ? (t.subcategoryId || null) : null;
  startTimer({ projectId, subcategoryId, accountId:t.accountId||null, notes:t.name, taskId:t.id });
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

    // Renderer draws the 256×256 timer icon and sends it as a PNG data URL.
    // Main decodes and calls setIcon. v1.4.3's runtime AUMID change makes
    // this actually update the installed-build taskbar icon (previously
    // grouped under the shortcut's static icon).
    const iconDataUrl = buildTaskbarIconDataUrl(elapsed);
    window.punch.updateTaskbarOverlay(elapsed, iconDataUrl);
  },1000);
}

// Lazily-reused canvas element — same instance every tick so we don't churn
// the DOM. Sized 256×256 which Windows happily downscales for the taskbar.
let _taskbarCanvas = null;
function buildTaskbarIconDataUrl(timerText){
  if(!_taskbarCanvas){
    _taskbarCanvas = document.createElement('canvas');
    _taskbarCanvas.width = 256;
    _taskbarCanvas.height = 256;
  }
  const cvs = _taskbarCanvas;
  const ctx = cvs.getContext('2d');
  const SIZE = 256;

  // Dark background + subtle border, matches the brand
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, SIZE - 2, SIZE - 2);

  // Pick which two parts to show. timerText is always HH:MM:SS from formatHMS,
  // so once hours >= 1 we switch to HH:MM — minutes-and-seconds isn't useful
  // when you've been at it for an hour.
  const parts = timerText.split(':');
  const hours = parseInt(parts[0], 10) || 0;
  const showHourMode = hours >= 1;
  const top    = showHourMode ? parts[0] : parts[1];
  const bottom = showHourMode ? parts[1] : parts[2];

  ctx.fillStyle = '#e89b43';
  ctx.textAlign = 'center';
  ctx.font = 'bold 110px Consolas, "Courier New", monospace';

  ctx.textBaseline = 'bottom';
  ctx.fillText(top, SIZE / 2, SIZE / 2 - 6);

  // Smaller colon between the two digit blocks
  ctx.font = 'bold 50px Consolas, "Courier New", monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(':', SIZE / 2, SIZE / 2);

  ctx.font = 'bold 110px Consolas, "Courier New", monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(bottom, SIZE / 2, SIZE / 2 + 6);

  return cvs.toDataURL('image/png');
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
  const taskSel=document.getElementById('taskSel');
  const subSel=document.getElementById('subcatSel');
  const acctSel=document.getElementById('accountSel');
  const notes=document.getElementById('notesInput');
  projSel.addEventListener('change',()=>{
    // Project changed manually. Keep the task selection — the spec says task should
    // survive a project override, and renderTaskOptions surfaces cross-project tasks
    // with a "ProjectName · TaskName" label so it's still visible.
    //
    // Note about "— any project —" (empty value): selecting it is a UI-only filter
    // that expands the task dropdown to all active tasks. We deliberately do NOT
    // clear activeTimer.projectId in that case, so a running timer keeps logging
    // against its real project. Picking a real project from the dropdown DOES
    // update the running timer.
    const keptTaskId = taskSel.value || null;
    renderTaskOptions(taskSel, projSel.value, keptTaskId);
    renderSubcatOptions(subSel, projSel.value, null);
    if(state.activeTimer && projSel.value){
      const prevProjectId = state.activeTimer.projectId;
      state.activeTimer.projectId=projSel.value;
      state.activeTimer.subcategoryId=null;
      // Don't clear taskId — entry preserves the manual project anyway.
      save();
      if(prevProjectId && prevProjectId !== projSel.value){
        recordFocusEvent('project_switched', getActiveWorkContext(),
          { fromProjectId: prevProjectId, toProjectId: projSel.value });
      }
    }
  });
  taskSel.addEventListener('change',()=>{
    const taskId = taskSel.value || null;
    const prevTaskId = state.activeTimer ? (state.activeTimer.taskId || null) : null;
    if(taskId){
      applyTaskToTimerInputs(taskId);
    } else if(state.activeTimer){
      state.activeTimer.taskId = null;
      save();
      renderTimerWidget();
    } else {
      renderTimerWidget();
    }
    if(state.activeTimer && prevTaskId !== taskId){
      recordFocusEvent('task_switched', getActiveWorkContext(),
        { fromTaskId: prevTaskId, toTaskId: taskId });
    }
  });
  subSel.addEventListener('change',()=>{ if(state.activeTimer){ state.activeTimer.subcategoryId=subSel.value||null; save(); } });
  acctSel.addEventListener('change',()=>{ if(state.activeTimer){ state.activeTimer.accountId=acctSel.value||null; save(); } });
  notes.addEventListener('blur',()=>{ if(state.activeTimer){ state.activeTimer.notes=notes.value.trim(); save(); } });
}

// Apply a task's defaults to the timer's input fields and update activeTimer if running.
// Project/subcat/account are auto-filled from the task; the user can still override
// them afterwards. Notes are only seeded when currently empty so we don't clobber
// what the user is typing.
//
// Project resolution when the task belongs to multiple projects:
//   - If the user has already narrowed to a project the task is in, keep it.
//     (e.g. you're in "Marketing" and pick a task that's in both Marketing and
//     Product Launch — Marketing stays selected.)
//   - Otherwise default to the task's primary project (projectIds[0]).
//   Subcategory only auto-fills when the resolved project is the task's primary,
//   since subcategories are project-scoped and the task's stored subcategoryId
//   only makes sense under its primary project.
function applyTaskToTimerInputs(taskId){
  const t = getTask(taskId);
  if(!t) return;
  const projSel=document.getElementById('projectSel');
  const taskSel=document.getElementById('taskSel');
  const subSel=document.getElementById('subcatSel');
  const acctSel=document.getElementById('accountSel');
  const notesEl=document.getElementById('notesInput');

  const currentProjectId = projSel.value || null;
  const resolvedProjectId = (currentProjectId && taskBelongsToProject(t, currentProjectId))
    ? currentProjectId
    : taskPrimaryProject(t);
  const useTaskSubcat = resolvedProjectId === taskPrimaryProject(t);
  const subcatId = useTaskSubcat ? (t.subcategoryId || null) : null;

  projSel.value = resolvedProjectId || '';
  renderTaskOptions(taskSel, resolvedProjectId, t.id);
  renderSubcatOptions(subSel, resolvedProjectId, subcatId);
  subSel.value = subcatId || '';
  renderAccountOptions(acctSel, t.accountId || null);
  acctSel.value = t.accountId || '';
  if(!notesEl.value.trim() && t.notes){ notesEl.value = t.notes; }

  if(state.activeTimer){
    state.activeTimer.projectId = resolvedProjectId;
    state.activeTimer.taskId = t.id;
    state.activeTimer.subcategoryId = subcatId;
    state.activeTimer.accountId = t.accountId || null;
    if(!state.activeTimer.notes && t.notes) state.activeTimer.notes = t.notes;
    save();
  }
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
    Object.assign(e,{projectId,subcategoryId,accountId,notes,billable,startMs,endMs});
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
// When set, openTaskModal pre-fills from these and saveTask passes the new task id back.
// Used by the timer's quick-add (+) button.
let taskModalDefaults = null;
let taskModalOnSave = null;

// Renders the "Also in" project chips in the task modal. The primary project is
// excluded from the chip list — to make a previously-extra project the primary,
// the user changes the Project dropdown.
function renderTaskAlsoInProjects(primaryId, selectedExtras){
  const wrap = document.getElementById('taskAlsoInProjects');
  if(!wrap) return;
  wrap.innerHTML = '';
  const others = state.projects.filter(p => !p.archived && p.id !== primaryId);
  if(others.length === 0){
    wrap.innerHTML = '<div class="hint-text" style="margin:0">No other projects to add.</div>';
    return;
  }
  for(const p of others){
    const checked = selectedExtras.includes(p.id);
    const lbl = document.createElement('label');
    lbl.className = 'task-also-in-chip' + (checked ? ' selected' : '');
    lbl.innerHTML = `<input type="checkbox" data-extra-pid="${esc(p.id)}" ${checked?'checked':''} /><span class="task-chip-swatch" style="background:${esc(p.color)}"></span><span class="task-chip-name">${esc(p.name)}</span>`;
    wrap.appendChild(lbl);
  }
  wrap.querySelectorAll('input[data-extra-pid]').forEach(cb=>{
    cb.addEventListener('change',()=>{
      cb.closest('.task-also-in-chip').classList.toggle('selected', cb.checked);
    });
  });
}

function getTaskAlsoInSelections(){
  return [...document.querySelectorAll('#taskAlsoInProjects input[data-extra-pid]:checked')].map(cb => cb.dataset.extraPid);
}

function openTaskModal(taskId, opts={}){
  editingTaskId=taskId||null;
  taskModalDefaults = opts.defaults || null;
  taskModalOnSave = opts.onSave || null;
  if(state.projects.length===0){ toast('Add a project first'); return; }
  const projSel=document.getElementById('taskProject');
  const subSel=document.getElementById('taskSubcat');
  const acctSel=document.getElementById('taskAccount');
  const dueEl=document.getElementById('taskDueDate');
  const estEl=document.getElementById('taskEstimate');
  const prioEl=document.getElementById('taskPriority');
  const statEl=document.getElementById('taskStatusSel');
  if(taskId){
    const t=getTask(taskId);
    const ids = taskProjectIds(t);
    const primary = ids[0];
    const extras = ids.slice(1);
    document.getElementById('taskModalTitle').textContent='Edit task';
    document.getElementById('taskName').value=t.name;
    document.getElementById('taskNotes').value=t.notes||'';
    renderProjectOptions(projSel, primary);
    renderSubcatOptions(subSel, primary, t.subcategoryId);
    renderAccountOptions(acctSel,t.accountId||null);
    renderTaskAlsoInProjects(primary, extras);
    dueEl.value = t.dueDate ? toDateInput(t.dueDate) : '';
    estEl.value = t.estimatedMinutes != null ? t.estimatedMinutes : '';
    prioEl.value = t.priority || '';
    statEl.value = taskStatus(t) || 'active';
    document.getElementById('btnDeleteTask').style.display='';
  } else {
    const def = taskModalDefaults || {};
    document.getElementById('taskModalTitle').textContent='New task';
    document.getElementById('taskName').value = def.name || '';
    document.getElementById('taskNotes').value = def.notes || '';
    const initialProject = def.projectId || state.projects[0].id;
    renderProjectOptions(projSel, initialProject);
    renderSubcatOptions(subSel, initialProject, def.subcategoryId || null);
    renderAccountOptions(acctSel, def.accountId || null);
    renderTaskAlsoInProjects(initialProject, []);
    dueEl.value = '';
    estEl.value = '';
    prioEl.value = '';
    statEl.value = 'active';
    document.getElementById('btnDeleteTask').style.display='none';
  }
  projSel.onchange=()=>{
    renderSubcatOptions(subSel,projSel.value,null);
    // Preserve any extras the user has already ticked, except the new primary itself.
    const currentExtras = getTaskAlsoInSelections().filter(id => id !== projSel.value);
    renderTaskAlsoInProjects(projSel.value, currentExtras);
  };
  updateAccountLabels();
  openModal('taskModal');
  setTimeout(()=>document.getElementById('taskName').focus(),50);
}
function saveTask(){
  const name=document.getElementById('taskName').value.trim();
  if(!name){ toast('Task name required'); return; }
  const primaryProjectId = document.getElementById('taskProject').value;
  if(!primaryProjectId){ toast('Pick a project'); return; }
  const extras = getTaskAlsoInSelections().filter(id => id && id !== primaryProjectId);
  const projectIds = [primaryProjectId, ...extras];
  const subcategoryId=document.getElementById('taskSubcat').value||null;
  const accountId=document.getElementById('taskAccount').value||null;
  const notes=document.getElementById('taskNotes').value.trim();
  const dueRaw = document.getElementById('taskDueDate').value;
  const dueDate = dueRaw ? new Date(dueRaw + 'T00:00:00').getTime() : null;
  const estRaw = document.getElementById('taskEstimate').value;
  const estimatedMinutes = estRaw === '' ? null : Math.max(0, parseInt(estRaw,10) || 0);
  const priority = document.getElementById('taskPriority').value || null;
  const status = document.getElementById('taskStatusSel').value || 'active';
  const completed = status === 'completed';
  const now = Date.now();
  let savedId;
  if(editingTaskId){
    const t=getTask(editingTaskId);
    const wasCompleted = !!t.completed;
    Object.assign(t,{
      name, projectIds, projectId: primaryProjectId, subcategoryId, accountId, notes,
      dueDate, estimatedMinutes, priority, status, completed,
      updatedAt: now
    });
    if(completed && !wasCompleted) t.completedAt = now;
    if(!completed) t.completedAt = null;
    savedId = t.id;
  } else {
    savedId = nextId('t');
    state.tasks.push({
      id: savedId, name, projectIds, projectId: primaryProjectId, subcategoryId, accountId, notes,
      dueDate, estimatedMinutes, priority, status, completed,
      completedAt: completed ? now : null,
      createdAt: now, updatedAt: now
    });
  }
  save();
  closeModal('taskModal');
  const cb = taskModalOnSave;
  taskModalOnSave = null;
  taskModalDefaults = null;
  renderAll();
  if(cb) cb(savedId);
}
function deleteTask(){
  if(!editingTaskId) return;
  if(!confirm('Delete this task? Time logged to it stays in history.')) return;
  state.tasks=state.tasks.filter(x=>x.id!==editingTaskId);
  save(); closeModal('taskModal'); renderTasks();
}
function toggleTaskComplete(taskId){
  const t=getTask(taskId); if(!t) return;
  const now = Date.now();
  t.completed = !t.completed;
  t.completedAt = t.completed ? now : null;
  t.status = t.completed ? 'completed' : 'active';
  t.updatedAt = now;
  save(); renderAll(); toast(t.completed?'Task marked complete':'Task reopened');
  if(t.completed){
    recordFocusEvent('task_completed', {
      projectId: taskPrimaryProject(t),
      taskId: t.id
    }, { taskName: t.name });
  }
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
// LOG tab
// ------------------------------------------------------------
function getLogRange(){
  const el=document.getElementById('logRange');
  const val=el?el.value:'thisWeek';
  const now=Date.now();
  switch(val){
    case 'today': return {start:startOfDay(now),end:now};
    case 'thisWeek': return {start:startOfWeek(now),end:now};
    case 'thisMonth': return {start:startOfMonth(now),end:now};
    case 'last30': return {start:now-30*86400000,end:now};
    case 'custom':{
      const s=document.getElementById('logRangeStart').value;
      const e=document.getElementById('logRangeEnd').value;
      if(!s||!e) return {start:startOfDay(now),end:now};
      return {start:new Date(s).getTime(),end:new Date(e).getTime()+86400000-1};
    }
    default: return {start:startOfWeek(now),end:now};
  }
}

function getLogEntries(){
  const range=getLogRange();
  return state.entries.filter(e=>{
    if(e.endMs<range.start||e.startMs>range.end) return false;
    if(logBillableFilter==='billable'&&!e.billable) return false;
    if(logBillableFilter==='nonbillable'&&e.billable) return false;
    if(logProjectFilter !== 'all' && e.projectId !== logProjectFilter) return false;
    if(logTaskFilter !== 'all'){
      if(logTaskFilter === '__none__'){ if(e.taskId) return false; }
      else if(e.taskId !== logTaskFilter) return false;
    }
    if(logMissingNotesOnly && (e.notes||'').trim()) return false;
    if(!matchesSearch(e,logSearchTerm)) return false;
    return true;
  });
}

function renderLogFilterDropdowns(){
  const projSel = document.getElementById('logProjectFilter');
  const taskSel = document.getElementById('logTaskFilter');
  if(!projSel || !taskSel) return;
  // Project filter options
  projSel.innerHTML = '';
  const allP = document.createElement('option'); allP.value='all'; allP.textContent='All projects'; projSel.appendChild(allP);
  state.projects.forEach(p=>{
    const o=document.createElement('option'); o.value=p.id; o.textContent=p.name; projSel.appendChild(o);
  });
  projSel.value = logProjectFilter;
  // Task filter options — narrow to selected project if any.
  taskSel.innerHTML = '';
  const allT = document.createElement('option'); allT.value='all'; allT.textContent='All tasks'; taskSel.appendChild(allT);
  const noneT = document.createElement('option'); noneT.value='__none__'; noneT.textContent='— no task —'; taskSel.appendChild(noneT);
  const taskList = state.tasks.filter(t => logProjectFilter==='all' || t.projectId === logProjectFilter);
  taskList.forEach(t=>{
    const o=document.createElement('option'); o.value=t.id;
    const p = getProject(t.projectId);
    o.textContent = logProjectFilter==='all' && p ? `${p.name} · ${t.name}` : t.name;
    taskSel.appendChild(o);
  });
  // Reset task filter if its task no longer exists in the narrowed list
  const taskValueExists = logTaskFilter==='all' || logTaskFilter==='__none__' || taskList.some(t=>t.id===logTaskFilter);
  if(!taskValueExists) logTaskFilter = 'all';
  taskSel.value = logTaskFilter;
  // Missing notes button toggle state
  const mn = document.getElementById('logMissingNotesBtn');
  if(mn) mn.classList.toggle('active', logMissingNotesOnly);
}

function groupIntoSessions(entries,gapMs=30*60*1000){
  if(!entries.length) return [];
  const sorted=[...entries].sort((a,b)=>a.startMs-b.startMs);
  const sessions=[];
  let current=[sorted[0]];
  for(let i=1;i<sorted.length;i++){
    const prev=current[current.length-1];
    if(sorted[i].startMs-prev.endMs<=gapMs) current.push(sorted[i]);
    else{ sessions.push(current); current=[sorted[i]]; }
  }
  sessions.push(current);
  return sessions;
}

function renderLog(){
  const list=document.getElementById('logList');
  if(!list) return;
  renderLogFilterDropdowns();
  list.innerHTML='';
  const entries=getLogEntries();

  const totalMs=entries.reduce((s,e)=>s+entryDuration(e),0);
  const billableMs=entries.filter(e=>e.billable).reduce((s,e)=>s+entryDuration(e),0);
  document.getElementById('logTotal').textContent=formatHM(totalMs);
  document.getElementById('logTotalBillable').textContent=formatHM(billableMs);
  document.getElementById('logTotalNonBillable').textContent=formatHM(totalMs-billableMs);

  if(!entries.length){
    list.innerHTML=logSearchTerm||logBillableFilter!=='all'
      ?`<div class="empty">No entries match the current filters.</div>`
      :`<div class="empty">No entries in this range.</div>`;
    return;
  }

  const sorted=[...entries].sort((a,b)=>b.startMs-a.startMs);
  const days=new Map();
  for(const e of sorted){
    const k=startOfDay(e.startMs);
    if(!days.has(k)) days.set(k,[]);
    days.get(k).push(e);
  }

  for(const [dayKey,dayEntries] of [...days.entries()].sort((a,b)=>b[0]-a[0])){
    const dayMs=dayEntries.reduce((s,e)=>s+entryDuration(e),0);
    const dayBillableMs=dayEntries.filter(e=>e.billable).reduce((s,e)=>s+entryDuration(e),0);
    const group=document.createElement('div'); group.className='day-group';
    group.innerHTML=`<div class="day-header">
      <span>${dayLabel(dayKey)}</span>
      <div style="display:flex;gap:14px;align-items:center">
        ${dayBillableMs>0?`<span style="font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--green)">${formatHM(dayBillableMs)} billable</span>`:''}
        <span class="day-total">${formatHM(dayMs)}</span>
      </div></div>`;

    const sessions=groupIntoSessions(dayEntries);
    for(const session of sessions){
      const sessionMs=session.reduce((s,e)=>s+entryDuration(e),0);
      const sessionStart=Math.min(...session.map(e=>e.startMs));
      const sessionEnd=Math.max(...session.map(e=>e.endMs));
      const sessionDiv=document.createElement('div'); sessionDiv.className='log-session';
      sessionDiv.innerHTML=`<div class="log-session-header"><span class="log-session-time">${formatTimeOfDay(sessionStart)} – ${formatTimeOfDay(sessionEnd)}</span><span class="log-session-duration">${formatHM(sessionMs)}</span></div>`;

      for(const e of [...session].sort((a,b)=>a.startMs-b.startMs)){
        const project=getProject(e.projectId);
        const subcat=getSubcat(e.projectId,e.subcategoryId);
        const account=e.accountId?getAccount(e.accountId):null;
        const task=e.taskId?getTask(e.taskId):null;
        const color=project?project.color:'#666';
        const row=document.createElement('div'); row.className='entry';
        row.innerHTML=`
          <div class="entry-bar" style="background:${esc(color)}"></div>
          <div class="entry-meta">
            <div class="entry-project">
              ${esc(project?project.name:'(deleted project)')}
              ${subcat?`<span class="subcat-tag">${esc(subcat.name)}</span>`:''}
              ${account?`<span class="account-badge">${esc(account.name)}</span>`:''}
              ${task?`<span class="subcat-tag" style="color:var(--amber)">📋 ${esc(task.name)}</span>`:''}
              ${e.billable?`<span class="billable-badge">$</span>`:''}
            </div>
            <div class="entry-notes">${esc(e.notes||'')}</div>
          </div>
          <div class="entry-times">${formatTimeOfDay(e.startMs)} → ${formatTimeOfDay(e.endMs)}</div>
          <div class="entry-duration">${formatHMS(entryDuration(e))}</div>
          <div class="entry-actions">
            <button class="icon-btn green" title="Resume" data-log-resume="${e.id}">▶</button>
            <button class="icon-btn" title="Edit" data-log-edit="${e.id}">✎</button>
          </div>`;
        sessionDiv.appendChild(row);
      }
      group.appendChild(sessionDiv);
    }
    list.appendChild(group);
  }
  list.querySelectorAll('[data-log-edit]').forEach(b=>b.addEventListener('click',()=>openEntryModal(b.dataset.logEdit)));
  list.querySelectorAll('[data-log-resume]').forEach(b=>b.addEventListener('click',()=>resumeEntry(b.dataset.logResume)));
}

// Build a CSV row for an entry. The schema is the same for both Today and Log
// exports, so downstream tools (Excel, dashboards, AI prompts) can rely on
// stable column names. IDs go alongside human-readable names — IDs are stable
// across renames; names are easy to scan.
function buildEntryRow(e){
  const p = getProject(e.projectId);
  const s = getSubcat(e.projectId, e.subcategoryId);
  const a = e.accountId ? getAccount(e.accountId) : null;
  const t = e.taskId ? getTask(e.taskId) : null;
  const dur = entryDuration(e);
  const ds = new Date(e.startMs);
  const de = new Date(e.endMs);
  return [
    e.id,
    ds.toISOString(),
    de.toISOString(),
    ds.toLocaleDateString(),
    formatHMS(dur),
    (dur/3600000).toFixed(2),
    e.projectId || '',
    p ? p.name : '(deleted)',
    e.subcategoryId || '',
    s ? s.name : '',
    e.taskId || '',
    t ? t.name : '',
    e.accountId || '',
    a ? a.name : '',
    e.notes || '',
    e.billable ? 'Yes' : 'No',
    e.createdAt ? new Date(e.createdAt).toISOString() : ''
  ];
}

const ENTRY_CSV_HEADER = [
  'Entry ID','Start (ISO)','End (ISO)','Date','Duration (HH:MM:SS)','Hours (decimal)',
  'Project ID','Project','Subcategory ID','Subcategory',
  'Task ID','Task',
  'Account ID','Account',
  'Notes','Billable','Created (ISO)'
];

function exportLogCSV(){
  const rows=[ENTRY_CSV_HEADER];
  const entries=getLogEntries().sort((a,b)=>a.startMs-b.startMs);
  for(const e of entries) rows.push(buildEntryRow(e));
  const csv=rows.map(r=>r.map(csvEscape).join(',')).join('\r\n');
  download('punch_log_'+dateStamp()+'.csv',csv,'text/csv');
  toast('CSV exported');
}

// ------------------------------------------------------------
// CSV / JSON
// ------------------------------------------------------------
function csvEscape(v){ if(v==null) return ''; const s=String(v); return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function exportCSV(){
  const rows=[ENTRY_CSV_HEADER];
  const sorted=[...state.entries].sort((a,b)=>a.startMs-b.startMs);
  for(const e of sorted) rows.push(buildEntryRow(e));
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
    return {id:t.id,name:t.name,project:p?p.name:'(deleted)',projectId:t.projectId,account:a?a.name:null,hoursLogged:+(sumTaskMs(t.id)/3600000).toFixed(2)};
  });

  // Tasks with time logged in this period that are not yet completed — likely
  // carry-forward work for next period. Compute hours-logged-in-range-only so
  // we don't conflate prior effort with the current window.
  const taskHoursInRange = new Map();
  for(const e of inRange){
    if(!e.taskId) continue;
    const dur = Math.min(e.endMs,range.end) - Math.max(e.startMs,range.start);
    if(dur <= 0) continue;
    taskHoursInRange.set(e.taskId, (taskHoursInRange.get(e.taskId)||0) + dur);
  }
  const incompleteWithTime = [];
  for(const [tid, ms] of taskHoursInRange){
    const t = getTask(tid);
    if(!t || t.completed) continue;
    const p = getProject(t.projectId);
    incompleteWithTime.push({
      id: t.id, name: t.name,
      project: p ? p.name : '(deleted)', projectId: t.projectId,
      hoursLoggedThisPeriod: +(ms/3600000).toFixed(2),
      hoursLoggedTotal: +(sumTaskMs(t.id)/3600000).toFixed(2),
      estimatedMinutes: t.estimatedMinutes || null,
      dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : null,
      priority: t.priority || null
    });
  }
  incompleteWithTime.sort((a,b)=>b.hoursLoggedThisPeriod - a.hoursLoggedThisPeriod);

  // Carry-forward candidates: active tasks that are overdue or due in the next
  // 7 days, ordered by due date. Use range.end as "now" so weekly summaries
  // stay coherent for past periods.
  const horizon = range.end + 7*86400000;
  const carryForward = state.tasks.filter(t => isTaskActive(t) && t.dueDate && t.dueDate <= horizon).map(t => {
    const p = getProject(t.projectId);
    return {
      id: t.id, name: t.name,
      project: p ? p.name : '(deleted)', projectId: t.projectId,
      dueDate: new Date(t.dueDate).toISOString(),
      overdue: t.dueDate < range.end,
      hoursLoggedTotal: +(sumTaskMs(t.id)/3600000).toFixed(2),
      estimatedMinutes: t.estimatedMinutes || null,
      priority: t.priority || null
    };
  }).sort((a,b)=>new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  // Quality signal: entries with no notes, useful for prompting users to fill in context.
  const entriesMissingNotes = inRange.filter(e => !(e.notes||'').trim()).length;

  return {
    period:{label:range.label,start:new Date(range.start).toISOString(),end:new Date(range.end).toISOString()},
    totals:{
      hours:+(totalMs/3600000).toFixed(2),
      formatted:formatHM(totalMs),
      entryCount:inRange.length,
      entriesMissingNotes
    },
    accountLabel:lbl, projects, accounts, completedTasks,
    incompleteWithTime, carryForward,
    entries:inRange.map(e=>{
      const p=getProject(e.projectId), s=getSubcat(e.projectId,e.subcategoryId);
      const a=e.accountId?getAccount(e.accountId):null, t=e.taskId?getTask(e.taskId):null;
      return {
        id:e.id,
        date:new Date(e.startMs).toLocaleDateString(),
        projectId:e.projectId, project:p?p.name:'(deleted)',
        subcategoryId:e.subcategoryId||null, subcategory:s?s.name:null,
        accountId:e.accountId||null, account:a?a.name:null,
        taskId:e.taskId||null, task:t?t.name:null,
        notes:e.notes||null,
        billable:!!e.billable,
        start:new Date(e.startMs).toISOString(),
        end:new Date(e.endMs).toISOString(),
        hours:+(entryDuration(e)/3600000).toFixed(2)
      };
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
  if(data.incompleteWithTime && data.incompleteWithTime.length>0){
    md+=`## In Flight — Tasks With Time Logged But Not Completed\n\n`;
    for(const t of data.incompleteWithTime){
      const est = t.estimatedMinutes ? ` (est ${(t.estimatedMinutes/60).toFixed(2)}h)` : '';
      const due = t.dueDate ? ` · due ${new Date(t.dueDate).toLocaleDateString()}` : '';
      md+=`- **${t.name}** (${t.project}${due}) — ${t.hoursLoggedThisPeriod}h this period, ${t.hoursLoggedTotal}h total${est}\n`;
    }
    md+=`\n`;
  }
  if(data.carryForward && data.carryForward.length>0){
    md+=`## Carry Forward — Active Tasks Due Soon or Overdue\n\n`;
    for(const t of data.carryForward){
      const tag = t.overdue ? ' ⚠️ overdue' : '';
      const prio = t.priority ? ` [${t.priority}]` : '';
      md+=`- **${t.name}** (${t.project}) — due ${new Date(t.dueDate).toLocaleDateString()}${tag}${prio}\n`;
    }
    md+=`\n`;
  }
  if(data.totals.entriesMissingNotes > 0){
    md+=`> **Quality note:** ${data.totals.entriesMissingNotes} of ${data.totals.entryCount} entries are missing notes — context that would otherwise feed into recap quality.\n\n`;
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

// ============================================================
// PRODUCTIVITY — Selectors, Services, Coach Card
// ------------------------------------------------------------
// Reusable data layer for Nudges, End Day, and any future Focus tab.
// Selectors are pure (no mutation, no save()). Services own mutations.
// The split exists so the same `buildDailyCloseoutPreview` powers both
// the End Day modal today and an AI summary/Focus dashboard later.
// ============================================================

// ----- Selectors: pure read-only over `state` -----

// startOfDay-anchored window for a given date.
function dayWindow(dateMs){
  const start = startOfDay(dateMs);
  return { start, end: start + 86400000 };
}

// Sum project totals (ms) for a single day. Returns [{ projectId, name, color, ms }]
// sorted desc by ms. Used by closeout summary and daily reports.
function getProjectTotalsForDate(dateMs){
  const { start, end } = dayWindow(dateMs);
  const totals = new Map();
  for(const e of state.entries){
    if(e.endMs <= start || e.startMs >= end) continue;
    const s = Math.max(e.startMs, start), en = Math.min(e.endMs, end);
    const dur = en - s; if(dur <= 0) continue;
    totals.set(e.projectId, (totals.get(e.projectId) || 0) + dur);
  }
  if(state.activeTimer){
    const s = Math.max(state.activeTimer.startMs, start), en = Math.min(Date.now(), end);
    if(en > s) totals.set(state.activeTimer.projectId,
      (totals.get(state.activeTimer.projectId) || 0) + (en - s));
  }
  return [...totals.entries()]
    .map(([pid, ms]) => {
      const p = getProject(pid);
      return { projectId: pid, name: p ? p.name : '(deleted project)', color: p ? p.color : '#666', ms };
    })
    .sort((a,b) => b.ms - a.ms);
}

// Tasks completed on the given calendar day (based on completedAt).
function getCompletedTasksForDate(dateMs){
  const { start, end } = dayWindow(dateMs);
  return state.tasks.filter(t =>
    taskStatus(t) === 'completed' && t.completedAt && t.completedAt >= start && t.completedAt < end
  );
}

// Active tasks that should appear in a daily closeout: due today, overdue,
// or had time logged today but not yet completed. Pure: does not mutate.
function getIncompleteTasksForDate(dateMs){
  const { start, end } = dayWindow(dateMs);
  const tomorrowStart = end;
  const idsWithTimeToday = new Set();
  for(const e of state.entries){
    if(!e.taskId) continue;
    if(e.endMs > start && e.startMs < end) idsWithTimeToday.add(e.taskId);
  }
  if(state.activeTimer && state.activeTimer.taskId){
    idsWithTimeToday.add(state.activeTimer.taskId);
  }
  return state.tasks.filter(t => {
    if(!isTaskActive(t)) return false;
    if(t.dueDate && t.dueDate < tomorrowStart) return true; // due today or overdue
    if(idsWithTimeToday.has(t.id)) return true;
    return false;
  });
}

// Carry-forward candidates: subset of incomplete tasks that should *default*
// to "carry to tomorrow" in End Day. Right now = same as incomplete; future
// versions may exclude tasks the user explicitly pinned to today, etc.
function getCarryForwardCandidates(dateMs){
  return getIncompleteTasksForDate(dateMs);
}

// Entries from a given day with empty/whitespace notes. Returns entry objects.
function getMissingNoteEntries(dateMs){
  const { start, end } = dayWindow(dateMs);
  return state.entries.filter(e =>
    e.endMs > start && e.startMs < end && !(e.notes || '').trim()
  );
}

// Longest single entry on the day, useful for "longest focus block" stats.
function getLongestEntryForDate(dateMs){
  const { start, end } = dayWindow(dateMs);
  let best = null, bestMs = 0;
  for(const e of state.entries){
    if(e.endMs <= start || e.startMs >= end) continue;
    const dur = Math.min(e.endMs, end) - Math.max(e.startMs, start);
    if(dur > bestMs){ bestMs = dur; best = e; }
  }
  return best ? { entry: best, durationMs: bestMs } : null;
}

// Aggregate stats over a nudgeEvent date range. Drives future analytics
// dashboards; the Nudges Settings panel uses a slimmer view of this.
function getNudgeStats(rangeStartMs, rangeEndMs){
  const events = state.nudgeEvents.filter(e =>
    e.triggeredAt >= rangeStartMs && e.triggeredAt <= rangeEndMs);
  const byNudge = new Map();
  let done=0, snoozed=0, skipped=0, missed=0;
  for(const e of events){
    if(!byNudge.has(e.nudgeId)) byNudge.set(e.nudgeId, { triggered:0, done:0, snoozed:0, skipped:0, missed:0 });
    const acc = byNudge.get(e.nudgeId);
    acc.triggered++;
    if(e.response === 'done'){ done++; acc.done++; }
    else if(e.response === 'snoozed'){ snoozed++; acc.snoozed++; }
    else if(e.response === 'skipped'){ skipped++; acc.skipped++; }
    else { missed++; acc.missed++; }
  }
  return {
    triggered: events.length, done, snoozed, skipped, missed,
    byNudge: [...byNudge.entries()].map(([nudgeId, s]) => {
      const n = state.nudges.find(x => x.id === nudgeId);
      return { nudgeId, name: n ? n.name : '(deleted)', ...s };
    })
  };
}

// Closeout history within an optional range, newest first.
function getCloseoutHistory(rangeStartMs, rangeEndMs){
  let list = state.dailyCloseouts || [];
  if(rangeStartMs != null) list = list.filter(c => c.closedAt >= rangeStartMs);
  if(rangeEndMs != null) list = list.filter(c => c.closedAt <= rangeEndMs);
  return [...list].sort((a,b) => b.closedAt - a.closedAt);
}

// ----- Coach Card -----

// Rule-based daily prompt. Returns { text, category } or null. Designed for
// reuse — End Day, Today, Insights, and a future Focus tab can all call this
// with a context bundle. Original lines; no famous-quote datasets.
function getDailyCoachCard(context){
  const c = context || {};
  if(c.carryForwardCount >= 5){
    return { text: 'Reduce drag. Carry forward only what still matters this week.', category: 'reduce-drag' };
  }
  if(c.missingNotesCount > 0 && c.missingNotesCount >= Math.max(2, Math.floor(c.entryCount * 0.3))){
    return { text: 'Context compounds. A clean note today makes the week easier to review.', category: 'context' };
  }
  if(c.completedTasksCount === 0 && c.totalTrackedMs >= 3 * 3600000){
    return { text: 'Effort without an outcome is a draft. Close one loop before the day ends.', category: 'effort-to-outcome' };
  }
  if(c.dominantProjectPercent >= 70){
    return { text: 'One project owned the day. If that was the plan, good. If not, redistribute tomorrow.', category: 'dominant-project' };
  }
  if(c.completedTasksCount > 0 && c.carryForwardCount === 0 && c.missingNotesCount === 0){
    return { text: 'Momentum beats intention. Tomorrow, pick the next useful move and start it early.', category: 'momentum' };
  }
  if(c.totalTrackedMs === 0){
    return { text: 'Quiet day on the timer. If that was intentional, no notes needed. If not, what blocked you?', category: 'quiet' };
  }
  return { text: 'If it matters, inspect it. Close the loop before the day ends.', category: 'default' };
}

// ----- Auto carry-forward -----

// Runs once at app load. Migrates active tasks whose dueDate is strictly in
// the past so the user doesn't have to manually push them every morning.
// Idempotent for the same calendar day via lastCarriedForwardAt: a task
// already auto-carried today won't be touched a second time if the app is
// reopened later. End Day's explicit carry uses a separate path that still
// increments the counter even on the same day.
function autoCarryForwardOverdueTasks(){
  const todayStart = startOfDay(Date.now());
  let bumped = 0;
  for(const t of state.tasks){
    if(!isTaskActive(t)) continue;
    if(!t.dueDate || t.dueDate >= todayStart) continue;
    if(t.lastCarriedForwardAt && t.lastCarriedForwardAt >= todayStart) continue;
    // Bump dueDate to today (not tomorrow) — the task is already overdue, the
    // user expects it on today's plan, not pushed another day out.
    t.dueDate = todayStart;
    t.carryForwardCount = (t.carryForwardCount || 0) + 1;
    t.lastCarriedForwardAt = Date.now();
    t.updatedAt = Date.now();
    // Overdue tasks get a priority bump to high (unless already higher).
    if(t.priority !== 'high') t.priority = 'high';
    bumped++;
  }
  if(bumped > 0) save();
  return bumped;
}

// ----- Closeout: preview (pure) and commit (mutating) -----

// Build a structured snapshot of a day's work — used for the End Day modal,
// future weekly closeouts, and AI summary input. Pure: does not write state.
// Names are snapshotted at build time so the resulting record stays readable
// even if a project is renamed/deleted later.
function buildDailyCloseoutPreview(dateMs){
  const day = dateMs || Date.now();
  const { start, end } = dayWindow(day);
  const isToday = startOfDay(Date.now()) === start;
  const observedEnd = isToday ? Date.now() : end;

  const projectTotals = getProjectTotalsForDate(day);
  const totalTrackedMs = projectTotals.reduce((s,p) => s + p.ms, 0);
  const completedTasks = getCompletedTasksForDate(day).map(t => {
    const p = getProject(taskPrimaryProject(t));
    return {
      id: t.id, name: t.name,
      projectId: taskPrimaryProject(t), projectName: p ? p.name : '(deleted project)',
      completedAt: t.completedAt,
      loggedTodayMs: sumTaskMsToday(t.id)
    };
  });
  const incompleteTasks = getIncompleteTasksForDate(day).map(t => {
    const p = getProject(taskPrimaryProject(t));
    const isOverdue = t.dueDate && t.dueDate < start;
    const isDueToday = t.dueDate && t.dueDate >= start && t.dueDate < end;
    return {
      id: t.id, name: t.name,
      projectId: taskPrimaryProject(t), projectName: p ? p.name : '(deleted project)',
      dueDate: t.dueDate || null,
      priority: t.priority || null,
      carryForwardCount: t.carryForwardCount || 0,
      loggedTodayMs: sumTaskMsToday(t.id),
      isOverdue: !!isOverdue,
      isDueToday: !!isDueToday,
      // Default action shown in End Day. Overdue/due-today default to carry.
      // In-progress-today-only defaults to keep (user has been working on it).
      defaultAction: (isOverdue || isDueToday) ? 'carry' : 'keep'
    };
  });
  const missingNoteEntries = getMissingNoteEntries(day).map(e => {
    const p = getProject(e.projectId);
    return {
      id: e.id,
      projectId: e.projectId, projectName: p ? p.name : '(deleted project)',
      startMs: e.startMs, endMs: e.endMs,
      durationMs: entryDuration(e)
    };
  });
  const longest = getLongestEntryForDate(day);
  const topProject = projectTotals[0] || null;
  const dominantPercent = totalTrackedMs > 0 && topProject
    ? Math.round((topProject.ms / totalTrackedMs) * 100)
    : 0;
  const entryCount = state.entries.filter(e => e.endMs > start && e.startMs < end).length;

  const summaryText = buildDailyCloseoutSummaryText({
    totalTrackedMs, projectTotals,
    completedTasksCount: completedTasks.length,
    incompleteTasksCount: incompleteTasks.length,
    missingNotesCount: missingNoteEntries.length,
    topProject, dominantPercent
  });
  const coachCard = getDailyCoachCard({
    totalTrackedMs,
    entryCount,
    completedTasksCount: completedTasks.length,
    carryForwardCount: incompleteTasks.length,
    missingNotesCount: missingNoteEntries.length,
    dominantProjectPercent: dominantPercent
  });

  return {
    date: start,
    builtAt: Date.now(),
    observedEnd,
    totalTrackedMs,
    projectTotals,
    completedTasks,
    incompleteTasks,
    missingNoteEntries,
    longestEntry: longest ? { id: longest.entry.id, durationMs: longest.durationMs } : null,
    topProjectId: topProject ? topProject.projectId : null,
    topProjectName: topProject ? topProject.name : null,
    dominantPercent,
    entryCount,
    summaryText,
    coachCard,
    timerRunning: !!state.activeTimer,
    activeTimer: state.activeTimer ? {
      projectId: state.activeTimer.projectId,
      taskId: state.activeTimer.taskId,
      startMs: state.activeTimer.startMs
    } : null
  };
}

// Rule-based daily summary line. Pure string composition; no AI required.
// Reusable for AI prompt headers later.
function buildDailyCloseoutSummaryText(parts){
  const { totalTrackedMs, projectTotals, completedTasksCount,
          incompleteTasksCount, missingNotesCount, topProject } = parts;
  if(totalTrackedMs === 0 && completedTasksCount === 0){
    return 'No tracked time and no completed tasks today.';
  }
  const bits = [];
  bits.push(`You tracked ${formatHM(totalTrackedMs)} today across ${projectTotals.length} project${projectTotals.length === 1 ? '' : 's'}.`);
  if(topProject && projectTotals.length > 1){
    bits.push(`Most of your time went to ${topProject.name}.`);
  }
  if(completedTasksCount > 0 || incompleteTasksCount > 0){
    bits.push(`You completed ${completedTasksCount} task${completedTasksCount === 1 ? '' : 's'}` +
      (incompleteTasksCount > 0
        ? ` and have ${incompleteTasksCount} active task${incompleteTasksCount === 1 ? '' : 's'} to carry forward.`
        : '.'));
  }
  if(missingNotesCount > 0){
    bits.push(`${missingNotesCount} ${missingNotesCount === 1 ? 'entry is' : 'entries are'} missing notes.`);
  }
  return bits.join(' ');
}

// Apply user selections from the End Day modal. Mutates: stops timer if
// requested, applies per-task actions, appends a dailyCloseout record.
// selections = {
//   stopActiveTimer: boolean,
//   taskActions: { [taskId]: 'carry' | 'keep' | 'complete' | 'archive' }
// }
function commitDailyCloseout(preview, selections){
  const now = Date.now();
  const sel = selections || {};
  const actions = sel.taskActions || {};

  if(sel.stopActiveTimer && state.activeTimer){
    stopTimer(); // writes entry, clears activeTimer, saves
  }

  const carriedForwardTaskIds = [];
  const completedDuringCloseoutIds = [];
  const archivedDuringCloseoutIds = [];
  const tomorrowStart = startOfDay(now) + 86400000;

  for(const inc of preview.incompleteTasks){
    const action = actions[inc.id] || inc.defaultAction;
    const t = getTask(inc.id);
    if(!t) continue;
    if(action === 'carry'){
      t.dueDate = tomorrowStart;
      t.carryForwardCount = (t.carryForwardCount || 0) + 1;
      t.lastCarriedForwardAt = now;
      t.updatedAt = now;
      // If carrying an overdue/due-today task, nudge priority up.
      if((inc.isOverdue || inc.isDueToday) && t.priority !== 'high'){
        t.priority = 'high';
      }
      carriedForwardTaskIds.push(t.id);
    } else if(action === 'complete'){
      t.completed = true;
      t.status = 'completed';
      t.completedAt = now;
      t.updatedAt = now;
      completedDuringCloseoutIds.push(t.id);
    } else if(action === 'archive'){
      t.status = 'archived';
      t.archivedAt = now;
      t.updatedAt = now;
      archivedDuringCloseoutIds.push(t.id);
    }
    // 'keep' = no change
  }

  // Re-snapshot completed tasks AFTER the closeout actions, so tasks the user
  // marked complete from the modal are included in the history record.
  const allCompletedIds = [
    ...preview.completedTasks.map(t => t.id),
    ...completedDuringCloseoutIds
  ];

  const record = {
    id: nextId('cl'),
    date: preview.date,
    closedAt: now,
    totalTrackedMinutes: Math.round(preview.totalTrackedMs / 60000),
    projectTotals: preview.projectTotals.map(p => ({
      projectId: p.projectId, name: p.name, minutes: Math.round(p.ms / 60000)
    })),
    completedTaskIds: allCompletedIds,
    completedTaskSnapshots: allCompletedIds.map(id => {
      const t = getTask(id);
      const p = t ? getProject(taskPrimaryProject(t)) : null;
      return t ? { id: t.id, name: t.name, projectName: p ? p.name : null } : { id, name: '(deleted)' };
    }),
    carriedForwardTaskIds,
    archivedTaskIds: archivedDuringCloseoutIds,
    incompleteTaskIds: preview.incompleteTasks
      .filter(t => (actions[t.id] || t.defaultAction) === 'keep')
      .map(t => t.id),
    missingNoteEntryIds: preview.missingNoteEntries.map(e => e.id),
    summaryText: preview.summaryText,
    coachCardText: preview.coachCard ? preview.coachCard.text : null,
    coachCardCategory: preview.coachCard ? preview.coachCard.category : null,
    topProjectId: preview.topProjectId,
    topProjectName: preview.topProjectName,
    entryCount: preview.entryCount,
    longestEntryId: preview.longestEntry ? preview.longestEntry.id : null,
    longestEntryMs: preview.longestEntry ? preview.longestEntry.durationMs : null,
    createdAt: now
  };
  state.dailyCloseouts.push(record);
  save();
  // Emit focus events so future Focus Insights can correlate End Day actions
  // with the rest of the day's signals. One event per carried task lets
  // attention-drift reports surface tasks that repeatedly slip.
  recordFocusEvent('end_day_completed', { projectId: preview.topProjectId, taskId: null }, {
    closeoutId: record.id,
    totalTrackedMinutes: record.totalTrackedMinutes,
    completedCount: allCompletedIds.length,
    carriedCount: carriedForwardTaskIds.length,
    archivedCount: archivedDuringCloseoutIds.length
  });
  for(const taskId of carriedForwardTaskIds){
    const t = getTask(taskId);
    recordFocusEvent('task_carried_forward', {
      projectId: t ? taskPrimaryProject(t) : null,
      taskId
    }, {
      carryForwardCount: t ? t.carryForwardCount : null,
      closeoutId: record.id
    });
  }
  return record;
}

// ============================================================
// PRODUCTIVITY — Nudge Service
// ------------------------------------------------------------
// One scheduler tick checks all enabled nudges. Triggering is gated by:
// global pause, presentation mode, working hours (unless overridden),
// the nudge's own activeDays/activeStart/activeEnd window, snoozeUntil,
// and the forward-looking nextDueAt (v5+) — never on (now - lastTriggeredAt),
// so a nudge that was overdue while the app was closed does NOT fire
// immediately on next launch. lastTriggeredAt is retained as a display-only
// "last fired" field. Triggers create a nudgeEvent in 'triggered' state;
// user responses transition it to done/snoozed/skipped.
// If the app isn't visible when a nudge fires, it queues until visible.
// ============================================================

// In-renderer state (deliberately not persisted).
let nudgeTickInterval = null;
let pendingNudgeQueue = [];   // [{ eventId, nudgeId }] — most recent at end
let currentNudgePopup = null; // { eventId, nudgeId } while a popup is showing
let lastInteractionMs = Date.now();
let nudgeInteractionListenersAttached = false;

function attachNudgeInteractionListeners(){
  if(nudgeInteractionListenersAttached) return;
  nudgeInteractionListenersAttached = true;
  const bump = () => { lastInteractionMs = Date.now(); };
  // Passive listeners, no throttle needed — these handlers do trivial work.
  document.addEventListener('mousemove', bump, { passive: true });
  document.addEventListener('keydown', bump, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible'){
      bump();
      flushPendingNudgeQueue();
    }
  });
}

function userIsActive(){
  if(state.activeTimer) return true;
  return Date.now() - lastInteractionMs < 5 * 60 * 1000;
}

function nudgesGloballyPaused(){
  const p = state.settings.productivity || {};
  if(p.presentationModeEnabled) return true;
  if(p.nudgePauseUntil && p.nudgePauseUntil > Date.now()) return true;
  return false;
}

function isWithinWorkingHours(nowMs){
  const p = (state.settings.productivity || {}).workingHours || {};
  const now = new Date(nowMs);
  const day = now.getDay();
  const days = Array.isArray(p.days) ? p.days : [1,2,3,4,5];
  if(!days.includes(day)) return false;
  const [sh, sm] = (p.start || '09:00').split(':').map(Number);
  const [eh, em] = (p.end   || '17:00').split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= sh*60 + sm && mins < eh*60 + em;
}

function isWithinNudgeWindow(nudge, nowMs){
  const now = new Date(nowMs);
  const day = now.getDay();
  if(!nudge.activeDays.includes(day)) return false;
  const [sh, sm] = (nudge.activeStartTime || '09:00').split(':').map(Number);
  const [eh, em] = (nudge.activeEndTime   || '17:00').split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= sh*60 + sm && mins < eh*60 + em;
}

// Forward-schedule a single nudge's nextDueAt. Reason controls the formula:
//   'init'   — first scheduling at app open; respects an active snoozeUntil,
//              otherwise sets due = base + interval
//   'resume' — same as init; used when global pause/presentation mode ends
//   'fire'   — call after a nudge triggers, so the next tick won't immediately
//              refire while the popup is open or the event is unresponded
//   'done'   — user acknowledged; due = base + interval
//   'snooze' — user snoozed; due = base + defaultSnoozeMinutes
//   'skip'   — user dismissed; due = base + interval (no shorter retry)
// base defaults to now. Returns the scheduled timestamp.
function scheduleNextNudge(nudge, reason, baseTimeMs){
  const base = typeof baseTimeMs === 'number' ? baseTimeMs : Date.now();
  const intervalMs = (nudge.intervalMinutes || 60) * 60 * 1000;
  let due;
  if(reason === 'snooze'){
    const snoozeMin = nudge.defaultSnoozeMinutes || 15;
    due = base + snoozeMin * 60 * 1000;
  } else if(reason === 'init' || reason === 'resume'){
    // An active snooze takes precedence — we don't yank a snooze forward.
    if(nudge.snoozeUntil && nudge.snoozeUntil > base){
      due = nudge.snoozeUntil;
    } else {
      due = base + intervalMs;
    }
  } else {
    // 'fire' | 'done' | 'skip' — standard forward interval from base.
    due = base + intervalMs;
  }
  nudge.nextDueAt = due;
  return due;
}

// Called once at init. Walks every enabled nudge and assigns a forward-looking
// nextDueAt so a nudge that was "overdue" while the app was closed does NOT
// fire immediately on next launch. This is the core of the no-backlog rule.
function initializeNudgeScheduleOnStartup(){
  const now = Date.now();
  let dirty = false;
  for(const n of state.nudges){
    if(!n.enabled) continue;
    // Missing or stale (past) due time → push forward.
    if(typeof n.nextDueAt !== 'number' || n.nextDueAt < now){
      scheduleNextNudge(n, 'init', now);
      dirty = true;
    } else if(n.snoozeUntil && n.snoozeUntil > now && n.nextDueAt < n.snoozeUntil){
      // A snooze set in a prior session that extends past the existing nextDueAt
      // should win. Rare but cheap to handle.
      n.nextDueAt = n.snoozeUntil;
      dirty = true;
    }
  }
  if(dirty) save();
}

// Decision function. Returns { fire: bool, reason: string } so logging can
// explain why a nudge didn't fire — useful when debugging in the future.
// Forward-looking: gated on nextDueAt, not on (now - lastTriggeredAt). A
// pre-v5 nudge that has not yet been touched by initializeNudgeScheduleOnStartup
// is treated as not-yet-scheduled (won't fire) rather than as overdue.
function shouldNudgeFire(nudge, nowMs){
  if(!nudge.enabled) return { fire:false, reason:'disabled' };
  if(nudge.archivedAt) return { fire:false, reason:'archived' };
  if(nudgesGloballyPaused()) return { fire:false, reason:'globally-paused' };
  if(nudge.snoozeUntil && nudge.snoozeUntil > nowMs) return { fire:false, reason:'snoozed' };
  if(!isWithinNudgeWindow(nudge, nowMs)) return { fire:false, reason:'outside-nudge-window' };
  if(nudge.respectWorkingHours && !isWithinWorkingHours(nowMs)){
    if(!(nudge.allowWhenActiveOutsideHours && userIsActive())){
      return { fire:false, reason:'outside-working-hours' };
    }
  }
  if(typeof nudge.nextDueAt !== 'number') return { fire:false, reason:'not-scheduled' };
  if(nudge.nextDueAt > nowMs) return { fire:false, reason:'not-yet-due' };
  return { fire:true, reason:'ok' };
}

// Create the persisted 'triggered' event. Snapshots the active context so a
// future report can correlate nudge timing with what the user was doing.
function createNudgeTriggerEvent(nudge){
  const now = Date.now();
  const ev = {
    id: nextId('ne'),
    nudgeId: nudge.id,
    triggeredAt: now,
    response: 'triggered',   // transitions to done/snoozed/skipped/missed
    respondedAt: null,
    snoozeUntil: null,
    snoozeMinutes: null,
    timedDurationMinutes: nudge.timedDurationMinutes || null,
    activeProjectId: state.activeTimer ? state.activeTimer.projectId : null,
    activeTaskId: state.activeTimer ? state.activeTimer.taskId : null,
    activeEntryId: null,
    wasTimerRunning: !!state.activeTimer,
    wasOutsideWorkingHours: !isWithinWorkingHours(now),
    createdAt: now
  };
  state.nudgeEvents.push(ev);
  nudge.lastTriggeredAt = now;
  // Forward-schedule immediately so an unresponded popup doesn't re-fire on
  // the next tick. User actions (Done/Snooze/Skip/Start Break) overwrite this.
  scheduleNextNudge(nudge, 'fire', now);
  save();
  return ev;
}

// Returns true if the bring-to-front side-effect should be skipped for a
// nudge fire. We don't want to yank focus when the user has explicitly
// signalled "leave me alone" (presentation mode, global pause). Per-nudge
// snooze is handled upstream by shouldNudgeFire and never reaches here.
function shouldSuppressNudgeBringToFront(){
  const p = state.settings.productivity || {};
  if(p.bringToFrontForNudges === false) return true;
  if(p.presentationModeEnabled) return true;
  if(p.nudgePauseUntil && p.nudgePauseUntil > Date.now()) return true;
  return false;
}

function requestBringToFrontForNudge(){
  if(shouldSuppressNudgeBringToFront()) return;
  try { window.punch.bringToFrontForNudge(); } catch(_) {}
}

// Push the nudge into the popup (or queue it if a popup is already up).
// Previously we also queued when the app was hidden; now we ask the main
// process to restore/focus the window so the nudge is actually seen.
function deliverNudge(nudge, event){
  if(currentNudgePopup){
    pendingNudgeQueue.push({ eventId: event.id, nudgeId: nudge.id });
    return;
  }
  requestBringToFrontForNudge();
  showNudgePopup(nudge, event);
}

function flushPendingNudgeQueue(){
  if(currentNudgePopup) return;
  if(pendingNudgeQueue.length === 0) return;
  const item = pendingNudgeQueue.pop(); // newest first
  // Mark older queued items as missed and discard them — showing a stack of
  // popups in sequence would be annoying.
  for(const skipped of pendingNudgeQueue){
    const ev = state.nudgeEvents.find(e => e.id === skipped.eventId);
    if(ev && ev.response === 'triggered'){
      ev.response = 'missed';
      ev.respondedAt = Date.now();
    }
  }
  pendingNudgeQueue = [];
  const nudge = state.nudges.find(n => n.id === item.nudgeId);
  const event = state.nudgeEvents.find(e => e.id === item.eventId);
  if(nudge && event){
    requestBringToFrontForNudge();
    showNudgePopup(nudge, event);
  } else {
    save();
  }
}

// Mutate a nudge event for the user's response. Returns nothing — caller
// closes the popup.
function recordNudgeResponse(eventId, response, extras){
  const ev = state.nudgeEvents.find(e => e.id === eventId);
  if(!ev) return;
  ev.response = response;
  ev.respondedAt = Date.now();
  if(extras){
    if(extras.snoozeUntil != null) ev.snoozeUntil = extras.snoozeUntil;
    if(extras.snoozeMinutes != null) ev.snoozeMinutes = extras.snoozeMinutes;
  }
  save();
}

// The scheduler tick. Called every 60 seconds while the app is running.
function nudgeTick(){
  const now = Date.now();
  for(const nudge of state.nudges){
    const decision = shouldNudgeFire(nudge, now);
    if(!decision.fire) continue;
    const event = createNudgeTriggerEvent(nudge);
    deliverNudge(nudge, event);
    // Only fire one nudge per tick to avoid stacking popups. Others wait
    // for the next 60-second tick.
    break;
  }
}

function startNudgeScheduler(){
  if(nudgeTickInterval) return;
  attachNudgeInteractionListeners();
  nudgeTickInterval = setInterval(nudgeTick, 60 * 1000);
}

function stopNudgeScheduler(){
  if(nudgeTickInterval) clearInterval(nudgeTickInterval);
  nudgeTickInterval = null;
}

// ----- Mental break preset (auto-seed) -----

// Called once at init. If the user has never had the preset seeded, drop in a
// disabled Mental Break nudge so it's discoverable in Settings without
// triggering until the user opts in.
function maybeSeedMentalBreakNudge(){
  const p = state.settings.productivity;
  if(p.mentalBreakSeeded) return;
  const exists = state.nudges.some(n => n.id === 'nudge_mentalbreak');
  if(!exists){
    state.nudges.push(normalizeNudgeShape({
      id: 'nudge_mentalbreak',
      name: 'Mental break',
      message: 'Take a short reset before continuing.',
      category: 'Break',
      intervalMinutes: 120,
      activeDays: [1,2,3,4,5],
      activeStartTime: '09:00',
      activeEndTime: '17:00',
      defaultSnoozeMinutes: 15,
      enabled: false,
      respectWorkingHours: true,
      allowWhenActiveOutsideHours: true,
      timedDurationMinutes: 5,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));
  }
  p.mentalBreakSeeded = true;
  save();
}

// ============================================================
// PRODUCTIVITY — End-of-block divider
// ============================================================

// ============================================================
// FOCUS SIGNALS — Service (events, helpers, selectors)
// ------------------------------------------------------------
// focusEvents is the data foundation for the future Focus hub. Each event
// is a small, append-only record of something productivity-meaningful: a
// timer start/stop, a project/task switch, a logged distraction, a window
// change (only when window tracking is on), a nudge response, a daily
// closeout. Selectors below let future dashboards roll these up by day,
// project, or type without bespoke queries scattered through the codebase.
// ============================================================

// Lightweight in-memory dedup window for window_changed events. The main
// process already dedups by (app, title) key, but the renderer also guards
// against rapid duplicates in case multiple polls overlap during a settings
// change.
const FOCUS_WIN_DEDUP_MS = 5000;
let _lastFocusWindowKey = null;
let _lastFocusWindowTs = 0;

// Snapshot of the current work context. Pure read, no mutation. Used by
// recordFocusEvent and any future caller (Focus dashboard, AI summaries)
// that needs to know what was happening when something occurred.
function getActiveWorkContext(){
  const t = state.activeTimer;
  return {
    projectId: t ? t.projectId : null,
    taskId: t ? (t.taskId || null) : null,
    entryId: null,                 // entries are written on stop; no live id
    timerRunning: !!t,
    timerStartMs: t ? t.startMs : null
  };
}

// Lightweight activity probe. The Nudge service has its own
// `userIsActive()` that includes a 5-minute interaction window; this one
// is intentionally simpler so it can be called from anywhere without
// pulling in the interaction-listener setup.
function isUserActive(){
  return !!state.activeTimer;
}

// Append one focus event. context defaults to the live work context, but
// callers can pass a frozen snapshot (e.g. End Day commit reads the
// pre-stop state). Failures here must never break the primary action that
// triggered the event — wrap in try/catch at every call site if needed.
function recordFocusEvent(type, context, metadata){
  try {
    const ctx = context || getActiveWorkContext();
    const ev = {
      id: nextId('fe'),
      type,
      ts: Date.now(),
      projectId: ctx.projectId || null,
      taskId: ctx.taskId || null,
      entryId: ctx.entryId || null,
      appName: ctx.appName || null,
      windowTitle: ctx.windowTitle || null,
      source: ctx.source || 'automatic',
      note: ctx.note || '',
      metadata: metadata || {},
      createdAt: Date.now()
    };
    state.focusEvents.push(ev);
    // Bound the log to keep punch-data.json from ballooning. 10k events ≈
    // months of normal use; older events drop off the front.
    if(state.focusEvents.length > 10000){
      state.focusEvents.splice(0, state.focusEvents.length - 10000);
    }
    save();
    return ev;
  } catch(err){
    console.warn('[focus] recordFocusEvent failed', err);
    return null;
  }
}

// ----- Selectors (pure) -----

function getFocusEventsForRange(startMs, endMs){
  return state.focusEvents.filter(e => e.ts >= startMs && e.ts < endMs);
}
function getFocusEventsForDate(dateMs){
  const { start, end } = dayWindow(dateMs);
  return getFocusEventsForRange(start, end);
}
function getDistractionsForDate(dateMs){
  return getFocusEventsForDate(dateMs).filter(e => e.type === 'distraction_logged');
}
function getTaskSwitchesForDate(dateMs){
  return getFocusEventsForDate(dateMs).filter(e => e.type === 'task_switched');
}
function getProjectSwitchesForDate(dateMs){
  return getFocusEventsForDate(dateMs).filter(e => e.type === 'project_switched');
}
function getWindowActivityForDate(dateMs){
  return getFocusEventsForDate(dateMs).filter(e => e.type === 'window_changed');
}
function getSuggestedFocusHistory(rangeStartMs, rangeEndMs){
  const events = getFocusEventsForRange(rangeStartMs, rangeEndMs);
  return events.filter(e =>
    e.type === 'suggested_focus_shown' ||
    e.type === 'suggested_focus_accepted' ||
    e.type === 'suggested_focus_dismissed'
  );
}

// Day-level rollup used by the Insights Attention Drift card and any
// future closeout/AI summary that wants a single object summarizing
// drift signals. Distraction metrics come from automated activity-rule
// matching (calculateActivityBlocks) rather than manual log events.
function getAttentionDriftSummary(rangeStartMs, rangeEndMs){
  const events = getFocusEventsForRange(rangeStartMs, rangeEndMs);
  const counts = {
    projectSwitches: 0,
    taskSwitches: 0,
    windowChanges: 0,
    nudgesDone: 0, nudgesSnoozed: 0, nudgesSkipped: 0,
    suggestedShown: 0, suggestedAccepted: 0, suggestedDismissed: 0
  };
  for(const e of events){
    switch(e.type){
      case 'project_switched': counts.projectSwitches++; break;
      case 'task_switched': counts.taskSwitches++; break;
      case 'window_changed': counts.windowChanges++; break;
      case 'nudge_done': counts.nudgesDone++; break;
      case 'nudge_snoozed': counts.nudgesSnoozed++; break;
      case 'nudge_skipped': counts.nudgesSkipped++; break;
      case 'suggested_focus_shown': counts.suggestedShown++; break;
      case 'suggested_focus_accepted': counts.suggestedAccepted++; break;
      case 'suggested_focus_dismissed': counts.suggestedDismissed++; break;
    }
  }
  // Automated distraction metrics from activity-rule-matched blocks.
  const distrBlocks = calculateActivityBlocks({ startMs: rangeStartMs, endMs: rangeEndMs })
    .filter(b => b.category === 'Distraction');
  const distractionMs = distrBlocks.reduce((sum, b) => sum + b.durationMs, 0);
  return {
    ...counts,
    distractionMs,
    distractionBlocks: distrBlocks.length
  };
}

// Dedup gate used by window-tracking event ingress. The same (app, title)
// landing twice within the dedup window is ignored.
function focusWindowChangeIsDuplicate(appName, windowTitle){
  const key = `${appName || ''}::${windowTitle || ''}`;
  const now = Date.now();
  if(key === _lastFocusWindowKey && now - _lastFocusWindowTs < FOCUS_WIN_DEDUP_MS){
    return true;
  }
  _lastFocusWindowKey = key;
  _lastFocusWindowTs = now;
  return false;
}

// ============================================================
// FOCUS SIGNALS — Distraction logger
// ============================================================
const DISTRACTION_TYPES = [
  'Interrupted',
  'Switched tasks',
  'Fire drill',
  'Waiting / blocker',
  'Forgot what I was doing',
  'Meeting / presentation',
  'Personal',
  'Other'
];
let _selectedDistractionType = null;

function openDistractionModal(){
  _selectedDistractionType = DISTRACTION_TYPES[0];
  // Context strip: show what currently links to this distraction so the
  // user understands what it'll be tagged against.
  const ctxEl = document.getElementById('distractionContext');
  const t = state.activeTimer;
  if(t){
    const p = getProject(t.projectId);
    const task = t.taskId ? getTask(t.taskId) : null;
    const projName = p ? p.name : '(deleted project)';
    const tail = task ? ` → ${esc(task.name)}` : '';
    ctxEl.innerHTML = `<span class="distraction-context-dot"></span>Tagging against: <strong>${esc(projName)}</strong>${tail}`;
    ctxEl.classList.remove('hidden');
  } else {
    ctxEl.innerHTML = `<span class="distraction-context-dot off"></span>No active timer — distraction will log without a project/task.`;
    ctxEl.classList.remove('hidden');
  }
  // Type chips
  const wrap = document.getElementById('distractionTypes');
  wrap.innerHTML = DISTRACTION_TYPES.map((d, i) => `
    <button class="distraction-chip${i===0?' selected':''}" data-distraction-type="${esc(d)}">${esc(d)}</button>
  `).join('');
  wrap.querySelectorAll('[data-distraction-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      _selectedDistractionType = btn.dataset.distractionType;
      wrap.querySelectorAll('.distraction-chip').forEach(x => x.classList.toggle('selected', x === btn));
    });
  });
  document.getElementById('distractionNote').value = '';
  openModal('distractionModal');
  setTimeout(() => document.getElementById('distractionNote').focus(), 50);
}

function saveDistractionFromModal(){
  const type = _selectedDistractionType || 'Other';
  const note = document.getElementById('distractionNote').value.trim();
  const ctx = { ...getActiveWorkContext(), source: 'manual', note };
  recordFocusEvent('distraction_logged', ctx, { distractionType: type });
  closeModal('distractionModal');
  toast(`Distraction logged: ${type}`);
}

// ============================================================
// FOCUS v1 — Activity Rules + Duration Calculation
// ------------------------------------------------------------
// Rules are user-defined patterns that classify a (appName, windowTitle)
// pair into a category (Work / Communication / Distraction / Utility /
// Break / Custom). They drive the Focus tab's labels, the distraction
// rollup, and the unlogged-work-detection prompts.
// ============================================================

const ACTIVITY_CATEGORIES = ['Work','Communication','Distraction','Utility','Break','Custom','Unknown'];
const ACTIVITY_GAP_CAP_MS = 5 * 60 * 1000;       // any silence ≥ 5min is treated as inactivity, not "still in app"

// Substring match, case-insensitive. Empty/missing pattern matches everything.
function _patternMatches(pattern, value){
  if(!pattern) return true;
  if(!value) return false;
  return value.toLowerCase().includes(String(pattern).toLowerCase());
}

// Find the first enabled rule whose match criteria fit. Returns null if
// no rule matches; callers can treat that as category=Unknown.
function matchActivityRule(appName, windowTitle){
  if(!state.settings.focus || state.settings.focus.enableActivityRules === false) return null;
  const rules = (state.activityRules || []).filter(r => r.enabled !== false);
  for(const r of rules){
    let matches = false;
    if(r.matchType === 'appName'){
      matches = _patternMatches(r.appNamePattern, appName);
    } else if(r.matchType === 'windowTitle'){
      matches = _patternMatches(r.windowTitlePattern, windowTitle);
    } else { // appAndTitle (default)
      matches = _patternMatches(r.appNamePattern, appName) && _patternMatches(r.windowTitlePattern, windowTitle);
    }
    if(matches) return r;
  }
  return null;
}

function classifyWindowActivity(appName, windowTitle){
  const rule = matchActivityRule(appName, windowTitle);
  if(rule){
    return {
      label: rule.label || rule.name || appName,
      category: rule.category || 'Custom',
      ruleId: rule.id,
      rule
    };
  }
  return {
    label: appName || 'Unknown',
    category: 'Unknown',
    ruleId: null,
    rule: null
  };
}

// Pair window_changed events with their next-event boundary to derive a
// duration per "block". Gaps beyond gapCapMinutes get clipped — that's
// where the user walked away (the next OS-idle interval will have
// captured it separately). Idle blocks are also subtracted: any
// idle_started/idle_ended pair that falls inside a window block reduces
// its credit. Returns array of { start, end, durationMs, appName,
// windowTitle, label, category, ruleId, timerRunning, projectId, taskId }.
function calculateActivityBlocks({ startMs, endMs, gapCapMs } = {}){
  const cap = gapCapMs || ACTIVITY_GAP_CAP_MS;
  const rangeStart = startMs || 0;
  const rangeEnd = endMs || Date.now();
  // Events in range, sorted ascending by ts.
  const events = state.focusEvents
    .filter(e => e.ts >= rangeStart && e.ts <= rangeEnd)
    .slice()
    .sort((a,b) => a.ts - b.ts);
  // Build idle intervals for subtraction.
  const idleIntervals = [];
  let openIdle = null;
  for(const e of events){
    if(e.type === 'idle_started') openIdle = { start: e.ts, end: null };
    else if(e.type === 'idle_ended'){
      if(openIdle){ openIdle.end = e.ts; idleIntervals.push(openIdle); openIdle = null; }
      else idleIntervals.push({ start: rangeStart, end: e.ts });
    }
  }
  if(openIdle){ openIdle.end = rangeEnd; idleIntervals.push(openIdle); }

  function overlapMs(blockStart, blockEnd, intervals){
    let total = 0;
    for(const i of intervals){
      const s = Math.max(blockStart, i.start);
      const e = Math.min(blockEnd, i.end);
      if(e > s) total += (e - s);
    }
    return total;
  }

  const wins = events.filter(e => e.type === 'window_changed');
  const blocks = [];
  for(let i = 0; i < wins.length; i++){
    const cur = wins[i];
    const nextTs = (i + 1 < wins.length) ? wins[i+1].ts : rangeEnd;
    const rawDuration = nextTs - cur.ts;
    const duration = Math.min(rawDuration, cap);
    if(duration <= 0) continue;
    const blockEnd = cur.ts + duration;
    const idle = overlapMs(cur.ts, blockEnd, idleIntervals);
    const credited = duration - idle;
    if(credited <= 1000) continue;            // <1s after idle subtraction → drop
    const cls = classifyWindowActivity(cur.appName, cur.windowTitle);
    blocks.push({
      start: cur.ts,
      end: blockEnd,
      durationMs: credited,
      appName: cur.appName,
      windowTitle: cur.windowTitle,
      label: cls.label,
      category: cls.category,
      ruleId: cls.ruleId,
      timerRunning: !!cur.metadata?.timerRunning || !!cur.timerRunning,
      projectId: cur.projectId || null,
      taskId: cur.taskId || null
    });
  }
  return blocks;
}

// Roll up blocks by a chosen key. groupBy: 'app' | 'label' | 'category' | 'rule'.
function rollupBlocks(blocks, groupBy){
  const out = new Map();
  for(const b of blocks){
    let key, name, category, ruleId;
    if(groupBy === 'category'){ key = b.category; name = b.category; category = b.category; }
    else if(groupBy === 'rule'){ key = b.ruleId || `_app:${b.appName}`; name = b.label; category = b.category; ruleId = b.ruleId; }
    else if(groupBy === 'app'){ key = b.appName || '(unknown)'; name = b.appName || 'Unknown'; category = b.category; }
    else { key = b.label; name = b.label; category = b.category; ruleId = b.ruleId; }
    const e = out.get(key) || { key, name, category, ruleId, durationMs: 0, blocks: 0, timerOverlapMs: 0 };
    e.durationMs += b.durationMs;
    e.blocks += 1;
    if(b.timerRunning) e.timerOverlapMs += b.durationMs;
    out.set(key, e);
  }
  return [...out.values()].sort((a,b) => b.durationMs - a.durationMs);
}

function getAppSiteUsageForRange(startMs, endMs, groupBy){
  const blocks = calculateActivityBlocks({ startMs, endMs });
  return rollupBlocks(blocks, groupBy || 'label');
}

function getTopDistractionsForRange(startMs, endMs){
  const blocks = calculateActivityBlocks({ startMs, endMs })
    .filter(b => b.category === 'Distraction');
  return rollupBlocks(blocks, 'label');
}

// Intentional break rollup. Drives the Focus "Intentional breaks" card and
// any future closeout/AI summary that wants a single object describing how
// many timed-break nudges the user actually completed. Reads focusEvents
// directly so it picks up history from before this helper existed.
function getTimedBreakSummaryForRange(startMs, endMs){
  const out = {
    completed: 0,
    skipped: 0,
    snoozed: 0,
    plannedMinutes: 0,
    actualMinutes: 0
  };
  for(const e of state.focusEvents){
    if(e.ts < startMs || e.ts > endMs) continue;
    if(e.type === 'timed_break_completed'){
      out.completed++;
      out.plannedMinutes += (e.metadata && e.metadata.plannedDurationMinutes) || 0;
      out.actualMinutes  += (e.metadata && e.metadata.actualDurationMinutes) || 0;
    } else if(e.type === 'timed_break_skipped'){
      out.skipped++;
    } else if(e.type === 'timed_break_snoozed'){
      out.snoozed++;
    }
  }
  return out;
}

// Idle summary: total idle time + longest idle block + how much of the
// idle overlapped a running timer (a strong signal the user forgot to
// stop the clock).
function getIdleSummaryForRange(startMs, endMs){
  const events = state.focusEvents
    .filter(e => e.ts >= startMs && e.ts <= endMs)
    .sort((a,b) => a.ts - b.ts);
  const idleIntervals = [];
  let openIdle = null;
  for(const e of events){
    if(e.type === 'idle_started') openIdle = { start: e.ts, end: null, timerRunningAtStart: !!e.metadata?.timerRunning };
    else if(e.type === 'idle_ended'){
      if(openIdle){ openIdle.end = e.ts; idleIntervals.push(openIdle); openIdle = null; }
    }
  }
  if(openIdle){ openIdle.end = endMs; idleIntervals.push(openIdle); }

  // Compute timer-during-idle overlap from the entry/timer history.
  function durationDuringTimers(blockStart, blockEnd){
    let total = 0;
    // Closed entries that overlap the block
    for(const ent of state.entries){
      const s = Math.max(blockStart, ent.startMs);
      const e = Math.min(blockEnd, ent.endMs);
      if(e > s) total += (e - s);
    }
    // Live active timer
    if(state.activeTimer){
      const s = Math.max(blockStart, state.activeTimer.startMs);
      const e = Math.min(blockEnd, Date.now());
      if(e > s) total += (e - s);
    }
    return total;
  }

  let total = 0, longest = 0, timerOverlap = 0;
  for(const i of idleIntervals){
    const d = i.end - i.start;
    total += d;
    if(d > longest) longest = d;
    timerOverlap += durationDuringTimers(i.start, i.end);
  }
  return {
    totalMs: total,
    longestMs: longest,
    blockCount: idleIntervals.length,
    timerDuringIdleMs: timerOverlap
  };
}

// Longest uninterrupted activity block in a category. Used by Attention
// Drift link on Focus.
function getLongestUninterruptedBlock(startMs, endMs, category){
  const blocks = calculateActivityBlocks({ startMs, endMs });
  const filtered = category ? blocks.filter(b => b.category === category) : blocks;
  return filtered.reduce((max, b) => b.durationMs > (max?.durationMs || 0) ? b : max, null);
}

function formatDurationMs(ms){
  if(ms < 60000) return `${Math.round(ms/1000)}s`;
  const totalMin = Math.round(ms/60000);
  if(totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin/60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ============================================================
// FOCUS v1 — Tab renderers
// ============================================================
let _focusRange = 'today';

function focusRangeWindow(){
  const now = Date.now();
  if(_focusRange === 'thisWeek'){
    return { start: startOfWeek(now), end: now };
  }
  return { start: startOfDay(now), end: now };
}

function getFocusSummaryForRange(startMs, endMs){
  const blocks = calculateActivityBlocks({ startMs, endMs });
  let active = 0, work = 0, comm = 0, distract = 0, util = 0, brk = 0, unknown = 0;
  for(const b of blocks){
    active += b.durationMs;
    if(b.category === 'Work') work += b.durationMs;
    else if(b.category === 'Communication') comm += b.durationMs;
    else if(b.category === 'Distraction') distract += b.durationMs;
    else if(b.category === 'Utility') util += b.durationMs;
    else if(b.category === 'Break') brk += b.durationMs;
    else unknown += b.durationMs;
  }
  const idle = getIdleSummaryForRange(startMs, endMs);
  // Unlogged detected count: events of type unlogged_work_detected in range.
  const unloggedDetectedCount = state.focusEvents.filter(e =>
    e.type === 'unlogged_work_detected' && e.ts >= startMs && e.ts <= endMs
  ).length;
  const unloggedLogged = state.focusEvents.filter(e =>
    e.type === 'unlogged_work_logged' && e.ts >= startMs && e.ts <= endMs
  );
  let unloggedLoggedMs = 0;
  for(const e of unloggedLogged) unloggedLoggedMs += (e.metadata?.durationMs || 0);
  // Traction score: (work + communication) / active. Null if active is tiny.
  const tractionScore = active > 60000
    ? Math.round(((work + comm) / active) * 100)
    : null;
  return {
    activeMs: active,
    workMs: work,
    communicationMs: comm,
    distractionMs: distract,
    utilityMs: util,
    breakMs: brk,
    unknownMs: unknown,
    idle,
    unloggedDetectedCount,
    unloggedLoggedMs,
    tractionScore
  };
}

function renderFocusTab(){
  renderFocusSummary();
  renderAppSiteUsage();
  renderTopDistractions();
  renderIdleSummary();
  renderFocusSuggested();
  renderIntentionalBreaks();
  renderRecentFocusEvents();
  // Range subtitle
  const lbl = document.getElementById('focusRangeLabel');
  if(lbl){
    const { start, end } = focusRangeWindow();
    const sd = new Date(start).toLocaleDateString();
    const ed = new Date(end).toLocaleDateString();
    lbl.textContent = sd === ed ? sd : `${sd} → ${ed}`;
  }
}

function renderFocusSummary(){
  const wrap = document.getElementById('focusSummary');
  if(!wrap) return;
  const { start, end } = focusRangeWindow();
  const s = getFocusSummaryForRange(start, end);
  const cells = [
    { label: 'Active', value: formatDurationMs(s.activeMs), sub: 'detected attention time' },
    { label: 'Work', value: formatDurationMs(s.workMs), sub: '', cls: 'work' },
    { label: 'Distraction', value: formatDurationMs(s.distractionMs), sub: '', cls: 'distraction' },
    { label: 'Idle', value: formatDurationMs(s.idle.totalMs), sub: s.idle.timerDuringIdleMs > 0 ? `${formatDurationMs(s.idle.timerDuringIdleMs)} during a timer` : '', cls: 'idle' },
    { label: 'Unlogged', value: String(s.unloggedDetectedCount), sub: s.unloggedLoggedMs > 0 ? `${formatDurationMs(s.unloggedLoggedMs)} recovered` : 'detected prompts', cls: 'unlogged' },
    { label: 'Traction', value: s.tractionScore != null ? `${s.tractionScore}%` : '—', sub: 'work + comm / active', cls: 'score' }
  ];
  wrap.innerHTML = cells.map(c => `
    <div class="focus-summary-cell">
      <div class="focus-summary-label">${esc(c.label)}</div>
      <div class="focus-summary-value ${c.cls || ''}">${esc(c.value)}</div>
      ${c.sub ? `<div class="focus-summary-sub">${esc(c.sub)}</div>` : ''}
    </div>
  `).join('');
}

function categoryCss(cat){
  return (cat || 'unknown').toLowerCase();
}

function renderUsageList(targetId, rows, totalMs){
  const wrap = document.getElementById(targetId);
  if(!wrap) return;
  if(!rows.length){
    wrap.innerHTML = '<div class="empty" style="padding:10px 0">No data yet for this range.</div>';
    return;
  }
  const max = Math.max(1, totalMs || rows[0].durationMs);
  wrap.innerHTML = rows.slice(0, 8).map(r => {
    const pct = Math.max(2, Math.round((r.durationMs / max) * 100));
    const catKey = categoryCss(r.category);
    const timerTag = r.timerOverlapMs > 0
      ? `<span class="focus-usage-timer-tag" title="time during a running timer">⏱ ${formatDurationMs(r.timerOverlapMs)}</span>`
      : '';
    return `
      <div class="focus-usage-row">
        <div class="focus-usage-head">
          <span class="focus-usage-label">${esc(r.name)}</span>
          <span class="focus-usage-cat ${catKey}">${esc(r.category)}</span>
        </div>
        <div class="focus-usage-time">${esc(formatDurationMs(r.durationMs))}${timerTag}</div>
        <div class="focus-usage-bar"><div class="focus-usage-bar-fill ${catKey}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

function renderAppSiteUsage(){
  const { start, end } = focusRangeWindow();
  const rows = getAppSiteUsageForRange(start, end, 'label');
  const total = rows.reduce((s, r) => s + r.durationMs, 0);
  renderUsageList('focusAppUsage', rows, total);
}

function renderTopDistractions(){
  const wrap = document.getElementById('focusDistractions');
  if(!wrap) return;
  const hasDistractionRules = (state.activityRules || [])
    .some(r => r.enabled !== false && r.category === 'Distraction');
  if(!hasDistractionRules){
    wrap.innerHTML = '<div class="empty" style="padding:10px 0">No distraction rules yet. Add rules for apps like YouTube, Reddit, or social media in <strong>Settings → Focus Tools → Activity Rules</strong> to track distraction time automatically.</div>';
    return;
  }
  const { start, end } = focusRangeWindow();
  const rows = getTopDistractionsForRange(start, end);
  if(!rows.length){
    wrap.innerHTML = '<div class="empty" style="padding:10px 0">No matched distractions for this range.</div>';
    return;
  }
  const totalMs = rows.reduce((s, r) => s + r.durationMs, 0);
  const maxMs = Math.max(1, totalMs);
  wrap.innerHTML = rows.slice(0, 8).map(r => {
    const barPct = Math.max(2, Math.round((r.durationMs / maxMs) * 100));
    const blockLabel = `${r.blocks} block${r.blocks !== 1 ? 's' : ''}`;
    return `
      <div class="focus-usage-row">
        <div class="focus-usage-head">
          <span class="focus-usage-label">${esc(r.name)}</span>
          <span class="focus-usage-cat distraction">Distraction</span>
        </div>
        <div class="focus-usage-time">${esc(formatDurationMs(r.durationMs))} <span class="focus-distraction-meta">${esc(blockLabel)}</span></div>
        <div class="focus-usage-bar"><div class="focus-usage-bar-fill distraction" style="width:${barPct}%"></div></div>
      </div>`;
  }).join('');
}

function renderIdleSummary(){
  const wrap = document.getElementById('focusIdle');
  if(!wrap) return;
  const { start, end } = focusRangeWindow();
  const idle = getIdleSummaryForRange(start, end);
  if(idle.blockCount === 0){
    wrap.innerHTML = '<div class="empty" style="padding:10px 0">No idle blocks detected. (Idle detection runs while the app is open.)</div>';
    return;
  }
  let html = `
    <div class="focus-idle-row"><span class="focus-idle-label">Total idle</span><span class="focus-idle-value">${esc(formatDurationMs(idle.totalMs))}</span></div>
    <div class="focus-idle-row"><span class="focus-idle-label">Longest idle block</span><span class="focus-idle-value">${esc(formatDurationMs(idle.longestMs))}</span></div>
    <div class="focus-idle-row"><span class="focus-idle-label">Idle blocks</span><span class="focus-idle-value">${idle.blockCount}</span></div>
  `;
  if(idle.timerDuringIdleMs > 0){
    html += `<div class="focus-idle-warning">⚠ Timer was running during ${esc(formatDurationMs(idle.timerDuringIdleMs))} of idle time. Consider trimming those entries.</div>`;
  }
  wrap.innerHTML = html;
}

function renderIntentionalBreaks(){
  const wrap = document.getElementById('focusBreaks');
  if(!wrap) return;
  const { start, end } = focusRangeWindow();
  const s = getTimedBreakSummaryForRange(start, end);
  if(s.completed === 0 && s.skipped === 0 && s.snoozed === 0){
    wrap.innerHTML = '<div class="empty" style="padding:10px 0">No timed breaks yet for this range. Set a nudge\'s type to <strong>Timed break</strong> in Settings → Workspace Setup → Nudges to track intentional resets.</div>';
    return;
  }
  const resetMs = s.actualMinutes * 60000;
  const cells = [
    { label: 'Completed', value: String(s.completed) },
    { label: 'Reset time', value: resetMs > 0 ? formatDurationMs(resetMs) : '0m' },
    { label: 'Skipped',   value: String(s.skipped) },
    { label: 'Snoozed',   value: String(s.snoozed) }
  ];
  wrap.innerHTML = cells.map(c => `
    <div class="focus-summary-cell">
      <div class="focus-summary-label">${esc(c.label)}</div>
      <div class="focus-summary-value">${esc(c.value)}</div>
    </div>
  `).join('');
}

function renderFocusSuggested(){
  const wrap = document.getElementById('focusSuggested');
  if(!wrap) return;
  const s = buildSuggestedFocus(Date.now());
  if(!s){
    wrap.innerHTML = '<div class="empty" style="padding:10px 0">All clear — no priority surfaced right now.</div>';
    return;
  }
  const project = s.projectId ? getProject(s.projectId) : null;
  const task = s.taskId ? getTask(s.taskId) : null;
  wrap.innerHTML = `
    <div class="suggested-focus-body">
      <div class="suggested-focus-title">${esc(project ? project.name : 'Suggested')}${task ? ` <span class="suggested-focus-task">${esc(task.name)}</span>` : ''}</div>
      <div class="suggested-focus-reason">${esc(s.reason)}</div>
      <div class="suggested-focus-move"><strong>Next:</strong> ${esc(s.firstMove)}</div>
    </div>`;
}

function renderRecentFocusEvents(){
  const wrap = document.getElementById('focusRecent');
  if(!wrap) return;
  const { start, end } = focusRangeWindow();
  const events = state.focusEvents
    .filter(e => e.ts >= start && e.ts <= end)
    .slice(-20)
    .reverse();
  if(!events.length){
    wrap.innerHTML = '<div class="empty" style="padding:10px 0">No focus events captured yet for this range.</div>';
    return;
  }
  wrap.innerHTML = events.map(e => {
    const time = formatTimeOfDay(e.ts);
    const detail = buildFocusEventDetail(e);
    return `
      <div class="focus-recent-row">
        <div class="focus-recent-time">${esc(time)}</div>
        <div class="focus-recent-type">${esc(e.type.replace(/_/g, ' '))}</div>
        <div class="focus-recent-detail">${detail}</div>
      </div>`;
  }).join('');
}

// ============================================================
// FOCUS v1 — Activity Rules manager (Settings → Focus Tools)
// ============================================================
let _editingRuleId = null;

function renderActivityRulesList(){
  const wrap = document.getElementById('activityRulesList');
  if(!wrap) return;
  const rules = state.activityRules || [];
  if(!rules.length){
    wrap.innerHTML = '<div class="empty" style="padding:12px">No rules yet. Add one above, or use "Seed common distraction rules" to start.</div>';
    return;
  }
  wrap.innerHTML = rules.map(r => {
    const desc = [];
    if(r.matchType === 'appName') desc.push(`app: <code>${esc(r.appNamePattern || '*')}</code>`);
    else if(r.matchType === 'windowTitle') desc.push(`title: <code>${esc(r.windowTitlePattern || '*')}</code>`);
    else desc.push(`app: <code>${esc(r.appNamePattern || '*')}</code> + title: <code>${esc(r.windowTitlePattern || '*')}</code>`);
    if(r.promptToLog) desc.push(`prompts after ${r.promptAfterMinutes || 30}m`);
    return `
      <div class="activity-rule-row">
        <div class="activity-rule-head">
          <div class="activity-rule-name">${esc(r.label || r.name)} <span class="focus-usage-cat ${categoryCss(r.category)}">${esc(r.category || 'Custom')}</span></div>
          <div class="activity-rule-meta">${desc.join(' · ')}</div>
        </div>
        <label class="checkbox" title="Enabled">
          <input type="checkbox" data-rule-toggle="${esc(r.id)}" ${r.enabled !== false ? 'checked' : ''} />
          <span></span>
        </label>
        <button class="icon-btn" data-rule-edit="${esc(r.id)}" title="Edit">✎</button>
      </div>`;
  }).join('');
  wrap.querySelectorAll('[data-rule-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const r = state.activityRules.find(x => x.id === cb.dataset.ruleToggle);
      if(!r) return;
      r.enabled = cb.checked;
      r.updatedAt = Date.now();
      save();
    });
  });
  wrap.querySelectorAll('[data-rule-edit]').forEach(btn => {
    btn.addEventListener('click', () => openActivityRuleModal(btn.dataset.ruleEdit));
  });
}

function openActivityRuleModal(ruleId){
  _editingRuleId = ruleId || null;
  const r = ruleId ? state.activityRules.find(x => x.id === ruleId) : null;
  document.getElementById('activityRuleModalTitle').textContent = r ? 'Edit activity rule' : 'New activity rule';
  document.getElementById('ruleNameInput').value = r ? (r.name || '') : '';
  document.getElementById('ruleMatchType').value = r ? (r.matchType || 'appAndTitle') : 'appAndTitle';
  document.getElementById('ruleCategory').value = r ? (r.category || 'Work') : 'Work';
  document.getElementById('ruleAppPattern').value = r ? (r.appNamePattern || '') : '';
  document.getElementById('ruleTitlePattern').value = r ? (r.windowTitlePattern || '') : '';
  document.getElementById('ruleLabelInput').value = r ? (r.label || '') : '';
  renderProjectOptions(document.getElementById('ruleDefaultProject'), r ? r.defaultProjectId : null, true);
  renderSubcatOptions(document.getElementById('ruleDefaultSubcat'), r ? r.defaultProjectId : null, r ? r.defaultSubcategoryId : null);
  document.getElementById('rulePromptToLog').checked = !!(r && r.promptToLog);
  document.getElementById('rulePromptAfter').value = r ? (r.promptAfterMinutes || '') : '';
  document.getElementById('ruleEnabled').checked = r ? (r.enabled !== false) : true;
  document.getElementById('btnDeleteRuleAdmin').style.display = r ? '' : 'none';
  openModal('activityRuleModal');
  setTimeout(() => document.getElementById('ruleNameInput').focus(), 50);
}

function saveActivityRuleFromModal(){
  const now = Date.now();
  const data = {
    name: document.getElementById('ruleNameInput').value.trim() || 'Untitled rule',
    matchType: document.getElementById('ruleMatchType').value || 'appAndTitle',
    category: document.getElementById('ruleCategory').value || 'Custom',
    appNamePattern: document.getElementById('ruleAppPattern').value.trim(),
    windowTitlePattern: document.getElementById('ruleTitlePattern').value.trim(),
    label: document.getElementById('ruleLabelInput').value.trim(),
    defaultProjectId: document.getElementById('ruleDefaultProject').value || null,
    defaultSubcategoryId: document.getElementById('ruleDefaultSubcat').value || null,
    promptToLog: document.getElementById('rulePromptToLog').checked,
    promptAfterMinutes: parseInt(document.getElementById('rulePromptAfter').value, 10) || null,
    enabled: document.getElementById('ruleEnabled').checked,
    updatedAt: now
  };
  if(!data.label) data.label = data.name;
  if(_editingRuleId){
    const r = state.activityRules.find(x => x.id === _editingRuleId);
    if(r) Object.assign(r, data);
  } else {
    state.activityRules.push({ id: nextId('ar'), createdAt: now, ...data });
  }
  save();
  renderActivityRulesList();
  closeModal('activityRuleModal');
  toast(_editingRuleId ? 'Rule updated' : 'Rule added');
  _editingRuleId = null;
}

function deleteActivityRuleFromModal(){
  if(!_editingRuleId) return;
  if(!confirm('Delete this activity rule? Historical focusEvents will keep the old label they were classified under at the time.')) return;
  state.activityRules = state.activityRules.filter(x => x.id !== _editingRuleId);
  save();
  renderActivityRulesList();
  closeModal('activityRuleModal');
  toast('Rule deleted');
  _editingRuleId = null;
}

function seedCommonDistractionRules(){
  const now = Date.now();
  const presets = [
    { name: 'YouTube', label: 'YouTube', matchType: 'windowTitle', windowTitlePattern: 'YouTube', category: 'Distraction' },
    { name: 'Reddit', label: 'Reddit', matchType: 'windowTitle', windowTitlePattern: 'Reddit', category: 'Distraction' },
    { name: 'Twitter / X', label: 'Twitter / X', matchType: 'windowTitle', windowTitlePattern: '(X) ', category: 'Distraction' },
    { name: 'Facebook', label: 'Facebook', matchType: 'windowTitle', windowTitlePattern: 'Facebook', category: 'Distraction' },
    { name: 'Instagram', label: 'Instagram', matchType: 'windowTitle', windowTitlePattern: 'Instagram', category: 'Distraction' },
    { name: 'TikTok', label: 'TikTok', matchType: 'windowTitle', windowTitlePattern: 'TikTok', category: 'Distraction' }
  ];
  let added = 0;
  for(const p of presets){
    // Don't add if a rule with the same label already exists.
    if((state.activityRules || []).some(r => (r.label || '').toLowerCase() === p.label.toLowerCase())) continue;
    state.activityRules.push({
      id: nextId('ar'),
      ...p,
      appNamePattern: '',
      enabled: true,
      promptToLog: false,
      promptAfterMinutes: null,
      createdAt: now,
      updatedAt: now
    });
    added++;
  }
  save();
  renderActivityRulesList();
  toast(added > 0 ? `Added ${added} rule${added === 1 ? '' : 's'}` : 'All presets already exist');
}

// ============================================================
// FOCUS v1 — Unlogged Work Detection
// ------------------------------------------------------------
// Every minute, examine the trailing window-changed events and look for
// a continuous run on the same activity label that:
//   1. matches a rule with promptToLog=true (or default behaviour for
//      Work/Communication categories)
//   2. ran for at least promptAfterMinutes (or default 30)
//   3. has no PUNCH timer overlapping
//   4. is not currently idle
//   5. hasn't been prompted for in this same block already
// If all hold, surface the Unlogged Work modal. Respect global pause /
// presentation mode like the nudge bring-to-front guard.
// ============================================================
let unloggedWorkTickInterval = null;
let currentUnloggedPrompt = null;   // { ruleId, label, blockStartMs, blockEndMs, durationMs }
// Map<key, lastPromptedMs> where key = `${ruleId||label}::${blockStartMs}`.
const _unloggedSuppress = new Map();
// Per-rule "snoozed until" map. ruleId/label -> ms.
const _unloggedSnoozeUntil = new Map();

function unloggedDetectionShouldSuppress(){
  // Respect presentation/pause like other foreground-stealers.
  if(nudgesGloballyPaused && typeof nudgesGloballyPaused === 'function' && nudgesGloballyPaused()) return true;
  return false;
}

function findCurrentActivityBlock(){
  // Walk window_changed events backward, grouping the trailing run that
  // shares the same classification label.
  const wins = state.focusEvents.filter(e => e.type === 'window_changed');
  if(wins.length === 0) return null;
  const last = wins[wins.length - 1];
  const lastCls = classifyWindowActivity(last.appName, last.windowTitle);
  if(!lastCls.label) return null;
  // Walk back while the same label persists.
  let blockStart = last.ts;
  let firstWin = last;
  for(let i = wins.length - 2; i >= 0; i--){
    const w = wins[i];
    const cls = classifyWindowActivity(w.appName, w.windowTitle);
    if(cls.label === lastCls.label && cls.ruleId === lastCls.ruleId){
      blockStart = w.ts;
      firstWin = w;
      continue;
    }
    break;
  }
  return {
    label: lastCls.label,
    category: lastCls.category,
    ruleId: lastCls.ruleId,
    rule: lastCls.rule,
    appName: last.appName,
    windowTitle: last.windowTitle,
    blockStartMs: blockStart,
    blockEndMs: Date.now(),
    durationMs: Date.now() - blockStart,
    firstWinEventId: firstWin.id
  };
}

function timerOverlapsBlock(block){
  // Closed entries
  for(const e of state.entries){
    if(e.endMs > block.blockStartMs && e.startMs < block.blockEndMs) return true;
  }
  if(state.activeTimer){
    if(state.activeTimer.startMs < block.blockEndMs) return true;
  }
  return false;
}

function userIsIdleNow(){
  // Look at the most recent idle_started/idle_ended pair — if started
  // more recently than ended (or no end yet), user is currently idle.
  let lastStart = 0, lastEnd = 0;
  for(const e of state.focusEvents){
    if(e.type === 'idle_started') lastStart = Math.max(lastStart, e.ts);
    else if(e.type === 'idle_ended') lastEnd = Math.max(lastEnd, e.ts);
  }
  return lastStart > lastEnd;
}

function tickUnloggedWorkDetection(){
  const f = state.settings.focus || {};
  if(f.enableUnloggedWorkDetection === false) return;
  if(currentUnloggedPrompt) return;             // a prompt is already open
  if(state.activeTimer) return;                 // timer running → nothing to detect
  if(unloggedDetectionShouldSuppress()) return;
  if(userIsIdleNow()) return;
  const block = findCurrentActivityBlock();
  if(!block) return;
  // Skip Distraction / Unknown unless explicitly opted-in. v1 keeps it
  // strict: only categories that look like real work.
  if(block.category !== 'Work' && block.category !== 'Communication') return;
  // Require an explicit promptToLog flag on the rule OR the global default
  // for any work/communication rule.
  const rule = block.rule;
  if(rule && rule.promptToLog === false) return;
  // Threshold: rule's setting wins if present, else global default.
  const thresholdMin = (rule && rule.promptAfterMinutes) || f.defaultUnloggedPromptMinutes || 30;
  if(block.durationMs < thresholdMin * 60 * 1000) return;
  // Per-block suppression: don't prompt twice for the same block.
  const key = `${rule?.id || block.label}::${block.blockStartMs}`;
  if(_unloggedSuppress.has(key)) return;
  // Per-rule snooze.
  const snoozeKey = rule?.id || block.label;
  const snoozeUntil = _unloggedSnoozeUntil.get(snoozeKey) || 0;
  if(Date.now() < snoozeUntil) return;
  // Trigger.
  _unloggedSuppress.set(key, Date.now());
  openUnloggedWorkPrompt(block);
  recordFocusEvent('unlogged_work_detected', {
    projectId: rule?.defaultProjectId || null,
    taskId: rule?.defaultTaskId || null
  }, {
    label: block.label,
    appName: block.appName,
    windowTitle: block.windowTitle,
    durationMs: block.durationMs,
    blockStartMs: block.blockStartMs,
    ruleId: rule?.id || null
  });
}

function startUnloggedWorkScheduler(){
  stopUnloggedWorkScheduler();
  unloggedWorkTickInterval = setInterval(tickUnloggedWorkDetection, 60 * 1000);
}
function stopUnloggedWorkScheduler(){
  if(unloggedWorkTickInterval) clearInterval(unloggedWorkTickInterval);
  unloggedWorkTickInterval = null;
}

function openUnloggedWorkPrompt(block){
  currentUnloggedPrompt = block;
  document.getElementById('unloggedPromptLabel').textContent = block.label;
  document.getElementById('unloggedPromptDuration').textContent =
    `${formatDurationMs(block.durationMs)} in this block — started at ${formatTimeOfDay(block.blockStartMs)}`;
  document.getElementById('unloggedPromptSub').textContent =
    block.appName ? `Detected in ${block.appName}` : 'Detected from window activity';
  // Pre-pick the rule's default project; allow override.
  const sel = document.getElementById('unloggedProjectSel');
  const defaultPid = block.rule?.defaultProjectId || null;
  renderProjectOptions(sel, defaultPid, false);
  // Bring Punch to the front so the user actually sees the prompt — this
  // is similar to nudge bring-to-front behavior.
  try { window.punch.bringToFrontForNudge(); } catch(_){}
  openModal('unloggedWorkModal');
}

function closeUnloggedPrompt(){
  closeModal('unloggedWorkModal');
  currentUnloggedPrompt = null;
}

function handleUnloggedLog(){
  if(!currentUnloggedPrompt) return;
  const block = currentUnloggedPrompt;
  const sel = document.getElementById('unloggedProjectSel');
  const projectId = sel.value || block.rule?.defaultProjectId || (state.projects[0] && state.projects[0].id);
  if(!projectId){ toast('Add a project first'); return; }
  const subcategoryId = block.rule?.defaultSubcategoryId || null;
  const accountId = null;
  const taskId = block.rule?.defaultTaskId || null;
  const entry = {
    id: nextId('e'),
    projectId, subcategoryId, accountId,
    notes: `Detected active work in ${block.label}`,
    taskId,
    billable: false,
    startMs: block.blockStartMs,
    endMs: block.blockEndMs,
    createdAt: Date.now(),
    source: 'detected_unlogged_work',
    metadata: {
      detectedLabel: block.label,
      detectedAppName: block.appName,
      detectedWindowTitle: block.windowTitle || null,
      activityRuleId: block.rule?.id || null
    }
  };
  state.entries.push(entry);
  save(); renderAll();
  recordFocusEvent('unlogged_work_logged', { projectId, taskId, entryId: entry.id }, {
    label: block.label,
    durationMs: block.durationMs,
    ruleId: block.rule?.id || null
  });
  toast(`Logged ${formatDurationMs(block.durationMs)} of ${block.label}`);
  closeUnloggedPrompt();
}

function handleUnloggedIgnore(){
  if(!currentUnloggedPrompt) return;
  recordFocusEvent('unlogged_work_ignored', {}, {
    label: currentUnloggedPrompt.label,
    durationMs: currentUnloggedPrompt.durationMs,
    ruleId: currentUnloggedPrompt.rule?.id || null
  });
  closeUnloggedPrompt();
}

function handleUnloggedSnooze(){
  if(!currentUnloggedPrompt) return;
  const minutes = 15;
  const until = Date.now() + minutes * 60 * 1000;
  _unloggedSnoozeUntil.set(currentUnloggedPrompt.rule?.id || currentUnloggedPrompt.label, until);
  recordFocusEvent('unlogged_work_snoozed', {}, {
    label: currentUnloggedPrompt.label,
    snoozeMinutes: minutes,
    ruleId: currentUnloggedPrompt.rule?.id || null
  });
  toast(`Snoozed ${minutes} min`);
  closeUnloggedPrompt();
}

function handleUnloggedDontAsk(){
  if(!currentUnloggedPrompt) return;
  const rule = currentUnloggedPrompt.rule;
  if(rule){
    rule.promptToLog = false;
    rule.updatedAt = Date.now();
    save();
    toast(`"${rule.label}" will no longer prompt`);
    renderActivityRulesList();
  } else {
    // No rule — set a long snooze keyed by label so we won't re-prompt this session.
    _unloggedSnoozeUntil.set(currentUnloggedPrompt.label, Date.now() + 24 * 60 * 60 * 1000);
    toast('Won\'t ask for this label today');
  }
  closeUnloggedPrompt();
}

function buildFocusEventDetail(e){
  const project = e.projectId ? getProject(e.projectId) : null;
  const task = e.taskId ? getTask(e.taskId) : null;
  const projTask = [project?.name, task?.name].filter(Boolean).join(' › ');
  if(e.type === 'window_changed'){
    return esc(e.windowTitle ? `${e.appName} — ${e.windowTitle}` : (e.appName || ''));
  }
  if(e.type === 'distraction_logged'){
    return esc([(e.metadata?.distractionType || ''), e.note, projTask].filter(Boolean).join(' · '));
  }
  if(e.type === 'unlogged_work_detected' || e.type === 'unlogged_work_logged' ||
     e.type === 'unlogged_work_ignored' || e.type === 'unlogged_work_snoozed'){
    const dur = e.metadata?.durationMs ? formatDurationMs(e.metadata.durationMs) : '';
    return esc([(e.metadata?.label || ''), dur].filter(Boolean).join(' · '));
  }
  if(e.type === 'timer_stopped'){
    const dur = e.metadata?.durationMs ? formatDurationMs(e.metadata.durationMs) : '';
    return esc([projTask, dur].filter(Boolean).join(' · '));
  }
  if(e.type === 'timed_break_started' || e.type === 'timed_break_completed'
     || e.type === 'timed_break_skipped' || e.type === 'timed_break_snoozed'){
    const planned = e.metadata?.plannedDurationMinutes;
    const actual  = e.metadata?.actualDurationMinutes;
    const parts = [];
    if(planned) parts.push(`${planned}m planned`);
    if(e.type === 'timed_break_completed' && typeof actual === 'number') parts.push(`${actual}m actual`);
    return esc(parts.join(' · '));
  }
  if(e.type === 'nudge_action_executed'){
    const action = (e.metadata?.actionType || '').replace(/_/g, ' ');
    return esc([action, projTask].filter(Boolean).join(' · '));
  }
  return esc(projTask);
}

// ============================================================
// FOCUS SIGNALS — Suggested Focus (rule-based)
// ------------------------------------------------------------
// Lightweight planner that surfaces the most worth-starting work item.
// Pure data: returns null when nothing is worth suggesting (e.g. a clean
// slate). The card UI hides itself when null. Order matches the priority
// list in the spec — first matching signal wins.
// ============================================================
function buildSuggestedFocus(dateMs){
  const day = dateMs || Date.now();
  const todayStart = startOfDay(day);
  const tomorrowStart = todayStart + 86400000;
  const hour = new Date(day).getHours();

  // 1. Missing notes after 14:00 if ≥3 today — context decay starts as the
  //    day winds down and notes get harder to recover.
  const missingNotes = getMissingNoteEntries(day);
  if(missingNotes.length >= 3 && hour >= 14){
    return {
      type: 'missing_notes',
      projectId: null,
      taskId: null,
      reason: `${missingNotes.length} entries from today are missing context.`,
      firstMove: 'Open the Log tab and add quick notes before End Day.',
      confidence: 'high',
      metadata: { missingCount: missingNotes.length }
    };
  }

  const active = state.tasks.filter(isTaskActive);
  const prioRank = (p) => p === 'high' ? 3 : p === 'normal' ? 2 : p === 'low' ? 1 : 0;

  // Helper to wrap a task into the suggestion shape.
  const fromTask = (t, type, reason, firstMove, extra) => ({
    type,
    projectId: taskPrimaryProject(t),
    taskId: t.id,
    reason,
    firstMove,
    confidence: 'high',
    metadata: { taskName: t.name, ...(extra || {}) }
  });

  // 2. Overdue + high-priority active task.
  const overdueHigh = active
    .filter(t => t.dueDate && t.dueDate < todayStart && t.priority === 'high')
    .sort((a,b) => a.dueDate - b.dueDate);
  if(overdueHigh[0]){
    const t = overdueHigh[0];
    return fromTask(t, 'overdue_priority',
      `Overdue high-priority task on ${getProject(taskPrimaryProject(t))?.name || 'a project'}.`,
      'Start the timer and aim for one solid 25-minute block.'
    );
  }

  // 3. Due today, highest priority first.
  const dueToday = active
    .filter(t => t.dueDate && t.dueDate >= todayStart && t.dueDate < tomorrowStart)
    .sort((a,b) => prioRank(b.priority) - prioRank(a.priority));
  if(dueToday[0]){
    const t = dueToday[0];
    return fromTask(t, 'due_today',
      `Due today${t.priority === 'high' ? ' · high priority' : ''}.`,
      "Open the task and start the timer. 25 minutes will tell you if it's a same-day finish."
    );
  }

  // 4. Carry-forward count ≥ 2 — tasks that keep slipping.
  const slipping = active
    .filter(t => (t.carryForwardCount || 0) >= 2)
    .sort((a,b) => (b.carryForwardCount || 0) - (a.carryForwardCount || 0));
  if(slipping[0]){
    const t = slipping[0];
    return fromTask(t, 'carried_forward',
      `Carried forward ${t.carryForwardCount} times. Reduce the unknowns.`,
      'Open the task and work for 15 minutes — even a small dent shrinks the friction.',
      { carryForwardCount: t.carryForwardCount }
    );
  }

  // 5. Time logged today but task not yet completed (in-progress momentum).
  const idsWithTimeToday = new Set();
  for(const e of state.entries){
    if(!e.taskId) continue;
    if(e.endMs > todayStart) idsWithTimeToday.add(e.taskId);
  }
  if(state.activeTimer && state.activeTimer.taskId){
    idsWithTimeToday.add(state.activeTimer.taskId);
  }
  const inFlight = active
    .filter(t => idsWithTimeToday.has(t.id))
    .sort((a,b) => prioRank(b.priority) - prioRank(a.priority));
  if(inFlight[0]){
    const t = inFlight[0];
    return fromTask(t, 'in_progress',
      "You've already put time into this today — finish what's started.",
      'Resume the task and aim to close it before End Day.'
    );
  }

  // 6. Highest-priority active task with a due date.
  const prioritized = active
    .filter(t => t.dueDate && t.priority)
    .sort((a,b) => {
      const r = prioRank(b.priority) - prioRank(a.priority);
      return r !== 0 ? r : a.dueDate - b.dueDate;
    });
  if(prioritized[0]){
    const t = prioritized[0];
    return fromTask(t, 'top_priority',
      `Highest-priority active task with a deadline.`,
      'Start now while the day is fresh.'
    );
  }

  return null; // 7. Fallback handled by the renderer with an "all clear" message.
}

// Session-scoped guard so we don't log suggested_focus_shown on every render
// for the same recommendation. Reset only when the suggestion changes.
let _lastSuggestedFocusKey = null;

function suggestedFocusKey(s){
  if(!s) return 'none';
  return `${s.type}::${s.taskId || ''}::${s.projectId || ''}`;
}

function renderSuggestedFocusCard(){
  const wrap = document.getElementById('suggestedFocus');
  if(!wrap) return;
  const f = state.settings.focus || {};
  if(f.enableSuggestedFocus === false){
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  const s = buildSuggestedFocus(Date.now());
  // "All clear" fallback — keep the section visible but small.
  if(!s){
    wrap.classList.remove('hidden');
    wrap.innerHTML = `
      <div class="suggested-focus-head">
        <span class="suggested-focus-label">Suggested focus</span>
        <span class="suggested-focus-confidence">all clear</span>
      </div>
      <div class="suggested-focus-body">
        <div class="suggested-focus-title">No clear priority — pick whatever you want.</div>
        <div class="suggested-focus-reason">No overdue or due-today tasks, no slipping tasks, no in-flight work waiting.</div>
      </div>`;
    _lastSuggestedFocusKey = 'none';
    return;
  }
  wrap.classList.remove('hidden');
  const project = s.projectId ? getProject(s.projectId) : null;
  const task = s.taskId ? getTask(s.taskId) : null;
  const projectName = project ? project.name : (s.type === 'missing_notes' ? 'Today\'s notes' : 'Suggested');
  const taskName = task ? task.name : null;
  const accentColor = project ? project.color : 'var(--amber)';
  const showStartTimer = !!task;
  const showViewTask = !!task;
  wrap.innerHTML = `
    <div class="suggested-focus-head">
      <span class="suggested-focus-bar" style="background:${esc(accentColor)}"></span>
      <span class="suggested-focus-label">Suggested focus</span>
      <span class="suggested-focus-confidence">${esc(s.confidence || 'medium')}</span>
    </div>
    <div class="suggested-focus-body">
      <div class="suggested-focus-title">${esc(projectName)}${taskName ? ` <span class="suggested-focus-task">${esc(taskName)}</span>` : ''}</div>
      <div class="suggested-focus-reason">${esc(s.reason)}</div>
      <div class="suggested-focus-move"><strong>Next:</strong> ${esc(s.firstMove)}</div>
    </div>
    <div class="suggested-focus-actions">
      ${showStartTimer ? `<button class="btn btn-primary" data-suggested-action="start">Start timer</button>` : ''}
      ${showViewTask ? `<button class="btn" data-suggested-action="view">View task</button>` : ''}
      <button class="btn" data-suggested-action="dismiss">Dismiss</button>
    </div>`;

  // Log shown event only on transitions to a new suggestion to avoid noise.
  const key = suggestedFocusKey(s);
  if(_lastSuggestedFocusKey !== key){
    _lastSuggestedFocusKey = key;
    recordFocusEvent('suggested_focus_shown', {
      projectId: s.projectId, taskId: s.taskId
    }, { type: s.type, reason: s.reason });
  }

  wrap.querySelectorAll('[data-suggested-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.suggestedAction;
      if(action === 'start' && s.taskId){
        recordFocusEvent('suggested_focus_accepted', {
          projectId: s.projectId, taskId: s.taskId
        }, { type: s.type, action: 'start' });
        startTimerForTask(s.taskId, s.projectId || undefined);
      } else if(action === 'view' && s.taskId){
        recordFocusEvent('suggested_focus_accepted', {
          projectId: s.projectId, taskId: s.taskId
        }, { type: s.type, action: 'view' });
        openTaskModal(s.taskId);
      } else if(action === 'dismiss'){
        recordFocusEvent('suggested_focus_dismissed', {
          projectId: s.projectId, taskId: s.taskId
        }, { type: s.type });
        // Hide for the rest of this session — re-renders won't bring it back
        // until the suggestion key actually changes.
        wrap.classList.add('hidden');
      }
    });
  });
}

// ------------------------------------------------------------
// Insights tab
// ------------------------------------------------------------
function getInsightsRange(){
  const sel = document.getElementById('insightsRange');
  const val = sel ? sel.value : 'thisWeek';
  const now = Date.now();
  if(val === 'thisWeek') return { start: startOfWeek(now), end: now, label: 'This week' };
  if(val === 'lastWeek'){
    const en = startOfWeek(now) - 1;
    const st = startOfWeek(en);
    return { start: st, end: startOfWeek(now), label: 'Last week' };
  }
  if(val === 'last7') return { start: now - 7*86400000, end: now, label: 'Last 7 days' };
  if(val === 'last14') return { start: now - 14*86400000, end: now, label: 'Last 14 days' };
  if(val === 'last30') return { start: now - 30*86400000, end: now, label: 'Last 30 days' };
  return { start: startOfWeek(now), end: now, label: 'This week' };
}

// Per-day rollup for the trend chart. Returns array of { dayStart, totalMs,
// billableMs } in chronological order, length = `days`.
function buildDailyRollup(days){
  const today = startOfDay(Date.now());
  const out = [];
  for(let i = days - 1; i >= 0; i--){
    const dayStart = today - i * 86400000;
    const dayEnd = dayStart + 86400000;
    let total = 0, billable = 0;
    for(const e of state.entries){
      if(e.endMs <= dayStart || e.startMs >= dayEnd) continue;
      const s = Math.max(e.startMs, dayStart);
      const en = Math.min(e.endMs, dayEnd);
      const dur = Math.max(0, en - s);
      total += dur;
      if(e.billable) billable += dur;
    }
    if(state.activeTimer && state.activeTimer.startMs < dayEnd && Date.now() > dayStart){
      const s = Math.max(state.activeTimer.startMs, dayStart);
      const en = Math.min(Date.now(), dayEnd);
      total += Math.max(0, en - s);
    }
    out.push({ dayStart, totalMs: total, billableMs: billable });
  }
  return out;
}

function renderInsights(){
  const pane = document.querySelector('.tab-pane[data-pane="insights"]');
  if(!pane) return;
  const range = getInsightsRange();
  const data = buildSummaryData(range);

  // Range subtitle (small "<dateA> to <dateB>" hint next to the picker)
  const subtitle = document.getElementById('insightsRangeLabel');
  if(subtitle){
    const sd = new Date(range.start).toLocaleDateString();
    const ed = new Date(range.end).toLocaleDateString();
    subtitle.textContent = `${sd} → ${ed}`;
  }

  renderInsightsKpis(data, range);
  renderDailyTrendChart();
  renderProjectBreakdownChart(data);
  renderInsightsTaskList('insightsCompletedTasks', data.completedTasks, 'completed');
  renderInsightsTaskList('insightsInFlight', data.incompleteWithTime, 'in-flight');
  renderInsightsCarryForward(data.carryForward);
  renderInsightsCloseouts();
  renderInsightsQuality(data, range);
  renderAttentionDriftCard();
}

// Compact today-only focus signals card. The range above covers a week+,
// but attention drift is most actionable when it's about the day in front
// of you — keep it focused on today.
function renderAttentionDriftCard(){
  const wrap = document.getElementById('attentionDrift');
  if(!wrap) return;
  const today = Date.now();
  const { start, end } = dayWindow(today);
  const summary = getAttentionDriftSummary(start, end);
  const noSignals =
    summary.distractionMs === 0 &&
    summary.projectSwitches === 0 &&
    summary.taskSwitches === 0 &&
    summary.windowChanges === 0 &&
    summary.suggestedShown === 0;
  if(noSignals){
    wrap.innerHTML = '<div class="empty" style="padding:18px">No focus signals captured today yet. Enable app/window tracking in Settings → Focus Tools.</div>';
    return;
  }
  const acceptRate = summary.suggestedShown > 0
    ? Math.round((summary.suggestedAccepted / summary.suggestedShown) * 100)
    : null;
  const blockLabel = `${summary.distractionBlocks} block${summary.distractionBlocks !== 1 ? 's' : ''}`;
  const cells = [
    { label: 'Distraction time', value: summary.distractionMs > 0 ? formatDurationMs(summary.distractionMs) : '0m', sub: blockLabel },
    { label: 'Project switches', value: summary.projectSwitches, sub: '' },
    { label: 'Task switches', value: summary.taskSwitches, sub: '' },
    { label: 'App switches', value: summary.windowChanges, sub: '' },
    { label: 'Suggested accept', value: acceptRate != null ? `${acceptRate}%` : '—', sub: summary.suggestedShown ? `${summary.suggestedAccepted}/${summary.suggestedShown}` : '' }
  ];
  wrap.innerHTML = cells.map(c => `
    <div class="drift-cell">
      <div class="drift-label">${esc(c.label)}</div>
      <div class="drift-value">${esc(String(c.value))}</div>
      ${c.sub ? `<div class="drift-sub">${esc(c.sub)}</div>` : ''}
    </div>
  `).join('');
}

function renderInsightsKpis(data, range){
  const wrap = document.getElementById('insightsKpis');
  if(!wrap) return;
  // Active and overdue task counts are global (not period-bound) — they describe
  // the current state of the work plan, not historical activity.
  const activeTasks = state.tasks.filter(isTaskActive).length;
  const overdueTasks = state.tasks.filter(t => isTaskActive(t) && t.dueDate && t.dueDate < startOfDay(Date.now())).length;
  const billableMs = state.entries
    .filter(e => e.billable && e.endMs >= range.start && e.startMs <= range.end)
    .reduce((s,e) => s + Math.min(e.endMs, range.end) - Math.max(e.startMs, range.start), 0);
  const totalMs = data.totals.hours * 3600000;
  const notesCoverage = data.totals.entryCount > 0
    ? Math.round(((data.totals.entryCount - (data.totals.entriesMissingNotes||0)) / data.totals.entryCount) * 100)
    : 0;

  const tiles = [
    { value: data.totals.formatted, label: 'Tracked' },
    { value: formatHM(billableMs), label: 'Billable' },
    { value: data.totals.entryCount, label: 'Entries' },
    { value: data.completedTasks.length, label: 'Tasks done' },
    { value: activeTasks, label: 'Active tasks' },
    { value: overdueTasks, label: 'Overdue', tone: overdueTasks > 0 ? 'warn' : '' },
    { value: notesCoverage + '%', label: 'With notes' }
  ];
  wrap.innerHTML = tiles.map(t => `
    <div class="kpi-tile${t.tone ? ' tone-'+t.tone : ''}">
      <div class="kpi-value">${esc(String(t.value))}</div>
      <div class="kpi-label">${esc(t.label)}</div>
    </div>`).join('');
}

// Vertical-bar SVG chart of daily activity for the last 14 days. Each day shows
// a billable (green) segment stacked under non-billable (amber). Bars use a
// shared scale anchored to the busiest day so quiet days are still readable.
function renderDailyTrendChart(){
  const wrap = document.getElementById('insightsDailyChart');
  if(!wrap) return;
  const data = buildDailyRollup(14);
  const maxMs = Math.max(...data.map(d => d.totalMs), 3600000); // floor at 1h so empty weeks don't divide-by-tiny
  const W = 360, H = 160, padTop = 12, padBottom = 22, padLeft = 4, padRight = 4;
  const chartH = H - padTop - padBottom;
  const barCount = data.length;
  const slot = (W - padLeft - padRight) / barCount;
  const barW = Math.min(20, slot * 0.7);

  let bars = '';
  let labels = '';
  data.forEach((d, i) => {
    const x = padLeft + i * slot + (slot - barW) / 2;
    const totalH = (d.totalMs / maxMs) * chartH;
    const billH = (d.billableMs / maxMs) * chartH;
    const nonBillH = totalH - billH;
    const yTotal = padTop + chartH - totalH;
    const yBill = padTop + chartH - billH;
    const dateStr = new Date(d.dayStart).toLocaleDateString(undefined, { month:'short', day:'numeric' });
    const tip = `${dateStr} — ${formatHM(d.totalMs)}${d.billableMs > 0 ? ` (${formatHM(d.billableMs)} billable)` : ''}`;
    if(nonBillH > 0){
      bars += `<rect class="bar bar-nonbill" x="${x}" y="${yTotal}" width="${barW}" height="${nonBillH}" rx="2"><title>${esc(tip)}</title></rect>`;
    }
    if(billH > 0){
      bars += `<rect class="bar bar-bill" x="${x}" y="${yBill}" width="${barW}" height="${billH}" rx="2"><title>${esc(tip)}</title></rect>`;
    }
    if(totalH === 0){
      // Show a faint baseline tick for empty days so the axis is readable.
      bars += `<rect class="bar bar-empty" x="${x}" y="${padTop+chartH-2}" width="${barW}" height="2" rx="1"><title>${esc(tip)} — no entries</title></rect>`;
    }
    // X-axis labels — only every other day to avoid crowding.
    if(i % 2 === barCount % 2){
      const dayShort = new Date(d.dayStart).toLocaleDateString(undefined, { weekday:'short' });
      labels += `<text x="${x + barW/2}" y="${H - 6}" class="axis-label" text-anchor="middle">${esc(dayShort[0])}</text>`;
    }
  });

  // Horizontal grid lines at 25/50/75% of max for visual reference.
  let grid = '';
  [0.25, 0.5, 0.75, 1].forEach(frac => {
    const y = padTop + chartH - chartH * frac;
    grid += `<line class="grid-line" x1="${padLeft}" y1="${y}" x2="${W-padRight}" y2="${y}" />`;
  });

  const totalRange = data.reduce((s,d) => s + d.totalMs, 0);
  const totalBill = data.reduce((s,d) => s + d.billableMs, 0);

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="punch-svg-chart" preserveAspectRatio="xMidYMid meet">
      ${grid}
      ${bars}
      ${labels}
    </svg>
    <div class="chart-footer">
      <span class="chart-legend"><span class="dot dot-bill"></span>Billable</span>
      <span class="chart-legend"><span class="dot dot-nonbill"></span>Non-billable</span>
      <span class="chart-footer-total">Total: ${formatHM(totalRange)}${totalBill ? ` · ${formatHM(totalBill)} billable` : ''}</span>
    </div>`;
}

// Horizontal stacked bars for project distribution within the selected period.
// Each row uses the project's color; widths scale to the period's biggest project
// so even small projects stay visible.
function renderProjectBreakdownChart(data){
  const wrap = document.getElementById('insightsProjectChart');
  if(!wrap) return;
  if(!data.projects.length){
    wrap.innerHTML = '<div class="insights-empty">No time logged in this period.</div>';
    return;
  }
  const maxHours = Math.max(...data.projects.map(p => p.hours), 0.01);
  // Look up project color by name (project entries in summary data carry the name).
  // Tiny inefficiency, but only runs once per render.
  const colorByName = new Map(state.projects.map(p => [p.name, p.color]));
  let html = '<div class="proj-bar-list">';
  for(const p of data.projects){
    const widthPct = (p.hours / maxHours) * 100;
    const color = colorByName.get(p.name) || '#666';
    html += `
      <div class="proj-bar-row">
        <div class="proj-bar-label" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="proj-bar-track">
          <div class="proj-bar-fill" style="width:${widthPct}%;background:${esc(color)}"></div>
        </div>
        <div class="proj-bar-value mono">${p.hours}h <span class="proj-bar-pct">${p.percent}%</span></div>
      </div>`;
  }
  html += '</div>';
  wrap.innerHTML = html;
}

function renderInsightsTaskList(targetId, items, kind){
  const wrap = document.getElementById(targetId);
  if(!wrap) return;
  if(!items || items.length === 0){
    const msg = kind === 'completed' ? 'Nothing completed in this period.' : 'No tasks in flight.';
    wrap.innerHTML = `<div class="insights-empty">${msg}</div>`;
    return;
  }
  let html = '';
  // Cap to 8 entries per list — beyond that this becomes a wall of text and the
  // user should jump to the Tasks tab for the full picture.
  const shown = items.slice(0, 8);
  for(const t of shown){
    const accountSuffix = t.account ? ` · ${esc(t.account)}` : '';
    if(kind === 'completed'){
      html += `<div class="insights-item">
        <span class="insights-item-mark insights-mark-done">✓</span>
        <div class="insights-item-main">
          <div class="insights-item-name">${esc(t.name)}</div>
          <div class="insights-item-sub">${esc(t.project)}${accountSuffix} · ${t.hoursLogged}h logged</div>
        </div>
      </div>`;
    } else {
      const due = t.dueDate ? ` · due ${new Date(t.dueDate).toLocaleDateString()}` : '';
      const est = t.estimatedMinutes ? ` · est ${(t.estimatedMinutes/60).toFixed(1)}h` : '';
      html += `<div class="insights-item">
        <span class="insights-item-mark insights-mark-flight">⏵</span>
        <div class="insights-item-main">
          <div class="insights-item-name">${esc(t.name)}</div>
          <div class="insights-item-sub">${esc(t.project)} · ${t.hoursLoggedThisPeriod}h this period (${t.hoursLoggedTotal}h total)${est}${due}</div>
        </div>
      </div>`;
    }
  }
  if(items.length > shown.length){
    html += `<div class="insights-empty">…and ${items.length - shown.length} more</div>`;
  }
  wrap.innerHTML = html;
}

function renderInsightsCarryForward(items){
  const wrap = document.getElementById('insightsCarryForward');
  if(!wrap) return;
  if(!items || items.length === 0){
    wrap.innerHTML = '<div class="insights-empty">Nothing scheduled in the next 7 days.</div>';
    return;
  }
  let html = '';
  for(const t of items.slice(0, 12)){
    const tone = t.overdue ? 'overdue' : '';
    const due = new Date(t.dueDate).toLocaleDateString();
    const prio = t.priority ? `<span class="task-priority-badge prio-${esc(t.priority)}" style="margin-left:6px">${esc(t.priority)}</span>` : '';
    html += `<div class="insights-item ${tone ? 'insights-item-warn' : ''}">
      <span class="insights-item-mark ${t.overdue ? 'insights-mark-overdue' : 'insights-mark-soon'}">${t.overdue ? '⚠' : '→'}</span>
      <div class="insights-item-main">
        <div class="insights-item-name">${esc(t.name)}${prio}</div>
        <div class="insights-item-sub">${esc(t.project)} · due ${due}${t.overdue ? ' (overdue)' : ''}${t.hoursLoggedTotal > 0 ? ` · ${t.hoursLoggedTotal}h logged` : ''}</div>
      </div>
    </div>`;
  }
  if(items.length > 12){
    html += `<div class="insights-empty">…and ${items.length - 12} more</div>`;
  }
  wrap.innerHTML = html;
}

function renderInsightsQuality(data, range){
  const wrap = document.getElementById('insightsQuality');
  if(!wrap) return;
  const flags = [];
  const missing = data.totals.entriesMissingNotes || 0;
  if(missing > 0){
    const pct = Math.round((missing / data.totals.entryCount) * 100);
    flags.push({ label: `${missing} of ${data.totals.entryCount} entries missing notes (${pct}%)`, tone: pct > 25 ? 'warn' : 'info' });
  }
  // Estimate accuracy on tasks completed in this period that had estimates.
  const tasksWithEst = state.tasks.filter(t => t.completed && t.completedAt >= range.start && t.completedAt <= range.end && t.estimatedMinutes);
  if(tasksWithEst.length > 0){
    const ratios = tasksWithEst.map(t => sumTaskMs(t.id) / 60000 / t.estimatedMinutes);
    const avg = ratios.reduce((s,r)=>s+r,0) / ratios.length;
    const hitCount = ratios.filter(r => r >= 0.8 && r <= 1.2).length;
    const tone = avg > 1.5 ? 'warn' : (avg < 0.7 ? 'info' : 'good');
    flags.push({
      label: `Estimate accuracy: ${tasksWithEst.length} task${tasksWithEst.length===1?'':'s'} avg ${avg.toFixed(2)}× (${hitCount} within ±20%)`,
      tone
    });
  }
  if(data.completedTasks.length === 0 && data.totals.entryCount > 0){
    flags.push({ label: 'Time logged but no tasks completed in this period.', tone: 'info' });
  }
  if(flags.length === 0){
    wrap.innerHTML = '<div class="insights-empty">All clean — nothing flagged.</div>';
    return;
  }
  wrap.innerHTML = flags.map(f => `<div class="quality-flag tone-${esc(f.tone)}">${esc(f.label)}</div>`).join('');
}

// ============================================================
// PRODUCTIVITY — UI: Nudges (popup + settings manager)
// ============================================================

const NUDGE_CATEGORIES = ['Health','Focus','Admin','Planning','Break','Custom'];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ----- Popup -----

function showNudgePopup(nudge, event){
  currentNudgePopup = { eventId: event.id, nudgeId: nudge.id };
  const modal = document.getElementById('nudgeModal');
  document.getElementById('nudgeModalName').textContent = nudge.name;
  document.getElementById('nudgeModalCategory').textContent = nudge.category;
  document.getElementById('nudgeModalMessage').textContent = nudge.message || '';
  const timedRow = document.getElementById('nudgeModalTimedRow');
  const timedVal = document.getElementById('nudgeModalTimedValue');
  const isTimedBreak = nudge.type === 'timed_break' && nudge.timedDurationMinutes;
  if(isTimedBreak){
    timedRow.classList.remove('hidden');
    timedVal.textContent = `${nudge.timedDurationMinutes} min`;
  } else {
    timedRow.classList.add('hidden');
  }
  // Primary button morphs based on nudge type/action so the popup's intent
  // is obvious at a glance. Dispatch lives in handleNudgePrimaryAction.
  let primaryLabel = 'Done';
  if(isTimedBreak){
    primaryLabel = `Start ${nudge.timedDurationMinutes}m break`;
  } else if(nudge.type === 'action_prompt'){
    const proj = nudge.actionProjectId ? getProject(nudge.actionProjectId) : null;
    primaryLabel = proj ? `Start · ${proj.name}` : 'Start';
  }
  document.getElementById('btnNudgeDone').textContent = primaryLabel;
  // Snooze button label reflects the per-nudge configured snooze.
  document.getElementById('btnNudgeSnooze').textContent =
    `Snooze ${nudge.defaultSnoozeMinutes} min`;
  openModal('nudgeModal');
}

function closeNudgePopup(){
  currentNudgePopup = null;
  closeModal('nudgeModal');
  // Drain queue after the user clears the current popup.
  setTimeout(flushPendingNudgeQueue, 50);
}

// Primary action dispatcher. The popup's primary button morphs by nudge type:
//   reminder       → "Done"        → handleNudgeDone
//   timed_break    → "Start break" → handleNudgeStartBreak
//   action_prompt  → action-specific (e.g., "Start timer") → handleNudgeAction
// Branching here keeps each handler focused. Wired to btnNudgeDone in bindUI.
function handleNudgePrimaryAction(){
  if(!currentNudgePopup) return;
  const nudge = state.nudges.find(n => n.id === currentNudgePopup.nudgeId);
  if(nudge && nudge.type === 'timed_break'){
    handleNudgeStartBreak();
  } else if(nudge && nudge.type === 'action_prompt'){
    handleNudgeAction();
  } else {
    handleNudgeDone();
  }
}

function handleNudgeDone(){
  if(!currentNudgePopup) return;
  const popupInfo = currentNudgePopup;
  const nudge = state.nudges.find(n => n.id === popupInfo.nudgeId);
  const now = Date.now();
  recordNudgeResponse(popupInfo.eventId, 'done');
  if(nudge) scheduleNextNudge(nudge, 'done', now);
  save();
  toast('Logged');
  closeNudgePopup();
  recordFocusEvent('nudge_done', getActiveWorkContext(),
    { nudgeId: popupInfo.nudgeId, nudgeEventId: popupInfo.eventId });
}

function handleNudgeSnooze(){
  if(!currentNudgePopup) return;
  const popupInfo = currentNudgePopup;
  const nudge = state.nudges.find(n => n.id === popupInfo.nudgeId);
  if(!nudge){ closeNudgePopup(); return; }
  const now = Date.now();
  const mins = nudge.defaultSnoozeMinutes || 15;
  const until = now + mins * 60 * 1000;
  nudge.snoozeUntil = until;
  scheduleNextNudge(nudge, 'snooze', now);
  recordNudgeResponse(popupInfo.eventId, 'snoozed', { snoozeUntil: until, snoozeMinutes: mins });
  toast(`Snoozed ${mins} min`);
  closeNudgePopup();
  // For timed_break nudges, the snooze event belongs to the break stream;
  // for plain reminders/action prompts, it counts as a nudge response.
  const evType = nudge.type === 'timed_break' ? 'timed_break_snoozed' : 'nudge_snoozed';
  recordFocusEvent(evType, getActiveWorkContext(),
    { nudgeId: popupInfo.nudgeId, nudgeEventId: popupInfo.eventId, snoozeMinutes: mins });
}

function handleNudgeSkip(){
  if(!currentNudgePopup) return;
  const popupInfo = currentNudgePopup;
  const nudge = state.nudges.find(n => n.id === popupInfo.nudgeId);
  const now = Date.now();
  recordNudgeResponse(popupInfo.eventId, 'skipped');
  if(nudge) scheduleNextNudge(nudge, 'skip', now);
  save();
  closeNudgePopup();
  const evType = nudge && nudge.type === 'timed_break' ? 'timed_break_skipped' : 'nudge_skipped';
  recordFocusEvent(evType, getActiveWorkContext(),
    { nudgeId: popupInfo.nudgeId, nudgeEventId: popupInfo.eventId });
}

// ----- Timed break flow -----
//
// In-renderer state — deliberately not persisted. A break in progress when
// the app quits is simply not completed (its start event is still in
// focusEvents, the next-due-at is already scheduled forward from start).
// Treating this as transient avoids ghost completions firing across sessions.
let activeTimedBreak = null;

function handleNudgeStartBreak(){
  if(!currentNudgePopup) return;
  const popupInfo = currentNudgePopup;
  const nudge = state.nudges.find(n => n.id === popupInfo.nudgeId);
  if(!nudge){ closeNudgePopup(); return; }
  const planned = nudge.timedDurationMinutes || 5;
  const startedAt = Date.now();

  // Log the user's response on the nudge event itself (treated as 'done' from
  // the nudge perspective; the focus event stream is the break-specific record).
  recordNudgeResponse(popupInfo.eventId, 'done');
  scheduleNextNudge(nudge, 'done', startedAt);
  recordFocusEvent('timed_break_started', getActiveWorkContext(), {
    nudgeId: nudge.id,
    nudgeEventId: popupInfo.eventId,
    plannedDurationMinutes: planned,
    startedAt
  });

  // Cancel any prior in-flight break (rare — user would have to start a
  // second timed_break before the first finished). We don't try to log a
  // partial completion; the start event is enough record.
  if(activeTimedBreak && activeTimedBreak.timeoutId){
    clearTimeout(activeTimedBreak.timeoutId);
  }
  activeTimedBreak = {
    nudgeId: nudge.id,
    nudgeEventId: popupInfo.eventId,
    plannedDurationMinutes: planned,
    startedAt,
    timeoutId: setTimeout(() => completeTimedBreak('timer'), planned * 60 * 1000)
  };

  save();
  toast(`Break started — ${planned} min`);
  closeNudgePopup();
}

function completeTimedBreak(source){
  if(!activeTimedBreak) return;
  const b = activeTimedBreak;
  activeTimedBreak = null;
  if(b.timeoutId) clearTimeout(b.timeoutId);
  const completedAt = Date.now();
  const actualMin = Math.max(0, Math.round((completedAt - b.startedAt) / 60000));
  recordFocusEvent('timed_break_completed', getActiveWorkContext(), {
    nudgeId: b.nudgeId,
    nudgeEventId: b.nudgeEventId,
    plannedDurationMinutes: b.plannedDurationMinutes,
    actualDurationMinutes: actualMin,
    completedAt,
    source: source || 'timer'
  });
  toast(`Break complete — ${actualMin}m`);
}

// ----- Action prompt flow -----
//
// Executes the configured action when the user clicks the primary button on
// an action_prompt nudge. Action prompts do NOT count as timed breaks — they
// are a separate event stream (nudge_action_executed) so analytics can tell
// the two apart.
function handleNudgeAction(){
  if(!currentNudgePopup) return;
  const popupInfo = currentNudgePopup;
  const nudge = state.nudges.find(n => n.id === popupInfo.nudgeId);
  if(!nudge){ handleNudgeDone(); return; }
  const now = Date.now();

  // Record response and forward-schedule before starting the timer so the popup
  // closes cleanly before any navigation side-effects.
  recordNudgeResponse(popupInfo.eventId, 'done');
  scheduleNextNudge(nudge, 'done', now);
  save();
  closeNudgePopup();

  if(!nudge.actionProjectId){
    toast('Action prompt has no project configured');
    return;
  }
  // Stop any running timer so elapsed time is persisted before switching context.
  if(state.activeTimer) stopTimer();
  startTimer({
    projectId: nudge.actionProjectId,
    taskId: nudge.actionTaskId || null,
    notes: nudge.message || '',
    subcategoryId: null,
    accountId: null
  });

  recordFocusEvent('nudge_action_executed', getActiveWorkContext(), {
    nudgeId: nudge.id,
    nudgeEventId: popupInfo.eventId,
    actionProjectId: nudge.actionProjectId,
    actionTaskId: nudge.actionTaskId || null,
    result: 'ok'
  });
}

// ----- Settings manager (list + add + edit + delete + pause + presentation) -----

function renderNudgeManager(){
  const wrap = document.getElementById('nudgesList');
  if(!wrap) return;
  if(state.nudges.length === 0){
    wrap.innerHTML = '<div class="empty" style="padding:14px">No nudges yet. Click "+ New nudge" to add one.</div>';
  } else {
    wrap.innerHTML = state.nudges.map(n => {
      const last = n.lastTriggeredAt ? new Date(n.lastTriggeredAt).toLocaleString() : 'never';
      const snoozed = n.snoozeUntil && n.snoozeUntil > Date.now()
        ? `<span class="nudge-row-snoozed">snoozed until ${new Date(n.snoozeUntil).toLocaleTimeString()}</span>`
        : '';
      let typeLabel;
      if(n.type === 'timed_break'){
        typeLabel = `Timed break${n.timedDurationMinutes ? ` (${n.timedDurationMinutes}m)` : ''}`;
      } else if(n.type === 'action_prompt'){
        const proj = n.actionProjectId ? getProject(n.actionProjectId) : null;
        typeLabel = proj ? `Action prompt · ${proj.name}` : 'Action prompt';
      } else {
        typeLabel = 'Reminder';
      }
      return `
        <div class="nudge-row${n.enabled ? '' : ' disabled'}">
          <label class="nudge-row-toggle">
            <input type="checkbox" data-nudge-toggle="${esc(n.id)}" ${n.enabled ? 'checked' : ''} />
          </label>
          <div class="nudge-row-main">
            <div class="nudge-row-title">
              <span class="nudge-row-name">${esc(n.name)}</span>
              <span class="nudge-row-category cat-${esc(n.category.toLowerCase())}">${esc(n.category)}</span>
              ${snoozed}
            </div>
            <div class="nudge-row-meta">
              ${esc(typeLabel)} · every ${n.intervalMinutes} min · ${n.activeStartTime}–${n.activeEndTime} ·
              ${n.activeDays.map(d => DAY_NAMES[d]).join(', ')}
              · last: ${last}
            </div>
          </div>
          <div class="nudge-row-actions">
            <button class="icon-btn" data-nudge-edit="${esc(n.id)}" title="Edit">✎</button>
          </div>
        </div>`;
    }).join('');
  }
  wrap.querySelectorAll('[data-nudge-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const n = state.nudges.find(x => x.id === cb.dataset.nudgeToggle);
      if(!n) return;
      const now = Date.now();
      n.enabled = cb.checked;
      n.updatedAt = now;
      // Enabling a nudge from the list should never cause an immediate pop:
      // forward-schedule from now regardless of the old nextDueAt.
      if(n.enabled) scheduleNextNudge(n, 'init', now);
      save();
      renderNudgeManager();
    });
  });
  wrap.querySelectorAll('[data-nudge-edit]').forEach(btn => {
    btn.addEventListener('click', () => openNudgeModal(btn.dataset.nudgeEdit));
  });
  renderNudgePauseStatus();
}

// Tiny status line so the user always knows the global pause state.
function renderNudgePauseStatus(){
  const el = document.getElementById('nudgePauseStatus');
  if(el){
    const p = state.settings.productivity || {};
    if(p.presentationModeEnabled){
      el.textContent = 'Presentation mode is ON — nudges suppressed.';
      el.className = 'hint-text nudge-pause-status active';
    } else if(p.nudgePauseUntil && p.nudgePauseUntil > Date.now()){
      el.textContent = `Paused until ${new Date(p.nudgePauseUntil).toLocaleString()}.`;
      el.className = 'hint-text nudge-pause-status active';
    } else {
      el.textContent = 'Nudges active.';
      el.className = 'hint-text nudge-pause-status';
    }
    const presEl = document.getElementById('presentationToggle');
    if(presEl) presEl.checked = !!(state.settings.productivity || {}).presentationModeEnabled;
  }
  // Keep the Today snapshot pill in sync with the same state.
  renderNudgeStatusPill();
}

function pauseNudges(durationMs){
  const p = state.settings.productivity || (state.settings.productivity = defaultProductivitySettings());
  if(durationMs === 'tomorrow'){
    const t = startOfDay(Date.now()) + 86400000;
    p.nudgePauseUntil = t;
  } else {
    p.nudgePauseUntil = Date.now() + durationMs;
  }
  save();
  renderNudgePauseStatus();
  toast('Nudges paused');
}

function resumeNudges(){
  const p = state.settings.productivity;
  if(p) p.nudgePauseUntil = null;
  // Forward-schedule all enabled nudges from resume time so the user doesn't
  // get a backlog dump the moment they unpause.
  const now = Date.now();
  for(const n of state.nudges){
    if(n.enabled) scheduleNextNudge(n, 'resume', now);
  }
  save();
  renderNudgePauseStatus();
  toast('Nudges resumed');
}

function togglePresentationMode(){
  const p = state.settings.productivity || (state.settings.productivity = defaultProductivitySettings());
  const wasOn = !!p.presentationModeEnabled;
  p.presentationModeEnabled = !wasOn;
  // When leaving presentation mode, treat it like a resume so nudges don't
  // pile up behind it. Turning it ON requires no scheduling action.
  if(wasOn){
    const now = Date.now();
    for(const n of state.nudges){
      if(n.enabled) scheduleNextNudge(n, 'resume', now);
    }
  }
  save();
  renderNudgePauseStatus();
  toast(p.presentationModeEnabled ? 'Presentation mode ON' : 'Presentation mode OFF');
}

// ----- Edit modal -----

let editingNudgeId = null;

// Type drives which conditional blocks are visible:
//   timed_break    → "Break duration" field
//   action_prompt  → project/task selectors
//   reminder       → neither
function applyNudgeTypeVisibility(type){
  const dur = document.getElementById('nudgeEditTimedField');
  const action = document.getElementById('nudgeEditActionBlock');
  if(dur) dur.classList.toggle('hidden', type !== 'timed_break');
  if(action) action.classList.toggle('hidden', type !== 'action_prompt');
}

function openNudgeModal(nudgeId){
  editingNudgeId = nudgeId || null;
  const isEdit = !!nudgeId;
  const n = isEdit ? state.nudges.find(x => x.id === nudgeId) : null;
  document.getElementById('nudgeEditTitle').textContent = isEdit ? 'Edit nudge' : 'New nudge';
  document.getElementById('nudgeEditName').value = n ? n.name : '';
  document.getElementById('nudgeEditMessage').value = n ? n.message : '';
  document.getElementById('nudgeEditInterval').value = n ? n.intervalMinutes : 60;
  document.getElementById('nudgeEditStart').value = n ? n.activeStartTime : '09:00';
  document.getElementById('nudgeEditEnd').value = n ? n.activeEndTime : '17:00';
  document.getElementById('nudgeEditSnooze').value = n ? n.defaultSnoozeMinutes : 15;
  document.getElementById('nudgeEditTimed').value = n && n.timedDurationMinutes != null ? n.timedDurationMinutes : '';
  document.getElementById('nudgeEditEnabled').checked = n ? n.enabled : true;
  document.getElementById('nudgeEditRespectHours').checked = n ? n.respectWorkingHours : true;
  document.getElementById('nudgeEditAllowOutside').checked = n ? !!n.allowWhenActiveOutsideHours : false;

  const typeSel = document.getElementById('nudgeEditType');
  const initialType = n ? (n.type || 'reminder') : 'reminder';
  typeSel.value = initialType;
  applyNudgeTypeVisibility(initialType);

  // Action prompt config — populate even if hidden so a quick type switch shows valid options.
  const actionProjSel = document.getElementById('nudgeEditActionProject');
  renderProjectOptions(actionProjSel, (n && n.actionProjectId) || '', true);
  const actionTaskSel = document.getElementById('nudgeEditActionTask');
  renderTaskOptions(actionTaskSel, (n && n.actionProjectId) || null, (n && n.actionTaskId) || '');

  const catSel = document.getElementById('nudgeEditCategory');
  catSel.innerHTML = NUDGE_CATEGORIES.map(c =>
    `<option value="${esc(c)}"${n && n.category === c ? ' selected' : ''}>${esc(c)}</option>`
  ).join('');

  const daysWrap = document.getElementById('nudgeEditDays');
  const days = n ? n.activeDays : [1,2,3,4,5];
  daysWrap.innerHTML = DAY_NAMES.map((d, idx) => `
    <label class="nudge-day-chip${days.includes(idx) ? ' selected' : ''}">
      <input type="checkbox" data-nudge-day="${idx}" ${days.includes(idx) ? 'checked' : ''} />
      <span>${d}</span>
    </label>`).join('');
  daysWrap.querySelectorAll('input[data-nudge-day]').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.nudge-day-chip').classList.toggle('selected', cb.checked);
    });
  });

  document.getElementById('btnDeleteNudge').style.display = isEdit ? '' : 'none';
  openModal('nudgeEditModal');
  setTimeout(() => document.getElementById('nudgeEditName').focus(), 50);
}

function saveNudgeFromModal(){
  const name = document.getElementById('nudgeEditName').value.trim();
  if(!name){ toast('Name required'); return; }
  const message = document.getElementById('nudgeEditMessage').value.trim();
  const type = document.getElementById('nudgeEditType').value || 'reminder';
  const intervalMinutes = Math.max(1, parseInt(document.getElementById('nudgeEditInterval').value, 10) || 60);
  const activeStartTime = document.getElementById('nudgeEditStart').value || '09:00';
  const activeEndTime = document.getElementById('nudgeEditEnd').value || '17:00';
  const defaultSnoozeMinutes = Math.max(1, parseInt(document.getElementById('nudgeEditSnooze').value, 10) || 15);
  // Only timed_break carries a duration. Reminder/action_prompt always clear it.
  let timedDurationMinutes = null;
  if(type === 'timed_break'){
    const timedRaw = document.getElementById('nudgeEditTimed').value;
    timedDurationMinutes = timedRaw === '' ? null : Math.max(1, parseInt(timedRaw, 10) || 0) || null;
    if(!timedDurationMinutes){ toast('Break duration required for timed break'); return; }
  }
  // Action prompt config. Only populated when type === 'action_prompt' — cleared
  // for other types so flipping back to reminder doesn't leave a phantom project wired up.
  let actionProjectId = null, actionTaskId = null;
  if(type === 'action_prompt'){
    actionProjectId = document.getElementById('nudgeEditActionProject').value || null;
    actionTaskId = document.getElementById('nudgeEditActionTask').value || null;
    if(!actionProjectId){ toast('Pick a project for the action prompt'); return; }
  }
  const enabled = document.getElementById('nudgeEditEnabled').checked;
  const respectWorkingHours = document.getElementById('nudgeEditRespectHours').checked;
  const allowWhenActiveOutsideHours = document.getElementById('nudgeEditAllowOutside').checked;
  const category = document.getElementById('nudgeEditCategory').value;
  const activeDays = [...document.querySelectorAll('#nudgeEditDays input[data-nudge-day]:checked')]
    .map(cb => parseInt(cb.dataset.nudgeDay, 10));
  if(activeDays.length === 0){ toast('Pick at least one day'); return; }

  const now = Date.now();
  if(editingNudgeId){
    const n = state.nudges.find(x => x.id === editingNudgeId);
    if(!n) return;
    // If the user just enabled a previously-disabled nudge, give it a fresh
    // forward schedule so it doesn't pop instantly off a stale nextDueAt.
    const wasEnabled = n.enabled;
    Object.assign(n, {
      name, message, category, type, intervalMinutes,
      activeDays, activeStartTime, activeEndTime,
      defaultSnoozeMinutes, timedDurationMinutes,
      actionProjectId, actionTaskId,
      enabled, respectWorkingHours, allowWhenActiveOutsideHours,
      updatedAt: now
    });
    if(enabled && (!wasEnabled || typeof n.nextDueAt !== 'number' || n.nextDueAt < now)){
      scheduleNextNudge(n, 'init', now);
    }
  } else {
    const created = normalizeNudgeShape({
      id: nextId('n'),
      name, message, category, type, intervalMinutes,
      activeDays, activeStartTime, activeEndTime,
      defaultSnoozeMinutes, timedDurationMinutes,
      actionProjectId, actionTaskId,
      enabled, respectWorkingHours, allowWhenActiveOutsideHours,
      createdAt: now, updatedAt: now
    });
    if(created.enabled) scheduleNextNudge(created, 'init', now);
    state.nudges.push(created);
  }
  save();
  closeModal('nudgeEditModal');
  editingNudgeId = null;
  renderNudgeManager();
}

function deleteNudgeFromModal(){
  if(!editingNudgeId) return;
  if(!confirm('Delete this nudge? Its history of events will stay in your data for reporting.')) return;
  state.nudges = state.nudges.filter(n => n.id !== editingNudgeId);
  save();
  closeModal('nudgeEditModal');
  editingNudgeId = null;
  renderNudgeManager();
}

// ============================================================
// PRODUCTIVITY — UI: End Day
// ============================================================

let currentClosePreview = null; // active preview while modal is open
let currentCloseSelections = {}; // { taskId: 'carry'|'keep'|'complete'|'archive' }

function openEndDayModal(){
  currentClosePreview = buildDailyCloseoutPreview(Date.now());
  // Seed selections with each task's defaultAction.
  currentCloseSelections = {};
  for(const inc of currentClosePreview.incompleteTasks){
    currentCloseSelections[inc.id] = inc.defaultAction;
  }
  renderEndDayModal();
  openModal('endDayModal');
}

function renderEndDayModal(){
  const p = currentClosePreview;
  if(!p) return;

  // Header date
  const dateEl = document.getElementById('endDayDate');
  if(dateEl) dateEl.textContent = new Date(p.date).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });

  // 1. Active timer warning
  const timerWrap = document.getElementById('endDayTimerWrap');
  if(p.timerRunning){
    timerWrap.classList.remove('hidden');
    const proj = p.activeTimer ? getProject(p.activeTimer.projectId) : null;
    document.getElementById('endDayTimerInfo').textContent =
      proj ? `Timer running on ${proj.name}.` : 'Timer running.';
    document.getElementById('endDayStopTimerCheck').checked = true;
  } else {
    timerWrap.classList.add('hidden');
  }

  // 2. Summary text + coach card
  document.getElementById('endDaySummary').textContent = p.summaryText;
  const coach = document.getElementById('endDayCoach');
  if(p.coachCard){
    coach.classList.remove('hidden');
    coach.querySelector('.coach-card-text').textContent = p.coachCard.text;
  } else {
    coach.classList.add('hidden');
  }

  // KPI strip
  document.getElementById('endDayKpis').innerHTML = `
    <div class="kpi-tile"><div class="kpi-value">${formatHM(p.totalTrackedMs)}</div><div class="kpi-label">Tracked</div></div>
    <div class="kpi-tile"><div class="kpi-value">${p.completedTasks.length}</div><div class="kpi-label">Tasks done</div></div>
    <div class="kpi-tile"><div class="kpi-value">${p.incompleteTasks.length}</div><div class="kpi-label">To carry</div></div>
    <div class="kpi-tile${p.missingNoteEntries.length > 0 ? ' tone-warn' : ''}"><div class="kpi-value">${p.missingNoteEntries.length}</div><div class="kpi-label">Missing notes</div></div>
    <div class="kpi-tile"><div class="kpi-value">${p.entryCount}</div><div class="kpi-label">Entries</div></div>
  `;

  // Project totals
  const ptWrap = document.getElementById('endDayProjectTotals');
  if(p.projectTotals.length === 0){
    ptWrap.innerHTML = '<div class="empty" style="padding:8px 0">No time logged today.</div>';
  } else {
    ptWrap.innerHTML = p.projectTotals.map(pt => `
      <div class="end-day-project-row">
        <span class="end-day-project-swatch" style="background:${esc(pt.color)}"></span>
        <span class="end-day-project-name">${esc(pt.name)}</span>
        <span class="end-day-project-time mono">${formatHM(pt.ms)}</span>
      </div>`).join('');
  }

  // 3. Completed
  const compWrap = document.getElementById('endDayCompleted');
  if(p.completedTasks.length === 0){
    compWrap.innerHTML = '<div class="insights-empty">Nothing marked complete today.</div>';
  } else {
    compWrap.innerHTML = p.completedTasks.map(t => `
      <div class="insights-item">
        <span class="insights-item-mark insights-mark-done">✓</span>
        <div class="insights-item-main">
          <div class="insights-item-name">${esc(t.name)}</div>
          <div class="insights-item-sub">${esc(t.projectName)} · ${formatHM(t.loggedTodayMs)} today</div>
        </div>
      </div>`).join('');
  }

  // 4. Incomplete / carry-forward — interactive radio selectors per task.
  const incWrap = document.getElementById('endDayIncomplete');
  if(p.incompleteTasks.length === 0){
    incWrap.innerHTML = '<div class="insights-empty">No open tasks need a decision.</div>';
  } else {
    incWrap.innerHTML = p.incompleteTasks.map(t => {
      const dueLabel = t.dueDate ? formatDueDate(t.dueDate) : '';
      const typeBadge = t.isOverdue
        ? '<span class="plan-type-badge type-overdue">Overdue</span>'
        : t.isDueToday ? '<span class="plan-type-badge type-due-today">Due today</span>'
        : t.loggedTodayMs > 0 ? '<span class="plan-type-badge type-in-progress">In progress</span>' : '';
      const carryHint = t.carryForwardCount > 0
        ? `<span class="end-day-task-cf">↻ carried ${t.carryForwardCount}×</span>`
        : '';
      const action = currentCloseSelections[t.id] || t.defaultAction;
      return `
        <div class="end-day-task" data-task-id="${esc(t.id)}">
          <div class="end-day-task-head">
            <div class="end-day-task-info">
              <div class="end-day-task-name">${esc(t.name)}</div>
              <div class="end-day-task-meta">
                ${typeBadge}
                <span class="end-day-task-project">${esc(t.projectName)}</span>
                ${dueLabel ? `<span>${esc(dueLabel)}</span>` : ''}
                ${t.loggedTodayMs > 0 ? `<span>${formatHM(t.loggedTodayMs)} today</span>` : ''}
                ${carryHint}
              </div>
            </div>
          </div>
          <div class="end-day-task-actions">
            ${['carry','keep','complete','archive'].map(a => `
              <label class="end-day-action${action === a ? ' selected' : ''}">
                <input type="radio" name="endday-act-${esc(t.id)}" value="${a}" data-task-action="${esc(t.id)}" ${action === a ? 'checked' : ''} />
                <span>${a === 'carry' ? 'Carry to tomorrow' : a === 'keep' ? 'Keep active' : a === 'complete' ? 'Mark complete' : 'Archive'}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }).join('');

    incWrap.querySelectorAll('input[data-task-action]').forEach(r => {
      r.addEventListener('change', () => {
        currentCloseSelections[r.dataset.taskAction] = r.value;
        // Update visual highlight on the labels.
        const card = r.closest('.end-day-task');
        card.querySelectorAll('.end-day-action').forEach(l => l.classList.remove('selected'));
        r.closest('.end-day-action').classList.add('selected');
      });
    });
  }

  // 5. Missing notes
  const mnWrap = document.getElementById('endDayMissingNotes');
  if(p.missingNoteEntries.length === 0){
    mnWrap.innerHTML = '<div class="insights-empty">All entries have notes.</div>';
    document.getElementById('endDayMissingShortcut').classList.add('hidden');
  } else {
    mnWrap.innerHTML = p.missingNoteEntries.slice(0, 6).map(e => `
      <div class="insights-item">
        <span class="insights-item-mark insights-mark-overdue">!</span>
        <div class="insights-item-main">
          <div class="insights-item-name">${esc(e.projectName)} — ${formatHM(e.durationMs)}</div>
          <div class="insights-item-sub">${formatTimeOfDay(e.startMs)} → ${formatTimeOfDay(e.endMs)}</div>
        </div>
      </div>`).join('') +
      (p.missingNoteEntries.length > 6
        ? `<div class="insights-empty">…and ${p.missingNoteEntries.length - 6} more</div>` : '');
    document.getElementById('endDayMissingShortcut').classList.remove('hidden');
  }
}

function commitEndDayFromModal(){
  if(!currentClosePreview) return;
  const stopActiveTimer = currentClosePreview.timerRunning &&
    document.getElementById('endDayStopTimerCheck').checked;
  const selections = { stopActiveTimer, taskActions: { ...currentCloseSelections } };
  // commitDailyCloseout calls stopTimer() which itself calls renderAll. We
  // re-render Today's Plan and Insights afterwards to make sure carry-forward
  // changes are visible.
  commitDailyCloseout(currentClosePreview, selections);
  closeModal('endDayModal');
  currentClosePreview = null;
  currentCloseSelections = {};
  renderAll();
  // Insights pane only rerenders when re-entered; force a refresh in case the
  // user is sitting on Insights when they close out.
  if(document.querySelector('.tab.active')?.dataset.tab === 'insights'){
    renderInsights();
  }
  toast('Day closed out');
}

function jumpToMissingNotesLog(){
  // Switch to Log tab with the missing-notes filter on.
  logMissingNotesOnly = true;
  logBillableFilter = 'all';
  logProjectFilter = 'all';
  logTaskFilter = 'all';
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
  document.querySelector('.tab[data-tab="log"]').classList.add('active');
  document.querySelector('.tab-pane[data-pane="log"]').classList.add('active');
  // Match billable filter buttons UI state.
  document.querySelectorAll('[data-log-filter]').forEach(x => {
    x.classList.toggle('active', x.dataset.logFilter === 'all');
  });
  renderLog();
  closeModal('endDayModal');
}

// ----- Insights: closeout history card -----

function renderInsightsCloseouts(){
  const wrap = document.getElementById('insightsCloseouts');
  if(!wrap) return;
  const history = getCloseoutHistory();
  if(history.length === 0){
    wrap.innerHTML = '<div class="insights-empty">No closeouts yet. Click End Day on the Today tab to capture one.</div>';
    return;
  }
  const latest = history[0];
  const dateStr = new Date(latest.date).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
  const minutesH = (latest.totalTrackedMinutes / 60).toFixed(1);
  let html = `
    <div class="closeout-latest">
      <div class="closeout-latest-head">
        <span class="closeout-latest-date">${esc(dateStr)}</span>
        <span class="closeout-latest-time mono">${minutesH}h tracked · ${latest.entryCount} entries</span>
      </div>
      <div class="closeout-latest-summary">${esc(latest.summaryText)}</div>
      ${latest.coachCardText ? `<div class="closeout-latest-coach">"${esc(latest.coachCardText)}"</div>` : ''}
      <div class="closeout-latest-stats">
        <span><strong>${latest.completedTaskIds.length}</strong> completed</span>
        <span><strong>${latest.carriedForwardTaskIds.length}</strong> carried</span>
        ${latest.archivedTaskIds && latest.archivedTaskIds.length > 0 ? `<span><strong>${latest.archivedTaskIds.length}</strong> archived</span>` : ''}
        ${latest.missingNoteEntryIds.length > 0 ? `<span class="closeout-warn"><strong>${latest.missingNoteEntryIds.length}</strong> missing notes</span>` : ''}
      </div>
    </div>`;
  if(history.length > 1){
    html += '<div class="closeout-history-title">Recent closeouts</div><div class="closeout-history-list">';
    for(const c of history.slice(1, 7)){
      const d = new Date(c.date).toLocaleDateString();
      html += `
        <div class="closeout-history-row">
          <span class="closeout-history-date">${esc(d)}</span>
          <span class="closeout-history-stats">${(c.totalTrackedMinutes/60).toFixed(1)}h · ${c.completedTaskIds.length} done · ${c.carriedForwardTaskIds.length} carried</span>
        </div>`;
    }
    html += '</div>';
  }
  wrap.innerHTML = html;
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
  applyProductivitySettings();
  window.punch.setAlwaysOnTop(!!s.alwaysOnTop);
  window.punch.setHotkey(s.hotkey);
  if(s.idleEnabled) window.punch.startIdlePoll(s.idleThresholdMin*60); else window.punch.stopIdlePoll();
  if(s.autodetectEnabled) window.punch.startAutodetect(); else window.punch.stopAutodetect();
}

// Reflect productivity settings into the Settings tab inputs. Pulled out of
// applySettings so it can also be called independently after a save.
function applyProductivitySettings(){
  const p = state.settings.productivity || (state.settings.productivity = defaultProductivitySettings());
  const wh = p.workingHours || (p.workingHours = { start:'09:00', end:'17:00', days:[1,2,3,4,5] });
  const startEl = document.getElementById('workingHoursStart');
  const endEl = document.getElementById('workingHoursEnd');
  if(startEl) startEl.value = wh.start;
  if(endEl) endEl.value = wh.end;
  const daysWrap = document.getElementById('workingHoursDays');
  if(daysWrap){
    daysWrap.innerHTML = DAY_NAMES.map((d, idx) => `
      <label class="nudge-day-chip${wh.days.includes(idx) ? ' selected' : ''}">
        <input type="checkbox" data-wh-day="${idx}" ${wh.days.includes(idx) ? 'checked' : ''} />
        <span>${d}</span>
      </label>`).join('');
    daysWrap.querySelectorAll('input[data-wh-day]').forEach(cb => {
      cb.addEventListener('change', () => {
        const day = parseInt(cb.dataset.whDay, 10);
        const set = new Set(state.settings.productivity.workingHours.days);
        if(cb.checked) set.add(day); else set.delete(day);
        state.settings.productivity.workingHours.days = [...set].sort();
        cb.closest('.nudge-day-chip').classList.toggle('selected', cb.checked);
        save();
      });
    });
  }
  const pres = document.getElementById('presentationToggle');
  if(pres) pres.checked = !!p.presentationModeEnabled;
  const btf = document.getElementById('bringToFrontToggle');
  if(btf) btf.checked = p.bringToFrontForNudges !== false;
  // Focus settings inputs — populated from state.settings.focus.
  const f = state.settings.focus || (state.settings.focus = defaultFocusSettings());
  const fwe = document.getElementById('focusEnableWindowTracking');
  if(fwe) fwe.checked = !!f.enableWindowTracking;
  const fwt = document.getElementById('focusTrackTitles');
  if(fwt) fwt.checked = !!f.trackWindowTitles;
  const fwi = document.getElementById('focusInterval');
  if(fwi) fwi.value = f.windowTrackingIntervalSeconds || 30;
  const fse = document.getElementById('focusEnableSuggested');
  if(fse) fse.checked = f.enableSuggestedFocus !== false;
  const far = document.getElementById('focusEnableActivityRules');
  if(far) far.checked = f.enableActivityRules !== false;
  const fuw = document.getElementById('focusEnableUnloggedWork');
  if(fuw) fuw.checked = f.enableUnloggedWorkDetection !== false;
  const fum = document.getElementById('focusUnloggedMinutes');
  if(fum) fum.value = f.defaultUnloggedPromptMinutes || 30;
  renderNudgePauseStatus();
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
function onIdleStart(info){
  // Always record idle_started for Focus accounting, regardless of timer
  // state. Carries `timerRunning` so Focus can flag idle-during-timer.
  recordFocusEvent('idle_started', { ...getActiveWorkContext(), source: 'system' }, {
    idleSinceMs: info.idleSinceMs,
    idleSec: info.idleSec,
    timerRunning: !!state.activeTimer
  });
  if(!state.activeTimer) return;
  idleTimerSnapshot={idleSinceMs:info.idleSinceMs,activeTimerStartMs:state.activeTimer.startMs};
}
function onIdleEnd(){
  recordFocusEvent('idle_ended', { source: 'system' }, { nowMs: Date.now() });
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
  window.punch.onFocusWindowChanged(onFocusWindowChanged);
}

// Bridge for the focus-tracking poll: receive (appName, windowTitle, ts)
// from main and persist one window_changed focusEvent. Dedup at the
// renderer side guards against any rapid duplicates if the main process
// is restarting its poll during a settings change.
function onFocusWindowChanged({ appName, windowTitle, ts }){
  if(focusWindowChangeIsDuplicate(appName, windowTitle)) return;
  const ctx = { ...getActiveWorkContext(), appName, windowTitle: windowTitle || null };
  recordFocusEvent('window_changed', ctx);
}

// Lifecycle helpers — called from applyFocusSettings whenever the user
// toggles tracking or changes the interval/title-capture. Centralized so
// init and the settings handlers don't drift.
function startWindowTracking(){
  const f = state.settings.focus || (state.settings.focus = defaultFocusSettings());
  if(!f.enableWindowTracking) return;
  window.punch.startFocusTracking({
    intervalSec: f.windowTrackingIntervalSeconds || 30,
    trackTitles: !!f.trackWindowTitles
  });
}
function stopWindowTracking(){
  window.punch.stopFocusTracking();
}
function applyFocusSettings(){
  const f = state.settings.focus || (state.settings.focus = defaultFocusSettings());
  if(f.enableWindowTracking){
    // Restart with current params so live edits to interval/title-capture
    // take effect without an app restart.
    stopWindowTracking();
    startWindowTracking();
  } else {
    stopWindowTracking();
  }
  // Unlogged work scheduler: only meaningful when window tracking is on
  // (no window_changed events otherwise, no signal to detect).
  if(f.enableUnloggedWorkDetection && f.enableWindowTracking){
    startUnloggedWorkScheduler();
  } else {
    stopUnloggedWorkScheduler();
  }
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
  const distractBtn = document.getElementById('btnLogDistraction');
  if(distractBtn) distractBtn.addEventListener('click', openDistractionModal);
  const saveDistract = document.getElementById('btnSaveDistraction');
  if(saveDistract) saveDistract.addEventListener('click', saveDistractionFromModal);

  // Activity rules manager
  const addRuleBtn = document.getElementById('btnAddActivityRule');
  if(addRuleBtn) addRuleBtn.addEventListener('click', () => openActivityRuleModal(null));
  const seedRulesBtn = document.getElementById('btnSeedActivityRules');
  if(seedRulesBtn) seedRulesBtn.addEventListener('click', seedCommonDistractionRules);
  const saveRuleBtn = document.getElementById('btnSaveActivityRule');
  if(saveRuleBtn) saveRuleBtn.addEventListener('click', saveActivityRuleFromModal);
  const delRuleBtn = document.getElementById('btnDeleteRuleAdmin');
  if(delRuleBtn) delRuleBtn.addEventListener('click', deleteActivityRuleFromModal);
  // Rule modal: refresh subcat dropdown when project changes
  const ruleProjectSel = document.getElementById('ruleDefaultProject');
  if(ruleProjectSel){
    ruleProjectSel.addEventListener('change', () => {
      renderSubcatOptions(document.getElementById('ruleDefaultSubcat'), ruleProjectSel.value, null);
    });
  }

  // Unlogged work prompt actions
  const unlogBtn  = document.getElementById('btnUnloggedLog');
  const unsnzBtn  = document.getElementById('btnUnloggedSnooze');
  const unignBtn  = document.getElementById('btnUnloggedIgnore');
  const undontBtn = document.getElementById('btnUnloggedDontAsk');
  if(unlogBtn)  unlogBtn.addEventListener('click', handleUnloggedLog);
  if(unsnzBtn)  unsnzBtn.addEventListener('click', handleUnloggedSnooze);
  if(unignBtn)  unignBtn.addEventListener('click', handleUnloggedIgnore);
  if(undontBtn) undontBtn.addEventListener('click', handleUnloggedDontAsk);
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
  document.getElementById('btnQuickAddTask').addEventListener('click',()=>{
    if(state.projects.length===0){ toast('Add a project first'); return; }
    const pid=document.getElementById('projectSel').value || (state.projects[0] && state.projects[0].id);
    openTaskModal(null, {
      defaults: { projectId: pid },
      onSave: (newTaskId) => {
        renderTaskOptions(document.getElementById('taskSel'), document.getElementById('projectSel').value, newTaskId);
        document.getElementById('taskSel').value = newTaskId;
        applyTaskToTimerInputs(newTaskId);
        toast('Task created and selected');
      }
    });
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
      // Insights is computed on demand — refresh whenever the user lands on it.
      if(t.dataset.tab === 'insights') renderInsights();
      if(t.dataset.tab === 'focus') renderFocusTab();
    });
  });

  // Focus range toggle (Today / This week)
  document.querySelectorAll('.focus-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _focusRange = btn.dataset.focusRange || 'today';
      document.querySelectorAll('.focus-range-btn').forEach(x => x.classList.toggle('active', x === btn));
      renderFocusTab();
    });
  });

  // "Manage rules" jumps to Settings → Focus Tools.
  const focusSettingsBtn = document.getElementById('btnFocusGotoSettings');
  if(focusSettingsBtn){
    focusSettingsBtn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
      document.querySelector('.tab[data-tab="settings"]').classList.add('active');
      document.querySelector('.tab-pane[data-pane="settings"]').classList.add('active');
      document.querySelectorAll('.settings-subnav-btn').forEach(x => x.classList.toggle('active', x.dataset.subtab === 'focus'));
      document.querySelectorAll('.settings-subpane').forEach(sp => sp.classList.toggle('active', sp.dataset.subpane === 'focus'));
    });
  }

  // Settings sub-navigation. The selected subpane persists for the session
  // (renderAll re-renders content but does not reset the visible subpane).
  document.querySelectorAll('.settings-subnav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.subtab;
      document.querySelectorAll('.settings-subnav-btn').forEach(x => x.classList.toggle('active', x === btn));
      document.querySelectorAll('.settings-subpane').forEach(sp => {
        sp.classList.toggle('active', sp.dataset.subpane === target);
      });
    });
  });
  document.getElementById('insightsRange').addEventListener('change', renderInsights);
  document.querySelectorAll('.task-filter').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.task-filter').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active'); taskFilter=btn.dataset.filter; renderTasks();
    });
  });
  document.getElementById('taskProjectFilter').addEventListener('change',(e)=>{
    taskProjectFilter = e.target.value || 'all';
    renderTasks();
  });

  // Entry search
  document.getElementById('entrySearch').addEventListener('input',(e)=>{ entrySearchTerm=e.target.value.trim(); renderEntries(); });

  document.getElementById('btnManualEntry').addEventListener('click',openManualEntry);
  document.getElementById('btnExportCSV').addEventListener('click',exportCSV);

  // LOG tab
  document.getElementById('logRange').addEventListener('change',(e)=>{
    document.getElementById('logCustomRange').classList.toggle('hidden',e.target.value!=='custom');
    renderLog();
  });
  document.getElementById('logRangeStart').addEventListener('change',renderLog);
  document.getElementById('logRangeEnd').addEventListener('change',renderLog);
  document.getElementById('logSearch').addEventListener('input',(e)=>{ logSearchTerm=e.target.value.trim(); renderLog(); });
  document.querySelectorAll('[data-log-filter]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('[data-log-filter]').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active');
      logBillableFilter=btn.dataset.logFilter;
      renderLog();
    });
  });
  document.getElementById('btnLogExportCSV').addEventListener('click',exportLogCSV);
  document.getElementById('logProjectFilter').addEventListener('change',(e)=>{
    logProjectFilter = e.target.value || 'all';
    // Reset task filter when changing project, since the task list is narrowed.
    logTaskFilter = 'all';
    renderLog();
  });
  document.getElementById('logTaskFilter').addEventListener('change',(e)=>{
    logTaskFilter = e.target.value || 'all';
    renderLog();
  });
  document.getElementById('logMissingNotesBtn').addEventListener('click',()=>{
    logMissingNotesOnly = !logMissingNotesOnly;
    renderLog();
  });
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
  document.getElementById('btnOpenLog').addEventListener('click',()=>window.punch.openLog());
  document.getElementById('btnWipe').addEventListener('click',wipeAll);

  // ----- Productivity: nudges -----
  document.getElementById('btnAddNudge').addEventListener('click', () => openNudgeModal(null));
  document.getElementById('btnSaveNudge').addEventListener('click', saveNudgeFromModal);
  const nudgeTypeSel = document.getElementById('nudgeEditType');
  if(nudgeTypeSel){
    nudgeTypeSel.addEventListener('change', e => applyNudgeTypeVisibility(e.target.value));
  }
  // Refilter the action-task list when the action-project changes — same UX as
  // the main timer's project/task pair.
  const nudgeActionProjSel = document.getElementById('nudgeEditActionProject');
  if(nudgeActionProjSel){
    nudgeActionProjSel.addEventListener('change', e => {
      const taskSel = document.getElementById('nudgeEditActionTask');
      renderTaskOptions(taskSel, e.target.value || null, '');
    });
  }
  document.getElementById('btnDeleteNudge').addEventListener('click', deleteNudgeFromModal);
  document.getElementById('btnNudgeDone').addEventListener('click', handleNudgePrimaryAction);
  document.getElementById('btnNudgeSnooze').addEventListener('click', handleNudgeSnooze);
  document.getElementById('btnNudgeSkip').addEventListener('click', handleNudgeSkip);
  document.querySelectorAll('[data-pause-nudges]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.pauseNudges;
      if(v === 'tomorrow') pauseNudges('tomorrow');
      else pauseNudges(parseInt(v, 10) * 60 * 1000);
    });
  });
  document.getElementById('btnResumeNudges').addEventListener('click', resumeNudges);
  document.getElementById('presentationToggle').addEventListener('change', togglePresentationMode);
  const bringToFrontEl = document.getElementById('bringToFrontToggle');
  if(bringToFrontEl){
    bringToFrontEl.addEventListener('change', (e) => {
      const p = state.settings.productivity || (state.settings.productivity = defaultProductivitySettings());
      p.bringToFrontForNudges = e.target.checked;
      save();
    });
  }

  // ----- Productivity: focus tracking -----
  const focusWinEl = document.getElementById('focusEnableWindowTracking');
  const focusTitlesEl = document.getElementById('focusTrackTitles');
  const focusIntervalEl = document.getElementById('focusInterval');
  const focusSuggestedEl = document.getElementById('focusEnableSuggested');
  function getFocus(){
    return state.settings.focus || (state.settings.focus = defaultFocusSettings());
  }
  if(focusWinEl){
    focusWinEl.addEventListener('change', (e) => {
      const f = getFocus();
      f.enableWindowTracking = e.target.checked;
      save();
      applyFocusSettings();
      if(!e.target.checked) toast('App/window tracking off');
      else toast('App/window tracking on');
    });
  }
  if(focusTitlesEl){
    focusTitlesEl.addEventListener('change', (e) => {
      const f = getFocus();
      f.trackWindowTitles = e.target.checked;
      save();
      applyFocusSettings();
    });
  }
  if(focusIntervalEl){
    focusIntervalEl.addEventListener('change', (e) => {
      const v = Math.max(5, Math.min(300, parseInt(e.target.value, 10) || 30));
      const f = getFocus();
      f.windowTrackingIntervalSeconds = v;
      e.target.value = v;
      save();
      applyFocusSettings();
    });
  }
  if(focusSuggestedEl){
    focusSuggestedEl.addEventListener('change', (e) => {
      const f = getFocus();
      f.enableSuggestedFocus = e.target.checked;
      save();
      renderSuggestedFocusCard();
    });
  }
  // Activity rules + unlogged work
  const focusRulesEl = document.getElementById('focusEnableActivityRules');
  if(focusRulesEl){
    focusRulesEl.addEventListener('change', (e) => {
      const f = getFocus();
      f.enableActivityRules = e.target.checked;
      save();
      // Re-render Focus tab in case it's open; rule changes affect labels.
      if(document.querySelector('.tab.active')?.dataset.tab === 'focus') renderFocusTab();
    });
  }
  const focusUnloggedEl = document.getElementById('focusEnableUnloggedWork');
  if(focusUnloggedEl){
    focusUnloggedEl.addEventListener('change', (e) => {
      const f = getFocus();
      f.enableUnloggedWorkDetection = e.target.checked;
      save();
      applyFocusSettings();
    });
  }
  const focusUnloggedMinEl = document.getElementById('focusUnloggedMinutes');
  if(focusUnloggedMinEl){
    focusUnloggedMinEl.addEventListener('change', (e) => {
      const v = Math.max(1, Math.min(180, parseInt(e.target.value, 10) || 30));
      const f = getFocus();
      f.defaultUnloggedPromptMinutes = v;
      e.target.value = v;
      save();
    });
  }

  // Working hours inputs
  document.getElementById('workingHoursStart').addEventListener('change', (e) => {
    state.settings.productivity.workingHours.start = e.target.value || '09:00';
    save();
  });
  document.getElementById('workingHoursEnd').addEventListener('change', (e) => {
    state.settings.productivity.workingHours.end = e.target.value || '17:00';
    save();
  });

  // ----- Productivity: End Day -----
  document.getElementById('btnEndDay').addEventListener('click', openEndDayModal);
  document.getElementById('btnCommitEndDay').addEventListener('click', commitEndDayFromModal);
  document.getElementById('endDayMissingShortcut').addEventListener('click', jumpToMissingNotesLog);

  // Modal close
  document.querySelectorAll('.modal-overlay').forEach(o=>{
    o.addEventListener('click',(e)=>{
      if(e.target!==o) return;
      // Nudge popup should not be dismissible by background click — force a
      // response so events don't get stuck in the 'triggered' state.
      if(o.id === 'nudgeModal') return;
      closeModal(o.id);
    });
  });
  document.querySelectorAll('[data-close]').forEach(b=>{
    b.addEventListener('click',()=>{
      // If the user closes the nudge popup via the X (none in our markup
      // currently, but defensive), treat as Skip.
      if(b.dataset.close === 'nudgeModal'){ handleNudgeSkip(); return; }
      closeModal(b.dataset.close);
    });
  });

  // Keyboard
  document.addEventListener('keydown',(e)=>{
    const tag=(e.target.tagName||'').toLowerCase();
    const inField=tag==='input'||tag==='textarea'||tag==='select';
    const modal=document.querySelector('.modal-overlay.open');
    if(e.key==='Escape'&&modal){
      // Nudge popup must record a response — Esc skips.
      if(modal.id === 'nudgeModal'){ handleNudgeSkip(); return; }
      closeModal(modal.id); return;
    }
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
  '1.5.0': `
    <h3>🎯 Nudges &amp; breaks</h3>
    <ul>
      <li>New in-app prompts that fire on an interval while you're working — Drink water, Stand up, Stretch, Mental break, anything you want</li>
      <li>Manage them in <strong>Settings → Nudges &amp; breaks</strong>: name, message, category, interval, active days/hours, snooze duration, optional timed-break duration</li>
      <li>Each nudge popup lets you log <strong>Done</strong>, <strong>Snooze</strong>, or <strong>Skip</strong> — every response is logged for future reporting</li>
      <li>Global pause controls: 30 min, 1 hr, until tomorrow, or full <strong>Presentation mode</strong> to suppress nudges during screen sharing</li>
      <li><strong>Mental break</strong> preset is seeded disabled — toggle it on if you want a periodic reset reminder</li>
      <li>Nudges respect a configurable working-hours window, with an opt-in to still fire when you're actively working outside hours</li>
    </ul>

    <h3>📅 End Day closeout</h3>
    <ul>
      <li>New <strong>End Day</strong> button on the Today tab — generates a daily summary you can review in under 2 minutes</li>
      <li>Stops a running timer (if any), shows project totals, completed tasks, open tasks, and entries missing notes</li>
      <li>Per-task decisions: <strong>Carry to tomorrow</strong>, <strong>Keep active</strong>, <strong>Mark complete</strong>, or <strong>Archive</strong></li>
      <li>Carry-forward updates the existing task (no duplicates) and tracks how many times each task has slipped</li>
      <li>Daily coach card surfaces a short, rule-based prompt — drag reduction, context cleanup, momentum, etc. No quotes, no AI.</li>
      <li>Closeout history appears in Insights, with the latest summary up top and recent days below</li>
    </ul>

    <h3>↻ Automatic carry-forward</h3>
    <ul>
      <li>Overdue active tasks now auto-migrate to today's plan on app open — you don't have to press End Day to keep things moving</li>
      <li>Idempotent: opening the app multiple times the same day won't double-bump anything</li>
      <li>End Day still works for explicit "carry to tomorrow" decisions and getting a summary</li>
    </ul>

    <h3>🔧 Under the hood</h3>
    <ul>
      <li>Storage schema bumped to v2 — adds <code>nudges</code>, <code>nudgeEvents</code>, <code>dailyCloseouts</code> collections and a productivity-settings namespace. Existing data auto-upgrades on load.</li>
      <li>Tasks gain <code>carryForwardCount</code> and <code>lastCarriedForwardAt</code> — both reflect on the task card and the End Day modal</li>
      <li>End Day logic is split into a pure preview and a separate commit step, so future Focus dashboards and AI summaries can reuse the same data without rewriting anything</li>
    </ul>
  `,

  '1.4.6': `
    <h3>🐛 Ghost timer window now actually appears in the taskbar</h3>
    <ul>
      <li>v1.4.5 set <code>focusable: false</code> on the ghost timer window — on Windows that quietly adds the <code>WS_EX_TOOLWINDOW</code> style, which <strong>also</strong> excludes the window from the taskbar. So the window existed but no taskbar entry ever appeared.</li>
      <li>Removed that flag. The ghost is now focusable (but uses <code>showInactive()</code> so it never steals focus when shown).</li>
      <li>Added <code>[taskbar]</code> diagnostic lines to the debug log so any remaining failure is visible (Settings → Open debug log).</li>
    </ul>
  `,

  '1.4.5': `
    <h3>📌 Pinned + live timer — proper Steam-style two-icon behavior</h3>
    <ul>
      <li>v1.4.3 and v1.4.4 tried to override the main window's AUMID — Windows ignored both because it binds the launch-process taskbar entry before our JS can react</li>
      <li>v1.4.5 follows Steam's actual approach: when the timer starts, Punch creates a tiny invisible <em>secondary</em> window with its own AUMID. Windows treats it as a separate app and gives it its own taskbar entry</li>
      <li><strong>Result:</strong> your pinned Punch entry stays right where it is, and a separate taskbar entry with the live MM:SS / HH:MM countdown appears while a timer is running. When you stop the timer, that entry disappears</li>
      <li>Same behavior whether you launch Punch from the pinned shortcut, desktop shortcut, or Start Menu</li>
      <li>Clicking the live-timer entry focuses the main Punch window</li>
    </ul>
  `,

  '1.4.4': `
    <h3>📌 Pinned-shortcut friendly</h3>
    <ul>
      <li>v1.4.3's process-level AUMID wasn't enough to escape a pinned shortcut's binding — Windows had already locked the taskbar entry by the time our code ran</li>
      <li>Now uses <strong>per-window</strong> AppDetails to claim a separate AUMID at the window level, applied before the window becomes visible</li>
      <li>Result with a pinned Punch shortcut: the pinned entry stays static, and a <strong>separate live-timer entry</strong> appears while the app runs (Steam-style two-icon behavior)</li>
      <li>Without pinning: same single live-timer entry as v1.4.3</li>
    </ul>
  `,

  '1.4.3': `
    <h3>⏱ Full taskbar icon replacement</h3>
    <ul>
      <li>The Windows taskbar icon now fully replaces with the live MM:SS countdown (and HH:MM after 1 hour), like in v1.3.4 portable</li>
      <li>Achieved by claiming a runtime-specific AppUserModelID so the window doesn't group under the installer shortcut (whose icon was overriding setIcon)</li>
      <li>Drops the v1.4.2 corner-badge approach</li>
    </ul>
    <p style="font-size:11px;color:var(--text-faint);margin-top:8px">
      Note: if you've <em>pinned</em> Punch to the taskbar, you may now see two entries while the app is running (the pinned shortcut + the running window). Launching from the desktop or Start Menu shortcut behaves normally with a single taskbar entry.
    </p>
  `,

  '1.4.2': `
    <h3>🐛 Taskbar badge now actually shows on installed builds</h3>
    <ul>
      <li>v1.4.1's icon redraw worked in dev mode but Windows ignored it on installed builds — AppUserModelID grouping uses the shortcut's icon, not the window icon</li>
      <li>Now uses <strong>setOverlayIcon</strong> instead: a small amber pill in the bottom-right of the taskbar icon, which Windows respects regardless of grouping</li>
      <li>Badge shows seconds in the first minute, then minutes, then <strong>Xh</strong> once you cross 1 hour</li>
      <li>Portable/unpacked builds still get the full icon redraw as before</li>
    </ul>
  `,

  '1.4.1': `
    <h3>🐛 Taskbar timer hotfix</h3>
    <ul>
      <li>Fixed: the live taskbar icon countdown stopped working in v1.4.0 packaged builds</li>
      <li>Drawing now happens in the renderer (browser canvas) instead of the native canvas npm package — no more asar / DLL packaging fragility</li>
      <li>After 1 hour the taskbar icon switches from <strong>MM:SS</strong> to <strong>HH:MM</strong>, so long sessions show useful info</li>
    </ul>
  `,

  '1.4.0': `
    <h3>🎯 Tasks integrated with the timer</h3>
    <ul>
      <li>New Task dropdown on the Today widget — pick a task and Project / Subcategory / Account auto-fill</li>
      <li>+ next to the dropdown creates a task without leaving the timer</li>
      <li>Tasks can belong to <em>multiple projects</em> — use the new "Also in" chip selector</li>
      <li>"— any project —" option lets you browse every active task; project auto-fills when you pick one</li>
      <li>New task fields: due date, estimate (minutes), priority, status (active / completed / archived)</li>
    </ul>

    <h3>📅 Today's Plan</h3>
    <ul>
      <li>New section at the top of the Today tab</li>
      <li>Surfaces overdue, due-today, and in-progress tasks</li>
      <li>One-click start/stop, complete, edit — without leaving the screen</li>
    </ul>

    <h3>📊 Insights tab</h3>
    <ul>
      <li>Period selector: this week / last week / last 7 / 14 / 30 days</li>
      <li>KPI tiles: tracked, billable, entries, tasks done, active, overdue, with-notes %</li>
      <li>Daily activity chart — last 14 days, billable stacked</li>
      <li>Hours-by-project chart with project colors</li>
      <li>Tasks completed + In flight side by side</li>
      <li>Carry-forward strip — overdue + due in next 7 days</li>
      <li>Quality flags: missing-notes %, estimate accuracy on completed tasks</li>
    </ul>

    <h3>🔍 Log filters</h3>
    <ul>
      <li>Filter by Project, Task, or "missing notes"</li>
      <li>Stacks cleanly with the existing date range and billable filters</li>
    </ul>

    <h3>📤 Export improvements</h3>
    <ul>
      <li>CSV now includes stable IDs alongside human-readable names</li>
      <li>New columns: Entry ID, Project ID, Task ID, Subcategory ID, Account ID, Created (ISO)</li>
      <li>Same schema for Today and Log exports — easier to feed into dashboards / Excel</li>
    </ul>

    <h3>🤖 AI Summary upgrades</h3>
    <ul>
      <li>Per-entry payload includes IDs + billable flag</li>
      <li>New sections: "In Flight" (time logged but not done) and "Carry Forward"</li>
      <li>Quality note when entries are missing notes</li>
    </ul>

    <h3>🛠 Migration</h3>
    <ul>
      <li>Existing data auto-upgrades on load — no manual steps</li>
      <li>Old tasks pick up the new fields with safe defaults</li>
    </ul>
  `,

  '1.3.5': `
    <h3>📋 LOG Tab</h3>
    <ul>
      <li>New LOG tab between Today and Tasks for full history browsing</li>
      <li>Entries grouped into work sessions (gaps > 30 min start a new session)</li>
      <li>Date range picker: Today, This week, This month, Last 30 days, or Custom</li>
      <li>Search across project, subcategory, account, task, and notes</li>
      <li>Filter by All / Billable / Non-billable with live totals</li>
      <li>Export filtered results to CSV (includes Billable column)</li>
    </ul>

    <h3>🐛 Bug Fix</h3>
    <ul>
      <li>Editing an entry now correctly saves the Billable checkbox state</li>
    </ul>
  `,

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
