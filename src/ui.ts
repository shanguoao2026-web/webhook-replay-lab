export function renderUiPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>webhook-replay-lab</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #17140f;
    --bg-raise: #221e17;
    --line: #3c3428;
    --ink: #f6f0e6;
    --muted: #b4a690;
    --amber: #e79b12;
    --amber-ink: #2a1d04;
    --paper: #f4efe4;
    --paper-ink: #241e16;
    --ok: #8fce7a;
    --danger: #ef7a62;
    --shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: "Segoe UI", Helvetica, Arial, sans-serif;
    background:
      radial-gradient(1200px 400px at 10% -10%, rgba(231, 155, 18, 0.16), transparent 50%),
      var(--bg);
    color: var(--ink);
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--line);
    background: rgba(23, 20, 15, 0.9);
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .mark {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    background: var(--amber);
    color: var(--amber-ink);
    font-weight: 750;
    letter-spacing: 0.02em;
    border-radius: 8px;
  }
  .titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  h1 { font-size: 16px; margin: 0; font-weight: 680; letter-spacing: 0.01em; }
  .sub { color: var(--muted); font-size: 12px; }
  header .spacer { flex: 1; }
  button, input, label { font: inherit; }
  button {
    background: var(--bg-raise);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
  }
  button:hover { border-color: var(--amber); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
  button:disabled { opacity: 0.55; cursor: wait; }
  .live { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  main {
    display: grid;
    grid-template-columns: minmax(260px, 340px) 1fr;
    min-height: calc(100% - 65px);
  }
  aside {
    border-right: 1px solid var(--line);
    padding: 12px;
    overflow: auto;
    max-height: calc(100vh - 65px);
  }
  .row {
    width: 100%;
    text-align: left;
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas: "method path bytes" "time time time";
    gap: 4px 8px;
    margin-bottom: 8px;
    background: var(--bg-raise);
  }
  .row.is-selected { border-color: var(--amber); box-shadow: inset 3px 0 0 var(--amber); }
  .method { grid-area: method; color: var(--amber); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .path { grid-area: path; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bytes, .time { color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .bytes { grid-area: bytes; }
  .time { grid-area: time; }
  section { padding: 20px; overflow: auto; max-height: calc(100vh - 65px); }
  .hint { color: var(--muted); line-height: 1.5; }
  .panel {
    background: var(--paper);
    color: var(--paper-ink);
    border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 16px;
  }
  .meta, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .meta { color: #5c5144; margin-bottom: 12px; }
  h2 { margin: 18px 0 8px; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: #6d6254; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  form.actions { margin-top: 8px; }
  input[type="url"] {
    flex: 1;
    min-width: 220px;
    background: #fffdf8;
    color: var(--paper-ink);
    border: 1px solid #d9d0c2;
    border-radius: 8px;
    padding: 8px 10px;
  }
  #replay-button, #copy-curl { background: var(--amber); color: var(--amber-ink); border-color: transparent; font-weight: 650; }
  #status { color: var(--muted); font-size: 13px; min-height: 1.2em; }
  #replay-result:not(:empty) { margin-top: 12px; }
  .check { color: var(--paper-ink); font-size: 14px; }
  @media (max-width: 800px) {
    main { grid-template-columns: 1fr; }
    aside, section { max-height: none; }
    aside { border-right: 0; border-bottom: 1px solid var(--line); }
  }
</style>
</head>
<body>
<header>
  <div class="mark">W</div>
  <div class="titles">
    <h1>webhook-replay-lab</h1>
    <div class="sub">local capture bench · no auth</div>
  </div>
  <div class="spacer"></div>
  <div id="status" role="status">Loading…</div>
  <label class="live"><input id="live" type="checkbox"> Live</label>
  <button id="refresh" type="button">Refresh</button>
</header>
<main>
  <aside id="list" aria-label="Captures"></aside>
  <section>
    <div id="empty" class="hint">
      <p>Select a capture to inspect it.</p>
      <p>Send a POST to any path other than /api. Example:</p>
      <pre class="panel" id="example">curl -X POST ORIGIN/hooks/stripe \\
  -H 'content-type: application/json' \\
  -d '{"hello":"webhook"}'</pre>
    </div>
    <div id="view" hidden>
      <div class="panel">
        <div id="meta" class="meta"></div>
        <div class="actions">
          <button id="copy-curl" type="button">Copy curl</button>
        </div>
        <h2>Headers</h2>
        <pre id="headers"></pre>
        <h2>Payload</h2>
        <pre id="payload"></pre>
        <h2>Replay</h2>
        <form id="replay-form" class="actions">
          <label class="visually-hidden" for="replay-to" style="position:absolute;left:-9999px">Replay URL</label>
          <input id="replay-to" name="to" type="url" placeholder="http://127.0.0.1:9999/hook" autocomplete="off" spellcheck="false">
          <label class="check"><input id="replay-preserve" type="checkbox"> Preserve headers</label>
          <button id="replay-button" type="submit">Replay</button>
        </form>
        <p class="hint">Preserve headers forwards the original signature. Replay does not mint a new one.</p>
        <pre id="replay-result"></pre>
      </div>
    </div>
  </section>
</main>
<noscript><p>JavaScript is required for the bench UI. The JSON API is still at /api/captures.</p></noscript>
<script>
(function () {
  var listEl = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var viewEl = document.getElementById('view');
  var metaEl = document.getElementById('meta');
  var headersEl = document.getElementById('headers');
  var payloadEl = document.getElementById('payload');
  var replayForm = document.getElementById('replay-form');
  var replayTo = document.getElementById('replay-to');
  var replayPreserve = document.getElementById('replay-preserve');
  var replayResult = document.getElementById('replay-result');
  var statusEl = document.getElementById('status');
  var liveEl = document.getElementById('live');
  var selected = null;
  var timer = null;

  function setStatus(text) { statusEl.textContent = text; }

  function pretty(capture) {
    if (capture.bodyEncoding === 'base64') return capture.rawBody;
    try { return JSON.stringify(JSON.parse(capture.rawBody), null, 2); }
    catch (err) { return capture.rawBody; }
  }

  function headerText(headers) {
    var names = Object.keys(headers || {}).sort();
    if (!names.length) return '(none)';
    return names.map(function (name) {
      var value = headers[name];
      var shown = Array.isArray(value) ? value.join(', ') : value;
      return name + ': ' + shown;
    }).join('\\n');
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderList(captures) {
    clear(listEl);
    if (!captures.length) {
      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No captures yet. POST a webhook to any path on this server.';
      listEl.appendChild(p);
      return;
    }
    captures.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row' + (item.id === selected ? ' is-selected' : '');
      btn.setAttribute('data-id', item.id);

      var method = document.createElement('span');
      method.className = 'method';
      method.textContent = item.method;

      var path = document.createElement('span');
      path.className = 'path';
      path.textContent = item.path + (item.query ? '?' + item.query : '');

      var bytes = document.createElement('span');
      bytes.className = 'bytes';
      bytes.textContent = String(item.bytes) + ' b';

      var time = document.createElement('span');
      time.className = 'time';
      time.textContent = item.timestamp;

      btn.append(method, path, bytes, time);
      btn.addEventListener('click', function () { select(item.id); });
      listEl.appendChild(btn);
    });
  }

  function loadList() {
    return fetch('/api/captures').then(function (res) {
      if (!res.ok) throw new Error('Could not load captures (' + res.status + ')');
      return res.json();
    }).then(function (data) {
      var captures = data.captures || [];
      renderList(captures);
      setStatus(captures.length + ' captured');
    }).catch(function (err) {
      setStatus(err.message || 'Failed to load captures');
    });
  }

  function select(id) {
    selected = id;
    Array.prototype.forEach.call(document.querySelectorAll('.row'), function (row) {
      row.classList.toggle('is-selected', row.getAttribute('data-id') === id);
    });
    fetch('/api/captures/' + encodeURIComponent(id)).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Could not load capture');
        return data.capture;
      });
    }).then(function (capture) {
      emptyEl.hidden = true;
      viewEl.hidden = false;
      viewEl.setAttribute('data-id', capture.id);
      var lines = [
        capture.method + ' ' + capture.path + (capture.query ? '?' + capture.query : ''),
        capture.timestamp,
        'id: ' + capture.id,
        'content-type: ' + (capture.contentType || '(none)'),
        'remote: ' + (capture.remoteAddr || '(unknown)')
      ];
      if (capture.bodyEncoding) lines.push('body: ' + capture.bodyEncoding);
      metaEl.textContent = lines.join('\\n');
      headersEl.textContent = headerText(capture.headers);
      payloadEl.textContent = pretty(capture);
      replayResult.textContent = '';
    }).catch(function (err) {
      setStatus(err.message || 'Could not load capture');
    });
  }

  document.getElementById('copy-curl').addEventListener('click', function () {
    var id = viewEl.getAttribute('data-id');
    if (!id) return;
    var to = replayTo.value.trim();
    var endpoint = '/api/captures/' + encodeURIComponent(id) + '/curl';
    if (to) endpoint += '?to=' + encodeURIComponent(to);
    fetch(endpoint).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Could not build curl');
        return data.curl;
      });
    }).then(function (curl) {
      replayResult.textContent = curl;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(curl).then(function () {
          setStatus('Copied curl');
        }, function () {
          setStatus('Curl is shown below. Clipboard is unavailable.');
        });
      }
      setStatus('Curl is shown below. Clipboard is unavailable.');
    }).catch(function (err) {
      setStatus(err.message || 'Copy failed');
    });
  });

  replayForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var id = viewEl.getAttribute('data-id');
    var to = replayTo.value.trim();
    if (!id) return;
    if (!to) {
      setStatus('Enter a replay URL.');
      return;
    }
    var button = document.getElementById('replay-button');
    button.disabled = true;
    setStatus('Replaying…');
    fetch('/api/captures/' + encodeURIComponent(id) + '/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: to, preserveHeaders: replayPreserve.checked })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok && !data.target) throw new Error(data.error || 'Replay failed');
        return data;
      });
    }).then(function (data) {
      var lines = [
        'ok: ' + data.ok,
        'status: ' + (data.status === null || data.status === undefined ? '-' : data.status),
        'target: ' + (data.target || to)
      ];
      if (data.error) lines.push('error: ' + data.error);
      if (data.body) lines.push('', data.body);
      replayResult.textContent = lines.join('\\n');
      setStatus(data.ok ? 'Replay completed' : 'Replay finished with an error');
    }).catch(function (err) {
      replayResult.textContent = err.message || 'Replay failed';
      setStatus('Replay failed');
    }).then(function () {
      button.disabled = false;
    });
  });

  function setLive(on) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (on) timer = setInterval(loadList, 2000);
  }

  var example = document.getElementById('example');
  if (example) example.textContent = example.textContent.replace('ORIGIN', location.origin);
  liveEl.addEventListener('change', function () { setLive(liveEl.checked); });
  document.getElementById('refresh').addEventListener('click', function () { loadList(); });
  loadList();
})();
</script>
</body>
</html>
`;
}
