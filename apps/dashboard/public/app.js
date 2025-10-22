const authCard = document.getElementById('auth-card');
const dashboard = document.getElementById('dashboard');
const showLoginButton = document.getElementById('show-login');
const showRegisterButton = document.getElementById('show-register');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const jobForm = document.getElementById('job-form');
const refreshJobsButton = document.getElementById('refresh-jobs');
const logoutButton = document.getElementById('logout-button');
const welcomeText = document.getElementById('welcome-text');
const jobsTable = document.getElementById('jobs-table');
const jobsEmpty = document.getElementById('jobs-empty');
const jobsTableBody = jobsTable.querySelector('tbody');
const jobRowTemplate = document.getElementById('job-row-template');

let jobsPoller = null;

function setMessage(form, message, type = 'error') {
  const el = document.querySelector(`.form-error[data-for="${form}"]`);
  if (!el) return;
  el.textContent = message || '';
  el.dataset.state = message ? type : '';
}

function clearMessages() {
  document.querySelectorAll('.form-error').forEach((el) => {
    el.textContent = '';
    el.dataset.state = '';
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'));
        return;
      }
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => {
      reject(reader.error || new Error('Failed to read file'));
    };
    reader.readAsDataURL(file);
  });
}

function toggleAuth(view) {
  clearMessages();
  if (view === 'login') {
    showLoginButton.classList.add('active');
    showRegisterButton.classList.remove('active');
    loginForm.classList.add('active');
    registerForm.classList.remove('active');
  } else {
    showRegisterButton.classList.add('active');
    showLoginButton.classList.remove('active');
    registerForm.classList.add('active');
    loginForm.classList.remove('active');
  }
}

showLoginButton.addEventListener('click', () => toggleAuth('login'));
showRegisterButton.addEventListener('click', () => toggleAuth('register'));

async function handleAuth(path, data, formKey) {
  clearMessages();
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    setMessage(formKey, body.error || 'Something went wrong');
    return null;
  }

  const body = await response.json();
  return body.user;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  const user = await handleAuth('/api/auth/login', {
    email: formData.get('email'),
    password: formData.get('password'),
  }, 'login');
  if (user) {
    await loadSession();
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(registerForm);
  const user = await handleAuth('/api/auth/register', {
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  }, 'register');
  if (user) {
    await loadSession();
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  setDashboard(null);
});

function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function buildActionLinks(job) {
  if (!job.output || job.status !== 'completed') {
    if (job.status === 'failed') {
      return `<span class="status" data-status="failed">Failed</span>`;
    }
    return '<span class="status" data-status="processing">In progress</span>';
  }
  return [
    `<a href="/api/jobs/${job.id}/files/clip" target="_blank">Download clip</a>`,
    `<a href="/api/jobs/${job.id}/files/captions" target="_blank">Captions</a>`,
    `<a href="/api/jobs/${job.id}/files/timeline" target="_blank">Timeline</a>`,
  ].join('');
}

function updateJobsTable(jobs) {
  jobsTableBody.innerHTML = '';
  if (!jobs || jobs.length === 0) {
    jobsEmpty.style.display = 'block';
    jobsTable.classList.remove('active');
    return;
  }
  jobsEmpty.style.display = 'none';
  jobsTable.classList.add('active');
  jobs.forEach((job) => {
    const node = jobRowTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.id').textContent = job.id;
    node.querySelector('.submitted').textContent = formatDate(job.createdAt);
    const status = node.querySelector('.status');
    status.textContent = job.status;
    status.dataset.status = job.status;
    node.querySelector('.actions').innerHTML = buildActionLinks(job);
    jobsTableBody.appendChild(node);
  });
}

async function fetchJobs() {
  const response = await fetch('/api/jobs');
  if (!response.ok) {
    return;
  }
  const body = await response.json();
  updateJobsTable(body.jobs || []);
}

async function loadSession() {
  const response = await fetch('/api/session');
  if (!response.ok) {
    setDashboard(null);
    return;
  }
  const body = await response.json();
  setDashboard(body.user || null);
}

function setDashboard(user) {
  if (jobsPoller) {
    clearInterval(jobsPoller);
    jobsPoller = null;
  }
  if (!user) {
    authCard.classList.add('active');
    dashboard.classList.remove('active');
    welcomeText.textContent = '';
    return;
  }
  welcomeText.textContent = `Welcome back, ${user.name}!`;
  authCard.classList.remove('active');
  dashboard.classList.add('active');
  fetchJobs();
  jobsPoller = setInterval(fetchJobs, 6000);
}

jobForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  const formData = new FormData(jobForm);
  const hasFile = formData.get('sourceFile') instanceof File && formData.get('sourceFile').size > 0;
  const hasUrl = typeof formData.get('sourceUrl') === 'string' && formData.get('sourceUrl').trim().length > 0;
  if (!hasFile && !hasUrl) {
    setMessage('job', 'Upload a video or provide a URL');
    return;
  }
  const submitButton = jobForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Queuing…';
  try {
    const payload = {};
    if (hasFile) {
      const file = formData.get('sourceFile');
      const base64 = await fileToBase64(file);
      payload.upload = {
        filename: file.name,
        mimeType: file.type,
        data: base64,
      };
    }
    if (hasUrl) {
      payload.sourceUrl = formData.get('sourceUrl').trim();
    }
    const watermark = formData.get('watermarkText');
    if (typeof watermark === 'string' && watermark.trim().length > 0) {
      payload.watermarkText = watermark.trim();
    }
    const maxDuration = Number.parseInt(formData.get('maxDurationSeconds'), 10);
    if (Number.isFinite(maxDuration)) {
      payload.maxDurationSeconds = maxDuration;
    }

    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setMessage('job', body.error || 'Failed to queue job');
    } else {
      jobForm.reset();
      setMessage('job', 'Queued successfully!', 'success');
      fetchJobs();
    }
  } catch (error) {
    setMessage('job', 'Unexpected error submitting job');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Queue clip';
  }
});

refreshJobsButton.addEventListener('click', () => {
  fetchJobs();
});

loadSession();
