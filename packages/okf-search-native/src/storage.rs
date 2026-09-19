//! Private per-engine index backing. Archives are never mapped.
use std::{collections::BTreeMap, io, path::Path, sync::Arc};
use tantivy::directory::{Directory, MmapDirectory, RamDirectory};

#[derive(Clone, Copy)]
#[allow(dead_code)] // Selected publicly in a later phase.
pub(super) enum StorageMode {
    Memory,
    Mmap,
}

pub(super) enum IndexStorage {
    Memory(RamDirectory),
    Mmap {
        directory: MmapDirectory,
        workspace: std::path::PathBuf,
        temporary: Option<tempfile::TempDir>,
    },
}
impl IndexStorage {
    pub(super) fn new(mode: StorageMode) -> tantivy::Result<Self> {
        Ok(match mode {
            StorageMode::Memory => Self::Memory(RamDirectory::create()),
            StorageMode::Mmap => {
                let mut builder = tempfile::Builder::new();
                builder.prefix("okf-search-mmap-");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    builder.permissions(std::fs::Permissions::from_mode(0o700));
                }
                let workspace = builder.tempdir()?;
                let directory = MmapDirectory::open(workspace.path())?;
                Self::Mmap {
                    directory,
                    workspace: workspace.path().to_owned(),
                    temporary: Some(workspace),
                }
            }
        })
    }
    pub(super) fn preserve_workspace(&mut self) -> Option<std::path::PathBuf> {
        match self {
            Self::Memory(_) => None,
            Self::Mmap { workspace, temporary, .. } => {
                if let Some(directory) = temporary.take() {
                    crate::shutdown::preserve(directory);
                }
                Some(workspace.clone())
            }
        }
    }
    pub(super) fn directory(&self) -> Box<dyn Directory> {
        match self {
            Self::Memory(d) => Box::new(d.clone()),
            Self::Mmap { directory, .. } => Box::new(directory.clone()),
        }
    }
    pub(super) fn size(&self) -> io::Result<usize> {
        match self {
            Self::Memory(d) => Ok(d.total_mem_usage()),
            Self::Mmap { workspace, .. } => {
                let mut size = 0;
                let context = |e: io::Error| {
                    io::Error::new(e.kind(), format!("{}: {e}", workspace.as_path().display()))
                };
                for entry in std::fs::read_dir(workspace.as_path()).map_err(context)? {
                    let entry = entry.map_err(context)?;
                    let metadata = match std::fs::symlink_metadata(entry.path()) {
                        Ok(metadata) => metadata,
                        Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                        Err(e) => {
                            return Err(io::Error::new(
                                e.kind(),
                                format!("{}: {e}", entry.path().display()),
                            ));
                        }
                    };
                    if metadata.is_file() {
                        size += metadata.len() as usize;
                    }
                }
                Ok(size)
            }
        }
    }
}

pub(super) type Files = BTreeMap<String, tantivy::directory::OwnedBytes>;

/// Only validation uses this directory. File handles share the captured buffers;
/// lock and watch bookkeeping is independent of the live index.
#[derive(Debug, Clone)]
pub(super) struct CapturedDirectory {
    pub(super) files: Arc<Files>,
    locks: RamDirectory,
}
impl CapturedDirectory {
    pub(super) fn new(files: Files) -> Self {
        Self {
            files: Arc::new(files),
            locks: RamDirectory::create(),
        }
    }
}
impl Directory for CapturedDirectory {
    fn get_file_handle(
        &self,
        path: &Path,
    ) -> Result<Arc<dyn tantivy::directory::FileHandle>, tantivy::directory::error::OpenReadError>
    {
        let bytes = self
            .files
            .get(path.to_str().unwrap_or_default())
            .ok_or_else(|| {
                tantivy::directory::error::OpenReadError::FileDoesNotExist(path.to_owned())
            })?;
        Ok(Arc::new(bytes.clone()))
    }
    fn exists(&self, path: &Path) -> Result<bool, tantivy::directory::error::OpenReadError> {
        Ok(self.files.contains_key(path.to_str().unwrap_or_default()))
    }
    fn atomic_read(
        &self,
        path: &Path,
    ) -> Result<Vec<u8>, tantivy::directory::error::OpenReadError> {
        self.files
            .get(path.to_str().unwrap_or_default())
            .map(|bytes| bytes.to_vec())
            .ok_or_else(|| {
                tantivy::directory::error::OpenReadError::FileDoesNotExist(path.to_owned())
            })
    }
    fn delete(&self, path: &Path) -> Result<(), tantivy::directory::error::DeleteError> {
        self.locks.delete(path)
    }
    fn open_write(
        &self,
        path: &Path,
    ) -> Result<tantivy::directory::WritePtr, tantivy::directory::error::OpenWriteError> {
        self.locks.open_write(path)
    }
    fn atomic_write(&self, _path: &Path, _data: &[u8]) -> io::Result<()> {
        Err(io::Error::other("read-only captured files"))
    }
    fn sync_directory(&self) -> io::Result<()> {
        Ok(())
    }
    fn acquire_lock(
        &self,
        lock: &tantivy::directory::Lock,
    ) -> Result<tantivy::directory::DirectoryLock, tantivy::directory::error::LockError> {
        self.locks.acquire_lock(lock)
    }
    fn watch(
        &self,
        callback: tantivy::directory::WatchCallback,
    ) -> tantivy::Result<tantivy::directory::WatchHandle> {
        self.locks.watch(callback)
    }
}

