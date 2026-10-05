// The converter page. Its script avoids backticks and dollar-brace because this file is a template literal.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fc2mp4</title>
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
  <h1>Fightcade replay → MP4</h1>
  <p class="sub">Street Fighter III: 3rd Strike</p>
  <div id="app" class="muted">Loading…</div>
</main>
<script>
  var app = document.getElementById('app');
  var me = null;
  var tracked = {};
  var MAX_POLL_FAILURES = 5;
  var listTimer = null;

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

  // Leaving the converter (logged out, password screen) stops its list refresh, or the login form
  // would be redrawn every 5 s.
  function show(node) { clearInterval(listTimer); app.className = ''; app.textContent = ''; app.appendChild(node); }

  function start() {
    api('GET', '/api/state').then(function (r) {
      if (r.status === 503) { setTimeout(start, 2000); return; }
      var s = r.data;
      if (!s.setUp) return show(el('p', { class: 'muted', text: 'Not set up yet. The admin creates the first account at /admin.' }));
      if (!s.user) return showLogin();
      me = s.user;
      if (me.mustChangePassword) return showChangePassword();
      showApp();
    }).catch(function () { app.textContent = 'The server is not reachable.'; setTimeout(start, 3000); });
  }

  function showLogin() {
    var name = el('input', { placeholder: 'Username', autocomplete: 'username', required: '' });
    var password = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: '' });
    var error = el('div', { class: 'error' });
    var form = el('form', { on: { submit: function (e) {
      e.preventDefault();
      api('POST', '/api/login', { name: name.value, password: password.value }).then(function (r) {
        if (r.ok) start(); else error.textContent = errorText(r.data);
      });
    } } }, [name, password, el('button', { text: 'Log in' })]);
    show(el('div', {}, [el('h2', { text: 'Log in' }), form, error]));
  }

  function showChangePassword() {
    var current = el('input', { type: 'password', placeholder: 'Current (temporary) password', autocomplete: 'current-password', required: '' });
    var next = el('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password', required: '' });
    var again = el('input', { type: 'password', placeholder: 'New password again', autocomplete: 'new-password', required: '' });
    var error = el('div', { class: 'error' });
    var form = el('form', { on: { submit: function (e) {
      e.preventDefault();
      if (next.value !== again.value) { error.textContent = 'The two new passwords are different.'; return; }
      api('POST', '/api/password', { current: current.value, password: next.value }).then(function (r) {
        if (r.ok) start(); else error.textContent = errorText(r.data);
      });
    } } }, [current, next, again, el('button', { text: 'Save' })]);
    show(el('div', {}, [el('h2', { text: 'Choose your password' }), el('p', { class: 'muted', text: 'Hello ' + me.name + '. Replace the temporary password you were given.' }), form, error]));
  }

  var quota, mine, listBody, filter, formError;

  function quotaText() {
    return me.limit === null ? 'No daily limit' : (me.limit - me.usedToday) + ' of ' + me.limit + ' replays left today';
  }

  function refreshMe() {
    api('GET', '/api/state').then(function (r) { if (r.ok && r.data.user) { me = r.data.user; quota.textContent = quotaText(); } });
  }

  function showApp() {
    quota = el('span', { class: 'muted', text: quotaText() });
    var logout = el('button', { class: 'link', text: 'Log out', on: { click: function () { api('POST', '/api/logout', {}).then(start); } } });
    var input = el('input', { placeholder: 'Paste a Fightcade replay link', autocomplete: 'off', required: '' });
    formError = el('div', { class: 'error' });
    var form = el('form', { on: { submit: function (e) {
      e.preventDefault();
      formError.textContent = '';
      api('POST', '/api/jobs', { url: input.value }).then(function (r) {
        if (r.status === 401) return start();
        if (!r.ok) { formError.textContent = errorText(r.data); return; }
        input.value = '';
        track(r.data.id);
        refreshMe();
      }).catch(function () { formError.textContent = 'The server is not reachable.'; });
    } } }, [input, el('button', { text: 'Convert' })]);
    mine = el('ul');
    filter = el('select', { on: { change: loadList } }, [el('option', { value: '', text: 'Everyone' })]);
    listBody = el('tbody');
    var table = el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: 'Replay' }), el('th', { text: 'Uploaded by' }), el('th', { text: 'Date' }), el('th', { text: 'Status' }), el('th', { text: '' })])]), listBody]);
    show(el('div', {}, [
      el('div', { class: 'bar' }, [el('span', {}, [el('strong', { text: me.name }), el('span', { text: ' · ' }), quota]), logout]),
      form, formError, mine,
      el('h2', { text: 'Conversions' }),
      el('div', { class: 'bar' }, [el('label', { class: 'muted', text: 'Uploaded by ' }, [filter])]),
      table,
    ]));
    loadList();
    listTimer = setInterval(loadList, 5000);
  }

  function loadList() {
    var by = filter.value;
    api('GET', '/api/conversions' + (by ? '?by=' + encodeURIComponent(by) : '')).then(function (r) {
      if (r.status === 401) return start();
      if (!r.ok) return;
      if (!by) updateFilter(r.data.conversions);
      listBody.textContent = '';
      r.data.conversions.forEach(function (c) { listBody.appendChild(row(c)); });
    });
  }

  function updateFilter(conversions) {
    var names = {};
    conversions.forEach(function (c) { names[c.by] = true; });
    var current = filter.value;
    filter.textContent = '';
    filter.appendChild(el('option', { value: '', text: 'Everyone' }));
    Object.keys(names).sort().forEach(function (n) { filter.appendChild(el('option', { value: n, text: n })); });
    filter.value = current;
  }

  var STATUS = { queued: 'Waiting', converting: 'Converting', done: 'Done', failed: 'Failed' };

  function row(c) {
    var actions = el('td');
    if (c.state === 'done') actions.appendChild(el('a', { href: '/api/jobs/' + c.id + '/file', download: c.id + '.mp4', text: 'Download' }));
    if (me.admin && (c.state === 'done' || c.state === 'failed')) {
      var del = el('button', { class: 'link', text: 'Delete' });
      var armed = false;
      del.addEventListener('click', function () {
        if (!armed) { armed = true; del.textContent = 'Confirm?'; setTimeout(function () { armed = false; del.textContent = 'Delete'; }, 3000); return; }
        api('DELETE', '/api/conversions/' + c.id).then(function (r) { if (r.ok) loadList(); else formError.textContent = errorText(r.data); });
      });
      actions.appendChild(document.createTextNode(' '));
      actions.appendChild(del);
    }
    return el('tr', {}, [
      el('td', { class: 'id', text: c.id }), el('td', { text: c.by }),
      el('td', { text: new Date(c.requestedAt).toLocaleString() }), el('td', { text: STATUS[c.state] || c.state }), actions,
    ]);
  }

  function track(id) {
    var item = tracked[id];
    if (!item) { item = { li: el('li'), downloaded: false, polling: false }; tracked[id] = item; }
    else item.downloaded = false;
    mine.insertBefore(item.li, mine.firstChild);
    if (!item.polling) poll(id);
  }

  function poll(id) {
    var item = tracked[id];
    item.polling = true;
    fetch('/api/jobs/' + id)
      .then(function (res) {
        if (res.status === 404) return { state: 'failed', error: 'Unknown replay — the server may have restarted' };
        if (res.status === 401) { start(); throw new Error('logged out'); }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (view) {
        item.failures = 0;
        render(id, view);
        if (view.state === 'queued' || view.state === 'converting') setTimeout(function () { poll(id); }, 1000);
        else { item.polling = false; loadList(); refreshMe(); }
      })
      .catch(function () {
        item.failures = (item.failures || 0) + 1;
        if (item.failures < MAX_POLL_FAILURES) { setTimeout(function () { poll(id); }, 2000); return; }
        item.polling = false;
        item.failures = 0;
        render(id, { state: 'failed', error: 'Lost contact with the server' });
      });
  }

  function clock(total) {
    var s = Math.floor(total);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function render(id, view) {
    var item = tracked[id];
    item.li.textContent = '';
    item.li.appendChild(el('div', { class: 'id', text: id }));
    var status = el('div', { class: 'muted' });
    item.li.appendChild(status);
    if (view.state === 'queued') {
      status.textContent = view.position === 0 ? 'Waiting…' : 'Waiting — ' + view.position + (view.position === 1 ? ' replay' : ' replays') + ' ahead';
    } else if (view.state === 'converting') {
      status.textContent = view.seconds > 0 ? 'Converting… ' + clock(view.seconds) + ' of replay (×' + view.speed.toFixed(1) + ')' : 'Converting… connecting to the replay';
    } else if (view.state === 'done') {
      status.textContent = item.downloaded ? 'Done. ' : 'Done — the download has started. ';
      var link = el('a', { href: '/api/jobs/' + id + '/file', download: id + '.mp4', text: 'Download again' });
      status.appendChild(link);
      if (!item.downloaded) { item.downloaded = true; link.click(); }
    } else {
      status.className = 'error';
      status.textContent = view.error + (view.hint ? ' — ' + view.hint : '') + ' (paste the link again to retry)';
    }
  }

  start();
</script>
</body>
</html>
`;
