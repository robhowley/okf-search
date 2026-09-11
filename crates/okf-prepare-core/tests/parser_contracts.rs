use okf_prepare_core::error::PrepareError;
use okf_prepare_core::markdown::{BlockKind, project};
use okf_prepare_core::yaml::YamlOwned;

#[test]
fn yaml_loads_owned_values_with_saphyr_scalar_types() {
    let value = YamlOwned::load_from_str(
        "title: note\ncount: 3\nactive: true\nratio: 1.5\nmissing: null\n",
    )
    .expect("valid YAML");

    assert_eq!(
        value,
        YamlOwned::Mapping(vec![
            ("title".into(), YamlOwned::String("note".into())),
            ("count".into(), YamlOwned::Integer(3)),
            ("active".into(), YamlOwned::Boolean(true)),
            ("ratio".into(), YamlOwned::Float(1.5)),
            ("missing".into(), YamlOwned::Null),
        ])
    );
}

#[test]
fn yaml_accepts_nested_tagged_and_aliased_string_keys() {
    let value = YamlOwned::load_from_str(
        "anchor: &name value\n? *name\n: alias value\n? !!str tagged\n: tagged value\nnested:\n  ? !custom child\n  : true\n",
    )
    .expect("string keys, including wrapped keys");

    let YamlOwned::Mapping(entries) = value else {
        panic!("mapping root");
    };
    assert_eq!(entries.len(), 4);
    assert!(matches!(entries[1].1, YamlOwned::String(ref value) if value == "alias value"));
    assert!(matches!(entries[2].1, YamlOwned::String(ref value) if value == "tagged value"));
}

#[test]
fn yaml_rejects_non_string_mapping_keys_at_any_depth() {
    for source in ["1: value", "outer:\n  1: value", "? [one]\n: value"] {
        assert!(YamlOwned::load_from_str(source).is_err(), "{source}");
    }
}

#[test]
fn markdown_projects_only_root_blocks_and_slices_original_lines() {
    let source = "# Root\r\n\r\n> ## Nested\r\n\r\nbody one\r\nbody two\r\n## Child";
    let blocks = project(source);

    assert_eq!(blocks.len(), 4);
    assert_heading(&blocks[0], 1, "Root", 1, 1, "# Root");
    assert!(matches!(blocks[1].kind, BlockKind::Content));
    assert_eq!((blocks[1].start_line, blocks[1].end_line), (3, 3));
    assert_eq!(blocks[1].source, "> ## Nested");
    assert_eq!((blocks[2].start_line, blocks[2].end_line), (5, 6));
    assert_eq!(blocks[2].source, "body one\r\nbody two");
    assert_heading(&blocks[3], 2, "Child", 7, 7, "## Child");
}

#[test]
fn markdown_heading_text_comes_from_comrak_inline_nodes() {
    let blocks = project("# [linked](url) and `code`");

    assert_heading(
        &blocks[0],
        1,
        "linked and code",
        1,
        1,
        "# [linked](url) and `code`",
    );
}

#[test]
fn prepare_errors_are_rust_owned_domain_fields() {
    let parse = PrepareError::parse("notes/example.md");
    assert_eq!(parse.code, "ERR_OKF_PARSE");
    assert_eq!(parse.path, "notes/example.md");
    assert_eq!(parse.message, "Cannot parse OKF concept: notes/example.md");
    assert_eq!(parse.field, None);

    let field = PrepareError::invalid_field("notes/example.md", "title");
    assert_eq!(field.code, "ERR_OKF_FIELD");
    assert_eq!(field.field.as_deref(), Some("title"));
}

fn assert_heading(
    block: &okf_prepare_core::markdown::RootBlock,
    depth: u8,
    text: &str,
    start_line: usize,
    end_line: usize,
    source: &str,
) {
    let BlockKind::Heading {
        depth: actual_depth,
        text: actual_text,
    } = &block.kind
    else {
        panic!("heading block");
    };
    assert_eq!(*actual_depth, depth);
    assert_eq!(actual_text, text);
    assert_eq!((block.start_line, block.end_line), (start_line, end_line));
    assert_eq!(block.source, source);
}
