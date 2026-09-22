const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const addon = process.argv[2];
const root = process.argv[3];
const { NativeOkfSearch: Native, lifecycleFixture: hook, lifecycleMappedFixture: mapped, lifecycleWorkspaceFixture: workspace, lifecycleReleaseWorkspaceFixture: releaseWorkspace } = require(addon);
const document = (word) => ({ path: 'same.md', markdown: `---\ntype: note\n---\n# title\n${word}` });
const fresh = () => Native.fromRaw([document('capturedneedle')]);
const target = (name) => path.join(root, `${name}.okf`);
const closed = /ERR_OKF_INDEX_CLOSED/;
function assertClosed(index) {
  for (const call of [
    () => index.assertUsable(), () => index.search('', { limit: -1 }),
    () => index.ingestRaw({ get path() { throw Error('getter ran'); } }),
    () => index.removePath('bad'), () => index.removeDocument('bad'),
    () => index.indexStats(), () => index.listTypes(), () => index.listDegradedDocuments(),
    () => index.autoSuggest('', { get limit() { throw Error('getter ran'); } }), () => index.save(''),
    () => index.ingestPrepared({ get documentId() { throw Error('getter ran'); } }),
    () => index.ingestPrepared({ documentId: '', path: '', type: '', title: '', tags: [], conformance: 'strict', stalenessClassified: false, resource: '', description: '', sourceText: '', sections: [], diagnostics: [] }),
  ]) assert.throws(call, closed);
  for (const value of [undefined, null, 42, true, Symbol('invalid'), {}, []]) {
    for (const call of [
      () => index.removeDocument(value), () => index.search(value),
      () => index.search('query', value), () => index.autoSuggest(value),
      () => index.save(value), () => index.ingestRaw(value),
      () => index.ingestPrepared(value), () => index.removePath(value),
    ]) assert.throws(call, closed);
  }
}
async function main() {
  const open = fresh();
  for (const value of [undefined, null, 42, true, Symbol('invalid'), {}, []]) {
    for (const call of [
      () => open.removeDocument(value), () => open.search(value),
      () => open.autoSuggest(value), () => open.save(value), () => open.removePath(value),
    ]) assert.throws(call);
  }
  for (const value of [42, true, Symbol('invalid')]) {
    assert.throws(() => open.search('query', value));
    assert.throws(() => open.ingestRaw(value));
  }
  await open.save(target('invalid-arguments-retry'));
  await open.close();
  assertClosed(open);
  const prepared = Native.fromPrepared([]);
  const preparedDocument = { documentId: 'prepared', path: 'prepared.md', type: 'note', title: '', tags: [], conformance: 'strict', status: 'stable', trustTier: 'unverified', stalenessClassified: true, resource: '', description: '', sourceText: '', sections: [{ sectionId: 'prepared#0', headingPath: '', text: 'preparedneedle', startLine: 1, endLine: 1 }], diagnostics: [] };
  prepared.ingestPrepared(preparedDocument);
  assert.equal(prepared.indexStats().logical.documents.total, 1);
  let reentrantClose;
  assert.throws(() => prepared.ingestPrepared({ ...preparedDocument, get documentId() { reentrantClose = prepared.close(); return 'prepared'; } }), closed);
  await reentrantClose;
  const poisoned = require(addon).createPoisonedSearchFixture();
  assert.throws(() => poisoned.indexStats(), /ERR_OKF_INDEX_UNUSABLE/);
  await poisoned.close();
  assertClosed(poisoned);
  // Each scheduling/capture/deferred failure releases both destination and handle claims.
  for (const storage of ['memory', 'mmap']) {
  for (const point of ['capture', 'save-deferred', 'okf-save', 'publication', 'publication-panic']) {
    const index = storage === 'mmap' ? mapped() : fresh();
    const owned = storage === 'mmap' ? workspace(index) : undefined;
    const destination = target(`${storage}-${point}`);
    await index.save(destination);
    const previous = fs.readFileSync(destination);
    index.ingestRaw(document('retryneedle'));
    hook(index, `fail:${point}`);
    await assert.rejects(async () => index.save(destination), point === 'okf-save'
      ? { code: 'ERR_OKF_WRITE', path: destination }
      : undefined);
    assert.deepEqual(fs.readFileSync(destination), previous);
    assert.equal(index.search('retryneedle').length, 1);
    await index.save(destination);
    const restored = await Native.openRaw(root, destination, storage);
    assert.equal(restored.search('retryneedle').length, 1);
    const contender = fresh();
    await contender.save(destination);
    await Promise.all([index.close(), contender.close(), restored.close()]);
    assertClosed(index);
    if (owned) assert(!fs.existsSync(owned));
  }
  }
  // Exercise real native failures and held save claims through the built facade translator.
  const facadeNative = fresh();
  const contenderNative = fresh();
  const facadeNatives = [facadeNative, contenderNative];
  const loader = require.resolve('../../native.cjs');
  require.cache[loader] = { id: loader, filename: loader, loaded: true,
    exports: { NativeOkfSearch: { fromRaw: () => facadeNatives.shift() } } };
  const { createOkfSearch, OkfError } = require('../../dist/index.cjs');
  const facade = createOkfSearch([]);
  const facadeContender = createOkfSearch([]);
  const facadeDestination = target('facade-spawn');
  hook(facadeNative, 'fail:okf-save');
  await assert.rejects(facade.save(facadeDestination), { code: 'ERR_OKF_WRITE', path: facadeDestination });
  await facade.save(facadeDestination);

  // Back-to-back JS calls need not overlap native publication. Hold both claims
  // until the same-handle and independent-handle rejections have been observed.
  hook(facadeNative, 'pause:publication');
  const facadeSave = facade.save(facadeDestination);
  try {
    hook(facadeNative, 'wait');
    await assert.rejects(facade.save(target('facade-different')), error =>
      error instanceof OkfError && error.code === 'ERR_OKF_PERSISTENCE_BUSY' && error.path === '<index>');
    await assert.rejects(facadeContender.save(facadeDestination), error =>
      error instanceof OkfError && error.code === 'ERR_OKF_CACHE_BUSY' && error.path === facadeDestination);
  } finally {
    hook(facadeNative, 'release');
    await facadeSave;
  }
  await facade.save(facadeDestination);
  await facadeContender.save(facadeDestination);
  await Promise.all([facade.close(), facadeContender.close()]);

  // Invalid destination and destination contention also release the save permit.
  const index = fresh();
  assert.throws(() => index.save(''));
  hook(index, 'pause:publication');
  const first = index.save(target('capture'));
  hook(index, 'wait');
  assert.throws(() => index.save(target('different')), /ERR_OKF_PERSISTENCE_BUSY/);
  const contender = fresh();
  assert.throws(() => contender.save(target('capture')), /ERR_OKF_CACHE_BUSY/);
  index.ingestRaw(document('lateeditneedle'));
  index.ingestRaw({ ...document('latenewneedle'), path: 'new.md' });
  index.removePath('same.md');
  const close = index.close();
  assertClosed(index);
  const repeated = index.close();
  hook(index, 'release');
  await Promise.all([first, close, repeated]);
  assertClosed(index);
  assert.equal(hook(index, 'events').filter(x => x.startsWith('teardown:')).length, 1);
  const restored = await Native.openRaw(root, target('capture'));
  assert.equal(restored.search('capturedneedle').length, 1);
  assert.equal(restored.search('lateeditneedle').length, 0);
  assert.equal(restored.search('latenewneedle').length, 0);
  await Promise.all([restored.close(), contender.close()]);

  // Close on either side of the settlement-to-idle handoff has one owner.
  for (const point of ['publication', 'handoff', 'idle']) {
    for (const fail of [null, 'publication', 'publication-panic']) {
      const index = mapped();
      const owned = workspace(index);
      assert(fs.existsSync(owned));
      const destination = target(`${point}-${fail}`);
      index.ingestRaw(document('previousneedle'));
      await index.save(destination);
      const previous = fs.readFileSync(destination);
      index.ingestRaw(document('publishedneedle'));
      if (fail) hook(index, `fail:${fail}`);
      hook(index, `pause:${point}`);
      const save = index.save(target(`${point}-${fail}`));
      const observed = save.then(() => 'published', error => {
        assert.match(error.message, fail === 'publication-panic' ? /ERR_OKF_NATIVE/ : /ERR_OKF_WRITE/);
        return 'failed';
      });
      hook(index, 'wait');
      const close = index.close();
      const again = index.close();
      assertClosed(index);
      hook(index, 'release');
      assert.equal(await observed, fail ? 'failed' : 'published');
      await Promise.all([close, again, index.close()]);
      assert(!fs.existsSync(owned));
      if (fail) assert.deepEqual(fs.readFileSync(destination), previous);
      const reopened = await Native.openRaw(root, destination, 'mmap');
      assert.equal(reopened.search(fail ? 'previousneedle' : 'publishedneedle').length, 1);
      assert.equal(reopened.search(fail ? 'publishedneedle' : 'previousneedle').length, 0);
      await reopened.close();
      const teardowns = hook(index, 'events').filter(x => x.startsWith('teardown:'));
      assert.deepEqual(teardowns, [`teardown:${point === 'idle' ? 'okf-close' : 'okf-save'}`]);
    }
  }
  // A first deferred failure leaves admission open; a repeated failure cannot reopen.
  const deferred = fresh();
  hook(deferred, 'fail:close-deferred');
  assert.throws(() => deferred.close(), /close-deferred/);
  assert.equal(deferred.search('capturedneedle').length, 1);
  hook(deferred, 'pause:teardown');
  const closing = deferred.close();
  hook(deferred, 'wait');
  hook(deferred, 'fail:close-deferred');
  assert.throws(() => deferred.close(), /close-deferred/);
  assertClosed(deferred);
  const waiter = deferred.close();
  hook(deferred, 'release');
  await Promise.all([closing, waiter]);

  // Failed teardown scheduling consumes resources synchronously, stores failure once.
  const failed = mapped();
  const failedPath = workspace(failed);
  hook(failed, 'pause:idle');
  const published = failed.save(target('successful-save'));
  hook(failed, 'wait');
  hook(failed, 'fail:okf-close');
  const failedClose = failed.close();
  hook(failed, 'release');
  await published;
  const firstFailure = await failedClose.then(() => assert.fail(), e => e.message);
  assert.match(firstFailure, /ERR_OKF_CLOSE/);
  assert.equal(await failed.close().then(() => assert.fail(), e => e.message), firstFailure);
  assertClosed(failed);
  assert(!fs.existsSync(failedPath));
  assert.equal(hook(failed, 'events').filter(x => x.startsWith('teardown:')).length, 1);
  assert(fs.existsSync(target('successful-save')));

  // Close never republishes later private mutations and removes only owned backing.
  const privateHandle = mapped();
  const otherHandle = mapped();
  const privatePath = workspace(privateHandle);
  const otherPath = workspace(otherHandle);
  privateHandle.ingestRaw(document('savedneedle'));
  await privateHandle.save(target('no-implicit-save'));
  const savedBytes = fs.readFileSync(target('no-implicit-save'));
  privateHandle.ingestRaw(document('unsavedneedle'));
  await privateHandle.close();
  assert.deepEqual(fs.readFileSync(target('no-implicit-save')), savedBytes);
  assert(!fs.existsSync(privatePath));
  assert(fs.existsSync(otherPath));
  await otherHandle.close();

  // Dropping promises does not cancel publication or make native cleanup await callbacks.
  const dropped = mapped();
  const droppedPath = workspace(dropped);
  dropped.save(target('dropped'));
  dropped.close();
  await dropped.close();
  assert(!fs.existsSync(droppedPath));
  assert(fs.existsSync(target('dropped')));

  // Terminate a JS environment after save/close admission. Wait for owned backing
  // removal outside that environment, so JS settlement cannot be the cleanup owner.
  for (const close of [false, true]) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const api = require(workerData.addon);
    const handle = api.lifecycleMappedFixture();
    const owned = api.lifecycleWorkspaceFixture(handle);
    api.lifecycleFixture(handle, 'pause:publication');
    handle.save(workerData.target);
    if (workerData.close) handle.close();
    api.lifecycleFixture(handle, 'wait');
    parentPort.postMessage(owned);
  `, { eval: true, workerData: { addon, close, target: target(`environment-${close}`) } });
  const owned = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  await worker.terminate();
  assert(fs.existsSync(owned), 'held publication lost its workspace');
  releaseWorkspace(owned);
  const deadline = Date.now() + 15000;
  while (fs.existsSync(owned) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert(!fs.existsSync(owned), 'environment teardown stranded workspace');
  assert(fs.existsSync(target(`environment-${close}`)));
  }
  const holder = fork(__filename, [addon, root, 'hold-workspace'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(holder, 'exit');
  let foreignPath;
  try {
  [foreignPath] = await once(holder, 'message', { signal: AbortSignal.timeout(15_000) });
  for (let n = 0; n < 20; n++) {
    const handle = mapped();
    const owned = workspace(handle);
    for (let mutation = 0; mutation < 8; mutation++) {
      handle.ingestRaw({ ...document(`stressneedle${n}`), path: `doc${mutation}.md` });
    }
    handle.removePath('doc0.md');
    const save = handle.save(target(`stress-${n}`));
    await Promise.all([save, handle.close(), handle.close()]);
    assert(!fs.existsSync(owned));
    const reopened = await Native.openRaw(root, target(`stress-${n}`), 'mmap');
    const reopenedPath = workspace(reopened);
    assert.equal(reopened.indexStats().logical.documents.total, 7);
    await reopened.close();
    assert(!fs.existsSync(reopenedPath));
    assert(fs.existsSync(foreignPath), 'close removed another process workspace');
  }
  } finally {
    if (foreignPath && holder.connected) holder.send('close');
    else holder.kill();
    const [code] = await exited;
    assert.equal(code, 0);
  }
  assert(!fs.existsSync(foreignPath));
}
async function holdWorkspace() {
  const handle = mapped();
  const close = once(process, 'message');
  process.send(workspace(handle));
  await close;
  await handle.close();
  process.disconnect();
}
(process.argv[4] === 'hold-workspace' ? holdWorkspace() : main()).catch(error => { console.error(error); process.exitCode = 1; });
