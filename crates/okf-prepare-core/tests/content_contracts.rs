use okf_prepare_core::sections::{PreparedSection, project_sections};

#[test]
fn empty_and_preamble_sections_have_the_title_and_full_document_lines() {
    assert_eq!(
        project_sections("folder\\opaque/Doc", "Document title", "", 10),
        vec![PreparedSection {
            id: "folder\\opaque/Doc#root".into(),
            heading_path: "Document title".into(),
            text: String::new(),
            start_line: 10,
            end_line: 10,
        }]
    );

    let sections = project_sections(
        "doc",
        "Document title",
        "preamble\n\n# Parent\n### Grandchild\nchild text\n## Child\nchild body",
        10,
    );
    assert_eq!(
        sections
            .iter()
            .map(|section| (
                section.heading_path.as_str(),
                section.text.as_str(),
                section.start_line,
                section.end_line,
            ))
            .collect::<Vec<_>>(),
        vec![
            ("Document title", "preamble", 10, 10),
            ("Parent", "", 12, 12),
            ("Parent > Grandchild", "child text", 13, 14),
            ("Parent > Child", "child body", 15, 16),
        ]
    );
}

#[test]
fn heading_only_sections_are_kept_and_nested_blockquote_headings_are_content() {
    let heading_only = project_sections("doc", "Title", "# Parent\n## Child", 4);
    assert_eq!(
        heading_only
            .iter()
            .map(|section| (
                section.id.as_str(),
                section.heading_path.as_str(),
                section.text.as_str(),
                section.start_line,
                section.end_line,
            ))
            .collect::<Vec<_>>(),
        vec![
            ("doc#parent", "Parent", "", 4, 4),
            ("doc#parent-child", "Parent > Child", "", 5, 5),
        ]
    );

    let nested = project_sections("doc", "Title", "> ## Nested\n\nplain", 7);
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0].heading_path, "Title");
    assert_eq!(nested[0].text, "> ## Nested\n\nplain");
    assert_eq!((nested[0].start_line, nested[0].end_line), (7, 9));
}

#[test]
fn heading_text_and_untitled_fallback_drive_paths_and_slugs() {
    let sections = project_sections(
        "slugs.md",
        "Title",
        "# [linked](url) and `code`\nfirst\n#\nsecond\n#\nthird",
        4,
    );
    assert_eq!(
        sections
            .iter()
            .map(|section| (
                section.id.as_str(),
                section.heading_path.as_str(),
                section.text.as_str(),
            ))
            .collect::<Vec<_>>(),
        vec![
            ("slugs.md#linked-and-code", "linked and code", "first"),
            ("slugs.md#untitled-section", "Untitled section", "second"),
            ("slugs.md#untitled-section--2", "Untitled section", "third",),
        ]
    );
}

#[test]
fn inline_heading_text_preserves_adjacency_in_paths_and_ids() {
    for (body, heading, id) in [
        (
            "## alpha**beta**gamma",
            "alphabetagamma",
            "doc#alphabetagamma",
        ),
        (
            "## Alpha **beta** gamma",
            "Alpha beta gamma",
            "doc#alpha-beta-gamma",
        ),
    ] {
        let sections = project_sections("doc", "Title", body, 4);
        assert_eq!(sections[0].heading_path, heading);
        assert_eq!(sections[0].id, id);
    }
}

#[test]
fn fenced_code_ends_on_the_last_content_line() {
    for (body, end_line) in [("```\none\n", 5), ("```\none", 5), ("```\none\n```\n", 6)] {
        let sections = project_sections("doc", "Title", body, 4);
        assert_eq!(
            (sections[0].start_line, sections[0].end_line),
            (4, end_line)
        );
    }
}

#[test]
fn text_normalizes_all_supported_line_endings_without_changing_offsets() {
    for newline in ["\n", "\r\n", "\r"] {
        let body = format!("# Heading{newline}{newline}first{newline}{newline}second");
        let sections = project_sections("doc", "Title", &body, 8);
        assert_eq!(sections.len(), 1, "line ending: {newline:?}");
        assert_eq!(sections[0].text, "first\n\nsecond");
        assert_eq!((sections[0].start_line, sections[0].end_line), (8, 12));
    }
}

