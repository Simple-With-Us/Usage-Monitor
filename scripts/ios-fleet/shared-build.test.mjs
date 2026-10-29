import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSharedBuild as next} from './shared-build.mjs';
const STAMP = '202610291259';
const input = {iosBuilds: [], macBuilds: [], complete: true, mergeStamp: STAMP};
test('fresh app plans the merge stamp itself', () => {
  assert.deepEqual(next(input), {build: STAMP});
});
test('existing builds below the stamp lose to the stamp', () => {
  assert.deepEqual(next({...input, iosBuilds: ['2394']}), {build: STAMP});
  assert.deepEqual(next({...input, macBuilds: ['1200']}), {build: STAMP});
  assert.deepEqual(next({...input, iosBuilds: ['0.1.3', '1.1.2']}), {build: STAMP});
  assert.deepEqual(next({...input, extraFloors: [1500]}), {build: STAMP});
});
test('existing build at or above the stamp plans one past it', () => {
  assert.deepEqual(next({...input, iosBuilds: [STAMP]}), {build: '202610291260'});
  assert.deepEqual(next({...input, iosBuilds: ['209912312359']}), {build: '209912312360'});
  assert.deepEqual(next({...input, macBuilds: ['209912312359']}), {build: '209912312360'});
});
test('iOS timestamp builds count now', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645', '202610180127']}),
    {build: '202610291259'}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645', '2394']}),
    {build: '202610291259'}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645'], mergeStamp: '202610180000'}),
    {build: '202610190646'}
  );
});
test('a mac-only higher build holds the floor up', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['1100'], macBuilds: ['202610300900']}),
    {build: '202610300901'}
  );
});
test('dotted builds count by their first component', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['202610300900.1']}),
    {build: '202610300901'}
  );
});
test('paired inventories and the feed floor join one max', () => {
  assert.deepEqual(
    next({iosBuilds: ['1100', '1500'], macBuilds: ['1200'], extraFloors: [1400], complete: true, mergeStamp: STAMP}),
    {build: STAMP}
  );
  assert.deepEqual(
    next({iosBuilds: ['202610300900'], macBuilds: ['1300'], extraFloors: [1400], complete: true, mergeStamp: STAMP}),
    {build: '202610300901'}
  );
  assert.deepEqual(
    next({iosBuilds: ['1100'], macBuilds: ['1300'], extraFloors: [202610300900], complete: true, mergeStamp: STAMP}),
    {build: '202610300901'}
  );
});
test('string floors above the safe-integer range count', () => {
  assert.deepEqual(
    next({...input, extraFloors: ['20261030090012345678']}),
    {build: '20261030090012345679'}
  );
});
test('malformed inventory throws before computing', () => {
  for (const bad of [null, 'NaN', '1.2.3.4', 42, '', ' 1000', 'v1']) {
    assert.throws(() => next({...input, iosBuilds: [bad]}), /malformed build inventory/);
    assert.throws(() => next({...input, macBuilds: [bad]}), /malformed build inventory/);
  }
  for (const bad of [-1, 1.5, NaN, null, '', '12x', '1.5']) {
    assert.throws(() => next({...input, extraFloors: [bad]}), /malformed build inventory/);
  }
  // A malformed entry is reported even when a higher build would also apply.
  assert.throws(() => next({...input, iosBuilds: ['209912312359', 'NaN']}), /malformed build inventory/);
});
test('bad merge stamp throws', () => {
  for (const bad of [undefined, null, 202610291259, '', '1000', '20261029125', '2026102912599', '022610291259', '20261029125a', ' 202610291259']) {
    assert.throws(() => next({...input, mergeStamp: bad}), /malformed merge stamp/);
  }
});
test('incomplete inventory refuses', () => {
  assert.throws(() => next({...input, complete: false}), /complete build inventory required/);
  assert.throws(() => next({...input, complete: undefined}), /complete build inventory required/);
  assert.throws(() => next({macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: '1000', macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
});
