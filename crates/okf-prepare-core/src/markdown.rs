use comrak::nodes::NodeValue;
use comrak::{Arena, Options, parse_document};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BlockKind {
    Heading { depth: u8, text: String },
    Content,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootBlock {
    pub kind: BlockKind,
    pub start_line: usize,
    pub end_line: usize,
    pub source: String,
}

/// Project the root blocks consumed by OKF preparation.
#[must_use]
pub fn project(source: &str) -> Vec<RootBlock> {
    let arena = Arena::new();
    let root = parse_document(&arena, source, &Options::default());
    let lines = line_ranges(source);

    root.children()
        .map(|node| {
            let sourcepos = node.data().sourcepos;
            let depth = match &node.data().value {
                NodeValue::Heading(heading) => Some(heading.level),
                _ => None,
            };
            let kind = depth.map_or(BlockKind::Content, |depth| BlockKind::Heading {
                depth,
                text: node.collect_text(),
            });

            RootBlock {
                kind,
                start_line: sourcepos.start.line,
                end_line: sourcepos.end.line,
                source: slice_lines(&lines, sourcepos.start.line, sourcepos.end.line, source),
            }
        })
        .collect()
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

fn slice_lines(
    lines: &[(usize, usize)],
    start_line: usize,
    end_line: usize,
    source: &str,
) -> String {
    let Some(&(start, _)) = start_line.checked_sub(1).and_then(|line| lines.get(line)) else {
        return String::new();
    };
    let Some(&(_, end)) = end_line.checked_sub(1).and_then(|line| lines.get(line)) else {
        return String::new();
    };
    source[start..end].to_owned()
}
