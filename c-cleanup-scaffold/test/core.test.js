const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../core");

test("inserts a marked free scaffold below a basic malloc assignment", () => {
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

test("caller-owned factories lose their internal scaffold and add one at the call site", () => {
  const lines = [
    "char *make_buf(void) {",
    "    char *buf = malloc(32);",
    "    free(buf); /* c-cleanup-scaffold */",
    "    return buf;",
    "}",
    "",
    "void use_buf(void) {",
    "    char *value = make_buf();",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {});
  assert.deepEqual(plan.edits, [
    {
      kind: "deleteLine",
      lineNumber: 2
    },
    {
      kind: "insert",
      afterLine: 7,
      text: "    free(value); /* c-cleanup-scaffold */"
    }
  ]);
});

test("duplicate prevention only looks at marked scaffolds", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf);",
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
});

test("removes exact duplicate marked scaffolds below the same creation", () => {
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
});

test("renames a marked scaffold when the allocated variable name changes in the same function", () => {
  const lines = [
    "void f(void) {",
    "    char *data = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "replaceLine",
      lineNumber: 2,
      text: "    free(data); /* c-cleanup-scaffold */"
    }
  ]);
});

test("renames two marked scaffolds in place when same-cleanup resources stay in local order", () => {
  const lines = [
    "void f(void) {",
    "    char *data = malloc(16);",
    "    free(buf); /* c-cleanup-scaffold */",
    "    char *scratch = calloc(1, 8);",
    "    free(tmp); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "replaceLine",
      lineNumber: 2,
      text: "    free(data); /* c-cleanup-scaffold */"
    },
    {
      kind: "replaceLine",
      lineNumber: 4,
      text: "    free(scratch); /* c-cleanup-scaffold */"
    }
  ]);
});

test("skips ambiguous same-cleanup rename groups instead of inserting or deleting guesses", () => {
  const lines = [
    "void f(void) {",
    "    char *first = malloc(16);",
    "    char *second = calloc(1, 8);",
    "    puts(second);",
    "    free(old_first); /* c-cleanup-scaffold */",
    "    free(old_second); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, []);
});

test("deletes a marked scaffold when its allocation disappears", () => {
  const lines = [
    "void f(void) {",
    "    puts(\"done\");",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "deleteLine",
      lineNumber: 2
    }
  ]);
});

test("deletes only the orphaned scaffold in a mixed-resource function", () => {
  const lines = [
    "void f(void) {",
    "    puts(\"done\");",
    "    fclose(fp); /* c-cleanup-scaffold */",
    "    char *buf = malloc(32);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "deleteLine",
      lineNumber: 2
    }
  ]);
});

test("preserves a marked scaffold when the prior assignment is still present but unsupported", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = cond ? malloc(8) : other();",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, []);
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

test("supports @takes_ownership by removing a managed scaffold for transferred ownership", () => {
  const lines = [
    "// @takes_ownership",
    "void set_buf(char *buf) {",
    "}",
    "",
    "void use_buf(void) {",
    "    char *buf = malloc(32);",
    "    set_buf(buf);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 5 });
  assert.deepEqual(plan.edits, [
    {
      kind: "deleteLine",
      lineNumber: 7
    }
  ]);
});

test("does not treat ownership transfer expressions as direct ownership handoff", () => {
  const lines = [
    "// @takes_ownership",
    "void set_buf(char *buf) {",
    "}",
    "",
    "void use_buf(void) {",
    "    char *buf = malloc(32);",
    "    set_buf(buf + 1);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 5 });
  assert.deepEqual(plan.edits, []);
});

test("supports multiline ownership-transfer calls with a direct casted variable argument", () => {
  const lines = [
    "// @takes_ownership",
    "void set_buf(char *buf) {",
    "}",
    "",
    "void use_buf(void) {",
    "    char *buf = malloc(32);",
    "    set_buf(",
    "        (char *) buf",
    "    );",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 5 });
  assert.deepEqual(plan.edits, [
    {
      kind: "deleteLine",
      lineNumber: 9
    }
  ]);
});

test("supports multiline allocations with block comments and inserts after the full statement", () => {
  const lines = [
    "void f(void) {",
    "    char *buf =",
    "        /* temp buffer */",
    "        malloc(64);",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "insert",
      afterLine: 3,
      text: "    free(buf); /* c-cleanup-scaffold */"
    }
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
