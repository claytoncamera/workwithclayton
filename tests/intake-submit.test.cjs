// Executes the shipped submit handler with a small DOM adapter. All HTTP calls
// are injected mocks; this suite never contacts the live intake service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../intake/index.html'), 'utf8');
const start = html.indexOf("    (function () {\n      var form = document.getElementById('intake-form');");
const end = html.indexOf('    // ── Stripe Payment Link', start);
assert.ok(start >= 0 && end > start, 'the shipped submit handler is present');
const script = new vm.Script(html.slice(start, end), { filename: 'intake/index.html' });

function node() {
  const classes = new Set();
  return {
    value: '', textContent: '', disabled: false, hidden: true, style: {}, attrs: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    focus() { this.focused = true; },
  };
}
function harness(fetchMock) {
  const fields = {
    name: { value: 'Jane Customer', type: 'text' },
    email: { value: 'jane@example.test', type: 'email' },
    company: { value: 'Example Company', type: 'text' },
    website: { value: 'https://example.test', type: 'url' },
    phone: { value: '', type: 'tel' },
    consent: { value: 'on', type: 'checkbox', checked: true },
    team_size: { value: '2-5', type: 'radio', checked: true },
    notes: { value: 'Please help with follow-up.', type: 'textarea' },
    stack: [{ value: 'shopify', type: 'checkbox', checked: true }, { value: 'stripe', type: 'checkbox', checked: true }],
  };
  for (const [name, field] of Object.entries(fields)) {
    if (!Array.isArray(field)) Object.assign(field, { name, focus() { this.focused = true; } });
  }
  const button = node();
  const form = node();
  const required = ['name', 'email', 'company', 'website', 'team_size', 'consent'].map(name => fields[name]);
  Object.assign(form, {
    // HTMLFormElement.name is a string, so the handler must use elements.
    name: '',
    elements: Object.assign({}, fields, { namedItem: name => fields[name] }),
    addEventListener(type, handler) { assert.equal(type, 'submit'); this.submit = handler; },
    querySelectorAll(selector) { assert.equal(selector, '[required]'); return required; },
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return button;
      if (selector === 'input[name="team_size"]:checked') return fields.team_size;
      throw new Error('Unexpected selector ' + selector);
    },
  });
  const nodes = Object.fromEntries(['submit-status', 'submit-fallback', 'intake-email', 'intake-summary', 'success'].map(id => [id, node()]));
  const calls = [], tracking = [], timers = new Map();
  let timerID = 0;
  const window = {
    setTimeout(callback, delay) { timers.set(++timerID, { callback, delay }); return timerID; },
    clearTimeout(id) { timers.delete(id); },
    scrollTo(value) { this.scrolled = value; },
    location: { href: 'https://workwithclayton.com/intake/' },
    lmx: { track(...args) { tracking.push(args); } },
  };
  class FormDataMock {
    forEach(callback) {
      for (const [name, field] of Object.entries(fields)) {
        for (const item of Array.isArray(field) ? field : [field]) {
          if (item.type !== 'checkbox' || item.checked) callback(item.value, name);
        }
      }
    }
  }
  const context = vm.createContext({
    document: { getElementById: id => id === 'intake-form' ? form : nodes[id] },
    window, AbortController, FormData: FormDataMock,
    alert(message) { throw new Error('Unexpected validation alert: ' + message); },
    fetch(url, options) { calls.push({ url, options }); return fetchMock(url, options); },
  });
  script.runInContext(context);
  return { fields, form, button, nodes, window, calls, tracking, timers, submit: () => form.submit({ preventDefault() {} }) };
}
function assertRetryable(h) {
  assert.equal(h.form.style.display, undefined, 'the completed form remains visible');
  assert.equal(h.nodes.success.classList.contains('show'), false, 'no unconfirmed success');
  assert.match(h.nodes['submit-status'].textContent, /couldn't confirm receipt/);
  assert.equal(h.nodes['submit-status'].classList.contains('is-error'), true);
  assert.equal(h.nodes['submit-fallback'].hidden, false);
  assert.equal(h.button.disabled, false, 'retry is enabled');
  assert.equal(h.form.attrs['aria-busy'], undefined);
  assert.equal(h.timers.size, 0, 'the timeout is cleaned up');
  assert.equal(h.fields.name.value, 'Jane Customer');
  assert.equal(h.fields.notes.value, 'Please help with follow-up.');
  const email = new URL(h.nodes['intake-email'].href);
  assert.equal(email.protocol, 'mailto:');
  assert.equal(email.pathname, 'clayton.camera@icloud.com');
  assert.match(email.searchParams.get('subject'), /Example Company/);
  assert.match(email.searchParams.get('body'), /Jane Customer/);
  assert.match(email.searchParams.get('body'), /shopify, stripe/);
  assert.equal(h.nodes['intake-summary'].value, email.searchParams.get('body'), 'summary can also be copied without a mail client');
  assert.equal(h.window.location.href, 'https://workwithclayton.com/intake/', 'the page does not launch a mail app automatically');
  assert.equal(h.tracking.length, 0, 'failed requests are not tracked as completed intakes');
}

test('success waits for HTTP acceptance, preserves the API payload, and focuses confirmation', async () => {
  let accept;
  const h = harness(() => new Promise(resolve => { accept = resolve; }));
  const submitted = h.submit();
  assert.equal(h.button.disabled, true);
  assert.equal(h.form.attrs['aria-busy'], 'true');
  assert.match(h.nodes['submit-status'].textContent, /Sending your intake/);
  assert.equal(h.nodes.success.classList.contains('show'), false);
  assert.equal(h.tracking.length, 0);
  const request = h.calls[0];
  assert.equal(request.url, 'https://hubapi.loopholemaxing.com/api/v1/leads/intake');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload).sort(), ['business_name', 'contact_name', 'current_website', 'email', 'notes', 'phone']);
  assert.equal(payload.business_name, 'Example Company');
  assert.equal(payload.contact_name, 'Jane Customer');
  assert.equal(payload.email, 'jane@example.test');
  assert.equal(payload.phone, 'n/a');
  assert.equal(payload.current_website, 'https://example.test');
  assert.match(payload.notes, /^WWC AUDIT INTAKE\nLOOPHOLE AUDIT INTAKE/);
  assert.match(payload.notes, /STACK:\n  shopify, stripe/);
  accept({ ok: true, status: 201 });
  await submitted;
  assert.equal(h.form.style.display, 'none');
  assert.equal(h.nodes.success.classList.contains('show'), true);
  assert.equal(h.nodes.success.focused, true);
  assert.equal(h.nodes['submit-fallback'].hidden, true);
  assert.equal(h.tracking[0][0], 'wwc_intake_submit');
  assert.equal(h.timers.size, 0);
  await h.submit();
  assert.equal(h.calls.length, 1, 'a completed form cannot be resubmitted');
});

