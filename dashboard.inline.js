(function() {
  var LOADING_ERR = function(name) {
    return function() {
      var el = document.getElementById('phoneErr');
      if (el) { el.textContent = 'App is still loading — please wait and try again.'; el.style.display = 'block'; }
      console.warn(name + ' called before Firebase loaded');
    };
  };
  // Login stubs (overridden once Firebase loads)
  ['sendOtp','verifyOtp','backToPhone','logout',
   'showPage','openCreateTask','openCreateGroup','createTask','createGroup',
   'addMember','deleteGroup','openGroupDetail','openUserDetail','toggleAdmin',
   'openResponses','archiveTask','deleteTask','removeMember','closeModal','addFormField','removeFormField',
   'openComplaintDetail','updateComplaintStatus','addAdminUpdate','openSendVerificationTask','sendVerificationTask','filterComplaints'].forEach(function(fn) {
    window[fn] = window[fn] || LOADING_ERR(fn);
  });
})();





// ── FIREBASE CONFIG ──────────────────────────────────────────────────────────
firebase.initializeApp({
  apiKey: "AIzaSyCm0mMgaed3w1gOFF3LzqbDjy3ELspFVPY",
  authDomain: "taskapp-cd2c0.firebaseapp.com",
  projectId: "taskapp-cd2c0",
  storageBucket: "taskapp-cd2c0.firebasestorage.app",
  messagingSenderId: "9386144641",
  appId: "1:9386144641:web:96ad409f1e74e8eef4ee80"
});
// Change to "prod_" for production data
const PREFIX = "dev_";
// ─────────────────────────────────────────────────────────────────────────────

const auth = firebase.auth();
const db   = firebase.firestore();

// Required for Firebase test phone numbers (bypasses reCAPTCHA for test numbers)
auth.settings.appVerificationDisabledForTesting = true;
const W    = window;

window.addEventListener('unhandledrejection', e => {
  console.error('Unhandled error:', e.reason);
  const err = document.getElementById('phoneErr');
  if (err) { err.textContent = 'App error: ' + (e.reason?.message || String(e.reason)); err.style.display = 'block'; }
});

