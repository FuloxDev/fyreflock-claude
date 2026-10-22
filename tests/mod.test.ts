import { expect, mock, test } from 'claude-code/testing';
import type { On, RenderElement } from 'claude-code';

/**
 * The pane and the slash command, driven through the engine's own `$` with the
 * network answered from memory: what `fyreflock_app_wait` returns is the whole
 * input of the mod, so a canned snapshot per call is a complete world.
 */

const PANE = {
  plugin: 'fyreflock',
  component: 'Pane' as const,
  requestId: 'fyreflock',
  props: { title: 'Fyreflock', isFocused: true, bodyColumns: 44, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 24 }, view: {} },
  viewport: { columns: 160, rows: 40 },
};
const BAND = { plugin: 'fyreflock', component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } };

/** What the composer sends when the person types the command. */
const typed = (args: string) => ({ command: 'fyreflock', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } });

const idle = { state: 'idle', mirror: { peer: null, queue: { agentWaiting: 2, textWaiting: 5 }, lines: [], deliveredSeq: 0, readSeq: 0 }, ended: null, notices: [] };
const searching = { ...idle, state: 'searching' };
const matched = (lines: { from: 'me' | 'them'; body: string; at: number }[], readSeq = 0) => ({
  state: 'matched',
  mirror: { peer: { id: 'p1', displayName: 'sam', viaAgent: true }, queue: { agentWaiting: 1, textWaiting: 5 }, lines, deliveredSeq: lines.length, readSeq },
  ended: null,
  notices: [],
});

type Form = Record<string, string>;
/** What an OAuth endpoint answers: a status and a JSON body. */
type OAuthAnswer = { status: number; body: Record<string, unknown> };

/**
 * A Fyreflock server in memory: records every call, answers from a script per
 * tool; a script that throws is a dropped connection, and one that answers
 * `401` is a refused token. OAuth posts go to `oauth`, keyed by path.
 */
function server(
  on: On,
  script: Record<string, (args: Record<string, unknown>) => unknown>,
  oauth: Record<string, (form: Form) => OAuthAnswer> = {},
) {
  const calls: { name: string; args: Record<string, unknown>; bearer?: string }[] = [];
  const posts: { path: string; form: Form }[] = [];
  const statuses: (string | undefined)[] = [];
  on('http.fetch', (_$, e) => {
    const path = new URL(e.url).pathname;
    if (path.startsWith('/oauth/')) {
      const form = Object.fromEntries((e.init?.body ?? '').split('&').map((kv) => kv.split('=').map(decodeURIComponent))) as Form;
      posts.push({ path, form });
      const a = oauth[path]?.(form) ?? { status: 404, body: { error: 'not_found' } };
      return { value: { status: a.status, ok: a.status < 400, headers: { 'content-type': 'application/json' }, text: JSON.stringify(a.body) } };
    }
    const body = JSON.parse(e.init?.body ?? '{}') as { params: { name: string; arguments: Record<string, unknown> } };
    calls.push({ name: body.params.name, args: body.params.arguments, bearer: e.init?.headers?.authorization });
    let structuredContent: unknown;
    try {
      structuredContent = script[body.params.name]?.(body.params.arguments) ?? idle;
    } catch {
      return { value: { status: 502, ok: false, headers: { 'content-type': 'text/html' }, text: '<h1>Bad gateway</h1>' } };
    }
    if (structuredContent === 401) {
      return { value: { status: 401, ok: false, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ message: 'invalid token' }) } };
    }
    return {
      value: {
        status: 200,
        ok: true,
        headers: { 'content-type': 'text/event-stream' },
        text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }], structuredContent } })}\n\n`,
      },
    };
  });
  // The surface's own answers to what the mod asks of the screen.
  on('ui.open', () => ({ value: { isPlaced: true as const } }));
  on('ui.status', (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', () => ({ value: undefined }));
  // What the engine draws where the mod draws nothing: an empty band.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as RenderElement);
  return { calls, posts, statuses };
}

/** `$.store` from memory, as `mock.store` answers it, with every write and delete recorded. */
function store(on: On, entries: Record<string, unknown> = {}) {
  const held = new Map(Object.entries(entries));
  const writes: { key: string; value: unknown }[] = [];
  on('store.get', (_$, e) => ({ value: held.get(e.key) }));
  on('store.set', (_$, e) => {
    held.set(e.key, e.value);
    writes.push({ key: e.key, value: e.value });
    return { value: undefined };
  });
  on('store.delete', (_$, e) => {
    held.delete(e.key);
    writes.push({ key: e.key, value: undefined });
    return { value: undefined };
  });
  return writes;
}

type Drawing = {
  find: (q: { type?: 'Text'; key?: string; text?: RegExp | string }) => Promise<{ props: Record<string, unknown> } | undefined>;
  drawn: () => Promise<unknown>;
};

/** A find that says what WAS drawn when it finds nothing. */
async function must(ui: Drawing, q: { type?: 'Text'; key?: string; text?: RegExp | string }) {
  const found = await ui.find(q);
  if (!found) throw new Error(`not drawn: ${typeof q.text === 'string' ? q.text : (q.text?.source ?? q.key)} in ${JSON.stringify(await ui.drawn()).slice(0, 900)}`);
  return found;
}

/** The state dot's theme colour, which is how the widget's glow reads in a terminal. */
const dot = async (ui: Drawing) => {
  const d = (await must(ui, { type: 'Text', text: /^●$/ })).props;
  return d.dimColor ? `dim ${String(d.color)}` : d.color;
};

const DEVICE = '/oauth/device';
const TOKEN = '/oauth/token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// https, because the desktop draws a Link to anywhere else as plain text.
const LINK = 'https://fyreflock.test/oauth/device/open?req=oar_1&code=BCDF-GHJK';
const minted = (n: number): OAuthAnswer => ({
  status: 200,
  body: { access_token: `acc${n}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `ref${n}`, scope: 'chat' },
});
const refused = (error: string): OAuthAnswer => ({ status: 400, body: { error, error_description: `Fyreflock said ${error}.` } });
const parked = (): OAuthAnswer => ({ status: 200, body: { device_code: 'dev1', user_code: 'BCDF-GHJK', verification_uri_complete: LINK, expires_in: 900, interval: 5 } });

