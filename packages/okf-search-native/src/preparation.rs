use std::{cmp::Ordering, error::Error, fmt};

use okf_prepare_core::{Diagnostic, Input, Prepared};

#[derive(Debug, PartialEq)]
pub(super) struct DocumentInput {
    pub path: String,
    pub markdown: String,
}

#[derive(Debug, PartialEq)]
pub(super) struct Identity {
    pub path: String,
    pub document_id: String,
}

#[derive(Debug, PartialEq)]
pub(super) struct PreparedEntry {
    pub identity: Identity,
    pub prepared: Prepared,
}

impl PreparedEntry {
    pub fn into_document(self) -> Result<crate::PreparedDocument, crate::EngineError> {
        let Prepared::Accepted {
            document_id,
            fields,
            conformance,
            diagnostics,
            sections,
            ..
        } = self.prepared
        else {
            return Err(crate::EngineError::Invalid(
                "Fatal preparation cannot be indexed".into(),
            ));
        };
        let line_number = |line: usize| {
            if line as u128 > crate::MAX_SAFE_INTEGER {
                Err(crate::EngineError::UnsafeInteger(
                    "Line exceeds JavaScript safe integer range".into(),
                ))
            } else {
                Ok(line as f64)
            }
        };
        Ok(crate::PreparedDocument {
            document_id,
            path: self.identity.path,
            document_type: fields.type_,
            conformance: conformance.as_str().into(),
            diagnostics: diagnostics
                .into_iter()
                .map(|diagnostic| crate::Diagnostic {
                    code: diagnostic.code.into(),
                    message: diagnostic.message,
                    field: diagnostic.field,
                    path: diagnostic.path,
                })
                .collect(),
            title: fields.title,
            tags: fields.tags,
            status: fields.status.map(|status| status.as_str().into()),
            stale_after_epoch: fields
                .staleness
                .stale_after
                .map(|value| value.epoch_millis as f64),
            staleness_classified: fields.staleness.classified,
            trust_tier: fields.trust_tier.map(|trust| trust.as_str().into()),
            resource: fields.resource.unwrap_or_default(),
            description: fields.description.unwrap_or_default(),
            source_text: fields.source_text,
            sections: sections
                .into_iter()
                .map(|section| {
                    Ok(crate::PreparedSection {
                        section_id: section.id,
                        heading_path: section.heading_path,
                        text: section.text,
                        start_line: line_number(section.start_line)?,
                        end_line: line_number(section.end_line)?,
                    })
                })
                .collect::<Result<_, crate::EngineError>>()?,
        })
    }
}

#[derive(Debug)]
pub struct PreparationError {
    pub code: &'static str,
    pub path: String,
    pub field: Option<String>,
    pub cause: Option<Box<dyn Error + Send + Sync>>,
    pub diagnostics: Vec<Diagnostic>,
}

impl PreparationError {
    pub fn caused(
        code: &'static str,
        path: &str,
        cause: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            field: None,
            cause: Some(Box::new(cause)),
            diagnostics: vec![],
        }
    }

    fn invalid_path(path: &str) -> Self {
        Self {
            code: "ERR_OKF_FIELD",
            path: path.into(),
            field: Some("path".into()),
            cause: None,
            diagnostics: vec![],
        }
    }
}

impl fmt::Display for PreparationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let prefix = match self.code {
            "ERR_OKF_READ" => "Cannot read OKF path",
            "ERR_OKF_PARSE" => "Cannot parse OKF concept",
            _ => "Invalid OKF field",
        };
        write!(f, "{prefix}: {}", self.path)?;
        if let Some(field) = &self.field {
            write!(f, " ({field})")?;
        }
        Ok(())
    }
}

impl Error for PreparationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn Error + 'static))
    }
}

