//! One portable payload plus a retained sibling OS-lock file. Local filesystems only;
//! atomic visibility is not a power-loss durability guarantee.
use super::*;
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tantivy::directory::Directory;

const MAGIC: &[u8; 8] = b"OKFCACHE";
const FORMAT: u32 = 3;
const MAX_MANIFEST: usize = 64 * 1024 * 1024;
// Allow framing overhead for incompressible JSON at the logical limit.
const MAX_ENCODED_MANIFEST: usize = 65 * 1024 * 1024;
// Bump the corresponding revision whenever schema, analysis, or preparation
// semantics change. The exact Tantivy dependency is pinned in Cargo.toml.
const COMPATIBILITY: &str = "schema=2;analyzer=1;preparation=1;tantivy=0.26.1";
type Result<T> = std::result::Result<T, PreparationError>;

fn error(code: &'static str, path: &str, cause: impl std::fmt::Display) -> PreparationError {
    let mut error = invalid(code, path, None);
    error.cause = Some(Box::new(std::io::Error::other(cause.to_string())));
    error
}
pub(super) fn path(value: &Utf16String, field: &str) -> Result<String> {
    let value = decode(value, "ERR_OKF_FIELD", "<input>", Some(field))?;
    if value.is_empty() || value.contains('\0') {
        return Err(invalid("ERR_OKF_FIELD", &value, Some(field)));
    }
    Ok(value)
}

pub(super) struct WriterGuard {
    supplied: String,
    destination: PathBuf,
    lock: File,
}
fn reject_alias(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err(std::io::Error::other("reparse destination is not writable"));
                }
            }
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(std::io::Error::other(
                    "destination must be a regular non-symlink file",
                ));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
impl WriterGuard {
    pub(super) fn acquire(supplied: &str) -> Result<Self> {
        let write_error = |e| error("ERR_OKF_WRITE", supplied, e);
        let destination = Path::new(supplied);
        let name = destination
            .file_name()
            .ok_or_else(|| write_error(std::io::Error::other("missing filename")))?;
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(write_error)?;
        let parent = parent.canonicalize().map_err(write_error)?;
        let destination = parent.join(name);
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if !metadata.file_type().is_symlink() && !metadata.is_file() => {
                return Err(error(
                    "ERR_OKF_READ",
                    supplied,
                    "cache destination is not a regular file",
                ));
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(error("ERR_OKF_READ", supplied, e));
            }
            _ => (),
        }
        reject_alias(&destination).map_err(write_error)?;
        let mut lock_name = std::ffi::OsString::from(".");
        lock_name.push(name);
        lock_name.push(".okf-lock");
        let lock_path = parent.join(lock_name);
        reject_alias(&lock_path).map_err(write_error)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(write_error)?;
        match lock.try_lock_exclusive() {
            Ok(true) => (),
            Ok(false) => {
                return Err(error(
                    "ERR_OKF_CACHE_BUSY",
                    supplied,
                    "another writer holds the destination lock",
                ));
            }
            Err(e) => return Err(write_error(e)),
        }
        Ok(Self {
            supplied: supplied.into(),
            destination,
            lock,
        })
    }
}

