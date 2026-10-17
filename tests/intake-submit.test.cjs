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
    name: { value: 'Jane Customer', type: 'text', required: true },
    email: { value: 'jane@example.test', type: 'email', required: true },
    company: { value: 'Example Company', type: 'text', required: true },
    website: { value: 'https://example.test', type: 'url', required: true },
    industry: { value: 'ecommerce', type: 'select-one', required: true },
    revenue: { value: '250k-1m', type: 'select-one', required: true },
    team_size: { value: '2-5', type: 'radio', required: true, checked: true },
    stack: [{ value: 'shopify', type: 'checkbox', checked: true }, { value: 'stripe', type: 'checkbox', checked: true }],
    problem_1: { value: 'Slow lead follow-up.', type: 'textarea', required: true },
    revenue_goal: { value: 'Improve lead conversion.', type: 'textarea', required: true },
    lead_sources: { value: 'Referrals.', type: 'textarea', required: true },
    time_sink: { value: 'Manual follow-up.', type: 'textarea', required: true },
    loom: { value: '', type: 'url' },
    phone: { value: '', type: 'tel' },
    notes: { value: 'Please help with follow-up.', type: 'textarea' },
    consent: { value: 'on', type: 'checkbox', required: true, checked: true },
  };
  for (const [name, field] of Object.entries(fields)) {
    for (const item of Array.isArray(field) ? field : [field]) {
      Object.assign(item, { ...node(), ...item, name });
      // Model the native constraint API used by the shipped handler. The
      // markup assertions below also guard the actual browser input types.
      item.checkValidity = function () {
        this.validityChecks = (this.validityChecks || 0) + 1;
        if (this.required && (this.type === 'checkbox' || this.type === 'radio')) return this.checked;
        if (!this.value) return !this.required;
        if (this.type === 'email') return /^[^\s@]+@[^\s@]+$/.test(this.value);
        if (this.type === 'url') {
          try { new URL(this.value); return true; } catch { return false; }
        }
        return true;
      };
    }
  }
  const button = node();
  const form = node();
  const controls = Object.values(fields).flat();
  Object.assign(form, {
    // HTMLFormElement.name is a string, so the handler must use elements.
    name: '',
    elements: Object.assign({}, fields, { namedItem: name => fields[name] }),
    addEventListener(type, handler) { assert.equal(type, 'submit'); this.submit = handler; },
    querySelectorAll(selector) {
      if (selector === 'input, select, textarea') return controls;
      const match = selector.match(/^\[name="([^"]+)"\]$/);
      if (match) return controls.filter(field => field.name === match[1]);
      throw new Error('Unexpected selector ' + selector);
    },
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return button;
      const match = selector.match(/^input\[name="([^"]+)"\]:checked$/);
      if (match) return controls.find(field => field.name === match[1] && field.checked) || null;
      throw new Error('Unexpected selector ' + selector);
    },
  });
  const errorIDs = [...html.matchAll(/id="([^"]+-error)"/g)].map(match => match[1]);
  const nodes = Object.fromEntries(['submit-status', 'submit-fallback', 'intake-email', 'intake-summary', 'success', ...errorIDs].map(id => [id, node()]));
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

function assertInvalid(h, name, message) {
  const field = Array.isArray(h.fields[name]) ? h.fields[name][0] : h.fields[name];
  assert.equal(h.calls.length, 0, 'invalid answers are never sent');
  assert.equal(field.attrs['aria-invalid'], 'true');
  assert.equal(field.focused, true, 'focus moves to the first invalid field');
  assert.equal(h.nodes[name + '-error'].hidden, false);
  assert.match(h.nodes[name + '-error'].textContent, message);
  assert.match(h.nodes['submit-status'].textContent, /Please correct 1 field before submitting/);
  assert.equal(h.nodes['submit-status'].classList.contains('is-error'), true);
  assert.equal(h.nodes.success.classList.contains('show'), false);
  assert.equal(h.button.disabled, false);
  assert.equal(h.timers.size, 0);
}

test('an invalid email exposes an inline error and prevents submission', async () => {
  const h = harness(async () => ({ ok: true }));
  h.fields.email.value = 'not-an-email';
  await h.submit();
  assertInvalid(h, 'email', /valid email address/);
  assert.ok(h.fields.email.validityChecks, 'uses native email constraint validation');
});

test('an invalid website URL exposes an inline error and prevents submission', async () => {
  const h = harness(async () => ({ ok: true }));
  h.fields.website.value = 'not a website';
  await h.submit();
  assertInvalid(h, 'website', /valid website URL/);
  assert.ok(h.fields.website.validityChecks, 'uses native URL constraint validation');
});

