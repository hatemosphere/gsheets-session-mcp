(() => {
  if (globalThis.__gsheetsSessionBridgeInstalled) return;
  globalThis.__gsheetsSessionBridgeInstalled = true;

  function infoParams() {
    const match = /"info_params"\s*:\s*(\{[^{}]*\})/.exec(document.documentElement.innerHTML);
    if (!match) throw new Error('Could not discover Sheets session parameters. Reload the sheet and try again.');
    let params;
    try { params = JSON.parse(match[1]); } catch {
      throw new Error('Could not parse Sheets session parameters. Reload the sheet and try again.');
    }
    if (typeof params.token !== 'string' || !params.token ||
        (typeof params.ouid !== 'string' && typeof params.ouid !== 'number')) {
      throw new Error('Sheets session parameters are incomplete. Sign in again and reload the sheet.');
    }
    return params;
  }

  async function responseResult(responsePromise) {
    let response;
    try { response = await responsePromise; } catch (error) {
      throw new Error(`Sheets browser request failed: ${error.message}. Sign in to Chrome and reload the sheet.`);
    }
    return { status: response.status, text: await response.text() };
  }

  async function readRange(params) {
    const qs = new URLSearchParams({ gid: String(params.gid), headers: '0', tqx: 'out:csv' });
    if (params.range) qs.set('range', params.range);
    const url = `https://docs.google.com/spreadsheets/d/${params.spreadsheetId}/gviz/tq?${qs}`;
    return responseResult(fetch(url, { credentials: 'include', cache: 'no-store' }));
  }

  async function writeCells(params) {
    const session = infoParams();
    const qs = new URLSearchParams({
      id: params.spreadsheetId,
      sid: params.sid,
      vc: '1',
      c: '1',
      w: '1',
      flr: '0',
      token: session.token,
      ouid: String(session.ouid),
      includes_info_params: 'true',
    });
    const form = new FormData();
    form.set('rev', String(params.rev));
    form.set('bundles', params.bundles);
    const url = `https://docs.google.com/spreadsheets/d/${params.spreadsheetId}/save?${qs}`;
    return responseResult(fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-same-domain': '1' },
      body: form,
    }));
  }

  function selectionInfo() {
    const rawRange = document.querySelector('#t-name-box')?.value?.trim() || '';
    const range = /^[A-Za-z]+\d+(?::[A-Za-z]+\d+)?$/.test(rawRange) ? rawRange : null;
    const viewers = [...document.querySelectorAll('.docs-presence-plus-collab-widget-container')].map((element) => {
      const label = element.getAttribute('aria-label')?.trim() || 'Unknown';
      const match = /^(.*?)(?:\s*\(([^)]+)\))?$/.exec(label);
      return {
        name: (match?.[1] || label).trim(),
        status: /inactief|inactive|inaktiv|inactif/i.test(match?.[2] ?? '') ? 'inactive' : 'active',
        label,
      };
    });
    return { range, selectionBy: 'current-tab', viewers };
  }

  async function revisionTiles(params) {
    const session = infoParams();
    const qs = new URLSearchParams({
      id: params.spreadsheetId,
      start: '1',
      revisionBatchSize: '1500',
      showDetailedRevisions: 'false',
      loadType: '0',
      token: session.token,
      ouid: String(session.ouid),
      includes_info_params: 'true',
      cros_files: 'false',
      nded: 'false',
    });
    const url = `https://docs.google.com/spreadsheets/u/1/d/${params.spreadsheetId}/revisions/tiles?${qs}`;
    return responseResult(fetch(url, { credentials: 'include', cache: 'no-store' }));
  }

  async function revisionSnapshot(params) {
    const session = infoParams();
    const qs = new URLSearchParams({
      sid: params.sid,
      token: session.token,
      ouid: String(session.ouid),
      includes_info_params: 'true',
      cros_files: 'false',
      nded: 'false',
      rev: String(params.revision),
      gid: String(params.gid),
      scr: 'false',
    });
    const url = `https://docs.google.com/spreadsheets/u/1/d/${params.spreadsheetId}/revisions/show?${qs}`;
    return responseResult(fetch(url, { credentials: 'include', cache: 'no-store' }));
  }

  async function streamFetch(params) {
    const url = new URL(params.url);
    url.searchParams.set('mcpReplay', '1');
    const form = new URLSearchParams();
    for (const [key, values] of Object.entries(params.body ?? {})) {
      for (const value of values ?? []) form.append(key, String(value));
    }
    return responseResult(fetch(url, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form,
    }));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'gsheets-session-request') return;
    const run = message.action === 'read' ? readRange(message.params)
      : message.action === 'write' ? writeCells(message.params)
        : message.action === 'selection' ? Promise.resolve(selectionInfo())
          : message.action === 'revision_tiles' ? revisionTiles(message.params)
            : message.action === 'revision_snapshot' ? revisionSnapshot(message.params)
              : message.action === 'stream_fetch' ? streamFetch(message.params)
                : Promise.reject(new Error(`Unknown browser action: ${message.action}`));
    run.then(
      (result) => sendResponse({ result }),
      (error) => sendResponse({ error: String(error.message ?? error) }),
    );
    return true;
  });
})();