impl Drop for WriterGuard {
    fn drop(&mut self) {
        // Explicit unlock also releases a Unix lock if an unrelated concurrent
        // fork briefly inherited the descriptor before close-on-exec runs.
        // Closing the handle still releases OS resources if unlock fails.
        let _ = FileExt::unlock(&self.lock);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    compatibility: String,
    #[serde(deserialize_with = "unique_map")]
    documents: BTreeMap<String, PersistedDocument>,
    #[serde(deserialize_with = "unique_map")]
    files: BTreeMap<String, u64>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedDocument {
    path: String,
    document_type: String,
    status: Option<String>,
    trust_tier: Option<String>,
    section_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    diagnostics: Vec<PersistedDiagnostic>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedDiagnostic {
    code: String,
    message: String,
    field: Option<String>,
}

impl From<DocumentState> for PersistedDocument {
    fn from(state: DocumentState) -> Self {
        Self {
            path: state.path,
            document_type: state.document_type,
            status: state.status,
            trust_tier: state.trust_tier,
            section_count: state.section_count,
            diagnostics: state
                .diagnostics
                .into_iter()
                .map(|d| PersistedDiagnostic {
                    code: d.code,
                    message: d.message,
                    field: d.field,
                })
                .collect(),
        }
    }
}

impl PersistedDocument {
    fn into_state(self, document_id: String) -> DocumentState {
        DocumentState {
            document_id,
            conformance: if self.diagnostics.is_empty() {
                "strict"
            } else {
                "degraded"
            }
            .into(),
            diagnostics: self
                .diagnostics
                .into_iter()
                .map(|d| Diagnostic {
                    code: d.code,
                    message: d.message,
                    field: d.field,
                    path: self.path.clone(),
                })
                .collect(),
            path: self.path,
            document_type: self.document_type,
            status: self.status,
            trust_tier: self.trust_tier,
            section_count: self.section_count,
            section_ids: BTreeSet::new(),
        }
    }
}

fn unique_map<'de, D, V>(deserializer: D) -> std::result::Result<BTreeMap<String, V>, D::Error>
where
    D: serde::Deserializer<'de>,
    V: Deserialize<'de>,
{
    struct Visitor<V>(std::marker::PhantomData<V>);
    impl<'de, V: Deserialize<'de>> serde::de::Visitor<'de> for Visitor<V> {
        type Value = BTreeMap<String, V>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("map with unique keys")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut access: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut map = BTreeMap::new();
            while let Some((key, value)) = access.next_entry::<String, V>()? {
                if map.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate map key"));
                }
            }
            Ok(map)
        }
    }
    deserializer.deserialize_map(Visitor(std::marker::PhantomData))
}
pub(super) struct Snapshot {
    directory: RamDirectory,
    documents: BTreeMap<String, DocumentState>,
}
impl Snapshot {
    pub(super) fn capture(engine: &Engine) -> Self {
        Self {
            directory: engine.ram_directory.deep_clone(),
            documents: engine.documents.clone(),
        }
    }
    fn files(&self) -> tantivy::Result<BTreeMap<String, Vec<u8>>> {
        let index = Index::open(self.directory.clone())?;
        let metas = index.load_metas()?;
        let mut names = BTreeSet::from([PathBuf::from("meta.json")]);
        for segment in metas.segments {
            for file in segment.list_files() {
                if self.directory.exists(&file)? {
                    names.insert(file);
                }
            }
        }
        let mut files = BTreeMap::new();
        for name in &names {
            files.insert(
                name.to_str()
                    .ok_or_else(|| std::io::Error::other("non UTF-8 index filename"))?
                    .to_owned(),
                self.directory.atomic_read(name)?,
            );
        }
        files.insert(".managed.json".into(), serde_json::to_vec(&names)?);
        Ok(files)
    }
    pub(super) fn publish(self, guard: &WriterGuard) -> Result<()> {
        #[cfg(test)]
        {
            let failure = PUBLICATION_FAILURE.take();
            self.publish_with(guard, |point| {
                if failure == Some(point) {
                    Err(std::io::Error::other("injected publication failure"))
                } else {
                    Ok(())
                }
            })
        }
        #[cfg(not(test))]
        {
            self.publish_with(guard)
        }
    }
    fn publish_with(
        self,
        guard: &WriterGuard,
        #[cfg(test)] mut checkpoint: impl FnMut(u8) -> std::io::Result<()>,
    ) -> Result<()> {
        let invalid = |e| error("ERR_OKF_CACHE_INVALID", &guard.supplied, e);
        let files = self.files().map_err(invalid)?;
        // Validate the detached committed generation, never the mutating live directory.
        restore(&files, self.documents.clone(), false)
            .map_err(|e| error("ERR_OKF_CACHE_INVALID", &guard.supplied, e))?;
        let manifest = Manifest {
            compatibility: COMPATIBILITY.into(),
            documents: self
                .documents
                .into_iter()
                .map(|(id, state)| (id, state.into()))
                .collect(),
            files: files
                .iter()
                .map(|(k, v)| (k.clone(), v.len() as u64))
                .collect(),
        };
        let metadata = serde_json::to_vec(&manifest)
            .map_err(|e| error("ERR_OKF_WRITE", &guard.supplied, e))?;
        if metadata.len() > MAX_MANIFEST {
            return Err(error(
                "ERR_OKF_WRITE",
                &guard.supplied,
                "inventory exceeds cache manifest limit",
            ));
        }
        let decoded_length = metadata.len();
        let encoded_metadata = zstd::bulk::compress(&metadata, 3)
            .map_err(|e| error("ERR_OKF_WRITE", &guard.supplied, e))?;
        drop(metadata);
        if encoded_metadata.len() > MAX_ENCODED_MANIFEST {
            return Err(error(
                "ERR_OKF_WRITE",
                &guard.supplied,
                "encoded manifest exceeds limit",
            ));
        }
        let write = |e| error("ERR_OKF_WRITE", &guard.supplied, e);
        let mut temp =
            tempfile::NamedTempFile::new_in(guard.destination.parent().unwrap()).map_err(write)?;
        #[cfg(test)]
        checkpoint(0).map_err(write)?;
        temp.write_all(MAGIC).map_err(write)?;
        temp.write_all(&FORMAT.to_le_bytes()).map_err(write)?;
        temp.write_all(&(encoded_metadata.len() as u64).to_le_bytes())
            .map_err(write)?;
        temp.write_all(&(decoded_length as u64).to_le_bytes())
            .map_err(write)?;
        let mut hash = Sha256::new();
        hash.update(&encoded_metadata);
        temp.write_all(&encoded_metadata).map_err(write)?;
        #[cfg(test)]
        checkpoint(1).map_err(write)?;
        for bytes in files.values() {
            hash.update(bytes);
            temp.write_all(bytes).map_err(write)?;
        }
        temp.write_all(&hash.finalize()).map_err(write)?;
        temp.flush().map_err(write)?;
        #[cfg(test)]
        checkpoint(2).map_err(write)?;
        reject_alias(&guard.destination).map_err(write)?;
        fs::rename(temp.path(), &guard.destination).map_err(write)?;
        Ok(())
    }
}

// Thread-local and consumed by the next publication: parallel tests cannot
// inject failures into one another. This hook is absent from the addon.
#[cfg(test)]
thread_local! {
    pub(super) static PUBLICATION_FAILURE: std::cell::Cell<Option<u8>> = const { std::cell::Cell::new(None) };
}