test('a website without a scheme is normalized before validation and submission', async () => {
  const h = harness(async () => ({ ok: true }));
  h.fields.website.value = ' example.test:8080/about ';
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.fields.website.value, 'https://example.test:8080/about');
  const payload = JSON.parse(h.calls[0].options.body);
  assert.equal(payload.current_website, 'https://example.test:8080/about');
  assert.match(payload.notes, /https:\/\/example.test:8080\/about/);
});

test('missing stack selection marks every checkbox and focuses the first', async () => {
  const h = harness(async () => ({ ok: true }));
  h.fields.stack.forEach(field => { field.checked = false; });
  await h.submit();
  assertInvalid(h, 'stack', /Select at least one/);
  assert.ok(h.fields.stack.every(field => field.attrs['aria-invalid'] === 'true'));
});

test('missing required text, radio and consent answers prevent submission', async () => {
  for (const name of ['name', 'company', 'industry', 'revenue', 'team_size', 'problem_1', 'revenue_goal', 'lead_sources', 'time_sink', 'consent']) {
    const h = harness(async () => ({ ok: true }));
    if (['team_size', 'consent'].includes(name)) h.fields[name].checked = false;
    else h.fields[name].value = '';
    await h.submit();
    assertInvalid(h, name, /required field|team size|intake terms/);
  }
});

test('whitespace-only required text is rejected', async () => {
  const h = harness(async () => ({ ok: true }));
  h.fields.company.value = '   ';
  await h.submit();
  assertInvalid(h, 'company', /required field/);
});

test('all errors are reported together, first field gets focus, and corrected answers can be sent', async () => {
  const h = harness(async () => ({ ok: true }));
  h.fields.email.value = 'bad-email';
  h.fields.website.value = 'https://';
  h.fields.stack.forEach(field => { field.checked = false; });
  await h.submit();
  assert.equal(h.calls.length, 0);
  assert.equal(h.fields.email.focused, true);
  assert.equal(h.fields.website.focused, undefined);
  assert.equal(h.fields.stack[0].focused, undefined);
  assert.match(h.nodes['submit-status'].textContent, /Please correct 3 fields/);
  for (const name of ['email', 'website', 'stack']) assert.equal(h.nodes[name + '-error'].hidden, false);
  h.fields.email.value = 'jane@example.test';
  h.fields.website.value = 'https://example.test';
  h.fields.stack[1].checked = true;
  await h.submit();
  assert.equal(h.calls.length, 1);
  for (const name of ['email', 'website', 'stack']) {
    assert.equal(h.nodes[name + '-error'].hidden, true);
    assert.equal(h.nodes[name + '-error'].textContent, '');
    for (const field of [h.fields[name]].flat()) assert.equal(field.attrs['aria-invalid'], undefined);
  }
  assert.equal(h.nodes['submit-status'].classList.contains('is-error'), false);
});

test('an optional Loom URL is validated when supplied', async () => {
  const h = harness(async () => ({ ok: true }));
  h.fields.loom.value = 'not a URL';
  await h.submit();
  assertInvalid(h, 'loom', /valid website URL/);
});

test('feedback markup is live, and the copyable fallback is read-only', () => {
  const h = harness(async () => ({ ok: true }));
  assert.match(html, /id="submit-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="submit-fallback"[^>]*hidden/);
  assert.match(html, /<label for="intake-summary">/);
  assert.match(html, /<textarea id="intake-summary" readonly>/);
  assert.match(html, /id="success"[^>]*tabindex="-1"[^>]*aria-labelledby="success-title"/);
  for (const match of html.matchAll(/<(?:input|select|textarea)\b[^>]*\brequired\b[^>]*>/g)) {
    const name = match[0].match(/name="([^"]+)"/)[1];
    assert.ok(h.fields[name], 'required field is covered by the adapter: ' + name);
    assert.ok(match[0].includes('aria-describedby="' + name + '-error"'), 'required field describes its inline error: ' + name);
    assert.ok(html.includes('id="' + name + '-error" class="field-error" hidden'), 'inline error container exists: ' + name);
  }
  for (const match of html.matchAll(/<input\b[^>]*\bname="stack"[^>]*>/g)) {
    assert.ok(match[0].includes('aria-describedby="stack-error"'));
  }
  assert.match(html, /type="email" name="email"/);
  assert.match(html, /type="url" name="website"/);
  assert.match(html, /<noscript>[\s\S]*?href="mailto:clayton.camera@icloud.com[^"]*"[\s\S]*?<\/noscript>/);
  assert.match(html, /data-stripe-audit href="https:\/\/buy.stripe.com\/3cI3cuaqh6rE8xy4xqdnW0b"/);
});
