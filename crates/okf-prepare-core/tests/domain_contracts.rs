use okf_prepare_core::analysis::{
    Analysis, Conformance, Input, Prepared, analyze, prepare, validate,
};
use okf_prepare_core::fields::{Staleness, Status, TrustTier, parse_timestamp};
use okf_prepare_core::frontmatter::parse as parse_frontmatter;
use okf_prepare_core::{ERR_OKF_FIELD, ERR_OKF_PARSE};

fn input(yaml: &str, body: &str) -> Input<'static> {
    let yaml = yaml
        .lines()
        .map(|line| line.strip_prefix("          ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n");
    let markdown = Box::leak(format!("---\n{yaml}\n---\n{body}").into_boxed_str());
    Input {
        path: "concept.md",
        markdown,
        fallback_title: "Fallback title",
    }
}

fn fields(yaml: &str) -> okf_prepare_core::ProjectedFields {
    match analyze(input(yaml, "body")) {
        Analysis::Accepted { fields, .. } => fields,
        Analysis::Fatal { diagnostics } => panic!("unexpected fatal diagnostics: {diagnostics:?}"),
    }
}

#[test]
fn frontmatter_accepts_exact_line_endings_and_preserves_body() {
    let lf =
        parse_frontmatter("---\ntype: note\n---\nbody\r\nnext", "note.md").expect("LF frontmatter");
    assert_eq!(lf.body, "body\r\nnext");
    assert_eq!(lf.yaml.as_mapping().expect("mapping").len(), 1);

    let crlf = parse_frontmatter("---\r\ntype: note\r\n---\r\nbody\nnext", "note.md")
        .expect("CRLF frontmatter");
    assert_eq!(crlf.body, "body\nnext");

    for markdown in [
        "type: note",
        "---\ntype: note",
        "\u{feff}---\ntype: note\n---\nbody",
        "---\rtype: note\r---\rbody",
        "---\ntype: note\n---   \nbody",
    ] {
        let error = parse_frontmatter(markdown, "note.md").expect_err("parse failure");
        assert_eq!(error.code, ERR_OKF_PARSE);
        assert_eq!(error.field, None);
    }
}

#[test]
fn frontmatter_parse_failures_are_fatal_without_field_diagnostics() {
    for yaml in [
        "type: [",
        "scalar",
        "- sequence",
        "1: value",
        "extension: {1: value}",
    ] {
        let result = validate(input(yaml, "body"));
        assert!(!result.is_valid);
        assert!(!result.is_indexable);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].code, ERR_OKF_PARSE);
        assert_eq!(result.errors[0].field, None);
    }
}

#[test]
fn omitted_fields_make_a_strict_baseline() {
    let result = analyze(input("type: note", "exact body"));
    let Analysis::Accepted {
        fields,
        body,
        conformance,
        diagnostics,
        ..
    } = result
    else {
        panic!("strict analysis expected");
    };

    assert_eq!(conformance, Conformance::Strict);
    assert!(diagnostics.is_empty());
    assert_eq!(body, "exact body");
    assert_eq!(fields.type_, "note");
    assert_eq!(fields.title, "Fallback title");
    assert_eq!(fields.status, Some(Status::Stable));
    assert_eq!(fields.trust_tier, Some(TrustTier::Unverified));
    assert_eq!(
        fields.staleness,
        Staleness {
            classified: true,
            stale_after: None
        }
    );
    assert!(fields.tags.is_empty());
    assert!(fields.sources.is_empty());
    assert!(fields.verified.is_empty());
}

#[test]
fn prepare_composes_strict_degraded_and_fatal_results_with_section_offsets() {
    let strict = prepare(input("type: note", "# Heading\nbody"), "opaque\\document");
    let Prepared::Accepted {
        document_id,
        fields,
        body,
        body_start_line,
        conformance,
        diagnostics,
        sections,
    } = strict
    else {
        panic!("strict preparation expected");
    };
    assert_eq!(document_id, "opaque\\document");
    assert_eq!(fields.type_, "note");
    assert_eq!(body, "# Heading\nbody");
    assert_eq!(body_start_line, 4);
    assert_eq!(conformance, Conformance::Strict);
    assert!(diagnostics.is_empty());
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].id, "opaque\\document#heading");
    assert_eq!((sections[0].start_line, sections[0].end_line), (4, 5));

    let degraded = prepare(
        input("type: note\nstatus: future", "# Heading\nbody"),
        "opaque",
    );
    let Prepared::Accepted {
        conformance,
        diagnostics,
        sections,
        ..
    } = degraded
    else {
        panic!("degraded preparation expected");
    };
    assert_eq!(conformance, Conformance::Degraded);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].field.as_deref(), Some("status"));
    assert_eq!(sections[0].id, "opaque#heading");
    assert_eq!((sections[0].start_line, sections[0].end_line), (5, 6));

    let fatal = prepare(input("title: missing", "# Heading\nbody"), "opaque");
    let Prepared::Fatal { diagnostics } = fatal else {
        panic!("fatal preparation expected");
    };
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, ERR_OKF_FIELD);
    assert_eq!(diagnostics[0].field.as_deref(), Some("type"));
}

