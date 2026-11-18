const $ = id => document.getElementById(id);
const mobile = matchMedia('(max-width: 760px)');
const clock = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const drafts = new Map();
const pendingMessages = new Map();
const errors = {
  invalid: 'Проверьте введённые данные.',
  unauthorized: 'Войдите по ключу доступа.',
  missing: 'Собеседник или диалог не найден.',
  rate: 'Слишком много запросов. Попробуйте через минуту.',
  unavailable: 'Сервис временно недоступен. Попробуйте ещё раз.',
};
let profile;
let active;
let dialogs = [];
let sending = false;
let lastHistory;
let pollGeneration = 0;
let polling = false;

async function api(operation, payload = {}) {
  let response;
  try {
    response = await fetch('/api/' + operation, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(errors.unavailable);
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  if (response.status === 401 && profile && operation !== 'login') leave();
  const message = operation === 'login' && response.status === 401 ? 'Ключ доступа не найден.' : errors[data.error];
  throw new Error(message ?? errors.unavailable);
}

function syncDialogs() {
  $('dialogs-toggle').setAttribute('aria-expanded', String(!mobile.matches || $('messenger').classList.contains('show-dialogs')));
}

function updateComposer() {
  $('send').disabled = sending || !$('message').value.trim();
}

function renderContacts() {
  const focusedId = document.activeElement?.dataset.dialog;
  $('contact-count').textContent = dialogs.length;
  $('contacts').replaceChildren(...dialogs.map(dialog => {
    const button = document.createElement('button');
    button.className = 'contact';
    button.dataset.dialog = dialog.id;
    button.setAttribute('aria-pressed', String(dialog.id === active));
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = dialog.peer.slice(-2).toUpperCase();
    const summary = document.createElement('span');
    const name = document.createElement('code');
    name.textContent = dialog.peer;
    const preview = document.createElement('small');
    preview.className = 'contact-preview';
    preview.textContent = dialog.preview ?? 'Нет сообщений';
    summary.append(name, preview);
    button.append(avatar, summary);
    button.addEventListener('click', () => openChat(dialog.id));
    return button;
  }));
  if (focusedId) $('contacts').querySelector(`[data-dialog="${focusedId}"]`)?.focus();
}

function renderMessages(messages, scrollToEnd = false) {
  const history = $('history');
  const follow = scrollToEnd || history.scrollHeight - history.scrollTop - history.clientHeight < 48;
  const scrollTop = history.scrollTop;
  const items = messages.map(message => {
    const item = document.createElement('div');
    item.className = message.mine ? 'message' : 'message received';
    const body = document.createElement('p');
    body.textContent = message.text;
    const time = document.createElement('time');
    time.dateTime = message.sentAt;
    time.textContent = clock.format(new Date(message.sentAt));
    item.append(body, time);
    return item;
  });
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-history';
    empty.textContent = active ? 'Здесь пока нет сообщений.' : 'Откройте диалог по публичному ID собеседника.';
    items.push(empty);
  }
  history.replaceChildren(...items);
  history.scrollTop = follow ? history.scrollHeight : scrollTop;
}

async function refreshDialogs(generation = pollGeneration) {
  const data = await api('dialogs');
  if (generation !== pollGeneration) return;
  if (JSON.stringify(data.dialogs) === JSON.stringify(dialogs)) return;
  dialogs = data.dialogs;
  renderContacts();
}

async function refreshHistory(id, scrollToEnd = false, generation = pollGeneration) {
  const data = await api('history', { id });
  if (generation !== pollGeneration || active !== id) return;
  const snapshot = JSON.stringify(data.messages);
  if (snapshot === lastHistory) return;
  lastHistory = snapshot;
  renderMessages(data.messages, scrollToEnd);
}

async function openChat(id) {
  const dialog = dialogs.find(item => item.id === id);
  if (!dialog) return;
  active = id;
  lastHistory = undefined;
  $('peer').textContent = dialog.peer;
  $('chat-avatar').textContent = dialog.peer.slice(-2).toUpperCase();
  $('messenger').classList.remove('show-dialogs');
  syncDialogs();
  $('composer').hidden = false;
  $('message').value = drafts.get(id) ?? '';
  updateComposer();
  $('history').replaceChildren();
  $('chat-status').textContent = 'Загрузка сообщений…';
  renderContacts();
  if (mobile.matches) $('peer').focus();
  try {
    await refreshHistory(id, true);
    if (active === id) $('chat-status').textContent = '';
  } catch (error) {
    if (active === id) $('chat-status').textContent = error.message;
  }
}

function enter(publicId) {
  profile = publicId;
  for (const id of document.querySelectorAll('.own-id code, .public-key code')) id.textContent = publicId;
  $('auth').hidden = true;
  $('messenger').hidden = false;
  $('peer').textContent = 'Диалоги';
  $('composer').hidden = true;
  renderMessages([]);
  $('messenger').classList.toggle('show-dialogs', mobile.matches);
  syncDialogs();
  void poll();
}

function leave() {
  pollGeneration++;
  profile = undefined;
  active = undefined;
  dialogs = [];
  drafts.clear();
  pendingMessages.clear();
  $('contacts').replaceChildren();
  $('chat-status').textContent = '';
  $('history').replaceChildren();
  $('access-key').value = '';
  $('access-key').type = 'password';
  $('toggle-key').textContent = 'Показать';
  $('toggle-key').setAttribute('aria-pressed', 'false');
  $('toggle-key').setAttribute('aria-label', 'Показать ключ');
  $('key-status').textContent = '0 / 16';
  $('new-key').querySelector('code').textContent = '';
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('messenger').hidden = true;
  $('auth').hidden = false;
  $('new-key').hidden = true;
  $('login').hidden = false;
  $('access-key').focus();
}

async function poll() {
  if (polling || !profile || document.hidden) return;
  polling = true;
  const generation = pollGeneration;
  try {
    await refreshDialogs(generation);
    if (generation === pollGeneration && active) await refreshHistory(active, false, generation);
    if (generation === pollGeneration && $('chat-status').textContent === errors.unavailable) {
      $('chat-status').textContent = '';
    }
  } catch (error) {
    if (generation === pollGeneration && !$('chat-status').textContent) $('chat-status').textContent = error.message;
  } finally {
    polling = false;
  }
}

$('access-key').addEventListener('input', event => {
  const key = event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 16);
  event.target.value = key.match(/.{1,4}/g)?.join(' ') ?? '';
  $('key-status').textContent = key.length + ' / 16';
});

