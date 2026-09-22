//! Consuming shutdown shared by complete engines and failed construction.
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
};
use tantivy::IndexWriter;

#[cfg(test)]
thread_local! {
    pub(super) static REMOVALS: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
    pub(super) static FAIL_REMOVAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Debug, Clone)]
pub(crate) struct ShutdownError {
    pub(crate) message: String,
    pub(crate) workspace: Option<PathBuf>,
}

impl std::error::Error for ShutdownError {}

impl std::fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ERR_OKF_CLOSE: {}", self.message)?;
        if let Some(path) = &self.workspace {
            write!(f, "; preserved workspace {}", path.display())?;
        }
        Ok(())
    }
}

/// Call before creating any writer. A kept path cannot be deleted by unwinding.
/// Pass the owned path to `finish` even when construction fails.
pub(crate) fn preserve(workspace: tempfile::TempDir) -> PathBuf {
    workspace.keep()
}

/// `resources` must include every local reader, index, directory and mapped buffer.
/// No save or commit is performed. A worker error is NOT proof of quiescence:
/// Tantivy can return early after taking (and detaching) the other join handles.
pub(crate) fn finish<R>(
    writer: IndexWriter,
    resources: R,
    workspace: Option<PathBuf>,
) -> Result<(), ShutdownError> {
    let stopped = catch_unwind(AssertUnwindSafe(|| writer.wait_merging_threads()));
    let released = catch_unwind(AssertUnwindSafe(|| drop(resources)));
    let failure = match stopped {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(format!("worker shutdown failed: {error}")),
        Err(_) => Some("worker shutdown panicked".into()),
    }
    .or_else(|| released.err().map(|_| "resource release panicked".into()));
    if let Some(message) = failure {
        return Err(ShutdownError { message, workspace });
    }
    if let Some(path) = &workspace {
        #[cfg(test)]
        REMOVALS.with(|attempts| attempts.borrow_mut().push(path.clone()));
        #[cfg(test)]
        if FAIL_REMOVAL.replace(false) {
            return Err(ShutdownError {
                message: "injected workspace removal failure".into(),
                workspace,
            });
        }
        std::fs::remove_dir_all(path).map_err(|error| ShutdownError {
            message: format!("workspace removal failed: {error}"),
            workspace: workspace.clone(),
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::{
        io::{self, Write},
        path::Path,
        sync::{Arc, mpsc},
        time::Duration,
    };
    use tantivy::{
        Index, IndexSettings,
        directory::{error::*, *},
        schema::{Schema, TEXT},
    };

    const WAIT: Duration = Duration::from_secs(15);

    #[derive(Debug)]
    struct DirectoryReleased(mpsc::Sender<()>);
    impl Drop for DirectoryReleased {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    #[derive(Debug, Clone)]
    struct FailingDirectory {
        inner: MmapDirectory,
        _released: Arc<DirectoryReleased>,
        started: mpsc::Sender<()>,
        start: Arc<Mutex<mpsc::Receiver<()>>>,
        flushing: mpsc::Sender<String>,
        fail: Arc<Mutex<mpsc::Receiver<()>>>,
        release: Arc<Mutex<mpsc::Receiver<()>>>,
        finished: mpsc::Sender<()>,
    }

    struct FailingFlush {
        inner: WritePtr,
        hooks: FailingDirectory,
    }

    impl Write for FailingFlush {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.inner.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
    }

    impl TerminatingWrite for FailingFlush {
        fn terminate_ref(&mut self, token: AntiCallToken) -> io::Result<()> {
            let name = std::thread::current().name().unwrap().to_owned();
            self.hooks.flushing.send(name.clone()).unwrap();
            if name.ends_with("index0") {
                self.hooks.fail.lock().recv_timeout(WAIT).unwrap();
                return Err(io::Error::other("injected indexing-worker flush failure"));
            }
            self.hooks.release.lock().recv_timeout(WAIT).unwrap();
            let result = self.inner.terminate_ref(token);
            self.hooks.finished.send(()).unwrap();
            result
        }
    }

    impl Directory for FailingDirectory {
        fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
            self.inner.get_file_handle(path)
        }
        fn delete(&self, path: &Path) -> Result<(), DeleteError> {
            self.inner.delete(path)
        }
        fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
            self.inner.exists(path)
        }
        fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
            let inner = self.inner.open_write(path)?;
            if path.extension().and_then(|s| s.to_str()) == Some("fast") {
                self.started.send(()).unwrap();
                self.start.lock().recv_timeout(WAIT).unwrap();
                return Ok(io::BufWriter::new(Box::new(FailingFlush {
                    inner,
                    hooks: self.clone(),
                })));
            }
            Ok(inner)
        }
        fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
            self.inner.atomic_read(path)
        }
        fn atomic_write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            self.inner.atomic_write(path, bytes)
        }
        fn sync_directory(&self) -> io::Result<()> {
            self.inner.sync_directory()
        }
        fn acquire_lock(&self, lock: &Lock) -> Result<DirectoryLock, LockError> {
            self.inner.acquire_lock(lock)
        }
        fn watch(&self, callback: WatchCallback) -> tantivy::Result<WatchHandle> {
            self.inner.watch(callback)
        }
    }

    #[test]
    fn actual_worker_failure_preserves_workspace_while_another_worker_is_live() {
        for mode in ["explicit", "partial", "unassembled", "finalizer", "handle"] {
            worker_failure(mode);
        }
    }

    fn worker_failure(mode: &'static str) {
        let mut storage = crate::IndexStorage::new(crate::StorageMode::Mmap).unwrap();
        let workspace = storage.preserve_workspace().unwrap();
        std::fs::write(workspace.join("sentinel"), b"must survive").unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (start_tx, start_rx) = mpsc::channel();
        let (flushing_tx, flushing_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (fail_tx, fail_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let (gone_tx, gone_rx) = mpsc::channel();
        let directory = FailingDirectory {
            _released: Arc::new(DirectoryReleased(gone_tx)),
            inner: match &storage {
                crate::IndexStorage::Mmap { directory, .. } => directory.clone(),
                _ => unreachable!(),
            },
            started: started_tx,
            start: Arc::new(Mutex::new(start_rx)),
            flushing: flushing_tx,
            fail: Arc::new(Mutex::new(fail_rx)),
            release: Arc::new(Mutex::new(release_rx)),
            finished: finished_tx,
        };
        let mut schema = Schema::builder();
        let field = schema.add_text_field("text", TEXT);
        let index = Index::create(directory, schema.build(), IndexSettings::default()).unwrap();
        let writer = index.writer_with_num_threads(2, 30_000_000).unwrap();
        for _ in 0..100 {
            writer
                .add_document(tantivy::doc!(field => "worker flush contents"))
                .unwrap();
        }
        // Both workers own an active segment before the ingestion channel closes.
        // Each worker reports before blocking; release only after both arrived.
        started_rx.recv_timeout(WAIT).unwrap();
        started_rx.recv_timeout(WAIT).unwrap();
        start_tx.send(()).unwrap();
        start_tx.send(()).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let owned_path = workspace.clone();
        let shutdown_thread = std::thread::spawn(move || {
            let result = if mode == "unassembled" {
                finish(writer, (index, storage), Some(owned_path)).map_err(|e| e.to_string())
            } else {
                let mut engine = crate::Engine::new(Vec::new()).unwrap();
                engine.reader = index
                    .reader_builder()
                    .reload_policy(tantivy::ReloadPolicy::Manual)
                    .try_into()
                    .unwrap();
                engine.writer = writer;
                engine._index = index;
                engine.storage = storage;
                engine.workspace = Some(owned_path);
                if mode == "handle" {
                    crate::lifecycle::HandleState::test_teardown(engine).map_err(|e| e.to_string())
                } else if mode == "explicit" {
                    engine.shutdown().map_err(|e| e.to_string())
                } else if mode == "partial" {
                    let original =
                        crate::EngineError::Invalid("original initialization failure".into());
                    let error = engine.initialization_error(original);
                    let native = crate::native_error(error);
                    assert_eq!(native.status, napi::Status::InvalidArg);
                    assert!(
                        native
                            .reason
                            .contains("[ERR_OKF_INVALID_PREPARED_DOCUMENT]")
                    );
                    assert!(native.reason.contains("original initialization failure"));
                    Err(native.reason)
                } else {
                    drop(engine);
                    Ok(())
                }
            };
            REMOVALS.with(|attempts| assert!(attempts.borrow().is_empty()));
            done_tx.send(result).unwrap();
        });
        let mut names = [
            flushing_rx.recv_timeout(WAIT).unwrap(),
            flushing_rx.recv_timeout(WAIT).unwrap(),
        ];
        names.sort();
        assert!(names[0].ends_with("index0"));
        assert!(names[1].ends_with("index1"));
        fail_tx.send(()).unwrap();
        let result = done_rx.recv_timeout(WAIT).unwrap();
        if mode != "finalizer" {
            let error = result.unwrap_err();
            assert!(
                error.to_string().contains("worker shutdown failed"),
                "{error}"
            );
            assert!(error.to_string().contains(workspace.to_str().unwrap()));
        }
        assert_eq!(
            std::fs::read(workspace.join("sentinel")).unwrap(),
            b"must survive"
        );
        assert!(
            finished_rx.try_recv().is_err(),
            "second worker is still blocked"
        );
        release_tx.send(()).unwrap();
        finished_rx.recv_timeout(WAIT).unwrap();
        shutdown_thread.join().unwrap();
        // Wait for every delegating Directory owner, including detached worker/merge
        // owners, before manually removing this fixture. No sleeps or process-exit assumption.
        gone_rx.recv_timeout(WAIT).unwrap();
        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn resources_are_released_before_removal_and_failures_report_retained_path() {
        struct Release {
            path: PathBuf,
            failure: &'static str,
        }
        impl Drop for Release {
            fn drop(&mut self) {
                assert!(
                    self.path.exists(),
                    "workspace removed before releasing mappings"
                );
                assert_ne!(self.failure, "panic", "injected release panic");
                if self.failure == "removal" {
                    // All mappings have dropped. Replace the directory with a file
                    // so remove_dir_all fails on every platform without permissions.
                    std::fs::remove_dir_all(&self.path).unwrap();
                    std::fs::write(&self.path, b"removal obstruction").unwrap();
                }
            }
        }
        for failure in ["none", "panic", "removal"] {
            let path = preserve(tempfile::tempdir().unwrap());
            let directory = MmapDirectory::open(&path).unwrap();
            let index = Index::create(
                directory.clone(),
                Schema::builder().build(),
                IndexSettings::default(),
            )
            .unwrap();
            let writer: IndexWriter = index.writer_with_num_threads(1, 15_000_000).unwrap();
            let mapped = directory.open_read(Path::new("meta.json")).unwrap();
            let result = finish(
                writer,
                (
                    mapped,
                    index,
                    directory,
                    Release {
                        path: path.clone(),
                        failure,
                    },
                ),
                Some(path.clone()),
            );
            assert_eq!(result.is_err(), failure != "none");
            assert_eq!(path.exists(), failure != "none");
            if let Err(error) = result {
                assert_eq!(error.workspace.as_ref(), Some(&path));
                assert!(error.to_string().contains("ERR_OKF_CLOSE"));
                assert!(error.to_string().contains(path.to_str().unwrap()));
                if failure == "removal" {
                    assert!(error.message.contains("workspace removal failed"));
                    std::fs::remove_file(path).unwrap();
                } else {
                    std::fs::remove_dir_all(path).unwrap();
                }
            }
        }
    }

    #[test]
    fn successful_engine_shutdown_and_finalization_remove_workspace() {
        for explicit in [true, false] {
            let engine =
                crate::Engine::new_with_storage(Vec::new(), crate::StorageMode::Mmap).unwrap();
            let workspace = engine.workspace.clone().unwrap();
            match &engine.storage {
                crate::IndexStorage::Mmap { temporary, .. } => assert!(temporary.is_none()),
                _ => panic!("expected mapped storage"),
            }
            if explicit {
                engine.shutdown().unwrap();
            } else {
                drop(engine);
            }
            assert!(!workspace.exists());
        }
    }
}