for (const surface of ['terminal', 'desktop'] as const) {
  test(`signs in from the pane with nothing to paste (${surface})`, async ($, on) => {
    const clock = mock.clock(on);
    mock.env(on, { FYREFLOCK_URL: 'https://fyreflock.test/mcp' });
    const saved = store(on);
    let allowed = false;
    const { calls, posts } = server(on, {}, {
      [DEVICE]: parked,
      [TOKEN]: (f) => (f.grant_type !== DEVICE_GRANT || f.device_code !== 'dev1' ? refused('invalid_grant') : allowed ? minted(1) : refused('authorization_pending')),
    });

    // Opening the pane asks for a link at once and shows it with its code: the two are the whole sign-in.
    expect((await $.command.run(typed(''))).text).toBe(
      `Sign in to Fyreflock: open ${LINK}, check the page shows the code BCDF-GHJK, and press Allow. The pane picks it up from there.`,
    );
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(posts[0]).toEqual({ path: DEVICE, form: { client_id: 'pane' } });
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(LINK);
    // The consent page shows the same code, so a link forwarded to somebody else gives itself away.
    await must(ui, { type: 'Text', text: 'The page will show this code. Press Allow only if it matches:' });
    expect((await must(ui, { type: 'Text', text: 'BCDF-GHJK' })).props.bold).toBe(true);
    await must(ui, { type: 'Text', text: 'Waiting for you to press Allow…' });
    expect(await ui.find({ key: 'start' })).toBeUndefined();
    // Asking to start meanwhile says what is missing, and keeps the link the browser may already hold.
    expect((await $.command.run(typed('start'))).text).toMatch(/^Sign in first/);
    expect(posts.filter((p) => p.path === DEVICE)).toHaveLength(1);

    await clock.advance(5_000);
    expect(posts.at(-1)).toEqual({ path: TOKEN, form: { client_id: 'pane', grant_type: DEVICE_GRANT, device_code: 'dev1' } });
    expect(calls).toHaveLength(0);

    allowed = true;
    await clock.advance(5_000);
    await must(ui, { type: 'Text', text: 'Find your flock' });
    expect(calls[0]?.bearer).toBe('Bearer acc1');
    // Kept in the plugin's own store, which outlives the session: the next one starts signed in.
    expect(saved.at(-1)).toEqual({ key: 'auth https://fyreflock.test', value: { access: 'acc1', refresh: 'ref1', expiresAt: 10_000 + 3600_000 } });
    await ui.unmount();
  });
}

