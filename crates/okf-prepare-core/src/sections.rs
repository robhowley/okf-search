use std::collections::HashMap;

use finl_unicode::categories::CharacterCategories;
use unicode_normalization::UnicodeNormalization;

use crate::markdown::{self, BlockKind, RootBlock};

const MAX_SECTION_WORDS: usize = 800;
const TARGET_CHUNK_WORDS: usize = 500;
const MIN_TAIL_WORDS: usize = 250;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedSection {
    pub id: String,
    pub heading_path: String,
    pub text: String,
    pub start_line: usize,
    pub end_line: usize,
}

/// Project root-level Markdown blocks into prepared sections.
///
/// The returned vector always contains at least one section.
#[must_use]
pub fn project_sections(
    document_id: &str,
    title: &str,
    body: &str,
    body_start_line: usize,
) -> Vec<PreparedSection> {
    let blocks = markdown::project(body);
    let lines = line_ranges(body);
    let drafts = build_sections(blocks, title, body_start_line);
    let mut slug_counts = HashMap::new();
    let mut prepared = Vec::new();

    for section in drafts {
        let section_slug = unique_slug(&section.slug, &mut slug_counts);
        let chunks = chunk_section(&section, body, &lines, body_start_line);
        let multiple_chunks = chunks.len() > 1;
        let base_id = format!("{document_id}#{section_slug}");

        for (index, chunk) in chunks.into_iter().enumerate() {
            let id = if multiple_chunks {
                format!("{base_id}--part-{}", index + 1)
            } else {
                base_id.clone()
            };
            prepared.push(PreparedSection {
                id,
                heading_path: section.heading_path.clone(),
                text: chunk.text,
                start_line: chunk.start_line,
                end_line: chunk.end_line,
            });
        }
    }

    debug_assert!(!prepared.is_empty());
    prepared
}

struct SectionDraft {
    heading_path: String,
    slug: String,
    heading_line: Option<usize>,
    blocks: Vec<RootBlock>,
}

struct Chunk {
    text: String,
    start_line: usize,
    end_line: usize,
}

fn build_sections(
    blocks: Vec<RootBlock>,
    title: &str,
    body_start_line: usize,
) -> Vec<SectionDraft> {
    let mut result = Vec::new();
    let mut stack: Vec<(u8, String)> = Vec::new();
    let mut current = SectionDraft {
        heading_path: title.to_owned(),
        slug: "root".to_owned(),
        heading_line: None,
        blocks: Vec::new(),
    };

    for block in blocks {
        let BlockKind::Heading { depth, text } = &block.kind else {
            current.blocks.push(block);
            continue;
        };

        if current.heading_line.is_some() || !current.blocks.is_empty() {
            result.push(current);
        }

        while stack
            .last()
            .is_some_and(|(existing_depth, _)| existing_depth >= depth)
        {
            stack.pop();
        }

        let text = text.trim();
        let text = if text.is_empty() {
            "Untitled section"
        } else {
            text
        };
        stack.push((*depth, text.to_owned()));
        let heading_path = stack
            .iter()
            .map(|(_, heading)| heading.as_str())
            .collect::<Vec<_>>()
            .join(" > ");

        current = SectionDraft {
            heading_path: heading_path.clone(),
            slug: slug(&heading_path),
            heading_line: Some(absolute_line(body_start_line, block.start_line)),
            blocks: Vec::new(),
        };
    }

    if current.heading_line.is_some() || !current.blocks.is_empty() || result.is_empty() {
        result.push(current);
    }

    result
}