pub(super) fn load(path: &str) -> Result<Option<Engine>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Inspect the opened entry without blocking on a cache path that is a
        // FIFO. This flag has no effect on reads of ordinary cache files.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                _ => Err(error("ERR_OKF_READ", path, e)),
            };
        }
        Err(e) => return Err(error("ERR_OKF_READ", path, e)),
    };
    if !file
        .metadata()
        .map_err(|e| error("ERR_OKF_READ", path, e))?
        .is_file()
    {
        return Err(error("ERR_OKF_READ", path, "cache is not a regular file"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| error("ERR_OKF_READ", path, e))?;
    drop(file);
    decode_cache(&bytes, path).map(Some)
}
fn decode_cache(bytes: &[u8], path: &str) -> Result<Engine> {
    let bad = |message: &str| error("ERR_OKF_CACHE_INVALID", path, message);
    if bytes.len() < 52 || &bytes[..8] != MAGIC {
        return Err(bad("truncated cache or invalid magic"));
    }
    if u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != FORMAT {
        return Err(error(
            "ERR_OKF_CACHE_INCOMPATIBLE",
            path,
            "unsupported cache format",
        ));
    }
    let length = usize::try_from(u64::from_le_bytes(bytes[12..20].try_into().unwrap()))
        .map_err(|_| bad("manifest length overflow"))?;
    if bytes.len() < 60 {
        return Err(bad("truncated cache header"));
    }
    if length > MAX_ENCODED_MANIFEST || length > bytes.len() - 60 {
        return Err(bad("invalid manifest length"));
    }
    let end = bytes.len() - 32;
    if Sha256::digest(&bytes[28..end])[..] != bytes[end..] {
        return Err(bad("checksum mismatch"));
    }
    let decoded_length = usize::try_from(u64::from_le_bytes(bytes[20..28].try_into().unwrap()))
        .map_err(|_| bad("decoded manifest length overflow"))?;
    if decoded_length > MAX_MANIFEST {
        return Err(bad("invalid decoded manifest length"));
    }
    // A slice is already buffered: finish() returns exactly the unconsumed input.
    let mut decoder = zstd::stream::read::Decoder::with_buffer(&bytes[28..28 + length])
        .map_err(|e| error("ERR_OKF_CACHE_INVALID", path, e))?
        .single_frame();
    decoder
        .window_log_max(26)
        .map_err(|e| error("ERR_OKF_CACHE_INVALID", path, e))?;
    let mut metadata = Vec::new();
    decoder
        .by_ref()
        .take(decoded_length as u64 + 1)
        .read_to_end(&mut metadata)
        .map_err(|e| error("ERR_OKF_CACHE_INVALID", path, e))?;
    if metadata.len() != decoded_length || !decoder.finish().is_empty() {
        return Err(bad(
            "manifest output length mismatch or trailing compressed bytes",
        ));
    }
    let manifest: Manifest =
        serde_json::from_slice(&metadata).map_err(|e| error("ERR_OKF_CACHE_INVALID", path, e))?;
    drop(metadata);
    if manifest.compatibility != COMPATIBILITY {
        return Err(error(
            "ERR_OKF_CACHE_INCOMPATIBLE",
            path,
            "unsupported schema/analyzer/preparation/Tantivy revision",
        ));
    }
    let mut offset = 28 + length;
    let mut files = BTreeMap::new();
    for (name, length) in manifest.files {
        let mut components = Path::new(&name).components();
        if !matches!(components.next(), Some(Component::Normal(_)))
            || components.next().is_some()
            || name.contains(['/', '\\', ':'])
            || name.contains('\0')
        {
            return Err(bad("unsafe filename"));
        }
        let length = usize::try_from(length).map_err(|_| bad("file length overflow"))?;
        let next = offset
            .checked_add(length)
            .filter(|n| *n <= end)
            .ok_or_else(|| bad("invalid file length"))?;
        files.insert(name, bytes[offset..next].to_vec());
        offset = next;
    }
    if offset != end || !files.contains_key("meta.json") || !files.contains_key(".managed.json") {
        return Err(bad("missing required file or trailing bytes"));
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let documents = manifest
            .documents
            .into_iter()
            .map(|(id, state)| (id.clone(), state.into_state(id)))
            .collect();
        restore(&files, documents, true)
    }))
    .map_err(|_| bad("index decoder panicked on corrupt data"))?
    .map_err(|e| error("ERR_OKF_CACHE_INVALID", path, e))
}
fn restore(
    files: &BTreeMap<String, Vec<u8>>,
    mut documents: BTreeMap<String, DocumentState>,
    reconstruct_section_ids: bool,
) -> std::result::Result<Engine, EngineError> {
    let managed: BTreeSet<String> = serde_json::from_slice(
        files
            .get(".managed.json")
            .ok_or_else(|| EngineError::StoredInvariant("missing managed files".into()))?,
    )
    .map_err(tantivy::TantivyError::from)?;
    let expected_files: BTreeSet<String> = files
        .keys()
        .filter(|name| (*name).as_str() != ".managed.json")
        .cloned()
        .collect();
    if managed != expected_files {
        return Err(EngineError::StoredInvariant(
            "managed file inventory mismatch".into(),
        ));
    }
    let directory = RamDirectory::create();
    for (name, bytes) in files {
        directory
            .atomic_write(Path::new(name), bytes)
            .map_err(tantivy::TantivyError::from)?;
    }
    let index = Index::open(directory.clone())?;
    if !index.validate_checksum()?.is_empty() {
        return Err(EngineError::StoredInvariant(
            "Tantivy checksum mismatch".into(),
        ));
    }
    let (schema, fields) = schema();
    if index.schema() != schema {
        return Err(EngineError::StoredInvariant("schema mismatch".into()));
    }
    index.tokenizers().register(TOKENIZER, analyzer());
    let reader: IndexReader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::Manual)
        .try_into()?;
    let searcher = reader.searcher();
    let mut paths = HashSet::new();
    let mut owned = HashSet::new();
    let mut expected = HashSet::new();
    for (id, state) in &documents {
        if id.trim().is_empty()
            || id != &state.document_id
            || state.path.trim().is_empty()
            || state.document_type.trim().is_empty()
            || (state.conformance == "strict"
                && (!state.diagnostics.is_empty()
                    || state.status.is_none()
                    || state.trust_tier.is_none()))
            || (state.conformance == "degraded" && state.diagnostics.is_empty())
            || state.diagnostics.iter().any(|d| {
                d.path != state.path
                    || !matches!(d.code.as_str(), "ERR_OKF_PARSE" | "ERR_OKF_FIELD")
            })
            || state
                .status
                .as_ref()
                .is_some_and(|s| !matches!(s.as_str(), "draft" | "stable" | "deprecated"))
            || state.trust_tier.as_ref().is_some_and(|s| {
                !matches!(
                    s.as_str(),
                    "unverified" | "machine-confirmed" | "human-reviewed"
                )
            })
            || !paths.insert(&state.path)
            || (!reconstruct_section_ids && state.section_count != state.section_ids.len())
            || !matches!(state.conformance.as_str(), "strict" | "degraded")
        {
            return Err(EngineError::StoredInvariant("invalid inventory".into()));
        }
        for section in &state.section_ids {
            if section.is_empty() || !owned.insert(section) {
                return Err(EngineError::StoredInvariant(
                    "duplicate section ownership".into(),
                ));
            }
            expected.insert((id.clone(), section.clone()));
        }
    }
    drop(paths);
    drop(owned);
    // Save checks the original detached IDs; load rebuilds exact IDs from live records.
    let mut live_ids = HashSet::new();
    for (segment_ord, segment) in searcher.segment_readers().iter().enumerate() {
        let mut records = BTreeMap::new();
        for doc in segment.doc_ids_alive() {
            let record = read_record(&searcher, &fields, DocAddress::new(segment_ord as u32, doc))?;
            let state = documents
                .get_mut(&record.document_id)
                .ok_or_else(|| EngineError::StoredInvariant("unowned record".into()))?;
            if record.start_line == 0
                || record.end_line < record.start_line
                || record.path != state.path
                || record.conformance != state.conformance
                || record.section_id.is_empty()
                || (reconstruct_section_ids && !live_ids.insert(record.section_id.clone()))
                || (!reconstruct_section_ids
                    && !expected.remove(&(record.document_id.clone(), record.section_id.clone())))
            {
                return Err(EngineError::StoredInvariant(
                    "record/inventory disagreement".into(),
                ));
            }
            if reconstruct_section_ids {
                state.section_ids.insert(record.section_id.clone());
            }
            records.insert(doc, record);
        }
        for field in [
            fields.document_id,
            fields.section_id,
            fields.conformance,
            fields.type_exact,
            fields.status,
            fields.trust_tier,
        ] {
            let values = records
                .iter()
                .filter_map(|(doc, record)| {
                    let state = &documents[&record.document_id];
                    let value = if field == fields.document_id {
                        Some(record.document_id.as_str())
                    } else if field == fields.section_id {
                        Some(record.section_id.as_str())
                    } else if field == fields.conformance {
                        Some(state.conformance.as_str())
                    } else if field == fields.type_exact {
                        Some(state.document_type.as_str())
                    } else if field == fields.status {
                        state.status.as_deref()
                    } else {
                        state.trust_tier.as_deref()
                    };
                    value.map(|value| (*doc, value))
                })
                .collect();
            validate_terms(segment, field, values)?;
        }
    }
    if !expected.is_empty()
        || documents
            .values()
            .any(|state| state.section_count != state.section_ids.len())
    {
        return Err(EngineError::StoredInvariant(
            "missing inventory records".into(),
        ));
    }
    drop(searcher);
    let writer = index.writer(WRITER_HEAP_BYTES)?;
    Ok(Engine {
        _index: index,
        ram_directory: directory,
        reader,
        writer,
        fields,
        documents,
        poisoned: Mutex::new(None),
        #[cfg(test)]
        count_results: Default::default(),
        #[cfg(test)]
        query_results: Default::default(),
    })
}