// ── COLLECTIONS ──────────────────────────────────────────────────────────────
const col = {
  users:  () => db.collection(`${PREFIX}users`),
  groups: () => db.collection(`${PREFIX}groups`),
  tasks:  () => db.collection(`${PREFIX}tasks`),
  responses: (taskId) => db.collection(`${PREFIX}tasks/${taskId}/responses`)
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let allTasks    = [];
let allGroups   = [];
let allUsers    = [];
let activeGroupId = null;
let confirmationResult = null;
let ctFormFields = [];

// ── AUTH ──────────────────────────────────────────────────────────────────────
let recaptchaVerifier = null;

function resetRecaptcha() {
  // Always destroy the old verifier before creating a new one
  if (recaptchaVerifier) {
    try { recaptchaVerifier.clear(); } catch(_) {}
    recaptchaVerifier = null;
  }
  document.getElementById('rc-container').innerHTML = '';
}

function initRecaptcha() {
  resetRecaptcha();
  if (auth.settings.appVerificationDisabledForTesting) {
    // Testing mode: Firebase ignores the verifier, but a real RecaptchaVerifier
    // crashes trying to load the reCAPTCHA iframe. Use a dummy object instead.
    // Stub every method Firebase internally calls on a verifier
    recaptchaVerifier = {
      type: 'recaptcha',
      verify:  () => Promise.resolve('test-token'),
      clear:   () => {},
      render:  () => Promise.resolve(0),
      reset:   () => {},
      _reset:  () => {},
      _destroy:() => {}
    };
  } else {
    recaptchaVerifier = new firebase.auth.RecaptchaVerifier('rc-container', {
      size: 'invisible',
      callback: () => {}
    });
  }
}

W.sendOtp = async () => {
  const cc    = document.getElementById('ccInput').value.trim();
  const num   = document.getElementById('phoneInput').value.trim();
  const phone = cc + num.replace(/\s/g, '');
  if (phone.length < 10) { showLoginErr('phoneErr','Enter a valid phone number'); return; }

  const btn = document.getElementById('sendOtpBtn');
  btn.disabled = true; btn.textContent = 'Sending…';
  hideErr('phoneErr');

  try {
    initRecaptcha(); // fresh verifier every attempt
    confirmationResult = await auth.signInWithPhoneNumber(phone, recaptchaVerifier);
    // OTP sent successfully — show OTP step regardless of post-send verifier cleanup errors
    document.getElementById('otpHint').textContent = `OTP sent to ${phone}`;
    document.getElementById('phoneStep').style.display = 'none';
    document.getElementById('otpStep').style.display   = 'block';
  } catch(e) {
    // If we already have a confirmationResult the OTP was sent — don't treat as failure
    if (confirmationResult) {
      document.getElementById('otpHint').textContent = `OTP sent to ${phone}`;
      document.getElementById('phoneStep').style.display = 'none';
      document.getElementById('otpStep').style.display   = 'block';
      return;
    }
    resetRecaptcha(); // clear on failure so next attempt starts clean
    showLoginErr('phoneErr', e.message || 'Failed to send OTP');
    btn.disabled = false; btn.textContent = 'Send OTP →';
  }
};

W.verifyOtp = async () => {
  const otp = document.getElementById('otpInput').value.trim();
  if (otp.length < 6) { showLoginErr('otpErr','Enter 6 digits'); return; }
  const btn = document.getElementById('verifyBtn');
  btn.disabled = true; btn.textContent = 'Verifying…';
  hideErr('otpErr');

  try {
    const cred = await confirmationResult.confirm(otp);
    const uid  = cred.user.uid;
    const phone = cred.user.phoneNumber;
    // ensure user doc exists
    const uref = db.collection(`${PREFIX}users`).doc(uid);
    const usnap = await uref.get();
    if (!usnap.exists) {
      await uref.set({ uid, phone, name:'', role:'USER', groupIds:[], fcmToken:'', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
  } catch(e) {
    showLoginErr('otpErr', 'Invalid OTP — try again');
    btn.disabled = false; btn.textContent = 'Verify & Enter →';
  }
};

W.backToPhone = () => {
  resetRecaptcha();
  confirmationResult = null;
  document.getElementById('otpStep').style.display   = 'none';
  document.getElementById('phoneStep').style.display = 'block';
  document.getElementById('sendOtpBtn').disabled = false;
  document.getElementById('sendOtpBtn').textContent = 'Send OTP →';
};

W.logout = async () => { await auth.signOut(); location.reload(); };

auth.onAuthStateChanged( async (user) => {
  if (!user) { showLogin(); return; }
  const snap = await db.collection(`${PREFIX}users`).doc(user.uid).get();
  if (!snap.exists || snap.data().role !== 'ADMIN') {
    showLogin();
    toast('Access denied. Admin accounts only.', 'error');
    await auth.signOut();
    return;
  }
  currentUser = { ...snap.data(), uid: user.uid };
  bootApp();
});

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function bootApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('envBadge').textContent = PREFIX === 'prod_' ? 'PRODUCTION' : 'DEVELOPMENT';
  document.getElementById('userName').textContent  = currentUser.name || currentUser.phone;
  document.getElementById('userAv').textContent    = (currentUser.name || currentUser.phone || 'A')[0].toUpperCase();
  loadAll();
}

// ── DATA LOADING ──────────────────────────────────────────────────────────────
function loadAll() {
  listenTasks();
  listenGroups();
  listenUsers();
}

function listenTasks() {
  const q = col.tasks().orderBy('createdAt','desc');
  q.onSnapshot(snap => {
    allTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderStats();
    renderOverviewTasks();
    renderTasks();
  });
}

function listenGroups() {
  const q = col.groups().orderBy('createdAt','desc');
  q.onSnapshot(snap => {
    allGroups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderStats();
    renderGroups();
  });
}

function listenUsers() {
  col.users().onSnapshot(snap => {
    allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderStats();
    renderUsers();
  });
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function renderStats() {
  document.getElementById('st-tasks').textContent  = allTasks.length;
  document.getElementById('st-active').textContent = allTasks.filter(t => t.status === 'ACTIVE').length;
  document.getElementById('st-groups').textContent = allGroups.length;
  document.getElementById('st-users').textContent  = allUsers.length;
}

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
function renderOverviewTasks() {
  const tbody = document.getElementById('overview-tasks-body');
  const tasks = allTasks.slice(0, 8);
  if (!tasks.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty"><span class="empty-icon">◈</span><p>No tasks yet</p></td></tr>`; return; }
  tbody.innerHTML = tasks.map(t => `
    <tr>
      <td><strong>${esc(t.title)}</strong></td>
      <td>${(t.targetGroupNames||[]).map(g=>`<span class="badge badge-dim">${esc(g)}</span>`).join(' ') || '—'}</td>
      <td>${statusBadge(t.status)}</td>
      <td><button class="btn btn-ghost" onclick="W.openResponses('${t.id}','${esc(t.title)}')">View</button></td>
      <td style="color:var(--sub);font-family:var(--mono);font-size:11px">${fmtDate(t.createdAt)}</td>
    </tr>`).join('');
}

// ── TASKS ─────────────────────────────────────────────────────────────────────
function renderTasks(filter = '') {
  const tbody = document.getElementById('tasks-body');
  let tasks = allTasks;
  if (filter) tasks = tasks.filter(t => t.title?.toLowerCase().includes(filter.toLowerCase()));
  document.getElementById('tasks-count').textContent = tasks.length;
  if (!tasks.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty"><span class="empty-icon">◈</span><p>No tasks found</p></td></tr>`; return; }
  tbody.innerHTML = tasks.map(t => `
    <tr>
      <td>
        <strong>${esc(t.title)}</strong>
        <div style="font-size:11px;color:var(--sub);margin-top:2px">${esc((t.description||'').slice(0,60))}${(t.description||'').length>60?'…':''}</div>
        <div style="margin-top:6px">${submissionModeBadges(t)}</div>
      </td>
      <td>${(t.targetGroupNames||[]).map(g=>`<span class="badge badge-dim">${esc(g)}</span>`).join(' ')||'—'}</td>
      <td>${statusBadge(t.status)}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--sub)">${t.deadline ? fmtTs(t.deadline) : '—'}</td>
      <td style="display:flex;gap:6px;align-items:center">
        <button class="btn btn-ghost" onclick="W.openResponses('${t.id}','${esc(t.title)}')">Responses</button>
        <button class="btn btn-danger" onclick="W.archiveTask('${t.id}','${t.status}')">
          ${t.status==='ARCHIVED'?'Restore':'Archive'}
        </button>
        <button class="btn btn-danger" onclick="W.deleteTask('${t.id}','${esc(t.title)}')">Delete</button>
      </td>
    </tr>`).join('');
}

W.filterTasks = (v) => renderTasks(v);

W.archiveTask = async (id, currentStatus) => {
  const newStatus = currentStatus === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED';
  await db.collection(`${PREFIX}tasks`).doc(id).update({ status: newStatus });
  toast(`Task ${newStatus === 'ARCHIVED' ? 'archived' : 'restored'}`, 'success');
};

W.deleteTask = async (taskId, taskTitle) => {
  const label = taskTitle || 'this task';
  if (!confirm(`Delete "${label}" and all responses?`)) return;
  try {
    const respSnap = await col.responses(taskId).get();
    const docs = [...respSnap.docs];
    while (docs.length) {
      const batch = db.batch();
      docs.splice(0, 400).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    await db.collection(`${PREFIX}tasks`).doc(taskId).delete();
    toast('Task deleted', 'success');
  } catch (e) {
    toast(`Delete failed: ${e.message || e}`, 'error');
  }
};

// ── GROUPS ────────────────────────────────────────────────────────────────────
function renderGroups() {
  const grid = document.getElementById('groups-grid');
  if (!allGroups.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><span class="empty-icon">◉</span><p>No groups yet. Create one to get started.</p></div>`;
    return;
  }
  grid.innerHTML = allGroups.map(g => {
    const members = g.memberIds || [];
    const shown   = members.slice(0, 4);
    const extra   = members.length - shown.length;
    return `
    <div class="gcard" onclick="W.openGroupDetail('${g.id}')">
      <div class="gcard-name">${esc(g.name)}</div>
      <div class="gcard-desc">${esc(g.description || 'No description')}</div>
      <div class="gcard-foot">
        <div class="avatars">
          ${shown.map((_,i)=>`<div class="av">${String.fromCharCode(65+i)}</div>`).join('')}
          ${extra > 0 ? `<div class="av av-more">+${extra}</div>` : ''}
          ${!members.length ? `<span style="font-size:11px;color:var(--sub)">No members</span>` : ''}
        </div>
        <span class="badge badge-dim">${members.length} member${members.length!==1?'s':''}</span>
      </div>
    </div>`;
  }).join('');
}

W.openGroupDetail = async (groupId) => {
  activeGroupId = groupId;
  const g = allGroups.find(x => x.id === groupId);
  if (!g) return;
  document.getElementById('gd-title').textContent = g.name;
  document.getElementById('gd-sub').textContent   = g.description || '';
  renderGroupMembers(g);
  openModal('m-groupDetail');
};

async function renderGroupMembers(group) {
  const cont = document.getElementById('gd-members');
  const ids  = group.memberIds || [];
  if (!ids.length) {
    cont.innerHTML = `<div style="text-align:center;padding:24px;color:var(--sub);font-size:13px">No members yet. Add by phone number above.</div>`;
    return;
  }
  cont.innerHTML = `<div class="loading-row"><span class="spin"></span></div>`;
  const members = await Promise.all(ids.map(async uid => {
    const s = await db.collection(`${PREFIX}users`).doc(uid).get();
    return s.exists ? { uid, ...s.data() } : { uid, name:'Unknown', phone:uid };
  }));
  cont.innerHTML = members.map(m => `
    <div class="mrow">
      <div class="mav">${(m.name||m.phone||'?')[0].toUpperCase()}</div>
      <div class="minfo">
        <div class="mname">${esc(m.name||'Unnamed')}</div>
        <div class="mphone">${esc(m.phone||'')}</div>
      </div>
      <button class="btn btn-danger" onclick="W.removeMember('${m.uid}')">Remove</button>
    </div>`).join('');
}

W.addMember = async () => {
  const phone = document.getElementById('add-member-phone').value.trim();
  if (!phone) { toast('Enter a phone number','error'); return; }

  const q = col.users().where('phone','==', phone);
  const snap = await q.get();
  if (snap.empty) { toast('No user found with that number','error'); return; }

  const user = snap.docs[0];
  const gref = db.collection(`${PREFIX}groups`).doc(activeGroupId);
  const uref = db.collection(`${PREFIX}users`).doc(user.id);
  await gref.update({ memberIds: firebase.firestore.FieldValue.arrayUnion(user.id) });
  await uref.update({ groupIds:  firebase.firestore.FieldValue.arrayUnion(activeGroupId) });

  document.getElementById('add-member-phone').value = '';
  toast(`${user.data().name || user.data().phone} added to group`, 'success');
  const g = allGroups.find(x => x.id === activeGroupId);
  if (g) { g.memberIds = [...(g.memberIds||[]), user.id]; renderGroupMembers(g); }
};

W.removeMember = async (uid) => {
  const gref = db.collection(`${PREFIX}groups`).doc(activeGroupId);
  const uref = db.collection(`${PREFIX}users`).doc(uid);
  await gref.update({ memberIds: firebase.firestore.FieldValue.arrayRemove(uid) });
  await uref.update({ groupIds:  firebase.firestore.FieldValue.arrayRemove(activeGroupId) });
  toast('Member removed', 'success');
  const g = allGroups.find(x => x.id === activeGroupId);
  if (g) { g.memberIds = (g.memberIds||[]).filter(x=>x!==uid); renderGroupMembers(g); }
};

W.deleteGroup = async () => {
  if (!confirm('Delete this group? This cannot be undone.')) return;
  await db.collection(`${PREFIX}groups`).doc(activeGroupId).delete();
  closeModal('m-groupDetail');
  toast('Group deleted', 'success');
};

// ── USERS ─────────────────────────────────────────────────────────────────────
function renderUsers(filter = '') {
  const tbody = document.getElementById('users-body');
  let users = allUsers;
  if (filter) users = users.filter(u =>
    (u.name||'').toLowerCase().includes(filter.toLowerCase()) ||
    (u.phone||'').includes(filter)
  );
  document.getElementById('users-count').textContent = users.length;
  if (!users.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty"><span class="empty-icon">◎</span><p>No users found</p></td></tr>`; return; }
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="mav" style="width:28px;height:28px;font-size:10px">${(u.name||u.phone||'?')[0].toUpperCase()}</div>
          <strong>${esc(u.name||'Unnamed')}</strong>
        </div>
      </td>
      <td style="font-family:var(--mono);font-size:12px">${esc(u.phone||'')}</td>
      <td>${u.role==='ADMIN' ? `<span class="badge badge-cyan">ADMIN</span>` : `<span class="badge badge-dim">USER</span>`}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--sub)">${(u.groupIds||[]).length}</td>
      <td><button class="btn btn-ghost" onclick="W.openUserDetail('${u.uid||u.id}')">Manage</button></td>
    </tr>`).join('');
}

W.filterUsers = (v) => renderUsers(v);

W.openUserDetail = (uid) => {
  const u = allUsers.find(x => (x.uid||x.id) === uid);
  if (!u) return;
  document.getElementById('ud-title').textContent = u.name || u.phone || 'User';
  document.getElementById('ud-body').innerHTML = `
    <div class="rblock">
      <div class="rblock-label">User Info</div>
      <div class="form-pair"><span class="form-k">Phone</span><span class="form-v">${esc(u.phone||'—')}</span></div>
      <div class="form-pair"><span class="form-k">Name</span><span class="form-v">${esc(u.name||'—')}</span></div>
      <div class="form-pair"><span class="form-k">Role</span><span class="form-v">${u.role}</span></div>
      <div class="form-pair"><span class="form-k">Groups</span><span class="form-v">${(u.groupIds||[]).length}</span></div>
    </div>`;
  const foot = document.getElementById('ud-foot');
  const isAdmin = u.role === 'ADMIN';
  foot.innerHTML = `
    <button class="btn btn-ghost" onclick="closeModal('m-userDetail')">Close</button>
    <button class="btn ${isAdmin ? 'btn-danger' : 'btn-primary'}" onclick="W.toggleAdmin('${uid}','${u.role}')">
      ${isAdmin ? 'Revoke Admin' : 'Make Admin'}
    </button>`;
  openModal('m-userDetail');
};

W.toggleAdmin = async (uid, currentRole) => {
  const newRole = currentRole === 'ADMIN' ? 'USER' : 'ADMIN';
  await db.collection(`${PREFIX}users`).doc(uid).update({ role: newRole });
  toast(`User ${newRole === 'ADMIN' ? 'promoted to Admin' : 'demoted to User'}`, 'success');
  closeModal('m-userDetail');
};

// ── CREATE TASK ───────────────────────────────────────────────────────────────
function syncCreateTaskOptionState() {
  const formsOn = document.getElementById('ct-forms').checked;
  const msgOn = document.getElementById('ct-msg').checked;
  document.getElementById('ct-forms-config').classList.toggle('ct-config-off', !formsOn);
  document.getElementById('ct-msg-config').classList.toggle('ct-config-off', !msgOn);
}

function syncFieldTypeOptionState() {
  const type = document.getElementById('ct-field-type').value;
  const showOptions = type === 'DROPDOWN' || type === 'CHECKBOX';
  document.getElementById('ct-field-options-wrap').style.display = showOptions ? 'flex' : 'none';
}

function renderTaskFormFields() {
  const list = document.getElementById('ct-fields-list');
  if (!ctFormFields.length) {
    list.innerHTML = `<span class="badge badge-dim">No fields added</span>`;
    return;
  }
  list.innerHTML = ctFormFields.map(f => `
    <span class="f-chip">
      <strong>${esc(f.label)}</strong>
      <span class="badge badge-dim">${esc(f.type)}</span>
      ${f.required ? `<span class="badge badge-amber">Required</span>` : ``}
      ${(f.options || []).length ? `<span class="f-chip-opt">${esc(f.options.join(', '))}</span>` : ``}
      <button type="button" class="f-chip-close" onclick="removeFormField('${f.id}')">✕</button>
    </span>
  `).join('');
}

W.addFormField = () => {
  if (!document.getElementById('ct-forms').checked) {
    toast('Enable Forms before adding fields', 'error');
    return;
  }

  const labelEl = document.getElementById('ct-field-label');
  const typeEl = document.getElementById('ct-field-type');
  const reqEl = document.getElementById('ct-field-required');
  const optionsEl = document.getElementById('ct-field-options');

  const label = labelEl.value.trim();
  const type = typeEl.value;
  const required = reqEl.checked;
  const options = (optionsEl.value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  if (!label) {
    toast('Field label is required', 'error');
    return;
  }
  if ((type === 'DROPDOWN' || type === 'CHECKBOX') && !options.length) {
    toast('Add options for dropdown/checkbox fields', 'error');
    return;
  }

  ctFormFields.push({
    id: `field_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    label,
    type,
    required,
    options
  });

  labelEl.value = '';
  optionsEl.value = '';
  reqEl.checked = false;
  renderTaskFormFields();
};

W.removeFormField = (fieldId) => {
  ctFormFields = ctFormFields.filter(f => f.id !== fieldId);
  renderTaskFormFields();
};

W.openCreateTask = () => {
  document.getElementById('ct-title').value  = '';
  document.getElementById('ct-desc').value   = '';
  document.getElementById('ct-deadline').value = '';
  document.getElementById('ct-msg-prompt').value = '';
  document.getElementById('ct-forms').checked = true;
  document.getElementById('ct-media').checked = true;
  document.getElementById('ct-msg').checked   = true;
  document.getElementById('ct-field-label').value = '';
  document.getElementById('ct-field-type').value = 'TEXT';
  document.getElementById('ct-field-required').checked = false;
  document.getElementById('ct-field-options').value = '';
  ctFormFields = [];
  syncCreateTaskOptionState();
  syncFieldTypeOptionState();
  renderTaskFormFields();
  const chips = document.getElementById('ct-groups-chips');
  chips.innerHTML = allGroups.length
    ? allGroups.map(g => `<span class="chip" data-gid="${g.id}" data-gname="${esc(g.name)}" onclick="this.classList.toggle('on')">${esc(g.name)}</span>`).join('')
    : `<span style="color:var(--sub);font-size:12px">No groups yet. Create a group first.</span>`;
  openModal('m-createTask');
};

W.createTask = async () => {
  const title = document.getElementById('ct-title').value.trim();
  if (!title) { toast('Title is required','error'); return; }
  const selected = [...document.querySelectorAll('#ct-groups-chips .chip.on')];
  if (!selected.length) { toast('Select at least one group','error'); return; }

  const groupIds   = selected.map(c => c.dataset.gid);
  const groupNames = selected.map(c => c.dataset.gname);
  const deadlineVal = document.getElementById('ct-deadline').value;
  const allowForms = document.getElementById('ct-forms').checked;
  const allowMedia = document.getElementById('ct-media').checked;
  const allowMessage = document.getElementById('ct-msg').checked;

  if (!allowForms && !allowMedia && !allowMessage) {
    toast('Enable at least one submission type', 'error');
    return;
  }
  if (allowForms && !ctFormFields.length) {
    toast('Add at least one form field or disable Forms', 'error');
    return;
  }

  const taskData = {
    title,
    description: document.getElementById('ct-desc').value.trim(),
    groupIds,
    targetGroupNames: groupNames,
    createdBy: currentUser.uid,
    status: 'ACTIVE',
    allowForms,
    allowMedia,
    allowMessage,
    messagePrompt: allowMessage ? document.getElementById('ct-msg-prompt').value.trim() : '',
    formFields: allowForms ? ctFormFields : [],
    deadline: deadlineVal ? firebase.firestore.Timestamp.fromDate(new Date(deadlineVal)) : null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  const ref = col.tasks().doc();
  await ref.set({ ...taskData, id: ref.id });
  closeModal('m-createTask');
  toast('Task created and broadcast!', 'success');
};

// ── CREATE GROUP ──────────────────────────────────────────────────────────────
W.openCreateGroup = () => {
  document.getElementById('cg-name').value = '';
  document.getElementById('cg-desc').value = '';
  openModal('m-createGroup');
};

W.createGroup = async () => {
  const name = document.getElementById('cg-name').value.trim();
  if (!name) { toast('Group name is required','error'); return; }
  const ref = col.groups().doc();
  await ref.set({
    id: ref.id, name,
    description: document.getElementById('cg-desc').value.trim(),
    memberIds: [], createdBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  closeModal('m-createGroup');
  toast('Group created!', 'success');
};

// ── RESPONSES ─────────────────────────────────────────────────────────────────
W.openResponses = async (taskId, taskTitle) => {
  document.getElementById('resp-task-title').textContent = taskTitle;
  document.getElementById('resp-task-sub').textContent   = 'Loading responses…';
  document.getElementById('resp-body').innerHTML = `<div class="loading-row"><span class="spin"></span></div>`;
  openModal('m-responses');

  const snap = await col.responses(taskId).orderBy('submittedAt','desc').get();
  const responses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const taskMeta = allTasks.find(t => t.id === taskId) || {};
  const fieldLabels = {};
  (taskMeta.formFields || []).forEach(f => { fieldLabels[f.id] = f.label || f.id; });
  document.getElementById('resp-task-sub').textContent = `${responses.length} response${responses.length!==1?'s':''}`;

  if (!responses.length) {
    document.getElementById('resp-body').innerHTML = `<div class="empty"><span class="empty-icon">◈</span><p>No responses yet</p></div>`;
    return;
  }

  document.getElementById('resp-body').innerHTML = responses.map(r => `
    <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;background:var(--surface-variant)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div style="font-weight:600;font-size:13px">${esc(r.userName||'Unnamed')}</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--sub)">${esc(r.userPhone||'')} · ${fmtTs(r.submittedAt)}</div>
        </div>
        <span class="badge badge-green">Submitted</span>
      </div>
      ${r.message ? `
        <div class="rblock">
          <div class="rblock-label">Message</div>
          <div class="rblock-val">${esc(r.message)}</div>
        </div>` : ''}
      ${Object.keys(r.formData||{}).length ? `
        <div class="rblock">
          <div class="rblock-label">Form Data</div>
          ${Object.entries(r.formData).map(([k,v])=>`
            <div class="form-pair">
              <span class="form-k">${esc(fieldLabels[k] || k)}</span>
              <span class="form-v">${esc(v)}</span>
            </div>`).join('')}
        </div>` : ''}
      ${(r.mediaUrls||[]).length ? `
        <div class="rblock">
          <div class="rblock-label">Attachments (${r.mediaUrls.length})</div>
          <div>${r.mediaUrls.map(m=>`
            <a class="media-link" href="${m.url}" target="_blank">
              ${m.type==='IMAGE'?'🖼':m.type==='VIDEO'?'🎬':'📎'} ${esc(m.name||m.type)}
            </a>`).join('')}
          </div>
        </div>` : ''}
    </div>`).join('');
};

// ── NAV ───────────────────────────────────────────────────────────────────────
W.showPage = (name) => {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  document.getElementById(`nav-${name}`).classList.add('active');
};

// ── MODALS ────────────────────────────────────────────────────────────────────
function openModal(id)  {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
W.closeModal = (id) => {
  document.getElementById(id).classList.remove('open');
  if (!document.querySelector('.overlay.open')) document.body.style.overflow = '';
};
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => {
    if (e.target === o) {
      o.classList.remove('open');
      if (!document.querySelector('.overlay.open')) document.body.style.overflow = '';
    }
  });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const topOpen = document.querySelector('.overlay.open');
  if (!topOpen) return;
  topOpen.classList.remove('open');
  if (!document.querySelector('.overlay.open')) document.body.style.overflow = '';
});

// ── TOAST ─────────────────────────────────────────────────────────────────────
function toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = type; t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3200);
}
W.toast = toast;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts.seconds*1000);
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function fmtTs(ts) { return fmtDate(ts); }

function statusBadge(s) {
  const m = { ACTIVE:'badge-green', COMPLETED:'badge-cyan', ARCHIVED:'badge-amber' };
  return `<span class="badge ${m[s]||'badge-dim'}">${s||'—'}</span>`;
}

function submissionModeBadges(t) {
  const formsOn = t.allowForms !== false;
  const mediaOn = t.allowMedia !== false;
  const msgOn = t.allowMessage !== false;
  const modes = [];
  if (formsOn) modes.push(`<span class="badge badge-cyan">Forms</span>`);
  if (mediaOn) modes.push(`<span class="badge badge-green">Media</span>`);
  if (msgOn) modes.push(`<span class="badge badge-amber">Message</span>`);
  return modes.join(' ') || `<span class="badge badge-red">No submissions</span>`;
}

function showLoginErr(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.style.display = 'block';
}
function hideErr(id) { document.getElementById(id).style.display = 'none'; }

// ── BIND LOGIN BUTTONS (no onclick= in HTML — wired here so firebase scope is accessible) ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('sendOtpBtn').addEventListener('click', W.sendOtp);
  document.getElementById('verifyBtn').addEventListener('click', W.verifyOtp);
  document.getElementById('backToPhoneBtn').addEventListener('click', W.backToPhone);
  document.getElementById('otpInput').addEventListener('input', function() {
    if (this.value.length === 6) W.verifyOtp();
  });
  const ctForms = document.getElementById('ct-forms');
  const ctMsg = document.getElementById('ct-msg');
  const ctFieldType = document.getElementById('ct-field-type');
  if (ctForms) ctForms.addEventListener('change', syncCreateTaskOptionState);
  if (ctMsg) ctMsg.addEventListener('change', syncCreateTaskOptionState);
  if (ctFieldType) ctFieldType.addEventListener('change', syncFieldTypeOptionState);
  syncCreateTaskOptionState();
  syncFieldTypeOptionState();
  renderTaskFormFields();
  // Logout button
  const logoutBtn = document.querySelector('.logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', W.logout);
});


