const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
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
}
async function main() {
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
  for (const point of ['capture', 'save-deferred', 'okf-save', 'publication', 'publication-panic']) {
    const index = fresh();
    hook(index, `fail:${point}`);
    await assert.rejects(async () => index.save(target(point)));
    await index.save(target(point));
    const contender = fresh();
    await contender.save(target(point));
    await Promise.all([index.close(), contender.close()]);
  }
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
      if (fail) hook(index, `fail:${fail}`);
      hook(index, `pause:${point}`);
      const save = index.save(target(`${point}-${fail}`));
      const observed = save.then(() => 'published', () => 'failed');
      hook(index, 'wait');
      const close = index.close();
      const again = index.close();
      assertClosed(index);
      hook(index, 'release');
      assert.equal(await observed, fail ? 'failed' : 'published');
      await Promise.all([close, again, index.close()]);
      assert(!fs.existsSync(owned));
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
  for (let n = 0; n < 20; n++) {
    const handle = mapped();
    const owned = workspace(handle);
    const save = handle.save(target(`stress-${n}`));
    await Promise.all([save, handle.close(), handle.close()]);
    assert(!fs.existsSync(owned));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
