use std::{
    ffi::OsStr,
    fs, io,
    path::{Component, Path, PathBuf},
};

use crate::preparation::{
    DocumentInput, PreparationError, PreparedEntry, compare_paths, is_document_file,
    normalize_and_sort, prepare_batch,
};

fn unicode_name<'a>(name: &'a OsStr, directory: &str) -> Result<&'a str, PreparationError> {
    name.to_str().ok_or_else(|| {
        PreparationError::caused(
            "ERR_OKF_READ",
            directory,
            io::Error::new(io::ErrorKind::InvalidData, "OKF filename is not Unicode"),
        )
    })
}

fn resolve_root(root: &Path) -> Result<PathBuf, PreparationError> {
    let absolute = if root.is_absolute() {
        root.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| PreparationError::caused("ERR_OKF_READ", ".", e))?
            .join(root)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            _ => resolved.push(component.as_os_str()),
        }
    }
    unicode_name(resolved.as_os_str(), ".")?;
    Ok(resolved)
}

fn discover(
    directory: &Path,
    relative: &str,
    candidates: &mut Vec<(String, PathBuf)>,
    enumerate: &mut impl FnMut(&Path) -> io::Result<Vec<io::Result<fs::DirEntry>>>,
) -> Result<(), PreparationError> {
    let read_error = |error| PreparationError::caused("ERR_OKF_READ", relative, error);
    // Finish enumeration before validating any names, and validate every name before recursion.
    let entries = enumerate(directory)
        .map_err(read_error)?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_error)?;
    let mut entries = entries
        .into_iter()
        .map(|entry| {
            let name = unicode_name(&entry.file_name(), relative)?.to_owned();
            Ok((name, entry))
        })
        .collect::<Result<Vec<_>, PreparationError>>()?;
    entries.sort_by(|a, b| compare_paths(&a.0, &b.0));
    for (name, entry) in entries {
        let path = if relative == "." {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let kind = entry.file_type().map_err(read_error)?;
        if kind.is_dir() {
            discover(&entry.path(), &path, candidates, enumerate)?;
        } else if kind.is_file() && is_document_file(&name) {
            candidates.push((path, entry.path()));
        }
    }
    Ok(())
}

pub(super) fn read_documents(root: &Path) -> Result<Vec<DocumentInput>, PreparationError> {
    read_documents_with(root, |path| fs::read(path))
}

// Narrow read hook makes replacement races and phase ordering deterministic in tests.
fn read_documents_with(
    root: &Path,
    mut read: impl FnMut(&Path) -> io::Result<Vec<u8>>,
) -> Result<Vec<DocumentInput>, PreparationError> {
    let root = resolve_root(root)?;
    let mut candidates = vec![];
    discover(&root, ".", &mut candidates, &mut |path| {
        fs::read_dir(path).map(Iterator::collect)
    })?;
    normalize_and_sort(candidates)?
        .into_iter()
        .map(|(identity, native)| {
            let bytes = read(&native)
                .map_err(|e| PreparationError::caused("ERR_OKF_READ", &identity.path, e))?;
            let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
            let markdown = std::str::from_utf8(bytes)
                .map_err(|e| PreparationError::caused("ERR_OKF_PARSE", &identity.path, e))?
                .to_owned();
            Ok(DocumentInput {
                path: identity.path,
                markdown,
            })
        })
        .collect()
}

