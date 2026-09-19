import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OkfError, openOkf } from "../src/index.js";

const roots: string[] = [];

function concept(type: string, body = "body"): string {
  return `---\ntype: ${type}\n---\n${body}\n`;
}

async function directory(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okf-native-root-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("openOkf", () => {
  it.each(["memory", "mmap"] as const)(
    "opens empty and nested directories through the raw-document path (%s)",
    async (storage) => {
      const empty = await directory({});
      const emptyIndex = storage === "mmap"
        ? await openOkf(empty, {
            cachePath: join(empty, ".cache.okf"),
            storage,
          })
        : await openOkf(empty, { storage });
      expect(emptyIndex.listTypes()).toEqual([]);
      expect(emptyIndex.search("anything")).toEqual([]);

      const root = await directory({
        "nested/guide.md": concept("guide", "directoryneedle"),
        "index.md": "not a concept",
        "nested/log.md": "not a concept",
        "UPPER.MD": "not a concept",
      });
      const index = storage === "mmap"
        ? await openOkf(root, {
            cachePath: join(root, ".cache.okf"),
            storage,
          })
        : await openOkf(root, { storage });
      expect(index.search("directoryneedle")).toEqual([
        expect.objectContaining({
          documentId: "nested/guide",
          path: "nested/guide.md",
        }),
      ]);
      await Promise.all([emptyIndex.close(), index.close()]);
    },
  );

  it("reports the first normalized failure without exposing a partial handle", async () => {
    const root = await directory({
      "z.md": "not frontmatter",
      "nested/valid.md": concept("note", "validneedle"),
      "a.md": "not frontmatter",
    });

    await expect(openOkf(root)).rejects.toMatchObject({
      name: "OkfError",
      code: "ERR_OKF_PARSE",
      path: "a.md",
    });
  });

  it("maps traversal and invalid UTF-8 errors to caller-usable OkfError values", async () => {
    const missing = join(tmpdir(), `missing-okf-${crypto.randomUUID()}`);
    const readFailure = await openOkf(missing).catch((error: unknown) => error);
    expect(readFailure).toBeInstanceOf(OkfError);
    expect(readFailure).toMatchObject({
      code: "ERR_OKF_READ",
      path: ".",
    });
    expect(Object.hasOwn(readFailure as object, "cause")).toBe(true);

    const root = await directory({
      "bad.md": new Uint8Array([
        0x2d, 0x2d, 0x2d, 0x0a,
        0x74, 0x79, 0x70, 0x65, 0x3a, 0x20,
        0xff,
      ]),
    });
    const parseFailure = await openOkf(root).catch((error: unknown) => error);
    expect(parseFailure).toBeInstanceOf(OkfError);
    expect(parseFailure).toMatchObject({
      code: "ERR_OKF_PARSE",
      path: "bad.md",
    });
    expect((parseFailure as Error).message).not.toMatch(/PrepareError|napi|native/i);
  });

  it.each(["memory", "mmap"] as const)(
    "remove changes only committed index state, not source files (%s)",
    async (storage) => {
      const markdown = concept("note", "sourcefileneedle");
      const root = await directory({ "nested/source.md": markdown });
      const path = join(root, "nested/source.md");
      const before = await readFile(path);
      const options = storage === "mmap"
        ? { cachePath: join(root, ".cache.okf"), storage }
        : { storage };
      const index = await openOkf(root, options);

      expect(index.remove("./nested//source.md")).toBe(true);
      expect(index.search("sourcefileneedle")).toEqual([]);
      expect(await readFile(path)).toEqual(before);

      const reopened = await openOkf(root, options);
      expect(reopened.search("sourcefileneedle")).toHaveLength(1);
      await Promise.all([index.close(), reopened.close()]);
    },
  );
});
