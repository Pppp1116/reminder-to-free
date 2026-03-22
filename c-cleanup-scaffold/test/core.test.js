const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../core");

test("inserts an immediate scaffold below a direct allocation", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {});
  assert.deepEqual(plan.edits, [
    {
      kind: "insert",
      afterLine: 1,
      text: "    free(buf); /* c-cleanup-scaffold */"
    }
  ]);

  const nextLines = core.applyLineEdits(lines, plan.edits);
  assert.equal(nextLines[2], "    free(buf); /* c-cleanup-scaffold */");
});

test("does not reinsert when a tagged scaffold has moved lower in the same function", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    puts(buf);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {});
  assert.deepEqual(plan.edits, []);
});

test("does not insert when an exact user cleanup already exists below", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf);",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {});
  assert.deepEqual(plan.edits, []);
});

test("adds a scaffold for simple owned-return helper calls", () => {
  const lines = [
    "char *make_buf(void) {",
    "    char *buf = malloc(32);",
    "    return buf;",
    "}",
    "",
    "void use_buf(void) {",
    "    char *value = make_buf();",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "line", lineNumber: 6 });
  assert.deepEqual(plan.edits, [
    {
      kind: "insert",
      afterLine: 6,
      text: "    free(value); /* c-cleanup-scaffold */"
    }
  ]);
});

test("supports @returns_owned above a multiline function header", () => {
  const lines = [
    "// @returns_owned",
    "char *",
    "read_file(",
    "    void",
    ") {",
    "    char *buf = malloc(16);",
    "    return buf;",
    "}",
    "",
    "void use_file(void) {",
    "    char *data = read_file();",
    "}"
  ];

  const plan = core.planScaffoldEdits(
    lines,
    { detectOwnedReturnFunctions: false },
    { kind: "line", lineNumber: 10 }
  );
  assert.deepEqual(plan.edits, [
    {
      kind: "insert",
      afterLine: 10,
      text: "    free(data); /* c-cleanup-scaffold */"
    }
  ]);
});

test("removes exact duplicate managed scaffolds directly below the creation line", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {});
  assert.deepEqual(plan.edits, [
    {
      kind: "deleteLine",
      lineNumber: 3
    }
  ]);

  const nextLines = core.applyLineEdits(lines, plan.edits);
  assert.deepEqual(nextLines, [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ]);
});

test("finalize removes markers without touching the cleanup call", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const edits = core.planFinalizeEdits(lines, { kind: "function", lineNumber: 1 });
  assert.deepEqual(edits, [
    {
      kind: "replaceLine",
      lineNumber: 2,
      text: "    free(buf);"
    }
  ]);
});