test('a non-2xx response keeps answers and exposes the email and copy fallback', async () => {
  const h = harness(async () => ({ ok: false, status: 503 }));
  await h.submit();
  assertRetryable(h);
});

test('network failure keeps answers and never claims receipt', async () => {
  const h = harness(async () => { throw new TypeError('Network unavailable'); });
  await h.submit();
  assertRetryable(h);
});

test('duplicate submit events while pending make exactly one request', async () => {
  let accept;
  const h = harness(() => new Promise(resolve => { accept = resolve; }));
  const first = h.submit();
  await h.submit();
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.button.disabled, true);
  accept({ ok: true });
  await first;
  assert.equal(h.tracking.length, 1);
});

test('a failed intake can be corrected and retried successfully', async () => {
  let attempt = 0;
  const h = harness(async () => ({ ok: ++attempt === 2, status: attempt === 2 ? 201 : 500 }));
  await h.submit();
  assertRetryable(h);
  h.fields.notes.value = 'Updated context for the retry.';
  await h.submit();
  assert.equal(h.calls.length, 2);
  assert.match(JSON.parse(h.calls[1].options.body).notes, /Updated context for the retry/);
  assert.equal(h.nodes.success.classList.contains('show'), true);
  assert.equal(h.nodes['submit-fallback'].hidden, true);
  assert.equal(h.nodes['submit-status'].classList.contains('is-error'), false);
  assert.equal(h.tracking.length, 1);
});

test('a stalled request times out and restores the email fallback', async () => {
  const h = harness((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Request timed out')));
  }));
  const submitted = h.submit();
  assert.equal([...h.timers.values()][0].delay, 20000);
  [...h.timers.values()][0].callback();
  await submitted;
  assert.equal(h.calls[0].options.signal.aborted, true);
  assertRetryable(h);
});

test('feedback markup is live, and the copyable fallback is read-only', () => {
  assert.match(html, /id="submit-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="submit-fallback"[^>]*hidden/);
  assert.match(html, /<label for="intake-summary">/);
  assert.match(html, /<textarea id="intake-summary" readonly>/);
  assert.match(html, /id="success"[^>]*tabindex="-1"[^>]*aria-labelledby="success-title"/);
});