// Walk postings once per identity/filter field, including absent values. Merely
// counting an expected term would miss extra values or a dropped classification.
fn validate_terms(
    segment: &tantivy::SegmentReader,
    field: Field,
    mut expected: BTreeMap<u32, &str>,
) -> std::result::Result<(), EngineError> {
    let inverted = segment.inverted_index(field)?;
    let mut terms = inverted
        .terms()
        .stream()
        .map_err(tantivy::TantivyError::from)?;
    while terms.advance() {
        let value = std::str::from_utf8(terms.key())
            .map_err(|_| EngineError::StoredInvariant("invalid metadata term".into()))?;
        let mut postings = inverted
            .read_postings_from_terminfo(terms.value(), IndexRecordOption::Basic)
            .map_err(tantivy::TantivyError::from)?;
        while postings.doc() != tantivy::TERMINATED {
            let doc = postings.doc();
            if !segment.is_deleted(doc) && expected.remove(&doc) != Some(value) {
                return Err(EngineError::StoredInvariant(
                    "indexed metadata/inventory disagreement".into(),
                ));
            }
            postings.advance();
        }
    }
    if !expected.is_empty() {
        return Err(EngineError::StoredInvariant(
            "missing indexed metadata".into(),
        ));
    }
    Ok(())
}

pub struct SaveTask {
    snapshot: Option<Snapshot>,
    guard: WriterGuard,
}
impl SaveTask {
    pub(super) fn new(snapshot: Snapshot, guard: WriterGuard) -> Self {
        Self {
            snapshot: Some(snapshot),
            guard,
        }
    }
}
impl napi::Task for SaveTask {
    type Output = Result<()>;
    type JsValue = ();
    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(self.snapshot.take().unwrap().publish(&self.guard))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<()> {
        output.map_err(|e| preparation_error(&env, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn document(id: &str) -> PreparedDocument {
        crate::preparation::prepare_normalized(
            crate::preparation::normalize_identity(&format!("{id}.md")).unwrap(),
            &format!("---\ntype: note\nstatus: invalid\n---\n# {id}\n\nSearchable persistence content {id}."),
        ).unwrap().into_document().unwrap()
    }
    fn engine(id: &str) -> Engine {
        Engine::new(vec![document(id)]).unwrap()
    }
    fn destination(temp: &tempfile::TempDir) -> String {
        temp.path().join("nested/cache").to_str().unwrap().into()
    }
    fn save(engine: &Engine, path: &str) {
        Snapshot::capture(engine)
            .publish(&WriterGuard::acquire(path).unwrap())
            .unwrap();
    }
    fn inventory(engine: &Engine) -> Vec<u8> {
        serde_json::to_vec(&engine.documents).unwrap()
    }
    fn load_error(path: &str) -> &'static str {
        match load(path) {
            Err(e) => e.code,
            _ => panic!("expected failure"),
        }
    }
    fn resign(bytes: &mut Vec<u8>) {
        bytes.truncate(bytes.len() - 32);
        let hash = Sha256::digest(&bytes[28..]);
        bytes.extend_from_slice(&hash);
    }
    fn rewrite_manifest(bytes: &[u8], change: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let length = u64::from_le_bytes(bytes[12..20].try_into().unwrap()) as usize;
        let decoded = zstd::stream::decode_all(&bytes[28..28 + length]).unwrap();
        let mut value = serde_json::from_slice(&decoded).unwrap();
        change(&mut value);
        let manifest = serde_json::to_vec(&value).unwrap();
        let encoded = zstd::bulk::compress(&manifest, 3).unwrap();
        let mut output = bytes[..12].to_vec();
        output.extend_from_slice(&(encoded.len() as u64).to_le_bytes());
        output.extend_from_slice(&(manifest.len() as u64).to_le_bytes());
        output.extend_from_slice(&encoded);
        output.extend_from_slice(&bytes[28 + length..]);
        resign(&mut output);
        output
    }

    #[test]
    fn persistence_roundtrip_mutation_diagnostics_and_detached_capture() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let mut source = engine("first");
        let original = inventory(&source);
        let guard = WriterGuard::acquire(&path).unwrap();
        let captured = Snapshot::capture(&source);
        source.ingest(document("second")).unwrap();
        captured.publish(&guard).unwrap();
        drop(guard);
        let mut restored = load(&path).unwrap().unwrap();
        assert_eq!(inventory(&restored), original);
        assert!(!restored.list_degraded().unwrap().is_empty());
        restored.ingest(document("third")).unwrap();
        let mut conflicting = document("third");
        conflicting.document_id = "different-owner".into();
        assert!(matches!(
            restored.ingest(conflicting),
            Err(EngineError::Invalid(_))
        ));
        let mut replacement = document("third");
        replacement.sections[0].text = "replacement content".into();
        restored.ingest(replacement).unwrap();
        let first = document("first").document_id;
        assert!(restored.remove(&first).unwrap());
        save(&restored, &path);
        assert_eq!(
            inventory(&load(&path).unwrap().unwrap()),
            inventory(&restored)
        );
        save(&source, &path);
        assert_eq!(
            inventory(&load(&path).unwrap().unwrap()),
            inventory(&source)
        );
    }

    #[test]
    fn persistence_search_scores_filters_and_logical_stats_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let strict = crate::preparation::prepare_normalized(
            crate::preparation::normalize_identity("strict.md").unwrap(),
            "---\ntype: concept\ntitle: Searchable title\ntags: [persistence]\nstatus: draft\nverified: []\nstale_after: '2025-01-01T00:00:00Z'\n---\n# Heading\nSearchable persistence content.",
        ).unwrap().into_document().unwrap();
        let source = Engine::new(vec![strict, document("degraded")]).unwrap();
        save(&source, &path);
        let restored = load(&path).unwrap().unwrap();
        let options = Some(SearchOptions {
            limit: None,
            snippet_length: None,
            where_filter: Some(SearchWhere {
                types: Some(vec!["concept".into()]),
                tags_any: Some(vec!["persistence".into()]),
                statuses: Some(vec!["draft".into()]),
                trust_tiers: Some(vec!["unverified".into()]),
                stale: Some(true),
                conformance: Some(vec!["strict".into()]),
            }),
            as_of: Some("2026-01-01T00:00:00Z".parse().unwrap()),
            match_mode: None,
            fields: None,
            boost: None,
            fuzzy: None,
        });
        for options in [None, options] {
            let before = source.search("searchable", options.clone()).unwrap();
            assert!(!before.is_empty());
            assert_eq!(
                format!("{before:?}"),
                format!("{:?}", restored.search("searchable", options).unwrap())
            );
        }
        assert_eq!(
            format!("{:?}", source.index_stats().unwrap().logical),
            format!("{:?}", restored.index_stats().unwrap().logical)
        );
        assert_eq!(
            restored.index_stats().unwrap().storage.kind,
            "in-memory-index-files"
        );
        assert!(restored.index_stats().unwrap().storage.size_in_bytes > 0.0);
        assert_eq!(
            format!("{:?}", source.list_degraded().unwrap()),
            format!("{:?}", restored.list_degraded().unwrap())
        );
        assert_eq!(source.list_types().unwrap(), restored.list_types().unwrap());
    }