#[test]
fn rich_projection_keeps_typed_values_and_search_source_text() {
    let fields = fields(
        r#"type: custom type
          title: ""
          description: ""
          resource: ../resource
          tags: [one, "", one]
          sources:
            - id: source-id
              title: Source title
              author: producer/version
              resource: ../source
              usage_count: -1.5
              last_modified: 2026-08-24T10:00:00Z
              usage_window:
                from: 2027-08-24T10:00:00Z
                to: 2026-08-24T10:00:00Z
          usage_window:
            from: 2027-08-24T10:00:00+01:00
            to: 2026-08-24T10:00:00Z
          generated:
            by: process:builder
            at: 2026-08-24T10:00:00.1239Z
          verified:
            by: human:alice
            at: 2026-08-24T10:00:00Z
          status: deprecated
          stale_after: 2026-08-24T10:00:00.1239Z
          runtime: runtime
          parameters:
            - name: ""
              type: ""
              required: false
          computation: computation
          executor:
            resource: executor
            receipt: []
          attester:
            resource: attester
          unknown:
            nested: true"#,
    );

    assert_eq!(fields.type_, "custom type");
    assert_eq!(fields.title, "");
    assert_eq!(fields.description.as_deref(), Some(""));
    assert_eq!(fields.resource.as_deref(), Some("../resource"));
    assert_eq!(fields.tags, ["one", "", "one"]);
    assert_eq!(fields.sources.len(), 1);
    assert_eq!(fields.sources[0].usage_count, Some(-1.5));
    assert_eq!(
        fields.sources[0].last_modified.as_deref(),
        Some("2026-08-24T10:00:00Z")
    );
    assert_eq!(
        fields.sources[0]
            .usage_window
            .as_ref()
            .expect("source window")
            .from,
        "2027-08-24T10:00:00Z"
    );
    assert_eq!(
        fields.usage_window.as_ref().expect("window").from,
        "2027-08-24T10:00:00+01:00"
    );
    assert_eq!(
        fields.generated.as_ref().expect("generation").by,
        "process:builder"
    );
    assert_eq!(fields.verified[0].by, "human:alice");
    assert_eq!(fields.trust_tier, Some(TrustTier::HumanReviewed));
    assert_eq!(fields.status, Some(Status::Deprecated));
    assert_eq!(
        fields.stale_after.as_ref().expect("stale after").value,
        "2026-08-24T10:00:00.1239Z"
    );
    assert_eq!(
        fields
            .stale_after
            .as_ref()
            .expect("stale after")
            .epoch_millis,
        parse_timestamp("2026-08-24T10:00:00.1239Z").expect("timestamp")
    );
    assert!(!fields.parameters.as_ref().expect("parameters")[0].required);
    assert_eq!(
        fields.executor.as_ref().expect("executor").receipt,
        Vec::<String>::new()
    );
    assert_eq!(
        fields.attester.as_ref().expect("attester").resource,
        "attester"
    );
    assert_eq!(
        fields.source_text,
        "source-id Source title producer/version ../source"
    );
}

#[test]
fn salvage_keeps_valid_siblings_and_orders_diagnostics_by_projector() {
    let result = validate(input(
        r#"attester: {}
          status: future
          sources:
            - {}
            - resource: ok
              author: bad actor
          type: note
          title: {}
          tags: [ok, 2]
          verified:
            - {}
            - nope
          executor: {}
          description: valid description
          parameters:
            - name: kept
              type: string
              required: true
          resource: valid resource"#,
        "body",
    ));

    assert!(!result.is_valid);
    assert!(result.is_indexable);
    assert!(
        result
            .errors
            .iter()
            .all(|error| error.code == ERR_OKF_FIELD)
    );
    assert_eq!(
        result
            .errors
            .iter()
            .map(|error| error.field.as_deref())
            .collect::<Vec<_>>(),
        vec![
            Some("title"),
            Some("tags[1]"),
            Some("sources[0].resource"),
            Some("sources[1].author"),
            Some("verified[0].by"),
            Some("verified[0].at"),
            Some("verified[1]"),
            Some("status"),
            Some("executor.resource"),
            Some("executor.receipt"),
            Some("attester.resource"),
        ]
    );

    let accepted = match analyze(input(
        "type: note\ndescription: good\nparameters:\n  - name: p\n    type: string\n    required: true",
        "body",
    )) {
        Analysis::Accepted { fields, .. } => fields,
        Analysis::Fatal { .. } => panic!("accepted projection expected"),
    };
    assert_eq!(accepted.description.as_deref(), Some("good"));
    assert_eq!(accepted.parameters.expect("parameters").len(), 1);

    let source_result = match analyze(input(
        "type: note\nsources:\n  - resource: kept\n    id: 1\n    title: valid\n  - resource: salvage",
        "body",
    )) {
        Analysis::Accepted { fields, .. } => fields,
        Analysis::Fatal { .. } => panic!("accepted source projection expected"),
    };
    assert_eq!(source_result.sources.len(), 1);
    assert_eq!(source_result.sources[0].resource, "salvage");
    assert_eq!(source_result.source_text, "valid kept salvage");
}

