const test = require('node:test');
const assert = require('node:assert');
const { computeCallerStats } = require('./callerStats');

// One hunt: alice called 2 slots and got both in (one opened at 10x), bob called 2 and got 0 in.
const HUNTS = [{
  calls: [
    { slot: 'Mental',   user: 'alice', callerId: '111', status: 'pending' },
    { slot: 'Le Bandit', user: 'alice', callerId: '111', status: 'pending' },
    { slot: 'Starlight', user: 'bob',   callerId: '222', status: 'pending' },
    { slot: 'Wanted',    user: 'bob',   callerId: '222', status: 'pending' },
  ],
  bonuses: [
    { slot: 'Mental',    bet: 10, win: 100, caller: 'alice', callerId: '111', ts: 1 },
    { slot: 'Le Bandit', bet: 10, win: null, caller: 'alice', callerId: '111', ts: 2 },
  ],
}];

test('hit rate is got-in calls over total calls, per caller id', () => {
  const r = computeCallerStats(HUNTS, { minColdCalls: 1, limit: 5 });
  const alice = r.best.find(x => x.callerId === '111');
  assert.strictEqual(alice.calls, 2);
  assert.strictEqual(alice.gotIn, 2);
  assert.strictEqual(alice.hitRate, 1);
});

test('avgMulti averages only OPENED bonuses (win > 0), unopened excluded', () => {
  const r = computeCallerStats(HUNTS, { minColdCalls: 1, limit: 5 });
  const alice = r.best.find(x => x.callerId === '111');
  assert.strictEqual(alice.avgMulti, 10); // 100/10 from the single opened bonus
});

test('a caller with zero got-ins reports hitRate 0, not NaN', () => {
  const r = computeCallerStats(HUNTS, { minColdCalls: 1, limit: 5 });
  const bob = r.cold.find(x => x.callerId === '222');
  assert.strictEqual(bob.hitRate, 0);
  assert.strictEqual(bob.avgMulti, null);
});

test('calls with no callerId are excluded and counted, never name-matched', () => {
  const hunts = [{
    calls: [
      { slot: 'Mental', user: 'alice', status: 'pending' },            // no callerId
      { slot: 'Mental', user: 'alice', callerId: '111', status: 'pending' },
    ],
    bonuses: [{ slot: 'Mental', bet: 10, win: 50, caller: 'alice', callerId: '111', ts: 1 }],
  }];
  const r = computeCallerStats(hunts, { minColdCalls: 1, limit: 5 });
  assert.strictEqual(r.excludedCalls, 1);
  assert.strictEqual(r.best.find(x => x.callerId === '111').calls, 1);
});

test('cold list requires minColdCalls; low-volume callers are not shamed', () => {
  const hunts = [{
    calls: [{ slot: 'Mental', user: 'newbie', callerId: '999', status: 'pending' }],
    bonuses: [],
  }];
  const r = computeCallerStats(hunts, { minColdCalls: 15, limit: 5 });
  assert.strictEqual(r.cold.length, 0);
});

test('best is sorted by hit rate descending, cold ascending', () => {
  const hunts = [{
    calls: [
      { slot: 'A', user: 'hi', callerId: '1', status: 'pending' },
      { slot: 'B', user: 'lo', callerId: '2', status: 'pending' },
      { slot: 'C', user: 'lo', callerId: '2', status: 'pending' },
    ],
    bonuses: [{ slot: 'A', bet: 1, win: 2, caller: 'hi', callerId: '1', ts: 1 }],
  }];
  const r = computeCallerStats(hunts, { minColdCalls: 1, limit: 5 });
  assert.strictEqual(r.best[0].callerId, '1');
  assert.strictEqual(r.cold[0].callerId, '2');
});