pub(super) fn compare_paths(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub(super) fn is_document_file(name: &str) -> bool {
    name.ends_with(".md") && name != "index.md" && name != "log.md"
}

pub(super) fn normalize_identity(path: &str) -> Result<Identity, PreparationError> {
    let bytes = path.as_bytes();
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with("\\\\")
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path.ends_with('/')
        || path.ends_with("/.")
        || path.split('/').any(|part| part == "..")
    {
        return Err(PreparationError::invalid_path("<input>"));
    }
    let path = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    if path.is_empty() {
        return Err(PreparationError::invalid_path("<input>"));
    }
    if !is_document_file(path.rsplit('/').next().unwrap()) {
        return Err(PreparationError::invalid_path(&path));
    }
    let document_id = path[..path.len() - 3].to_owned();
    Ok(Identity { path, document_id })
}

// Both callers normalize in input/discovery order, then check the entire batch before content work.
pub(super) fn normalize_and_sort<T>(
    inputs: Vec<(String, T)>,
) -> Result<Vec<(Identity, T)>, PreparationError> {
    let mut normalized = inputs
        .into_iter()
        .map(|(path, input)| Ok((normalize_identity(&path)?, input)))
        .collect::<Result<Vec<_>, PreparationError>>()?;
    normalized.sort_by(|a, b| compare_paths(&a.0.path, &b.0.path));
    for pair in normalized.windows(2) {
        if pair[0].0.document_id == pair[1].0.document_id {
            return Err(PreparationError::invalid_path(&pair[1].0.path));
        }
    }
    Ok(normalized)
}

fn fallback_title(id: &str) -> String {
    let mut title = String::new();
    let mut separator = false;
    for ch in id.rsplit('/').next().unwrap().chars() {
        if ch == '-' || ch == '_' {
            if !separator {
                title.push(' ');
            }
            separator = true;
        } else {
            title.push(ch);
            separator = false;
        }
    }
    // JS charAt(0) uppercases only one UTF-16 unit; supplementary letters stay unchanged.
    if let Some(first) = title.chars().next().filter(|ch| ch.len_utf16() == 1) {
        title.replace_range(
            ..first.len_utf8(),
            &first.to_uppercase().collect::<String>(),
        );
    }
    title
}

pub(super) fn prepare_batch(
    inputs: Vec<DocumentInput>,
) -> Result<Vec<PreparedEntry>, PreparationError> {
    normalize_and_sort(
        inputs
            .into_iter()
            .map(|input| (input.path, input.markdown))
            .collect(),
    )?
    .into_iter()
    .map(|(identity, markdown)| prepare_normalized(identity, &markdown))
    .collect()
}

pub(super) fn prepare_normalized(
    identity: Identity,
    markdown: &str,
) -> Result<PreparedEntry, PreparationError> {
    let prepared = okf_prepare_core::prepare(
        Input {
            path: &identity.path,
            markdown,
            fallback_title: &fallback_title(&identity.document_id),
        },
        &identity.document_id,
    );
    if let Prepared::Fatal { diagnostics } = prepared {
        // The core's fatal outcomes are parser failure or invalid required type.
        let fatal = diagnostics
            .iter()
            .find(|d| d.code == "ERR_OKF_PARSE" || d.field.as_deref() == Some("type"))
            .expect("core fatal diagnostic");
        return Err(PreparationError {
            code: fatal.code,
            path: fatal.path.clone(),
            field: fatal.field.clone(),
            cause: None,
            diagnostics,
        });
    }
    Ok(PreparedEntry { identity, prepared })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(path: &str, markdown: &str) -> DocumentInput {
        DocumentInput {
            path: path.into(),
            markdown: markdown.into(),
        }
    }

    #[test]
    fn core_output_uses_existing_engine_replacement_and_inventory() {
        let markdown = "---\ntype: note\ntitle: Native title\nstatus: draft\nverified: []\nstale_after: '2026-01-01T00:00:00Z'\nsources: [{resource: source, title: Source title}]\ncustom: retained only for response\n---\n# Heading\nNative body";
        let document = prepare_normalized(normalize_identity("a.md").unwrap(), markdown)
            .unwrap()
            .into_document()
            .unwrap();
        assert_eq!(document.title, "Native title");
        assert_eq!(document.status.as_deref(), Some("draft"));
        assert_eq!(document.trust_tier.as_deref(), Some("unverified"));
        assert!(document.staleness_classified);
        assert!(document.stale_after_epoch.is_some());
        assert!(document.source_text.contains("Source title"));
        assert_eq!(document.sections[0].heading_path, "Heading");
        let mut engine = crate::Engine::new(vec![document]).unwrap();
        assert_eq!(engine.list_types().unwrap(), ["note"]);
        let replacement = prepare_normalized(
            normalize_identity("a.md").unwrap(),
            "---\ntype: replacement\nstatus: invalid\n---\nReplacement body",
        )
        .unwrap()
        .into_document()
        .unwrap();
        assert!(!replacement.diagnostics.is_empty());
        assert!(replacement.status.is_none());
        engine.ingest(replacement).unwrap();
        assert_eq!(engine.list_types().unwrap(), ["replacement"]);
        let stats = engine.index_stats().unwrap();
        assert_eq!(stats.logical.documents.total, 1.0);
        assert_eq!(stats.logical.documents.strict, 0.0);
        assert_eq!(stats.logical.documents.degraded, 1.0);
        assert_eq!(stats.logical.statuses.unclassified, 1.0);
    }

    #[test]
    fn normalized_single_preparation_matches_batch() {
        for markdown in [
            "---\ntype: note\ncustom: {nested: [1, two]}\n---\n# Heading\nBody",
            "---\ntype: note\nstatus: invalid\n---\nBody",
        ] {
            let single =
                prepare_normalized(normalize_identity("a/b.md").unwrap(), markdown).unwrap();
            let batch = prepare_batch(vec![input("a/./b.md", markdown)]).unwrap();
            assert_eq!(batch, vec![single]);
        }
        for markdown in ["no frontmatter", "---\ntitle: no type\n---\nBody"] {
            let single =
                prepare_normalized(normalize_identity("a/b.md").unwrap(), markdown).unwrap_err();
            let batch = prepare_batch(vec![input("a/./b.md", markdown)]).unwrap_err();
            assert_eq!(single.code, batch.code);
            assert_eq!(single.path, batch.path);
            assert_eq!(single.field, batch.field);
            assert_eq!(single.diagnostics, batch.diagnostics);
            assert!(single.cause.is_none());
        }
    }

    #[test]
    fn identities_match_js_rules() {
        for path in [
            "",
            "/a.md",
            "C:a.md",
            "\\\\host\\a.md",
            "a/../b.md",
            "a.md/",
            "a.md/.",
            ".",
        ] {
            let error = normalize_identity(path).unwrap_err();
            assert_eq!(error.path, "<input>");
            assert_eq!(error.to_string(), "Invalid OKF field: <input> (path)");
        }
        for (path, expected) in [
            ("./a//./b.md", "a/b.md"),
            ("a\\b.md", "a\\b.md"),
            ("Index.md", "Index.md"),
            (".md", ".md"),
            ("�.md", "�.md"),
        ] {
            let identity = normalize_identity(path).unwrap();
            assert_eq!(identity.path, expected);
            assert_eq!(identity.document_id, &expected[..expected.len() - 3]);
        }
        for path in ["index.md", "log.md", "a.MD", "a.txt"] {
            assert_eq!(
                normalize_identity(&format!("./{path}")).unwrap_err().path,
                path
            );
        }
    }

    #[test]
    fn fallback_uses_first_utf16_unit_and_separator_runs() {
        for (id, title) in [
            ("a/hello--_world", "Hello world"),
            ("ßeta", "SSeta"),
            ("𐐨name", "𐐨name"),
            ("école", "École"),
            ("_name", " name"),
            ("", ""),
        ] {
            assert_eq!(fallback_title(id), title);
        }
    }

    #[test]
    fn identity_checks_precede_content_in_caller_order() {
        let error = prepare_batch(vec![input("z.txt", "bad"), input("/a.md", "bad")]).unwrap_err();
        assert_eq!(error.path, "z.txt");
        let error = prepare_batch(vec![input("./a.md", "---\n["), input("a.md", "")]).unwrap_err();
        assert_eq!(error.field.as_deref(), Some("path"));
    }

    #[test]
    fn batches_preserve_core_outputs_and_utf16_order() {
        assert!(prepare_batch(vec![]).unwrap().is_empty());
        let markdown = "---\ntype: Concept\ntitle: Example\n---\n# Heading\nBody\r\n";
        let paths = ["\u{e000}.md", "𐐨.md", "a.md"];
        for _ in 0..2 {
            let batch = prepare_batch(paths.iter().map(|p| input(p, markdown)).collect()).unwrap();
            assert_eq!(
                batch
                    .iter()
                    .map(|e| e.identity.path.as_str())
                    .collect::<Vec<_>>(),
                ["a.md", "𐐨.md", "\u{e000}.md"]
            );
            for entry in batch {
                assert_eq!(
                    entry.prepared,
                    okf_prepare_core::prepare(
                        Input {
                            path: &entry.identity.path,
                            markdown,
                            fallback_title: &fallback_title(&entry.identity.document_id)
                        },
                        &entry.identity.document_id
                    )
                );
            }
        }
    }

    #[test]
    fn mixed_batches_keep_accepted_fields_and_stop_at_first_sorted_fatal() {
        use okf_prepare_core::Conformance;
        let strict = "---\ntype: note\ntags: [one]\n---\n# Heading\nBody\n";
        let degraded = "---\ntype: note\ntitle: 12\nstatus: future\n---\nBody";
        let batch = prepare_batch(vec![input("z.md", degraded), input("a.md", strict)]).unwrap();
        for (entry, expected) in batch
            .iter()
            .zip([Conformance::Strict, Conformance::Degraded])
        {
            let Prepared::Accepted {
                conformance,
                body,
                sections,
                ..
            } = &entry.prepared
            else {
                panic!("accepted entry required")
            };
            assert_eq!(*conformance, expected);
            assert!(body.contains("Body"));
            assert!(!sections.is_empty());
        }
        let Prepared::Accepted {
            fields,
            diagnostics,
            ..
        } = &batch[1].prepared
        else {
            unreachable!()
        };
        assert_eq!(fields.title, "");
        assert_eq!(
            diagnostics
                .iter()
                .map(|d| d.field.as_deref())
                .collect::<Vec<_>>(),
            [Some("title"), Some("status")]
        );
        for inputs in [
            vec![
                input("z.md", "---\ntype: 42\n---"),
                input("b.md", "---\n[broken"),
                input("a.md", strict),
            ],
            vec![
                input("b.md", "---\n[broken"),
                input("a.md", strict),
                input("z.md", "---\ntype: 42\n---"),
            ],
        ] {
            let error = prepare_batch(inputs).unwrap_err();
            assert_eq!((error.code, error.path.as_str()), ("ERR_OKF_PARSE", "b.md"));
            assert_eq!(error.diagnostics.len(), 1);
        }
        // All identity validation precedes duplicate detection, not just content preparation.
        let error = prepare_batch(vec![
            input("a.md", ""),
            input("./a.md", ""),
            input("z.txt", ""),
        ])
        .unwrap_err();
        assert_eq!(error.path, "z.txt");
        let error = prepare_batch(vec![
            input("z.md", ""),
            input("./z.md", ""),
            input("a.md", ""),
            input("./a.md", ""),
        ])
        .unwrap_err();
        assert_eq!(error.path, "a.md");
    }

    #[test]
    fn fatal_error_retains_ordered_diagnostics_and_selects_type() {
        let markdown = "---\ntitle: 12\ntype: 42\n---\nbody";
        let direct = okf_prepare_core::prepare(
            Input {
                path: "a.md",
                markdown,
                fallback_title: "A",
            },
            "a",
        );
        let error = prepare_batch(vec![input("z.md", "bad"), input("a.md", markdown)]).unwrap_err();
        assert_eq!(error.path, "a.md");
        assert_eq!(error.field.as_deref(), Some("type"));
        let Prepared::Fatal { diagnostics } = direct else {
            panic!("expected fatal")
        };
        assert_eq!(error.diagnostics, diagnostics);
    }
}