#[test]
fn trust_and_compliance_keep_invalid_present_values_unclassified() {
    assert_eq!(
        fields("type: note\nverified: []").trust_tier,
        Some(TrustTier::Unverified)
    );
    assert_eq!(
        fields("type: note\nverified:\n  - by: invalid actor\n    at: never").trust_tier,
        None
    );
    assert_eq!(
        fields("type: note\nverified:\n  - by: process:builder\n    at: 2026-08-24T10:00:00Z")
            .trust_tier,
        Some(TrustTier::MachineConfirmed)
    );

    let strict = validate(input("type: custom\ntags: []", "body"));
    assert_eq!(
        (strict.is_valid, strict.is_indexable, strict.errors.len()),
        (true, true, 0)
    );
    let degraded = validate(input("type: note\nstatus: future", "body"));
    assert_eq!(
        (
            degraded.is_valid,
            degraded.is_indexable,
            degraded.errors.len()
        ),
        (false, true, 1)
    );

    for yaml in ["title: missing", "type: '   '", "type: []"] {
        let fatal = validate(input(yaml, "body"));
        assert_eq!((fatal.is_valid, fatal.is_indexable), (false, false));
        assert_eq!(fatal.errors[0].field.as_deref(), Some("type"));
    }
}

#[test]
fn timestamps_match_the_explicit_profile_and_round_fractional_milliseconds_up() {
    for (value, expected) in [
        ("1970-01-01T00:00:00Z", 0),
        ("1969-12-31T23:59:59.999Z", -1),
        ("1969-12-31T23:59:59.9991Z", 0),
        ("1970-01-01T00:00:00+00:30", -1_800_000),
        ("1970-01-01T00:00:00-00:30", 1_800_000),
        ("2000-02-29T00:00:00Z", 951_782_400_000),
        ("0000-01-01T00:00:00Z", -62_167_219_200_000),
        ("9999-12-31T23:59:59.999Z", 253_402_300_799_999),
    ] {
        assert_eq!(parse_timestamp(value), Some(expected), "{value}");
    }
    for value in [
        "1900-02-29T00:00:00Z",
        "2024-04-31T00:00:00Z",
        "2000-02-29T00:00:60Z",
    ] {
        assert_eq!(parse_timestamp(value), None, "{value}");
    }
    let base = parse_timestamp("2026-08-24T10:00:00.123Z").expect("timestamp");
    assert_eq!(parse_timestamp("2026-08-24T10:00:00.1239Z"), Some(base + 1));
    assert_eq!(
        parse_timestamp("2026-08-24T10:00:00Z"),
        parse_timestamp("2026-08-24T11:00:00+01:00")
    );
    assert_eq!(
        parse_timestamp("2026-08-24T10:00:00Z"),
        parse_timestamp("2026-08-24T09:00:00-01:00")
    );

    for value in [
        "2026-02-29T10:00:00Z",
        "2026-08-24T24:00:00Z",
        "2026-08-24T10:00:60Z",
        "2026-08-24T10:00:00+24:00",
        "2026-08-24T10:00:00. Z",
        "2026-08-24",
    ] {
        assert_eq!(parse_timestamp(value), None, "{value}");
    }
}

#[test]
fn no_extra_range_or_content_validation_is_added() {
    let result = validate(input(
        r#"type: user-defined
          title: ""
          tags: [same, same]
          sources:
            - resource: source
              usage_count: -20
              usage_window:
                from: 2027-01-01T00:00:00Z
                to: 2026-01-01T00:00:00Z
          usage_window:
            from: 2027-01-01T00:00:00Z
            to: 2026-01-01T00:00:00Z"#,
        "body",
    ));
    assert!(result.is_valid);
    assert!(result.errors.is_empty());
}