test('a refused or expired link ends the wait, and Sign in asks for a new one', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, {});
  mock.store(on);
  let answer = refused('authorization_pending');
  const { posts } = server(on, {}, { [DEVICE]: parked, [TOKEN]: () => answer });
  await $.command.run(typed(''));
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });

  // A slow-down is not an ending: the pane waits five seconds longer between polls.
  answer = refused('slow_down');
  await clock.advance(5_000);
  answer = refused('authorization_pending');
  await clock.advance(5_000);
  expect(posts.filter((p) => p.path === TOKEN)).toHaveLength(1);
  await clock.advance(5_000);
  expect(posts.filter((p) => p.path === TOKEN)).toHaveLength(2);

  answer = refused('access_denied');
  await clock.advance(10_000);
  await must(ui, { type: 'Text', text: 'Fyreflock said access_denied.' });
  expect(await ui.find({ type: 'Link' })).toBeUndefined();
  await ui.press({ key: 'signin' });
  expect(posts.filter((p) => p.path === DEVICE)).toHaveLength(2);
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe(LINK);

  // Nobody pressing anything for the link's quarter hour ends it too.
  answer = refused('authorization_pending');
  await clock.advance(900_000);
  await must(ui, { type: 'Text', text: 'The sign-in link expired.' });
  await must(ui, { key: 'signin' });
  await ui.unmount();
});

test('renews the hour-long token, and goes back to Sign in once the server ends the sign-in', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, {});
  const saved = store(on, { 'auth https://fyreflock.com': { access: 'stale', refresh: 'ref0', expiresAt: 1_030_000 } });
  let revoked = false;
  let refreshes = 0;
  const { calls, posts } = server(
    on,
    { fyreflock_app_wait: () => (revoked ? 401 : idle) },
    {
      [TOKEN]: (f) => {
        if (f.grant_type !== 'refresh_token') return refused('unsupported_grant_type');
        refreshes += 1;
        return revoked ? refused('invalid_grant') : minted(refreshes);
      },
    },
  );
  // Inside the last minute of the hour, so the first call renews before it goes out.
  await $.command.run(typed(''));
  await clock.settle();
  expect(posts[0]).toEqual({ path: TOKEN, form: { client_id: 'pane', grant_type: 'refresh_token', refresh_token: 'ref0' } });
  expect(calls[0]?.bearer).toBe('Bearer acc1');
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await must(ui, { type: 'Text', text: 'Find your flock' });

  // Disconnected in Settings: the token is refused, the refresh too, and the pane says so instead of retrying forever.
  revoked = true;
  await clock.advance(20_000);
  expect(calls.at(-1)?.bearer).toBe('Bearer acc1');
  expect(posts.at(-1)?.form.refresh_token).toBe('ref1');
  await must(ui, { type: 'Text', text: 'Fyreflock signed this pane out. Sign in again.' });
  await must(ui, { key: 'signin' });
  expect(saved.at(-1)).toEqual({ key: 'auth https://fyreflock.com', value: undefined });
  const polls = calls.length;
  await clock.advance(60_000);
  expect(calls.length).toBe(polls);
  await ui.unmount();
});

test('FYREFLOCK_TOKEN still overrides the pane sign-in, and is never refreshed', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { FYREFLOCK_TOKEN: 'tok' });
  mock.store(on, { 'auth https://fyreflock.com': { access: 'acc9', refresh: 'ref9', expiresAt: 0 } });
  const { calls, posts } = server(on, { fyreflock_app_wait: () => 401 });
  await $.command.run(typed(''));
  await clock.settle();
  expect(calls[0]?.bearer).toBe('Bearer tok');
  expect(posts).toHaveLength(0);
});

