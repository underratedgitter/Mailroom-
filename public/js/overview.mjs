import {
  api,
  baseName,
  currentDelay,
  formatDuration,
  formatWhen,
  h,
  hooks,
  plural,
  reconcile,
  setAttr,
  setClass,
  setHidden,
  setText,
  state,
  ui,
} from './api.mjs';

export const mailboxOf = (smtp) => smtp.user || (smtp.from.match(/<([^>]+)>/) || [])[1] || smtp.from || '';

export function renderConn() {
  if (!state.smtp) return;
  const configured = state.setup.configured;
  const kind = !configured ? 'warn' : state.conn;
  const labels = { idle: 'Not checked', wait: 'Checking…', ok: 'Connected', bad: 'Failed', warn: 'Not set up' };

  setText(ui.connPill, labels[kind]);
  setAttr(ui.connPill, 'data-state', kind);
  setAttr(ui.sidebarConn, 'data-state', kind === 'wait' ? 'idle' : kind);
  setText(ui.connSub, configured ? (mailboxOf(state.smtp) || state.smtp.host) : 'Not connected');
  setText(ui.connTitle, !configured ? 'Mailbox needs setup' : labels[kind] === 'Not checked' ? 'Mailbox' : 'Mailbox ' + labels[kind].toLowerCase());
}

export function setConn(kind) {
  state.conn = kind;
  renderConn();
}

export async function loadHealth() {
  try {
    const data = await api('/api/health');
    state.online = true;
    state.version = data.version || state.version;
    setText(ui.aboutHealth, 'Online' + (data.version ? ' · v' + data.version : ''));
  } catch {
    state.online = false;
    setText(ui.aboutHealth, 'Unreachable');
  }
  setHidden(ui.offlineBar, state.online);
}

export function renderCampaigns() {
  const rows = state.log.campaigns || [];
  setHidden(ui.campaignsEmpty, rows.length > 0);
  setHidden(ui.campaignsWrap, rows.length === 0);
  const cells = (c) => [c.id, String(c.sent), String(c.failed), String(c.skipped), c.last ? formatWhen(c.last) : '—'];
  reconcile(ui.campaignsBody, rows, (c) => c.id,
    () => h('tr', {}, h('th', { scope: 'row' }), h('td', { class: 'num' }), h('td', { class: 'num' }), h('td', { class: 'num' }), h('td')),
    (tr, c) => {
      cells(c).forEach((text, i) => setText(tr.children[i], text));
      setClass(tr.children[2], 'is-bad', c.failed > 0);
    });
}

function setStep(name, done, text) {
  const li = ui.steps.querySelector('[data-step="' + name + '"]');
  setAttr(li, 'data-state', done ? 'done' : 'todo');
  const sub = ui['step' + name[0].toUpperCase() + name.slice(1)];
  setText(sub, text);
  setAttr(sub, 'title', text);
}

function unpreviewedRecipients() {
  const roster = state.rosters[state.mode];
  return roster && roster.total
    ? plural(roster.total, 'address', 'addresses') + ' in the list. Add a subject to see who will be mailed.'
    : 'No recipients chosen yet.';
}

// What the campaign being drafted still needs, shown on Overview and Send.
export function draftChecks() {
  const p = state.lastPreview;
  const subject = ui.subject.value.trim();
  const template = state.templates.find((t) => t.path === ui.template.value);
  const held = p ? [
    p.skipped ? p.skipped + ' already sent' : null,
    p.suppressed ? p.suppressed + ' suppressed' : null,
  ].filter(Boolean) : [];

  return {
    mailbox: {
      ok: state.setup.configured,
      text: state.setup.configured ? (state.smtp.from || state.smtp.user) : 'Not connected yet — add your SMTP details in Settings.',
    },
    compose: {
      ok: Boolean(template && subject),
      text: !state.templates.length ? 'No templates found.'
        : !subject ? 'Add a subject line.'
          : template.name + ' · “' + subject + '”',
    },
    recipients: {
      ok: Boolean(p && p.willSend > 0),
      text: p
        ? (p.willSend > 0
          ? plural(p.willSend, 'message') + ' to send' + (held.length ? ' (' + held.join(', ') + ')' : '')
          : 'Nothing left to send' + (held.length ? ': ' + held.join(', ') : '') + '.')
        : state.previewError || unpreviewedRecipients(),
    },
    // A warning, not a blocker: the message can still be sent.
    links: {
      ok: Boolean(p && !p.warnings?.length),
      text: !p ? 'Checked once there is a preview.'
        : p.warnings?.length ? p.warnings.map((w) => w.message).join(' ')
          : 'Every link works and there is an unsubscribe link.',
    },
  };
}

export function renderDraft() {
  if (!state.smtp) return;
  const checks = draftChecks();
  const p = state.lastPreview;

  for (const [name, check] of Object.entries(checks)) {
    const li = ui.sendChecks.querySelector('[data-check="' + (name === 'compose' ? 'template' : name) + '"]');
    setAttr(li, 'data-state', check.ok ? 'ok' : 'bad');
    const sub = ui[{ mailbox: 'chkMailbox', compose: 'chkCompose', recipients: 'chkRecipients', links: 'chkLinks' }[name]];
    setText(sub, check.text);
    setAttr(sub, 'title', check.text);
  }
  setStep('mailbox', checks.mailbox.ok, checks.mailbox.ok ? checks.mailbox.text : 'Required before anything can be sent.');
  setStep('compose', checks.compose.ok, checks.compose.text);
  setStep('recipients', checks.recipients.ok, checks.recipients.text);
  setStep('test', state.tested, state.tested ? 'Test delivered in this session.' : 'Recommended before every campaign.');

  setText(ui.sumFrom, state.smtp.from || '(not set)');
  setText(ui.sumSubject, p ? p.subject : (ui.subject.value.trim() || '—'));
  setText(ui.sumCampaign, ui.campaign.value.trim() || 'No campaign name');
  setText(ui.recipientSummary, p
    ? 'Sending to ' + plural(p.willSend, 'recipient') + (p.source === 'pasted' ? ' from your pasted list.' : ' from ' + baseName(p.source) + '.')
    : 'No recipients chosen yet.');

  const ready = checks.mailbox.ok && checks.compose.ok && checks.recipients.ok;
  setText(ui.sendLabel, ready ? 'Send ' + plural(p.willSend, 'message') : 'Send campaign');
  ui.sendBtn.disabled = state.sending || !ready;
  ui.scheduleBtn.disabled = !(checks.compose.ok && checks.recipients.ok);

  const total = p ? p.willSend * currentDelay() : 0;
  setText(ui.delayHint, ready && total > 0
    ? 'About ' + formatDuration(total) + ' for ' + plural(p.willSend, 'message') + '.'
    : 'Keeps a single mailbox inside provider rate limits.');

  hooks.renderScheduleSummary();
}
