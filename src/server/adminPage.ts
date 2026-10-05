// The admin page (/admin): first-time setup, admin login, users. Same template-literal rules as page.ts.
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fc2mp4 admin</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --accent: #0a66c2; --err: #c62828; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #f2f2f2; --muted: #a1a1a6; --line: #38383c; --accent: #4c9aff; --err: #ff6b6b; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; }
.sub, .muted { color: var(--muted); } .sub { margin: 0 0 24px; }
form { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 8px; }
input, select { flex: 1; min-width: 0; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
input.small { flex: 0 0 90px; }
button { padding: 10px 16px; font: inherit; color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
button.link { padding: 0; color: var(--accent); background: none; }
.error { color: var(--err); min-height: 1.5em; margin: 4px 0; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 16px; }
ul { list-style: none; margin: 8px 0 0; padding: 0; } li { padding: 12px 0; border-top: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 8px 6px; border-top: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-weight: 500; } .id { font-family: ui-monospace, monospace; font-size: 14px; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>fc2mp4 admin</h1>
  <p class="sub"><a href="/">Open the converter</a></p>
  <div id="app" class="muted">Loading…</div>
</main>
<script>
  var app = document.getElementById('app');

  function el(tag, props, children) {
    var node = document.createElement(tag);
    for (var key in props || {}) {
      if (key === 'text') node.textContent = props[key];
      else if (key === 'on') for (var ev in props.on) node.addEventListener(ev, props.on[ev]);
      else node.setAttribute(key, props[key]);
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function api(method, path, body) {
    var options = { method: method, headers: {} };
    if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
    });
  }

  function errorText(data) { return (data.error || 'Something went wrong') + (data.hint ? ' — ' + data.hint : ''); }
  function show(node) { app.className = ''; app.textContent = ''; app.appendChild(node); }

  function start() {
    api('GET', '/api/state').then(function (r) {
      if (r.status === 503) { setTimeout(start, 2000); return; }
      var s = r.data;
      if (!s.setUp) return showSetup();
      if (!s.user) return showLogin();
      if (!s.user.admin) return show(el('p', { text: 'This page is for the admin. You are logged in as ' + s.user.name + '.' }));
      showUsers();
    }).catch(function () { app.textContent = 'The server is not reachable.'; setTimeout(start, 3000); });
  }

  function credentialsForm(title, button, path, withRepeat) {
    var name = el('input', { placeholder: 'Username', autocomplete: 'username', required: '' });
    var password = el('input', { type: 'password', placeholder: withRepeat ? 'Password (8+ characters)' : 'Password', autocomplete: withRepeat ? 'new-password' : 'current-password', required: '' });
    var again = withRepeat ? el('input', { type: 'password', placeholder: 'Password again', autocomplete: 'new-password', required: '' }) : null;
    var error = el('div', { class: 'error' });
    var form = el('form', { on: { submit: function (e) {
      e.preventDefault();
      if (again && password.value !== again.value) { error.textContent = 'The two passwords are different.'; return; }
      api('POST', path, { name: name.value, password: password.value }).then(function (r) {
        if (r.ok) start(); else error.textContent = errorText(r.data);
      });
    } } }, [name, password, again, el('button', { text: button })]);
    show(el('div', {}, [el('h2', { text: title }), form, error]));
  }

  function showSetup() { credentialsForm('Create the admin account', 'Create', '/api/setup', true); }
  function showLogin() { credentialsForm('Admin login', 'Log in', '/api/login', false); }

  var error;

  function showUsers() {
    error = el('div', { class: 'error' });
    var name = el('input', { placeholder: 'Username', autocomplete: 'off', required: '' });
    var password = el('input', { placeholder: 'Temporary password (8+ characters)', autocomplete: 'off', required: '' });
    var limit = el('input', { class: 'small', type: 'number', min: '0', max: '1000', value: '3', title: 'Daily limit' });
    var add = el('form', { on: { submit: function (e) {
      e.preventDefault();
      api('POST', '/api/admin/users', { name: name.value, password: password.value, limit: Number(limit.value) }).then(function (r) {
        if (!r.ok) { error.textContent = errorText(r.data); return; }
        name.value = ''; password.value = ''; limit.value = '3'; error.textContent = '';
        loadUsers();
      });
    } } }, [name, password, limit, el('button', { text: 'Add user' })]);
    var logout = el('button', { class: 'link', text: 'Log out', on: { click: function () { api('POST', '/api/logout', {}).then(start); } } });
    var body = el('tbody', { id: 'users' });
    var table = el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: 'User' }), el('th', { text: 'Status' }), el('th', { text: 'Daily limit' }), el('th', { text: 'Today' }), el('th', { text: '' })])]), body]);
    show(el('div', {}, [el('div', { class: 'bar' }, [el('h2', { text: 'Users' }), logout]), table, el('h2', { text: 'Add user' }), add, error]));
    loadUsers();
  }

  function loadUsers() {
    api('GET', '/api/admin/users').then(function (r) {
      if (r.status === 401 || r.status === 403) return start();
      var body = document.getElementById('users');
      body.textContent = '';
      r.data.users.forEach(function (u) { body.appendChild(userRow(u)); });
    });
  }

  function change(name, patch) {
    return api('PATCH', '/api/admin/users/' + encodeURIComponent(name), patch).then(function (r) {
      if (!r.ok) error.textContent = errorText(r.data); else { error.textContent = ''; loadUsers(); }
    });
  }

  function twoClick(label, action) {
    var button = el('button', { class: 'link', text: label });
    var armed = false;
    button.addEventListener('click', function () {
      if (!armed) { armed = true; button.textContent = 'Confirm?'; setTimeout(function () { armed = false; button.textContent = label; }, 3000); return; }
      action();
    });
    return button;
  }

  function userRow(u) {
    var status = u.admin ? 'Admin' : u.disabled ? 'Disabled' : u.mustChangePassword ? 'Must change password' : 'Active';
    var limitCell = el('td', { text: u.admin ? 'Unlimited' : '' });
    var actions = el('td');
    if (!u.admin) {
      var limit = el('input', { class: 'small', type: 'number', min: '0', max: '1000', value: String(u.limit) });
      limitCell.appendChild(limit);
      limitCell.appendChild(el('button', { class: 'link', text: ' Save', on: { click: function () { change(u.name, { limit: Number(limit.value) }); } } }));
      var temp = el('input', { placeholder: 'New temporary password', autocomplete: 'off' });
      actions.appendChild(temp);
      actions.appendChild(el('button', { class: 'link', text: 'Reset password', on: { click: function () {
        change(u.name, { password: temp.value }).then(function () { if (!error.textContent) error.textContent = 'New temporary password for ' + u.name + ': ' + temp.value; });
      } } }));
      actions.appendChild(document.createTextNode(' · '));
      actions.appendChild(el('button', { class: 'link', text: u.disabled ? 'Enable' : 'Disable', on: { click: function () { change(u.name, { disabled: !u.disabled }); } } }));
      actions.appendChild(document.createTextNode(' · '));
      actions.appendChild(twoClick('Delete', function () {
        api('DELETE', '/api/admin/users/' + encodeURIComponent(u.name)).then(function (r) { if (!r.ok) error.textContent = errorText(r.data); else loadUsers(); });
      }));
    }
    return el('tr', {}, [el('td', { text: u.name }), el('td', { text: status }), limitCell, el('td', { text: u.admin ? '—' : String(u.usedToday) }), actions]);
  }

  start();
</script>
</body>
</html>
`;