#[test]
fn chunk_text_normalization_preserves_unicode_trim_and_internal_spacing() {
    for (body, text, end_line) in [
        ("\u{00a0}\tα\r\n\rβ\n\u{2003}", "α\n\nβ", 11),
        ("\u{00a0}\tα\n\nβ\n\u{2003}", "α\n\nβ", 11),
        ("a\r\r\nb", "a\n\nb", 10),
        ("a\tb\r\nc\u{2003}d", "a\tb\nc\u{2003}d", 9),
        ("\u{00a0}\t\u{2003}", "", 8),
    ] {
        assert_eq!(
            project_sections("doc", "Title", body, 8),
            vec![PreparedSection {
                id: "doc#root".into(),
                heading_path: "Title".into(),
                text: text.into(),
                start_line: 8,
                end_line,
            }],
            "body: {body:?}"
        );
    }
}

#[test]
fn mixed_newlines_keep_source_bounds_and_interblock_gaps() {
    for body in ["# H\r\n\r\nα\r\rβ\n", "# H\r\n\r\nα\r\rβ"] {
        assert_eq!(
            project_sections("doc", "Title", body, 8),
            vec![PreparedSection {
                id: "doc#h".into(),
                heading_path: "H".into(),
                text: "α\n\nβ".into(),
                start_line: 8,
                end_line: 12,
            }],
            "body: {body:?}"
        );
    }
}