#[cfg(test)]
pub(super) mod test_directory {
    use super::*;
    use parking_lot::Mutex;
    use std::{
        path::PathBuf,
        sync::mpsc::{self, Receiver, Sender},
        time::Duration,
    };
    use tantivy::directory::error::*;
    use tantivy::directory::*;

    pub const TIMEOUT: Duration = Duration::from_secs(15);
    pub struct Gate {
        reached: Sender<()>,
        resume: Receiver<()>,
    }
    impl Gate {
        pub fn new() -> (Self, Receiver<()>, Sender<()>) {
            let (reached, seen) = mpsc::channel();
            let (release, resume) = mpsc::channel();
            (Self { reached, resume }, seen, release)
        }
        fn wait(self) {
            self.reached.send(()).unwrap();
            self.resume
                .recv_timeout(TIMEOUT)
                .expect("directory gate timed out");
        }
    }
    #[derive(Debug)]
    pub enum Event {
        Delete(PathBuf),
        LockAttempt,
        LockResult(bool),
        MetaWritten,
    }
    #[derive(Default)]
    pub struct Hooks {
        pub events: Option<Sender<Event>>,
        pub before_meta: Option<Gate>,
        pub before_sentinel_delete: Option<Gate>,
        pub fail_read: Option<PathBuf>,
    }
    #[derive(Clone)]
    pub struct ObservedDirectory {
        inner: Box<dyn Directory>,
        pub hooks: Arc<Mutex<Hooks>>,
    }
    impl std::fmt::Debug for ObservedDirectory {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_tuple("ObservedDirectory")
                .field(&self.inner)
                .finish()
        }
    }
    impl ObservedDirectory {
        pub fn new(inner: Box<dyn Directory>) -> Self {
            Self {
                inner,
                hooks: Arc::new(Mutex::new(Hooks::default())),
            }
        }
        fn event(&self, event: Event) {
            if let Some(sender) = &self.hooks.lock().events {
                let _ = sender.send(event);
            }
        }
    }
    impl Directory for ObservedDirectory {
        fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
            self.inner.get_file_handle(path)
        }
        fn open_read(&self, path: &Path) -> Result<FileSlice, OpenReadError> {
            self.inner.open_read(path)
        }
        fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
            self.inner.exists(path)
        }
        fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
            let mut hooks = self.hooks.lock();
            if hooks.fail_read.as_deref() == Some(path) {
                hooks.fail_read.take();
                return Err(OpenReadError::wrap_io_error(
                    io::Error::other("injected capture read failure"),
                    path.to_owned(),
                ));
            }
            drop(hooks);
            self.inner.atomic_read(path)
        }
        fn delete(&self, path: &Path) -> Result<(), DeleteError> {
            self.event(Event::Delete(path.to_owned()));
            if path == Path::new("gc-sentinel") {
                let gate = self.hooks.lock().before_sentinel_delete.take();
                if let Some(gate) = gate {
                    gate.wait();
                }
            }
            self.inner.delete(path)
        }
        fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
            self.inner.open_write(path)
        }
        fn atomic_write(&self, path: &Path, data: &[u8]) -> io::Result<()> {
            if path == Path::new("meta.json") {
                let gate = self.hooks.lock().before_meta.take();
                if let Some(gate) = gate {
                    gate.wait();
                }
            }
            self.inner.atomic_write(path, data)?;
            if path == Path::new("meta.json") {
                self.event(Event::MetaWritten);
            }
            Ok(())
        }
        fn sync_directory(&self) -> io::Result<()> {
            self.inner.sync_directory()
        }
        fn acquire_lock(&self, lock: &Lock) -> Result<DirectoryLock, LockError> {
            let meta = lock.filepath == META_LOCK.filepath;
            if meta {
                self.event(Event::LockAttempt);
            }
            let result = self.inner.acquire_lock(lock);
            if meta {
                self.event(Event::LockResult(result.is_ok()));
            }
            result
        }
        fn watch(&self, callback: WatchCallback) -> tantivy::Result<WatchHandle> {
            self.inner.watch(callback)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapped_size_samples_only_direct_regular_files() {
        let storage = IndexStorage::new(StorageMode::Mmap).unwrap();
        let IndexStorage::Mmap { workspace, .. } = &storage else {
            unreachable!()
        };
        let initial = storage.size().unwrap();
        std::fs::write(workspace.as_path().join("obsolete"), b"12345").unwrap();
        std::fs::write(workspace.as_path().join(".lock"), b"123").unwrap();
        std::fs::create_dir(workspace.as_path().join("nested")).unwrap();
        std::fs::write(workspace.as_path().join("nested/ignored"), b"123456789").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt, symlink};
            assert_eq!(
                std::fs::metadata(workspace.as_path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
            symlink(
                workspace.as_path().join("obsolete"),
                workspace.as_path().join("ignored-link"),
            )
            .unwrap();
        }
        assert_eq!(storage.size().unwrap(), initial + 8);
        std::fs::remove_dir_all(workspace.as_path()).unwrap();
        assert!(
            storage
                .size()
                .unwrap_err()
                .to_string()
                .contains("okf-search-mmap-")
        );
    }
}