let authenticating = false;
async function authenticate(operation) {
  if (authenticating) return;
  authenticating = true;
  const buttons = $('login').querySelectorAll('button');
  for (const button of buttons) button.disabled = true;
  $('key-status').textContent = '';
  try {
    const data = await api(operation, { key: $('access-key').value.replaceAll(' ', '') });
    $('access-key').value = '';
    if (operation === 'login') enter(data.publicId);
    else {
      $('login').hidden = true;
      $('new-key').hidden = false;
      $('copy-key-status').textContent = 'Ключ понадобится для входа с другого устройства.';
      const key = $('new-key').querySelector('code');
      key.textContent = data.key.match(/.{4}/g).join(' ');
      $('continue').onclick = () => {
        key.textContent = '';
        enter(data.publicId);
      };
      $('continue').focus();
    }
  } catch (error) {
    $('key-status').textContent = error.message;
  } finally {
    authenticating = false;
    for (const button of buttons) button.disabled = false;
  }
}

$('login').addEventListener('submit', event => {
  event.preventDefault();
  void authenticate('login');
});
$('create').addEventListener('click', () => void authenticate('create'));
$('back').addEventListener('click', () => {
  $('access-key').value = $('new-key').querySelector('code').textContent;
  $('new-key').querySelector('code').textContent = '';
  $('new-key').hidden = true;
  $('login').hidden = false;
  $('access-key').dispatchEvent(new Event('input'));
  $('access-key').focus();
});
$('logout').addEventListener('click', async () => {
  try {
    await api('logout');
    leave();
  } catch (error) {
    if (profile) $('chat-status').textContent = error.message;
  }
});
$('dialogs-toggle').addEventListener('click', () => {
  if (mobile.matches) $('messenger').classList.toggle('show-dialogs');
  syncDialogs();
});
mobile.addEventListener('change', syncDialogs);
for (const button of document.querySelectorAll('.search-trigger')) button.addEventListener('click', () => {
  $('search-error').textContent = '';
  $('search').showModal();
  $('public-id').focus();
});
for (const button of document.querySelectorAll('.profile-trigger')) {
  button.addEventListener('click', () => {
    $('copy-status').textContent = '';
    $('profile').showModal();
  });
}
for (const button of document.querySelectorAll('.close')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
$('profile-ok').addEventListener('click', () => $('profile').close());
$('copy-id').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(profile);
    $('copy-status').textContent = 'Публичный ID скопирован.';
  } catch {
    $('copy-status').textContent = 'Выделите и скопируйте ID вручную.';
  }
});
$('search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  if (button.disabled) return;
  button.disabled = true;
  try {
    const { id } = await api('open', { peer: $('public-id').value.trim().toLowerCase() });
    await refreshDialogs();
    $('search').close();
    await openChat(id);
  } catch (error) {
    $('search-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$('message').addEventListener('input', event => {
  drafts.set(active, event.target.value);
  updateComposer();
});
$('message').addEventListener('keydown', event => {
  if (mobile.matches || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!$('send').disabled) $('composer').requestSubmit();
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('message');
  const text = input.value.trim();
  const id = active;
  if (!text || !id || sending) return;
  const previous = pendingMessages.get(id);
  const messageId = previous?.text === text ? previous.messageId : crypto.randomUUID();
  pendingMessages.set(id, { text, messageId });
  sending = true;
  updateComposer();
  try {
    await api('send', { id, text, messageId });
    pendingMessages.delete(id);
    if (drafts.get(id)?.trim() === text) {
      drafts.delete(id);
      if (active === id) input.value = '';
    }
    if (active === id) $('chat-status').textContent = '';
    await Promise.all([refreshDialogs(), refreshHistory(id, true)]);
  } catch (error) {
    if (active === id) $('chat-status').textContent = error.message;
  } finally {
    sending = false;
    updateComposer();
  }
});

syncDialogs();
setInterval(poll, 6000);
document.addEventListener('visibilitychange', poll);
const loginButtons = $('login').querySelectorAll('button');
for (const button of loginButtons) button.disabled = true;
api('profile')
  .then(data => enter(data.publicId))
  .catch(error => {
    if (error.message !== errors.unauthorized) $('key-status').textContent = error.message;
  })
  .finally(() => {
    for (const button of loginButtons) button.disabled = false;
  });

$('toggle-key').addEventListener('click', () => {
  const visible = $('access-key').type === 'password';
  $('access-key').type = visible ? 'text' : 'password';
  $('toggle-key').textContent = visible ? 'Скрыть' : 'Показать';
  $('toggle-key').setAttribute('aria-label', visible ? 'Скрыть ключ' : 'Показать ключ');
  $('toggle-key').setAttribute('aria-pressed', String(visible));
  $('access-key').focus();
});
$('copy-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('new-key').querySelector('code').textContent);
    $('copy-key-status').textContent = 'Ключ скопирован. Сохраните его перед продолжением.';
  } catch {
    $('copy-key-status').textContent = 'Выделите ключ и скопируйте его вручную.';
  }
});