#[test]
fn borrowed_blocks_preserve_parser_and_chunk_boundaries() {
    let paragraph = |words: usize, term: &str| {
        std::iter::once(term)
            .chain(std::iter::repeat_n("word", words - 1))
            .collect::<Vec<_>>()
            .join(" ")
    };

    for (first_words, first_group) in [
        (499, vec!["first", "bridge", "---"]),
        (500, vec!["first"]),
        (501, vec!["first"]),
    ] {
        let first = paragraph(first_words, &format!("first{first_words}"));
        let third = paragraph(300, "third");
        let fourth = paragraph(300, "fourth");
        let body = format!("{first}\r\n\r\nbridge\r\r---\n\n{third}\r\n\r\n{fourth}");
        let sections = project_sections("blocks", "Title", &body, 30);

        assert_eq!(sections.len(), 3, "first words: {first_words}");
        assert_eq!(sections[0].id, "blocks#root--part-1");
        assert_eq!(
            sections[0].text,
            first_group
                .iter()
                .map(|block| if *block == "first" {
                    first.as_str()
                } else {
                    *block
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        );
        assert_eq!(sections[0].start_line, 30);
        assert_eq!(
            sections[0].end_line,
            if first_words == 499 { 34 } else { 30 }
        );

        let second_text = if first_words == 499 {
            third.clone()
        } else {
            format!("bridge\n\n---\n\n{third}")
        };
        let second_start = if first_words == 499 { 36 } else { 32 };
        assert_eq!(sections[1].id, "blocks#root--part-2");
        assert_eq!(sections[1].text, second_text);
        assert_eq!(
            (sections[1].start_line, sections[1].end_line),
            (second_start, 36)
        );
        assert_eq!(sections[2].id, "blocks#root--part-3");
        assert_eq!(sections[2].text, fourth);
        assert_eq!((sections[2].start_line, sections[2].end_line), (38, 38));
    }

    let source_based =
        "````\r\na--b __under_score__ 日本語 12.5\r\n````\r\n\r\n- list_item\r\n\r\n> quoted\r\n";
    let source_sections = project_sections("source", "Title", source_based, 20);
    assert_eq!(source_sections.len(), 1);
    assert_eq!(
        source_sections[0].text,
        "````\na--b __under_score__ 日本語 12.5\n````\n\n- list_item\n\n> quoted"
    );
}

#[test]
fn slugs_use_nfkd_unicode_runs_and_full_heading_paths() {
    let body = [
        "# Café!",
        "first",
        "# Cafe",
        "second",
        "# Parent",
        "## Café",
        "nested one",
        "# Parent",
        "## Cafe",
        "nested two",
    ]
    .join("\n");
    let sections = project_sections("Éxample\\document", "Title", &body, 3);

    assert_eq!(
        sections
            .iter()
            .map(|section| (section.id.as_str(), section.heading_path.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("Éxample\\document#cafe", "Café!"),
            ("Éxample\\document#cafe--2", "Cafe"),
            ("Éxample\\document#parent", "Parent"),
            ("Éxample\\document#parent-cafe", "Parent > Café"),
            ("Éxample\\document#parent--2", "Parent"),
            ("Éxample\\document#parent-cafe--2", "Parent > Cafe"),
        ]
    );
}

#[test]
fn chunking_keeps_blocks_complete_and_formats_split_ids() {
    let paragraph = |words: usize, term: &str| {
        std::iter::once(term)
            .chain(std::iter::repeat_n("word", words - 1))
            .collect::<Vec<_>>()
            .join(" ")
    };

    let exact = (0..8)
        .map(|index| paragraph(100, &format!("exact{index}")))
        .collect::<Vec<_>>();
    let exact_sections = project_sections("limit", "Title", &exact.join("\n\n"), 1);
    assert_eq!(exact_sections.len(), 1);
    assert_eq!(exact_sections[0].id, "limit#root");
    assert_eq!(word_count(&exact_sections[0].text), 800);

    let over = (0..7)
        .map(|index| paragraph(100, &format!("over{index}")))
        .chain(std::iter::once(paragraph(101, "over-final")))
        .collect::<Vec<_>>();
    let over_body = over.join("\n\n");
    let over_sections = project_sections("over", "Title", &over_body, 20);
    assert_eq!(
        over_sections
            .iter()
            .map(|section| section.id.as_str())
            .collect::<Vec<_>>(),
        vec!["over#root--part-1", "over#root--part-2"]
    );
    assert_eq!(over_sections[0].text, over[..5].join("\n\n"));
    assert_eq!(over_sections[1].text, over[5..].join("\n\n"));
    assert_eq!(over_sections[0].start_line, 20);
    assert_eq!(over_sections[0].end_line, 28);
    assert_eq!(over_sections[1].start_line, 30);

    let threshold = [250, 250, 1, 300, 300]
        .into_iter()
        .enumerate()
        .map(|(index, words)| paragraph(words, &format!("threshold{index}")))
        .collect::<Vec<_>>();
    let threshold_sections = project_sections("threshold", "Title", &threshold.join("\n\n"), 1);
    assert_eq!(threshold_sections.len(), 3);
    assert_eq!(word_count(&threshold_sections[0].text), 500);
    assert_eq!(threshold_sections[0].text, threshold[..2].join("\n\n"));

    let tail = |words: usize| {
        [300, 300, words]
            .into_iter()
            .enumerate()
            .map(|(index, count)| paragraph(count, &format!("tail{index}")))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    assert_eq!(project_sections("tail249", "Title", &tail(249), 1).len(), 2);
    assert_eq!(project_sections("tail250", "Title", &tail(250), 1).len(), 3);

    let oversized = [paragraph(801, "oversized"), paragraph(300, "tail")].join("\n\n");
    let oversized_sections = project_sections("oversized", "Title", &oversized, 1);
    assert_eq!(oversized_sections.len(), 2);
    assert_eq!(word_count(&oversized_sections[0].text), 801);
    assert_eq!(oversized_sections[0].text, paragraph(801, "oversized"));
}

#[test]
fn collision_suffix_precedes_part_suffix() {
    let blocks = (0..8)
        .map(|index| format!("part{index} "))
        .map(|prefix| format!("{prefix}{}", "word ".repeat(99)))
        .chain(std::iter::once("extra".to_owned()))
        .collect::<Vec<_>>();
    let body = format!("# Café\n{}\n\n# Cafe\nshort", blocks.join("\n\n"));
    let sections = project_sections("doc", "Title", &body, 1);

    assert_eq!(sections[0].id, "doc#cafe--part-1");
    assert_eq!(sections[1].id, "doc#cafe--part-2");
    assert_eq!(sections[2].id, "doc#cafe--2");
}

#[test]
fn projector_never_returns_an_empty_vector() {
    for body in ["", "   \n\n", "# Heading", "ordinary content"] {
        assert!(
            !project_sections("doc", "Title", body, 1).is_empty(),
            "{body:?}"
        );
    }
}

fn word_count(value: &str) -> usize {
    value.split_whitespace().count()
}
