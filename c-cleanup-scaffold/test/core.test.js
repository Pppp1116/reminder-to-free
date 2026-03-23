const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../core");
const lifecycle = require("../lifecycle");

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

test("renames only the unmatched scaffold in a mixed exact-match and rename group", () => {
  const lines = [
    "void f(void) {",
    "    FILE *out = fopen(path, \"w\");",
    "    fclose(out); /* c-cleanup-scaffold */",
    "    FILE *log_file = fopen(log_path, \"w\");",
    "    fclose(tmp); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "replaceLine",
      lineNumber: 4,
      text: "    fclose(log_file); /* c-cleanup-scaffold */"
    }
  ]);
});

test("keeps a moved managed scaffold linked when the source remains unambiguous", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(16);",
    "    puts(buf);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, []);
});

test("same-shape nested-block creations get distinct creation keys", () => {
  const lines = [
    "void f(int cond) {",
    "    if (cond) {",
    "        char *buf = malloc(32);",
    "    } else {",
    "        char *buf = malloc(32);",
    "    }",
    "}"
  ];

  const creations = core.collectSourceCreations(lines);
  assert.equal(creations.length, 2);
  assert.notEqual(creations[0].creationKey, creations[1].creationKey);
  assert.notEqual(creations[0].blockKey, creations[1].blockKey);
});

