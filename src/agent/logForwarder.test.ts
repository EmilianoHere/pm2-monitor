import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogForwarder } from './logForwarder.js';
import { MonitorEvents, type LogLineEvent } from '../core/events.js';
import type { ProtocolMessage } from '../protocol/messages.js';

function makeForwarder() {
  const events = new MonitorEvents();
  const sent: ProtocolMessage[] = [];
  const fwd = new LogForwarder({ events, send: (m) => sent.push(m) });
  const line = (process: string, stream: 'out' | 'err'): LogLineEvent => ({
    process,
    stream,
    level: stream === 'err' ? 'error' : 'info',
    line: `${process}:${stream}`,
    ts: 1,
  });
  return { events, sent, fwd, line };
}

test('forwards only subscribed process + stream lines', () => {
  const { events, sent, fwd, line } = makeForwarder();
  fwd.subscribe('api', ['out']);
  events.emit('log:line', line('api', 'out')); // forwarded
  events.emit('log:line', line('api', 'err')); // wrong stream, dropped
  events.emit('log:line', line('worker', 'out')); // wrong process, dropped
  assert.equal(sent.length, 1);
  const [frame] = sent;
  assert.equal(frame.type, 'log:line');
  if (frame.type === 'log:line') {
    assert.equal(frame.process, 'api');
    assert.equal(frame.stream, 'out');
  }
});

test('an empty streams array defaults to both out and err', () => {
  const { events, sent, fwd, line } = makeForwarder();
  fwd.subscribe('api', []);
  events.emit('log:line', line('api', 'out'));
  events.emit('log:line', line('api', 'err'));
  assert.equal(sent.length, 2);
});

test('unsubscribe stops forwarding', () => {
  const { events, sent, fwd, line } = makeForwarder();
  fwd.subscribe('api', ['out']);
  fwd.unsubscribe('api');
  events.emit('log:line', line('api', 'out'));
  assert.equal(sent.length, 0);
});

test('clear drops every subscription', () => {
  const { events, sent, fwd, line } = makeForwarder();
  fwd.subscribe('api', ['out']);
  fwd.subscribe('worker', ['err']);
  fwd.clear();
  events.emit('log:line', line('api', 'out'));
  events.emit('log:line', line('worker', 'err'));
  assert.equal(sent.length, 0);
});

test('stop detaches the listener', () => {
  const { events, sent, fwd, line } = makeForwarder();
  fwd.subscribe('api', ['out']);
  fwd.stop();
  events.emit('log:line', line('api', 'out'));
  assert.equal(sent.length, 0);
});