for (const surface of ['terminal', 'desktop'] as const) {
  test(`finds someone, shows their lines and sends yours unchanged (${surface})`, async ($, on) => {
    const clock = mock.clock(on);
    mock.env(on, { FYREFLOCK_TOKEN: 'tok', FYREFLOCK_URL: 'http://fyreflock.test/mcp' });
    // The hub in two variables: a join matches at once, a leave empties it and, as the real one does, writes the ending to the leaver's own mailbox too.
    let talking = false;
    let echo: string | null = null;
    const sam = () => matched([{ from: 'them', body: 'hi, what are you into?', at: 1 }]);
    const { calls } = server(on, {
      fyreflock_app_wait: (args) => {
        if (args.join === true) talking = true;
        const ended = echo;
        echo = null;
        return { ...(talking ? sam() : idle), ended };
      },
      fyreflock_app_say: (args) => ({ delivered: true, sent_text: args.text }),
      fyreflock_app_leave: () => {
        talking = false;
        echo = 'leave';
        return { ...idle, ended: 'leave' };
      },
    });

    // Opening the pane is what starts the loop, and the first poll finds nobody.
    await $.command.run(typed(''));
    await clock.advance(20_000);
    // Every poll says it is the pane: that flag is what folds a chat box in the same Claude Code down to one line.
    expect(calls[0]).toEqual({ name: 'fyreflock_app_wait', args: { join: false, budget_ms: 25_000, pane: true }, bearer: 'Bearer tok' });
    const ui = await $.ui.mount({ ...PANE, surface });
    await must(ui, { type: 'Text', text: 'Find your flock' });
    await must(ui, { type: 'Text', text: '7 by the fire' });
    await must(ui, { type: 'Text', text: 'Text only · leave any time' });
    expect(await dot(ui)).toBe('warning');

    await ui.press({ key: 'start' });
    await clock.settle();
    expect(calls.some((c) => c.name === 'fyreflock_app_wait' && c.args.join === true)).toBe(true);
    await must(ui, { type: 'Text', text: /^@sam$/ });
    await must(ui, { type: 'Text', text: 'Verified · reads through an assistant' });
    await must(ui, { type: 'Text', text: /hi, what are you into\?/ });
    await must(ui, { type: 'Text', text: 'Goes to them directly, not to Claude' });
    await must(ui, { key: 'next', text: /Next person/ });
    expect(await dot(ui)).toBe('success');

    await ui.input({ key: 'say', text: '  books, mostly. you?  ' });
    await clock.settle();
    const said = calls.find((c) => c.name === 'fyreflock_app_say');
    // Trimmed and nothing else: the field's words are the stranger's words.
    expect(said?.args).toEqual({ text: 'books, mostly. you?' });
    await must(ui, { type: 'Text', text: /books, mostly\. you\?/ });
    await must(ui, { type: 'Text', text: /^Sent$/ });

    // The slash command sends the rest of its line as written, too.
    const run = await $.command.run(typed('see you at the fire'));
    expect(run.text).toBe('Sent: see you at the fire');
    expect(calls.filter((c) => c.name === 'fyreflock_app_say').pop()?.args).toEqual({ text: 'see you at the fire' });

    // Leaving yourself is the ended state in your own words, the lines kept, until you move on.
    await ui.press({ key: 'leave' });
    await clock.settle();
    expect(calls.some((c) => c.name === 'fyreflock_app_leave' && c.args.next === false)).toBe(true);
    await must(ui, { type: 'Text', text: 'You left the campfire' });
    await must(ui, { type: 'Text', text: '3 lines · Thanks for keeping it kind.' });
    await must(ui, { key: 'start', text: 'Find someone new' });
    expect(await dot(ui)).toBe('error');
    // The echoed ending, then the idle answers after it, change nothing.
    await clock.advance(20_000);
    expect(calls.filter((c) => c.name === 'fyreflock_app_wait').length).toBeGreaterThan(2);
    await must(ui, { type: 'Text', text: 'You left the campfire' });
    await ui.unmount();
  });
}

test('your own Next goes straight to looking, whatever ending the hub echoes back', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { FYREFLOCK_TOKEN: 'tok' });
  let talking = true;
  let echo: string | null = null;
  server(on, {
    fyreflock_app_wait: () => {
      const ended = echo;
      echo = null;
      return { ...(talking ? matched([{ from: 'them', body: 'bye then', at: 1 }]) : searching), ended };
    },
    fyreflock_app_leave: () => {
      talking = false;
      echo = 'next';
      return { ...searching, ended: 'next' };
    },
  });
  await $.command.run(typed('start'));
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await must(ui, { type: 'Text', text: /^@sam$/ });
  await ui.press({ key: 'next' });
  await clock.advance(250);
  await must(ui, { type: 'Text', text: 'Finding someone for you' });
  expect(await ui.find({ type: 'Text', text: /left the campfire/ })).toBeUndefined();
  await ui.unmount();
});

