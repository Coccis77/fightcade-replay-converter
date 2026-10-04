// The whole web page: one file, no external resources. The script avoids `${` and backticks because
// this file is itself a template literal.
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
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { margin: 0 0 24px; color: var(--muted); }
  form { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
  button { padding: 10px 16px; font: inherit; color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
  #form-error { min-height: 1.5em; margin: 8px 0 0; color: var(--err); }
  ul { list-style: none; margin: 16px 0 0; padding: 0; }
  li { padding: 12px 0; border-top: 1px solid var(--line); }
  .id { font-family: ui-monospace, monospace; font-size: 14px; }
  .status { color: var(--muted); }
  .status.error { color: var(--err); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Fightcade replay → MP4</h1>
  <p class="sub">Street Fighter III: 3rd Strike</p>
  <form id="form">
    <input id="url" placeholder="Paste a Fightcade replay link" autocomplete="off" required>
    <button>Convert</button>
  </form>
  <div id="form-error"></div>
  <ul id="jobs"></ul>
</main>
<script>
  var form = document.getElementById('form');
  var input = document.getElementById('url');
  var formError = document.getElementById('form-error');
  var list = document.getElementById('jobs');
  var tracked = {};

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    formError.textContent = '';
    fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input.value }) })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (answer) {
        if (!answer.ok) { formError.textContent = answer.body.error + (answer.body.hint ? ' — ' + answer.body.hint : ''); return; }
        input.value = '';
        track(answer.body.id);
      })
      .catch(function () { formError.textContent = 'The server is not reachable.'; });
  });

  function track(id) {
    var item = tracked[id];
    if (!item) {
      item = { li: document.createElement('li'), downloaded: false, polling: false };
      tracked[id] = item;
    } else {
      item.downloaded = false;
    }
    list.insertBefore(item.li, list.firstChild);
    if (!item.polling) poll(id);
  }

  // A network blip must not stop the updates: retry a few times before giving up.
  var MAX_POLL_FAILURES = 5;

  function poll(id) {
    var item = tracked[id];
    item.polling = true;
    fetch('/api/jobs/' + id)
      .then(function (res) {
        if (res.status === 404) return { state: 'failed', error: 'Unknown replay — the server may have restarted' };
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (view) {
        item.failures = 0;
        render(id, view);
        if (view.state === 'queued' || view.state === 'converting') setTimeout(function () { poll(id); }, 1000);
        else item.polling = false;
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
    var name = document.createElement('div');
    name.className = 'id';
    name.textContent = id;
    item.li.appendChild(name);
    var status = document.createElement('div');
    status.className = 'status';
    item.li.appendChild(status);
    if (view.state === 'queued') {
      status.textContent = view.position === 0 ? 'Waiting…' : 'Waiting — ' + view.position + (view.position === 1 ? ' replay' : ' replays') + ' ahead';
    } else if (view.state === 'converting') {
      status.textContent = view.seconds > 0 ? 'Converting… ' + clock(view.seconds) + ' of replay (×' + view.speed.toFixed(1) + ')' : 'Converting… connecting to the replay';
    } else if (view.state === 'done') {
      status.textContent = item.downloaded ? 'Done. ' : 'Done — the download has started. ';
      var link = document.createElement('a');
      link.href = '/api/jobs/' + id + '/file';
      link.setAttribute('download', id + '.mp4');
      link.textContent = 'Download again';
      status.appendChild(link);
      if (!item.downloaded) { item.downloaded = true; link.click(); }
    } else {
      status.className = 'status error';
      status.textContent = view.error + (view.hint ? ' — ' + view.hint : '') + ' (paste the link again to retry)';
    }
  }
</script>
</body>
</html>
`;