pub(super) fn prepare_directory(root: &Path) -> Result<Vec<PreparedEntry>, PreparationError> {
    prepare_batch(read_documents(root)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        error::Error,
        sync::atomic::{AtomicU64, Ordering},
    };

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "okf-native-fs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn put(&self, path: &str, bytes: impl AsRef<[u8]>) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn nested_isolated_repeated_sorted_and_excluded() {
        let root = Root::new();
        let empty = Root::new();
        for path in ["z.md", "a/𐐨.md", "a/\u{e000}.md", "�.md", "Index.md"] {
            root.put(path, "body");
        }
        for path in ["excluded/index.md", "a/log.md", "upper.MD", "other.txt"] {
            root.put(path, [0xff]);
        }
        for _ in 0..2 {
            assert!(read_documents(&empty.0).unwrap().is_empty());
            let docs = read_documents(&root.0).unwrap();
            assert_eq!(
                docs.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(),
                ["Index.md", "a/𐐨.md", "a/\u{e000}.md", "z.md", "�.md"]
            );
        }
        assert_eq!(resolve_root(&root.0.join("missing/..")).unwrap(), root.0);
    }

    #[test]
    fn decoding_removes_exactly_one_bom_and_preserves_crlf() {
        let root = Root::new();
        for (bytes, expected) in [
            ("plain\r\n", "plain\r\n"),
            ("\u{feff}one", "one"),
            ("\u{feff}\u{feff}two", "\u{feff}two"),
            ("in\u{feff}terior", "in\u{feff}terior"),
            ("", ""),
        ] {
            root.put("a.md", bytes);
            assert_eq!(read_documents(&root.0).unwrap()[0].markdown, expected);
        }
        for bytes in [&[0xff][..], &[0xe2, 0x82][..]] {
            root.put("a.md", bytes);
            let error = read_documents(&root.0).unwrap_err();
            assert_eq!(error.code, "ERR_OKF_PARSE");
            assert_eq!(error.to_string(), "Cannot parse OKF concept: a.md");
            assert!(
                error
                    .cause
                    .unwrap()
                    .downcast_ref::<std::str::Utf8Error>()
                    .is_some()
            );
        }
    }

    #[test]
    fn discovery_and_identity_failures_precede_all_reads() {
        let root = Root::new();
        root.put("a.md", "---\n[broken");
        let error = read_documents_with(&root.0.join("missing"), |_| {
            panic!("no reads before discovery")
        })
        .unwrap_err();
        assert_eq!((error.code, error.path.as_str()), ("ERR_OKF_READ", "."));
        // A colon is legal in Unix filenames but a drive prefix is not a document identity.
        #[cfg(unix)]
        {
            root.put("C:bad.md", "body");
            let error =
                read_documents_with(&root.0, |_| panic!("no reads before identity validation"))
                    .unwrap_err();
            assert_eq!(
                (error.code, error.path.as_str(), error.field.as_deref()),
                ("ERR_OKF_FIELD", "<input>", Some("path"))
            );
        }
    }

    #[test]
    fn all_decoding_precedes_preparation_and_reading_stops_on_failure() {
        let root = Root::new();
        root.put("a.md", "---\n[broken");
        root.put("z.md", [0xff]);
        root.put("zz.md", "body");
        let error = prepare_directory(&root.0).unwrap_err();
        assert_eq!((error.code, error.path.as_str()), ("ERR_OKF_PARSE", "z.md"));
        let mut reads = vec![];
        let error = read_documents_with(&root.0, |path| {
            reads.push(path.file_name().unwrap().to_str().unwrap().to_owned());
            fs::read(path)
        })
        .unwrap_err();
        assert_eq!(reads, ["a.md", "z.md"]);
        assert_eq!(error.path, "z.md");
    }

    #[test]
    fn discovery_finishes_collection_then_visits_sorted_directories() {
        let root = Root::new();
        root.put("z/last.md", "body");
        root.put("a/first.md", "body");
        let mut visited = vec![];
        let mut candidates = vec![];
        let error = discover(&root.0, ".", &mut candidates, &mut |path| {
            visited.push(path.to_owned());
            if path != root.0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected descendant failure",
                ));
            }
            let mut entries = fs::read_dir(path)?.collect::<Vec<_>>();
            entries.reverse();
            Ok(entries)
        })
        .unwrap_err();
        assert_eq!(error.path, "a");
        assert_eq!(visited, [root.0.clone(), root.0.join("a")]);
        assert!(candidates.is_empty());
        visited.clear();
        let error = discover(&root.0, ".", &mut candidates, &mut |path| {
            visited.push(path.to_owned());
            let mut entries = fs::read_dir(path)?.collect::<Vec<_>>();
            entries.push(Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "injected entry failure",
            )));
            Ok(entries)
        })
        .unwrap_err();
        assert_eq!(error.path, ".");
        assert_eq!(
            error
                .source()
                .unwrap()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::Interrupted
        );
        assert_eq!(visited, [root.0.clone()]);
        assert!(candidates.is_empty());
    }

    #[test]
    fn disappearing_file_retains_io_cause_and_no_partial_vector() {
        let root = Root::new();
        root.put("a.md", "body");
        root.put("z.md", "body");
        let mut reads = 0;
        let error = read_documents_with(&root.0, |path| {
            reads += 1;
            if reads == 1 {
                fs::remove_file(root.0.join("z.md"))?;
            }
            fs::read(path)
        })
        .unwrap_err();
        assert_eq!(reads, 2);
        assert_eq!(error.path, "z.md");
        assert_eq!(error.to_string(), "Cannot read OKF path: z.md");
        assert_eq!(
            error
                .cause
                .unwrap()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_entries_skipped_but_selected_root_followed() {
        use std::os::unix::fs::symlink;
        let root = Root::new();
        let links = Root::new();
        root.put("a.md", "body");
        symlink(&root.0, links.0.join("root")).unwrap();
        symlink(root.0.join("a.md"), root.0.join("link.md")).unwrap();
        symlink("missing", root.0.join("dangling.md")).unwrap();
        symlink(&root.0, root.0.join("loop")).unwrap();
        assert_eq!(read_documents(&links.0.join("root")).unwrap().len(), 1);
        assert!(read_documents(&links.0).unwrap().is_empty());
    }

    #[cfg(unix)]
    fn invalid_name() -> std::ffi::OsString {
        use std::os::unix::ffi::OsStringExt;
        std::ffi::OsString::from_vec(vec![0xff])
    }
    #[cfg(windows)]
    fn invalid_name() -> std::ffi::OsString {
        use std::os::windows::ffi::OsStringExt;
        std::ffi::OsString::from_wide(&[0xd800])
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn host_helper_rejects_native_invalid_names_without_loss() {
        let name = invalid_name();
        let error = unicode_name(&name, "nested").unwrap_err();
        assert_eq!(
            (error.code, error.path.as_str()),
            ("ERR_OKF_READ", "nested")
        );
        assert_eq!(
            error
                .cause
                .unwrap()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(unicode_name(OsStr::new("�.md"), ".").unwrap(), "�.md");
        let root = Root::new();
        let invalid_root = root.0.join(name);
        assert_eq!(resolve_root(&invalid_root).unwrap_err().path, ".");
        let error = read_documents_with(&invalid_root, |_| panic!("invalid root must precede IO"))
            .unwrap_err();
        assert_eq!(error.code, "ERR_OKF_READ");
        assert_eq!(
            error
                .cause
                .unwrap()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn native_invalid_filename_fixtures() {
        let root = Root::new();
        let probe = root.0.join(invalid_name());
        if let Err(error) = fs::write(&probe, b"") {
            // APFS refuses invalid bytes; Windows/filesystem policy can likewise prohibit a fixture.
            eprintln!(
                "SKIP native invalid-name OS fixtures: {}: {error}",
                std::env::consts::OS
            );
            return;
        }
        fs::remove_file(probe).unwrap();
        for suffix in [".md", ".txt", ""] {
            let fixture = Root::new();
            fixture.put("�.md", "body");
            let mut name = invalid_name();
            name.push(suffix);
            let native = fixture.0.join(name);
            if suffix.is_empty() {
                fs::create_dir(&native).unwrap();
            } else {
                fs::write(&native, b"").unwrap();
            }
            let error = read_documents_with(&fixture.0, |_| {
                panic!("filename rejection must precede reads")
            })
            .unwrap_err();
            assert_eq!((error.code, error.path.as_str()), ("ERR_OKF_READ", "."));
            assert_eq!(read_documents(&native).unwrap_err().path, ".");
        }
        // Invalid symlink names are rejected even though valid symlinks are skipped.
        #[cfg(unix)]
        {
            let fixture = Root::new();
            std::os::unix::fs::symlink("missing", fixture.0.join(invalid_name())).unwrap();
            assert_eq!(read_documents(&fixture.0).unwrap_err().path, ".");
        }
        // Parent validation beats descendant errors, and multiple invalid names give the same error.
        root.put("a/x.md", "bad");
        for suffix in [".md", ".txt"] {
            let mut name = invalid_name();
            name.push(suffix);
            fs::write(root.0.join(name), b"").unwrap();
        }
        let mut candidates = vec![];
        let error = discover(&root.0, ".", &mut candidates, &mut |path| {
            assert_eq!(path, root.0, "invalid parent must prevent recursion");
            Ok(fs::read_dir(path)?.collect())
        })
        .unwrap_err();
        assert_eq!(error.path, ".");
        let error = discover(&root.0, ".", &mut candidates, &mut |path| {
            let mut entries = fs::read_dir(path)?.collect::<Vec<_>>();
            entries.push(Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "entry failure beats invalid name",
            )));
            Ok(entries)
        })
        .unwrap_err();
        assert_eq!(
            error
                .cause
                .unwrap()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::Interrupted
        );
        let siblings = Root::new();
        siblings.put("a/file.md", "body");
        fs::create_dir(siblings.0.join("z")).unwrap();
        fs::write(siblings.0.join("z").join(invalid_name()), b"").unwrap();
        let error = discover(&siblings.0, ".", &mut candidates, &mut |path| {
            if path == siblings.0.join("a") {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "earlier sibling",
                ));
            }
            Ok(fs::read_dir(path)?.collect())
        })
        .unwrap_err();
        assert_eq!(error.path, "a");
        assert_eq!(
            read_documents_with(&root.0, |_| panic!("no reads"))
                .unwrap_err()
                .path,
            "."
        );
    }
}