fn chunk_section(
    section: &SectionDraft,
    body: &str,
    lines: &[(usize, usize)],
    body_start_line: usize,
) -> Vec<Chunk> {
    let words = section
        .blocks
        .iter()
        .map(|block| word_count(&block.source))
        .collect::<Vec<_>>();
    let total_words = words.iter().sum::<usize>();

    if total_words <= MAX_SECTION_WORDS {
        return vec![make_chunk(
            section,
            &(0..section.blocks.len()).collect::<Vec<_>>(),
            body,
            lines,
            body_start_line,
            true,
        )];
    }

    let mut groups: Vec<Vec<usize>> = vec![Vec::new()];
    let mut group_words = vec![0usize];

    for (index, block_words) in words.into_iter().enumerate() {
        let last = groups.len() - 1;
        if !groups[last].is_empty() && group_words[last] + block_words > TARGET_CHUNK_WORDS {
            groups.push(Vec::new());
            group_words.push(0);
        }
        let last = groups.len() - 1;
        groups[last].push(index);
        group_words[last] += block_words;
    }

    if groups.len() > 1 && group_words.last().copied().unwrap_or(0) < MIN_TAIL_WORDS {
        let tail = groups.pop().expect("there is a final group");
        groups
            .last_mut()
            .expect("a tail has a previous group")
            .extend(tail);
    }

    groups
        .iter()
        .enumerate()
        .map(|(index, group)| make_chunk(section, group, body, lines, body_start_line, index == 0))
        .collect()
}

fn make_chunk(
    section: &SectionDraft,
    block_indices: &[usize],
    body: &str,
    lines: &[(usize, usize)],
    body_start_line: usize,
    include_heading: bool,
) -> Chunk {
    if block_indices.is_empty() {
        let line = section.heading_line.unwrap_or(body_start_line);
        return Chunk {
            text: String::new(),
            start_line: line,
            end_line: line,
        };
    }

    let first = &section.blocks[block_indices[0]];
    let last = &section.blocks[*block_indices.last().expect("non-empty chunk")];
    let start_line = absolute_line(body_start_line, first.start_line);
    let end_line = absolute_line(body_start_line, last.end_line);

    Chunk {
        text: source_between(body, lines, first.start_line, last.end_line),
        start_line: if include_heading {
            section.heading_line.unwrap_or(start_line)
        } else {
            start_line
        },
        end_line,
    }
}

fn source_between(
    body: &str,
    lines: &[(usize, usize)],
    start_line: usize,
    end_line: usize,
) -> String {
    let Some(&(start, _)) = start_line.checked_sub(1).and_then(|line| lines.get(line)) else {
        return String::new();
    };
    let Some(&(_, end)) = end_line.checked_sub(1).and_then(|line| lines.get(line)) else {
        return String::new();
    };

    body[start..end]
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_owned()
}

fn line_ranges(source: &str) -> Vec<(usize, usize)> {
    let bytes = source.as_bytes();
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                ranges.push((start, index));
                index += 1;
                start = index;
            }
            b'\r' => {
                ranges.push((start, index));
                index += 1;
                if bytes.get(index) == Some(&b'\n') {
                    index += 1;
                }
                start = index;
            }
            _ => index += 1,
        }
    }
    ranges.push((start, source.len()));
    ranges
}

fn absolute_line(body_start_line: usize, body_line: usize) -> usize {
    body_start_line + body_line - 1
}

fn word_count(value: &str) -> usize {
    let mut count = 0;
    let mut in_word = false;

    for character in value.chars() {
        let is_word = character == '_' || character.is_letter() || character.is_number();
        if is_word && !in_word {
            count += 1;
        }
        in_word = is_word;
    }

    count
}

fn unique_slug(slug: &str, counts: &mut HashMap<String, usize>) -> String {
    let count = counts.entry(slug.to_owned()).or_insert(0);
    *count += 1;
    if *count == 1 {
        slug.to_owned()
    } else {
        format!("{slug}--{count}")
    }
}

fn slug(value: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    let normalized = value.nfkd().collect::<String>();

    for character in normalized.to_lowercase().chars() {
        if character.is_letter() || character.is_number() {
            if separator && !result.is_empty() {
                result.push('-');
            }
            result.push(character);
            separator = false;
        } else if !result.is_empty() {
            separator = true;
        }
    }

    if result.is_empty() {
        "section".to_owned()
    } else {
        result
    }
}