    #[test]
    fn persistence_zero_section_inventory_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let mut source = Engine::new(vec![]).unwrap();
        let mut state = DocumentState::from(&document("empty"));
        state.section_ids.clear();
        state.section_count = 0;
        source
            .documents
            .insert(state.document_id.clone(), state.clone());
        state.document_id = "strict empty 雪".into();
        state.path = "strict-empty.md".into();
        state.document_type = "zero-only-type".into();
        state.conformance = "strict".into();
        state.diagnostics.clear();
        state.status = Some("draft".into());
        state.trust_tier = Some("unverified".into());
        source
            .documents
            .insert(state.document_id.clone(), state.clone());
        save(&source, &path);
        rewrite_manifest(&fs::read(&path).unwrap(), |m| {
            assert!(
                m["documents"][&state.document_id]
                    .get("diagnostics")
                    .is_none()
            );
        });
        let mut restored = load(&path).unwrap().unwrap();
        assert_eq!(inventory(&restored), inventory(&source));
        assert_eq!(source.list_types().unwrap(), restored.list_types().unwrap());
        assert_eq!(
            format!("{:?}", source.index_stats().unwrap().logical),
            format!("{:?}", restored.index_stats().unwrap().logical)
        );
        assert!(restored.remove(&state.document_id).unwrap());
        assert!(restored.remove(&document("empty").document_id).unwrap());
        assert!(restored.documents.is_empty());
    }

    #[test]
    fn persistence_reduced_metadata_arbitrary_ids_diagnostics_and_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let mut prepared = document("unrelated-path");
        prepared.document_id = "owner 雪 / arbitrary".into();
        for (i, section) in prepared.sections.iter_mut().enumerate() {
            section.section_id = format!("independent λ {i}");
        }
        prepared.diagnostics = vec![
            Diagnostic {
                code: "ERR_OKF_FIELD".into(),
                message: "custom second\n雪".into(),
                field: Some("custom".into()),
                path: prepared.path.clone(),
            },
            Diagnostic {
                code: "ERR_OKF_PARSE".into(),
                message: "custom first".into(),
                field: None,
                path: prepared.path.clone(),
            },
        ];
        let source = Engine::new(vec![prepared.clone()]).unwrap();
        save(&source, &path);
        let bytes = fs::read(&path).unwrap();
        rewrite_manifest(&bytes, |m| {
            assert!(m.get("ownership_digest").is_none());
            let state = &m["documents"][&prepared.document_id];
            for omitted in ["document_id", "section_ids", "conformance"] {
                assert!(state.get(omitted).is_none());
            }
            assert!(state["diagnostics"][0].get("path").is_none());
            assert!(state["diagnostics"][1]["field"].is_null());
        });
        let mut restored = load(&path).unwrap().unwrap();
        assert_eq!(inventory(&source), inventory(&restored));
        let mut collision = document("other-path");
        collision.sections[0].section_id = prepared.sections[0].section_id.clone();
        assert!(matches!(
            restored.ingest(collision),
            Err(EngineError::Invalid(_))
        ));
        prepared.sections[0].text = "replacement searchable".into();
        restored.ingest(prepared.clone()).unwrap();
        save(&restored, &path);
        let mut restored = load(&path).unwrap().unwrap();
        assert!(restored.remove(&prepared.document_id).unwrap());
        assert!(!restored.remove(&prepared.document_id).unwrap());
    }

    #[test]
    fn persistence_original_snapshot_mismatch_never_publishes() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let source = engine("original");
        save(&source, &path);
        let original = fs::read(&path).unwrap();
        for mismatch in 0..4 {
            let mut snapshot = Snapshot::capture(&source);
            let state = snapshot.documents.values_mut().next().unwrap();
            match mismatch {
                0 => {
                    state.section_ids.pop_first();
                    state.section_ids.insert("renamed".into());
                }
                1 => state.document_id = "different".into(),
                2 => state.diagnostics[0].path = "different.md".into(),
                _ => state.conformance = "strict".into(),
            }
            let guard = WriterGuard::acquire(&path).unwrap();
            assert_eq!(
                snapshot.publish(&guard).unwrap_err().code,
                "ERR_OKF_CACHE_INVALID"
            );
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    // Build a checksum-valid payload without the production save-time validation.
    fn unchecked_cache(source: &Engine) -> Vec<u8> {
        let snapshot = Snapshot::capture(source);
        let files = snapshot.files().unwrap();
        let manifest = Manifest {
            compatibility: COMPATIBILITY.into(),
            documents: snapshot
                .documents
                .into_iter()
                .map(|(id, state)| (id, state.into()))
                .collect(),
            files: files
                .iter()
                .map(|(name, bytes)| (name.clone(), bytes.len() as u64))
                .collect(),
        };
        let json = serde_json::to_vec(&manifest).unwrap();
        let encoded = zstd::bulk::compress(&json, 3).unwrap();
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&FORMAT.to_le_bytes());
        bytes.extend_from_slice(&(encoded.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&encoded);
        for file in files.values() {
            bytes.extend_from_slice(file);
        }
        bytes.extend_from_slice(&[0; 32]);
        resign(&mut bytes);
        bytes
    }

    #[test]
    fn persistence_reconstruction_rejects_duplicate_ids_unknown_owners_and_counts() {
        for corruption in 0..4 {
            let mut source = engine("first");
            let mut extra = document(if corruption == 0 { "first" } else { "second" });
            if corruption == 1 {
                extra.sections[0].section_id = document("first").sections[0].section_id.clone();
            }
            add_document(&source.writer, &source.fields, &extra).unwrap();
            source.writer.commit().unwrap();
            if corruption != 2 {
                if corruption == 0 {
                    source
                        .documents
                        .get_mut(&extra.document_id)
                        .unwrap()
                        .section_count += extra.sections.len();
                } else {
                    source
                        .documents
                        .insert(extra.document_id.clone(), DocumentState::from(&extra));
                }
            }
            if corruption == 3 {
                source
                    .documents
                    .get_mut(&extra.document_id)
                    .unwrap()
                    .section_count += 1;
            }
            assert!(
                matches!(decode_cache(&unchecked_cache(&source), "test"), Err(e) if e.code == "ERR_OKF_CACHE_INVALID")
            );
        }
    }

    #[test]
    fn persistence_lock_excludes_fresh_handles_and_threads_then_releases() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let guard = WriterGuard::acquire(&path).unwrap();
        assert!(matches!(WriterGuard::acquire(&path), Err(e) if e.code == "ERR_OKF_CACHE_BUSY"));
        let other = path.clone();
        std::thread::spawn(move || {
            assert!(
                matches!(WriterGuard::acquire(&other), Err(e) if e.code == "ERR_OKF_CACHE_BUSY")
            )
        })
        .join()
        .unwrap();
        drop(guard);
        let _retry = WriterGuard::acquire(&path).unwrap();
        assert!(
            Path::new(&path)
                .parent()
                .unwrap()
                .join(".cache.okf-lock")
                .exists()
        );
    }

    #[test]
    fn persistence_faults_preserve_old_generation_and_clean_owned_temporary() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let old = engine("old");
        let new = engine("new");
        save(&old, &path);
        let original = fs::read(&path).unwrap();
        for failure in 0..3 {
            let guard = WriterGuard::acquire(&path).unwrap();
            let result = Snapshot::capture(&new).publish_with(&guard, |point| {
                if point == failure {
                    Err(std::io::Error::other("injected write/publication failure"))
                } else {
                    Ok(())
                }
            });
            assert_eq!(result.unwrap_err().code, "ERR_OKF_WRITE");
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(
                fs::read_dir(Path::new(&path).parent().unwrap())
                    .unwrap()
                    .count(),
                2
            );
            assert_eq!(inventory(&load(&path).unwrap().unwrap()), inventory(&old));
            new.usable().unwrap();
        }
        save(&new, &path);
    }

    #[test]
    fn persistence_corruption_compatibility_lengths_and_inventory_reject() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        save(&engine("valid"), &path);
        let original = fs::read(&path).unwrap();
        for length in [0, 7, 20, 51, original.len() - 1] {
            fs::write(&path, &original[..length]).unwrap();
            assert_eq!(load_error(&path), "ERR_OKF_CACHE_INVALID");
        }
        let mut corrupt = original.clone();
        corrupt[22] ^= 1;
        fs::write(&path, corrupt).unwrap();
        assert_eq!(load_error(&path), "ERR_OKF_CACHE_INVALID");
        let mut incompatible = original.clone();
        incompatible[8] = 1;
        fs::write(&path, incompatible).unwrap();
        assert_eq!(load_error(&path), "ERR_OKF_CACHE_INCOMPATIBLE");
        let changed = rewrite_manifest(&original, |m| m["compatibility"] = "new".into());
        fs::write(&path, changed).unwrap();
        assert_eq!(load_error(&path), "ERR_OKF_CACHE_INCOMPATIBLE");
        let previous_schema = rewrite_manifest(&original, |m| {
            m["compatibility"] = "schema=1;analyzer=1;preparation=1;tantivy=0.26.1".into();
        });
        fs::write(&path, previous_schema).unwrap();
        assert_eq!(load_error(&path), "ERR_OKF_CACHE_INCOMPATIBLE");
        for (field, value) in [
            ("document_type", serde_json::json!("other")),
            ("status", serde_json::json!("stable")),
            ("trust_tier", serde_json::json!("human-reviewed")),
            ("section_count", serde_json::json!(0)),
            ("diagnostics", serde_json::json!([])),
            ("section_ids", serde_json::json!([])),
            ("document_id", serde_json::json!("obsolete")),
            ("conformance", serde_json::json!("degraded")),
        ] {
            let changed = rewrite_manifest(&original, |m| {
                let state = m["documents"]
                    .as_object_mut()
                    .unwrap()
                    .values_mut()
                    .next()
                    .unwrap();
                state[field] = value;
            });
            fs::write(&path, changed).unwrap();
            assert_eq!(load_error(&path), "ERR_OKF_CACHE_INVALID", "{field}");
        }
        for changed in [
            rewrite_manifest(&original, |m| {
                m["documents"] = serde_json::json!({});
            }),
            rewrite_manifest(&original, |m| {
                let (_, state) = m["documents"]
                    .as_object_mut()
                    .unwrap()
                    .iter_mut()
                    .next()
                    .unwrap();
                state["path"] = "wrong.md".into();
            }),
            rewrite_manifest(&original, |m| {
                m["files"]["../evil"] = 0.into();
            }),
            rewrite_manifest(&original, |m| {
                m["files"]["meta.json"] = u64::MAX.into();
            }),
            rewrite_manifest(&original, |m| {
                m["files"].as_object_mut().unwrap().remove("meta.json");
            }),
        ] {
            fs::write(&path, changed).unwrap();
            assert_eq!(load_error(&path), "ERR_OKF_CACHE_INVALID");
        }
        // A valid envelope digest does not exempt embedded Tantivy checksums.
        let mut corrupt = original.clone();
        let length = u64::from_le_bytes(corrupt[12..20].try_into().unwrap()) as usize;
        let decoded = zstd::stream::decode_all(&corrupt[28..28 + length]).unwrap();
        let manifest: Manifest = serde_json::from_slice(&decoded).unwrap();
        let mut offset = 28 + length;
        for (name, length) in manifest.files {
            if name.ends_with(".store") {
                corrupt[offset] ^= 1;
                break;
            }
            offset += length as usize;
        }
        resign(&mut corrupt);
        fs::write(&path, corrupt).unwrap();
        assert_eq!(load_error(&path), "ERR_OKF_CACHE_INVALID");
    }

    #[test]
    fn persistence_duplicate_manifest_names_are_rejected_even_with_valid_digest() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        save(&engine("valid"), &path);
        let original = fs::read(&path).unwrap();
        let length = u64::from_le_bytes(original[12..20].try_into().unwrap()) as usize;
        let decoded = zstd::stream::decode_all(&original[28..28 + length]).unwrap();
        let manifest = std::str::from_utf8(&decoded).unwrap();
        let duplicate = manifest.replace("\"files\":{", "\"files\":{\".managed.json\":0,");
        assert_ne!(duplicate, manifest);
        let mut bytes = original[..12].to_vec();
        let encoded = zstd::bulk::compress(duplicate.as_bytes(), 3).unwrap();
        bytes.extend_from_slice(&(encoded.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&(duplicate.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&encoded);
        bytes.extend_from_slice(&original[28 + length..]);
        resign(&mut bytes);
        fs::write(&path, bytes).unwrap();
        assert_eq!(load_error(&path), "ERR_OKF_CACHE_INVALID");
    }

    #[test]
    fn persistence_compressed_manifest_limits_and_framing() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        save(&engine("valid"), &path);
        let original = fs::read(&path).unwrap();
        let length = u64::from_le_bytes(original[12..20].try_into().unwrap()) as usize;
        let encoded = &original[28..28 + length];
        let decoded = zstd::stream::decode_all(encoded).unwrap();
        let envelope = |frame: &[u8], decoded_length: u64| {
            let mut bytes = original[..12].to_vec();
            bytes.extend_from_slice(&(frame.len() as u64).to_le_bytes());
            bytes.extend_from_slice(&decoded_length.to_le_bytes());
            bytes.extend_from_slice(frame);
            bytes.extend_from_slice(&original[28 + length..]);
            resign(&mut bytes);
            bytes
        };
        assert!(decode_cache(&envelope(encoded, decoded.len() as u64), &path).is_ok());
        let mut trailing = encoded.to_vec();
        trailing.push(0);
        let mut concatenated = encoded.to_vec();
        concatenated.extend_from_slice(encoded);
        let mut damaged = encoded.to_vec();
        damaged[0] ^= 1;
        let bomb = zstd::bulk::compress(&vec![b' '; MAX_MANIFEST + 1], 3).unwrap();
        for bytes in [
            envelope(&encoded[..encoded.len() - 1], decoded.len() as u64),
            envelope(&[], decoded.len() as u64),
            envelope(&trailing, decoded.len() as u64),
            envelope(&concatenated, decoded.len() as u64),
            envelope(&damaged, decoded.len() as u64),
            envelope(encoded, decoded.len() as u64 - 1),
            envelope(encoded, decoded.len() as u64 + 1),
            envelope(encoded, MAX_MANIFEST as u64 + 1),
            envelope(encoded, u64::MAX),
        ] {
            assert_eq!(
                decode_cache(&bytes, &path).err().unwrap().code,
                "ERR_OKF_CACHE_INVALID"
            );
        }
        let failure = decode_cache(&envelope(&bomb, MAX_MANIFEST as u64), &path)
            .err()
            .unwrap();
        assert!(
            failure
                .cause
                .unwrap()
                .to_string()
                .contains("output length mismatch")
        );
        // Non-single-segment frame requests a 128 MiB window, above our 64 MiB cap.
        let oversized_window = [0x28, 0xb5, 0x2f, 0xfd, 0, 0x88, 1, 0, 0];
        let failure = decode_cache(&envelope(&oversized_window, 0), &path)
            .err()
            .unwrap();
        assert!(
            failure
                .cause
                .unwrap()
                .to_string()
                .contains("too much memory")
        );
        for length in [MAX_ENCODED_MANIFEST as u64 + 1, u64::MAX] {
            let mut bytes = original.clone();
            bytes[12..20].copy_from_slice(&length.to_le_bytes());
            assert_eq!(
                decode_cache(&bytes, &path).err().unwrap().code,
                "ERR_OKF_CACHE_INVALID"
            );
        }
        let mut bytes = envelope(&damaged, decoded.len() as u64);
        let digest_start = bytes.len() - 32;
        bytes[digest_start] ^= 1;
        assert_eq!(
            decode_cache(&bytes, &path)
                .err()
                .unwrap()
                .cause
                .unwrap()
                .to_string(),
            "checksum mismatch"
        );
    }

    #[test]
    fn persistence_missing_directory_and_dangling_link_are_distinct() {
        let temp = tempfile::tempdir().unwrap();
        assert!(load(&destination(&temp)).unwrap().is_none());
        assert_eq!(load_error(temp.path().to_str().unwrap()), "ERR_OKF_READ");
        #[cfg(unix)]
        {
            let link = temp.path().join("dangling");
            std::os::unix::fs::symlink(temp.path().join("absent"), &link).unwrap();
            assert_eq!(load_error(link.to_str().unwrap()), "ERR_OKF_READ");
            let fifo = temp.path().join("fifo");
            assert!(
                std::process::Command::new("mkfifo")
                    .arg(&fifo)
                    .status()
                    .unwrap()
                    .success()
            );
            assert_eq!(load_error(fifo.to_str().unwrap()), "ERR_OKF_READ");
            assert!(
                matches!(WriterGuard::acquire(link.to_str().unwrap()), Err(e) if e.code == "ERR_OKF_WRITE")
            );
        }
    }

    #[test]
    fn persistence_reader_atomicity_with_publication_barrier() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let old = engine("old");
        let new = engine("new");
        save(&old, &path);
        let old_inventory = inventory(&old);
        let new_inventory = inventory(&new);
        let barrier = Arc::new(Barrier::new(2));
        let child_barrier = barrier.clone();
        let child_path = path.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..12 {
                let engine = if i % 2 == 0 { &new } else { &old };
                let guard = WriterGuard::acquire(&child_path).unwrap();
                Snapshot::capture(engine)
                    .publish_with(&guard, |point| {
                        if point == 2 {
                            child_barrier.wait();
                        }
                        Ok(())
                    })
                    .unwrap();
            }
        });
        for _ in 0..12 {
            barrier.wait();
            for _ in 0..3 {
                let state = inventory(&load(&path).unwrap().unwrap());
                assert!(state == old_inventory || state == new_inventory);
            }
        }
        writer.join().unwrap();
    }

    #[test]
    fn persistence_real_background_merges_keep_captured_generations_readable() {
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let mut source = engine("initial");
        source
            .writer
            .set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
        for round in 0..4 {
            for i in 0..8 {
                source
                    .ingest(document(&format!("round{round}-doc{i}")))
                    .unwrap();
            }
            source.remove(&format!("round{round}-doc0")).unwrap();
            let segments = source._index.searchable_segment_ids().unwrap();
            assert!(segments.len() > 1);
            let merge = source.writer.merge(&segments);
            let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let done = completed.clone();
            let waiter = std::thread::spawn(move || {
                let result = merge.wait();
                done.store(true, std::sync::atomic::Ordering::Release);
                result
            });
            let mut snapshots = std::collections::VecDeque::new();
            // Capture through the entire merge, not just its first few moments.
            // Bound retained bytes if a heavily loaded runner stalls the merge.
            while !completed.load(std::sync::atomic::Ordering::Acquire) {
                snapshots.push_back(Snapshot::capture(&source));
                if snapshots.len() > 128 {
                    snapshots.pop_front();
                }
                std::thread::yield_now();
            }
            snapshots.push_back(Snapshot::capture(&source));
            assert!(waiter.join().unwrap().unwrap().is_some());
            source.writer.garbage_collect_files().wait().unwrap();
            for snapshot in snapshots {
                snapshot
                    .publish(&WriterGuard::acquire(&path).unwrap())
                    .unwrap();
                let restored = load(&path).unwrap().unwrap();
                assert_eq!(inventory(&restored), inventory(&source));
                let hits = restored
                    .search(
                        "persistence",
                        Some(SearchOptions {
                            limit: Some(1000.0),
                            snippet_length: None,
                            where_filter: None,
                            as_of: None,
                            match_mode: None,
                            fields: None,
                            boost: None,
                            fuzzy: None,
                        }),
                    )
                    .unwrap();
                let found: BTreeSet<_> = hits.into_iter().map(|hit| hit.document_id).collect();
                assert_eq!(found, source.documents.keys().cloned().collect());
            }
        }
    }

    // Child synchronization uses a pipe marker, not timing. This environment
    // variable is read only by this cfg(test) helper, never by the addon.
    #[test]
    fn persistence_process_writer_helper() {
        let Ok(path) = std::env::var("OKF_TEST_CHILD_CACHE") else {
            return;
        };
        let guard = WriterGuard::acquire(&path).unwrap();
        Snapshot::capture(&engine("child"))
            .publish_with(&guard, |point| {
                if point == 2 {
                    println!("OKF_CHILD_BEFORE_PUBLISH");
                    std::io::stdout().flush().unwrap();
                    // Do not wait for stdin: Child::kill closes its stdin first,
                    // which could release the barrier before the kill arrives.
                    loop {
                        std::thread::park();
                    }
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn persistence_process_death_releases_lock_and_preserves_previous_cache() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let old = engine("old");
        save(&old, &path);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::tests::persistence_process_writer_helper",
                "--nocapture",
            ])
            .env("OKF_TEST_CHILD_CACHE", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "child exited before barrier"
            );
            if line.contains("OKF_CHILD_BEFORE_PUBLISH") {
                break;
            }
        }
        assert!(matches!(WriterGuard::acquire(&path), Err(e) if e.code == "ERR_OKF_CACHE_BUSY"));
        assert_eq!(inventory(&load(&path).unwrap().unwrap()), inventory(&old));
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(inventory(&load(&path).unwrap().unwrap()), inventory(&old));
        save(&engine("retry"), &path);
    }

    #[cfg(unix)]
    #[test]
    fn persistence_permission_failures_preserve_cache_and_handle() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let source = engine("old");
        save(&source, &path);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
        let inaccessible = load(&path);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        // Privileged test runners can bypass POSIX permission bits.
        if inaccessible.is_ok() {
            return;
        }
        assert!(matches!(inaccessible, Err(e) if e.code == "ERR_OKF_READ"));
        let guard = WriterGuard::acquire(&path).unwrap();
        let parent = Path::new(&path).parent().unwrap();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o500)).unwrap();
        let result = Snapshot::capture(&source).publish(&guard);
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(result, Err(e) if e.code == "ERR_OKF_WRITE"));
        assert_eq!(
            inventory(&load(&path).unwrap().unwrap()),
            inventory(&source)
        );
        source.usable().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn persistence_parent_aliases_share_lock_and_final_symlink_is_not_written() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        fs::create_dir(&real).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let path = real.join("cache");
        let guard = WriterGuard::acquire(path.to_str().unwrap()).unwrap();
        assert!(
            matches!(WriterGuard::acquire(alias.join("cache").to_str().unwrap()), Err(e) if e.code == "ERR_OKF_CACHE_BUSY")
        );
        drop(guard);
        save(&engine("real"), path.to_str().unwrap());
        let link = temp.path().join("file-link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(load(link.to_str().unwrap()).unwrap().is_some());
        assert!(
            matches!(WriterGuard::acquire(link.to_str().unwrap()), Err(e) if e.code == "ERR_OKF_WRITE")
        );
    }

    #[test]
    fn persistence_case_alias_lock_matches_filesystem_behavior() {
        let temp = tempfile::tempdir().unwrap();
        let lower = temp.path().join("cache");
        let upper = temp.path().join("CACHE");
        fs::write(&lower, b"probe").unwrap();
        let insensitive = upper.exists();
        let _guard = WriterGuard::acquire(lower.to_str().unwrap()).unwrap();
        let other = WriterGuard::acquire(upper.to_str().unwrap());
        if insensitive {
            assert!(matches!(other, Err(e) if e.code == "ERR_OKF_CACHE_BUSY"));
        } else {
            assert!(other.is_ok());
        }
    }

    #[cfg(windows)]
    #[test]
    fn persistence_windows_delete_sharing_and_denied_replacement() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = destination(&temp);
        let old = engine("old");
        let new = engine("new");
        save(&old, &path);
        let mut cooperating = File::open(&path).unwrap();
        save(&new, &path);
        let mut old_bytes = Vec::new();
        cooperating.read_to_end(&mut old_bytes).unwrap();
        assert_eq!(
            inventory(&decode_cache(&old_bytes, &path).unwrap()),
            inventory(&old)
        );
        drop(cooperating);
        let denied = OpenOptions::new()
            .read(true)
            .share_mode(1 | 2)
            .open(&path)
            .unwrap();
        let guard = WriterGuard::acquire(&path).unwrap();
        assert_eq!(
            Snapshot::capture(&old).publish(&guard).unwrap_err().code,
            "ERR_OKF_WRITE"
        );
        assert_eq!(inventory(&load(&path).unwrap().unwrap()), inventory(&new));
        drop(denied);
        drop(guard);
        save(&old, &path);
    }
}