test('looks, loses the connection mid-conversation, reconnects, and keeps their leaving up', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { FYREFLOCK_TOKEN: 'tok' });
  let hub: 'looking' | 'talking' | 'down' | 'gone' | 'forgotten' = 'looking';
  const { statuses } = server(on, {
    fyreflock_app_wait: () => {
      if (hub === 'down') throw new Error('dropped');
      if (hub === 'gone') {
        hub = 'forgotten';
        return { ...idle, ended: 'leave' };
      }
      return hub === 'looking' ? searching : hub === 'talking' ? matched([{ from: 'them', body: 'still there?', at: 1 }]) : idle;
    },
  });
  await $.command.run(typed('start'));
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' });
  await must(ui, { type: 'Text', text: 'Finding someone for you' });
  // Seven by the fire, one of them the person looking.
  await must(ui, { type: 'Text', text: 'Matching on anything · 6 others looking' });
  await must(ui, { type: 'Text', text: 'You can keep talking to Claude meanwhile' });
  await must(ui, { key: 'leave', text: 'Cancel' });
  expect(await dot(ui)).toBe('warning');
  await must(band, { type: 'Text', text: 'Fyreflock: looking for someone' });
  expect(statuses.at(-1)).toBe('looking for someone');

  hub = 'talking';
  await clock.advance(250);
  await must(ui, { type: 'Text', text: /^@sam$/ });
  expect(await dot(ui)).toBe('success');

  hub = 'down';
  await clock.advance(250);
  await must(ui, { type: 'Text', text: '↻ Lost the connection to @sam. Reconnecting…' });
  await must(ui, { type: 'Text', text: 'Reconnecting…' });
  // The conversation stays on screen and the field stays usable while the poll retries.
  await must(ui, { type: 'Text', text: 'still there?' });
  await must(ui, { key: 'next' });
  expect(await dot(ui)).toBe('claude');
  await must(band, { type: 'Text', text: 'Fyreflock: lost the connection to @sam, reconnecting…' });
  expect(statuses.at(-1)).toBe('reconnecting to @sam…');

  hub = 'talking';
  await clock.advance(5_000);
  expect(await ui.find({ type: 'Text', text: /Lost the connection/ })).toBeUndefined();
  expect(await dot(ui)).toBe('success');
  expect(statuses.at(-1)).toBe('talking to @sam');

  hub = 'gone';
  await clock.advance(250);
  await must(ui, { type: 'Text', text: '@sam left the campfire' });
  expect(await dot(ui)).toBe('error');
  // The server forgets the mailbox on the next poll; the ending stays until the person moves on.
  await clock.advance(20_000);
  await must(ui, { type: 'Text', text: '@sam left the campfire' });
  await must(band, { type: 'Text', text: 'Fyreflock: @sam left the campfire' });
  expect(statuses.at(-1)).toBeUndefined();
  await ui.unmount();
  await band.unmount();
});

test('the band above the prompt names the match only while Claude is idle', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { FYREFLOCK_TOKEN: 'tok' });
  server(on, { fyreflock_app_wait: () => matched([{ from: 'them', body: 'hello?', at: 1 }]) });

  await $.command.run(typed('start'));
  await clock.settle();
  for (const surface of ['terminal', 'desktop'] as const) {
    const quiet = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, isWorking: true } });
    expect(await quiet.find({ type: 'Text', text: /talking to/ })).toBeUndefined();
    await quiet.unmount();
    const ui = await $.ui.mount({ ...BAND, surface });
    await must(ui, { type: 'Text', text: 'Fyreflock: talking to @sam, 1 new line' });
    expect(await dot(ui)).toBe('success');
    await ui.unmount();
  }
});

test('a video invite is answered in the pane and the call opens in the browser', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { FYREFLOCK_TOKEN: 'tok', FYREFLOCK_URL: 'http://fyreflock.test/mcp' });
  let accepted = false;
  const invited = () => {
    const s = matched([{ from: 'them', body: 'video?', at: 1 }]);
    const pendingVideo = { peerName: 'sam', youInvited: false, youAccepted: accepted, theyAccepted: true, expiresAt: 0 };
    return { ...s, mirror: { ...s.mirror, pendingVideo } };
  };
  const { calls } = server(on, {
    fyreflock_app_wait: invited,
    fyreflock_app_video: (args) => {
      accepted = args.answer === 'accept';
      return invited();
    },
  });

  await $.command.run(typed('start'));
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await must(ui, { type: 'Text', text: /@sam wants to video call/ });

  await ui.press({ key: 'video-yes' });
  await clock.settle();
  expect(calls.find((c) => c.name === 'fyreflock_app_video')?.args).toEqual({ answer: 'accept' });
  await must(ui, { type: 'Text', text: /You both said yes/ });
  // The terminal has no camera: the yes becomes a link to the call, tagged with where it came from.
  const link = await ui.find({ type: 'Link' });
  expect(link?.props.href).toBe('http://fyreflock.test/handoff?utm_source=claude');
  await ui.unmount();
});