test("renames a moved managed scaffold when the source variable changes safely", () => {
  const lines = [
    "void f(void) {",
    "    char *data = malloc(16);",
    "    puts(data);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "replaceLine",
      lineNumber: 3,
      text: "    free(data); /* c-cleanup-scaffold */"
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

test("deletes the correct moved marked scaffold when its allocation disappears", () => {
  const lines = [
    "void f(void) {",
    "    puts(\"work\");",
    "    free(buf); /* c-cleanup-scaffold */",
    "    char *other = malloc(8);",
    "    free(other); /* c-cleanup-scaffold */",
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

test("keeps different cleanup functions stable in the same function", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(32);",
    "    free(buf); /* c-cleanup-scaffold */",
    "    FILE *fp = fopen(path, \"r\");",
    "    fclose(fp); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, []);
});

test("same-shape fopen creations stay isolated when one moved scaffold is renamed", () => {
  const lines = [
    "void f(void) {",
    "    FILE *left = fopen(path1, \"r\");",
    "    FILE *right_file = fopen(path2, \"r\");",
    "    puts(\"between\");",
    "    fclose(left); /* c-cleanup-scaffold */",
    "    puts(\"later\");",
    "    fclose(tmp); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, [
    {
      kind: "replaceLine",
      lineNumber: 6,
      text: "    fclose(right_file); /* c-cleanup-scaffold */"
    }
  ]);
});

test("skips reused same-name allocations instead of guessing scaffold identity", () => {
  const lines = [
    "void f(void) {",
    "    char *buf = malloc(16);",
    "    buf = malloc(32);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  const plan = core.planScaffoldEdits(lines, {}, { kind: "function", lineNumber: 1 });
  assert.deepEqual(plan.edits, []);
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

test("manual scaffold edits are finalized automatically when a touched managed line changes", () => {
  const previousLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];
  const currentLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    cleanup_buf(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  assert.deepEqual(
    lifecycle.detectManualOwnershipLineNumbers(previousLines, currentLines, [2]),
    [2]
  );

  const edits = core.planFinalizeEdits(currentLines, { kind: "lines", lineNumbers: [2] });
  assert.deepEqual(edits, [
    {
      kind: "replaceLine",
      lineNumber: 2,
      text: "    cleanup_buf(buf);"
    }
  ]);
});

test("manual marker removal creates an opt-out that blocks future reinsertion", () => {
  const previousLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];
  const currentLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf);",
    "}"
  ];

  const creationKey = core.collectSourceCreations(currentLines)[0].creationKey;
  const optOuts = lifecycle.deriveManualOptOuts(previousLines, currentLines, new Set());
  assert.deepEqual([...optOuts], [creationKey]);
  assert.deepEqual(
    core.planScaffoldEdits(currentLines, {}, { kind: "function", lineNumber: 1 }, { manualOptOuts: [...optOuts] }).edits,
    []
  );
});

test("nearby line insertions above the allocation preserve creation-key opt-outs", () => {
  const baseLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf);",
    "}"
  ];
  const shiftedLines = [
    "void f(void) {",
    "    puts(\"prefix\");",
    "    char *buf = malloc(64);",
    "    free(buf);",
    "}"
  ];

  const optOuts = new Set([core.collectSourceCreations(baseLines)[0].creationKey]);
  const shiftedCreationKey = core.collectSourceCreations(shiftedLines)[0].creationKey;

  assert.equal(shiftedCreationKey, [...optOuts][0]);
  assert.deepEqual(
    core.planScaffoldEdits(shiftedLines, {}, { kind: "function", lineNumber: 1 }, { manualOptOuts: [...optOuts] }).edits,
    []
  );
});

test("long multi-step sequences keep same-shape sources stable", () => {
  const initialLines = [
    "void f(void) {",
    "    char *a = malloc(64);",
    "    char *b = malloc(64);",
    "}"
  ];

  const initialPlan = core.planScaffoldEdits(initialLines, {}, { kind: "function", lineNumber: 1 });
  const managedLines = core.applyLineEdits(initialLines, initialPlan.edits);
  const finalizedOnce = core.applyLineEdits(
    managedLines,
    core.planFinalizeEdits(managedLines, { kind: "lines", lineNumbers: [2] })
  );
  const optOuts = lifecycle.deriveManualOptOuts(managedLines, finalizedOnce, new Set());

  const renamedAndShifted = [
    "void f(void) {",
    "    puts(\"prefix\");",
    "    char *a = malloc(64);",
    "    free(a);",
    "    char *scratch = malloc(64);",
    "    puts(\"middle\");",
    "    free(b); /* c-cleanup-scaffold */",
    "}"
  ];

  const renamePlan = core.planScaffoldEdits(
    renamedAndShifted,
    {},
    { kind: "function", lineNumber: 1 },
    { manualOptOuts: [...optOuts] }
  );
  assert.deepEqual(renamePlan.edits, [
    {
      kind: "replaceLine",
      lineNumber: 6,
      text: "    free(scratch); /* c-cleanup-scaffold */"
    }
  ]);

  const afterRename = core.applyLineEdits(renamedAndShifted, renamePlan.edits);
  const afterDelete = [
    "void f(void) {",
    "    puts(\"prefix\");",
    "    char *a = malloc(64);",
    "    free(a);",
    "    puts(\"middle\");",
    "    free(scratch); /* c-cleanup-scaffold */",
    "}"
  ];

  const deletePlan = core.planScaffoldEdits(
    afterDelete,
    {},
    { kind: "function", lineNumber: 1 },
    { manualOptOuts: [...optOuts] }
  );
  assert.deepEqual(deletePlan.edits, [
    {
      kind: "deleteLine",
      lineNumber: 5
    }
  ]);
});

test("non-scaffold edits do not trigger manual finalization", () => {
  const previousLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];
  const currentLines = [
    "void f(void) {",
    "    char *data = malloc(64);",
    "    free(data); /* c-cleanup-scaffold */",
    "}"
  ];

  assert.deepEqual(
    lifecycle.detectManualOwnershipLineNumbers(previousLines, currentLines, [1]),
    []
  );
});

test("moving a managed scaffold line counts as taking ownership", () => {
  const previousLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];
  const currentLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    puts(\"before cleanup\");",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  assert.deepEqual(
    lifecycle.detectManualOwnershipLineNumbers(previousLines, currentLines, [2, 3]),
    []
  );
});

test("ambiguous moved-scaffold cases still finalize instead of guessing", () => {
  const previousLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}",
    "",
    "void g(void) {",
    "    char *buf = malloc(32);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];
  const currentLines = [
    "void f(void) {",
    "    char *buf = malloc(64);",
    "    free(buf); /* c-cleanup-scaffold */",
    "}",
    "",
    "void g(void) {",
    "    char *buf = malloc(32);",
    "    free(buf); /* c-cleanup-scaffold */",
    "    free(buf); /* c-cleanup-scaffold */",
    "}"
  ];

  assert.deepEqual(
    lifecycle.detectManualOwnershipLineNumbers(previousLines, currentLines, [7, 8]),
    [8]
  );
});
