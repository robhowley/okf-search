export function oracleInputs() {
  const strictInput = input("oracle/strict.md", `
    type: note
    title: Oracle strict
    description: ''
    resource: resource://strict
    tags: [alpha, beta]
    sources:
      - resource: source://one
        id: source-one
        author: human:alice
        usage_count: -1.5
        last_modified: 2026-08-24T10:00:00Z
    usage_window:
      from: 2026-01-01T00:00:00Z
      to: 2026-12-31T23:59:59.1239+01:00
    generated:
      by: process:oracle
      at: 2026-08-24T10:00:00Z
    verified:
      - by: process:builder
        at: 2026-08-24T10:00:00Z
      - by: human:alice
        at: 2026-08-25T10:00:00Z
    status: deprecated
    stale_after: 2027-01-01T00:00:00Z
    runtime: node
    parameters:
      - name: query
        type: string
        required: true
    computation: resource://computation
    executor:
      resource: resource://executor
      receipt: [resource://receipt]
    attester:
      resource: resource://attester
    extension_graph: &graph
      self: *graph
    extension_shared: &shared
      value: shared
    extension_alias: *shared
    extension_nan: .nan
    extension_positive_infinity: .inf
    extension_negative_infinity: -.inf
    extension_negative_zero: -0
    extension_surrogate: "\\uD800"
    extension_date: !!timestamp 2026-08-24
    extension_map: !!omap
      - first: one
      - second: two
    extension_set: !!set
      first:
      second:
    extension_binary: !!binary SGVsbG8=
  `, [
    "# Escaped &amp; [linked](resource) ![image alt](image)",
    "paragraph one",
    "",
    "Setext child",
    "------------",
    "paragraph two",
    "",
    "> # nested quote heading",
    "",
    "- # nested list heading",
    "",
    "```md",
    "# fenced heading",
    "```",
    "",
    "<div>html block</div>",
    "",
    "[resource]: https://example.com",
  ].join("\n"));

  const cases = [
    { id: "strict-rich-yaml-and-markdown", input: strictInput },
    {
      id: "degraded-diagnostic-order",
      input: input("oracle/degraded.md", `
        attester: {}
        status: future
        sources:
          - {}
        type: note
        tags: [ok, 2]
        verified: [{}]
      `, "degraded body"),
    },
    {
      id: "fatal-missing-type",
      input: input("oracle/missing-type.md", "title: Missing type", "body"),
    },
    {
      id: "fatal-duplicate-yaml-key",
      input: input("oracle/duplicate-key.md", "type: note\ntype: guide", "body"),
    },
    {
      id: "line-endings-crlf",
      input: withLineEndings(input(
        "oracle/crlf.md",
        "type: note",
        "# Parent\n\n## Child\nline ending body",
      ), "\r\n"),
    },
    {
      id: "line-endings-lone-cr-body",
      input: {
        path: "oracle/lone-cr.md",
        markdown: "---\ntype: note\n---\n# Parent\rbody\rnext",
      },
    },
    {
      id: "chunk-801-words",
      input: input(
        "oracle/chunk.md",
        "type: note",
        Array.from({ length: 7 }, () => words(100))
          .concat(words(101))
          .join("\n\n"),
      ),
    },
    {
      id: "lone-surrogate-path-and-body",
      input: input("oracle/\uD800.md", "type: note", "# \uD800\nbody \uD800"),
    },
    {
      id: "batch-order-astral",
      input: input("oracle/\u{10000}.md", "type: astral", "astral path"),
    },
    {
      id: "batch-order-private-use",
      input: input("oracle/\uE000.md", "type: private-use", "private-use path"),
    },
  ];

  return cases;
}

function input(path, metadata, body) {
  const lines = metadata.split("\n");
  while (!lines[0]?.trim()) lines.shift();
  while (!lines.at(-1)?.trim()) lines.pop();
  const indentation = Math.min(...lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0));
  const yaml = lines.map((line) => line.slice(indentation)).join("\n");
  return { path, markdown: `---\n${yaml}\n---\n${body}` };
}

function withLineEndings(document, newline) {
  return { ...document, markdown: document.markdown.replaceAll("\n", newline) };
}

function words(count) {
  return Array.from({ length: count }, () => "word").join(" ");
}

