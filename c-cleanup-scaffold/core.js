const SCAFFOLD_MARKER = "/* c-cleanup-scaffold */";

const DEFAULT_CLEANUP_MAP = Object.freeze({
  malloc: "free",
  calloc: "free",
  realloc: "free",
  strdup: "free",
  strndup: "free"
});

const DEFAULT_SCOPE = Object.freeze({ kind: "document" });

function normalizeConfig(rawConfig = {}) {
  const cleanupFunctionName = typeof rawConfig.cleanupFunctionName === "string" && rawConfig.cleanupFunctionName.trim()
    ? rawConfig.cleanupFunctionName.trim()
    : "free";

  const cleanupMap = { ...DEFAULT_CLEANUP_MAP };

  if (rawConfig.cleanupMap && typeof rawConfig.cleanupMap === "object") {
    for (const [allocator, cleanup] of Object.entries(rawConfig.cleanupMap)) {
      if (!allocator || typeof cleanup !== "string" || !cleanup.trim()) continue;
      cleanupMap[String(allocator).trim()] = cleanup.trim();
    }
  }

  for (const allocator of toStringArray(rawConfig.allocatorFunctions)) {
    if (!cleanupMap[allocator]) {
      cleanupMap[allocator] = cleanupFunctionName;
    }
  }

  return {
    enabled: rawConfig.enabled !== false,
    detectOwnedReturnFunctions: rawConfig.detectOwnedReturnFunctions !== false,
    cleanupFunctionName,
    cleanupMap,
    allocatorFunctions: Object.keys(cleanupMap),
    ownedReturnFunctions: toStringArray(rawConfig.ownedReturnFunctions)
  };
}

function planScaffoldEdits(rawLines, rawConfig = {}, scope = DEFAULT_SCOPE) {
  const config = normalizeConfig(rawConfig);
  const sanitizedLines = sanitizeLines(rawLines);
  const functions = findFunctions(rawLines, sanitizedLines);
  const ownedReturnFunctions = collectOwnedReturnFunctions(
    rawLines,
    sanitizedLines,
    functions,
    config
  );
  const targetLines = resolveTargetLines(scope, rawLines.length, functions);
  const edits = [];

  for (const lineNumber of targetLines) {
    const creation = parseOwnershipCreationLine(
      rawLines[lineNumber],
      sanitizedLines[lineNumber],
      config,
      ownedReturnFunctions
    );

    if (!creation) continue;

    const containingFunction = findContainingFunction(functions, lineNumber);
    const maxLine = containingFunction ? containingFunction.endLine : rawLines.length - 1;
    const existingCleanup = findCleanupBelow(
      rawLines,
      lineNumber,
      creation.varName,
      creation.cleanupFunction,
      maxLine
    );

    if (!existingCleanup) {
      edits.push({
        kind: "insert",
        afterLine: lineNumber,
        text: formatScaffoldLine(creation.indent, creation.varName, creation.cleanupFunction)
      });
      continue;
    }

    if (existingCleanup.markerPresent && existingCleanup.line === lineNumber + 1) {
      edits.push(
        ...findDuplicateManagedCleanupEdits(
          rawLines,
          existingCleanup.line,
          creation.varName,
          creation.cleanupFunction
        )
      );
    }
  }

  return {
    edits: dedupeEdits(edits),
    functions,
    managedScaffoldLines: collectManagedScaffoldLines(rawLines),
    ownedReturnFunctions
  };
}

function planFinalizeEdits(rawLines, scope = DEFAULT_SCOPE) {
  const sanitizedLines = sanitizeLines(rawLines);
  const functions = findFunctions(rawLines, sanitizedLines);
  const targetLines = resolveTargetLines(scope, rawLines.length, functions);
  const edits = [];

  for (const lineNumber of targetLines) {
    const scaffold = parseManagedScaffoldLine(rawLines[lineNumber]);
    if (!scaffold) continue;

    edits.push({
      kind: "replaceLine",
      lineNumber,
      text: formatCleanupLine(scaffold.indent, scaffold.varName, scaffold.cleanupFunction)
    });
  }

  return dedupeEdits(edits);
}

function collectManagedScaffoldLines(rawLines) {
  const scaffolds = [];

  for (let i = 0; i < rawLines.length; i++) {
    const scaffold = parseManagedScaffoldLine(rawLines[i]);
    if (!scaffold) continue;
    scaffolds.push({ line: i, ...scaffold });
  }

  return scaffolds;
}

function applyLineEdits(rawLines, edits) {
  const nextLines = rawLines.slice();

  for (const edit of sortEditsDescending(edits)) {
    if (edit.kind === "insert") {
      nextLines.splice(edit.afterLine + 1, 0, edit.text);
    } else if (edit.kind === "deleteLine") {
      nextLines.splice(edit.lineNumber, 1);
    } else if (edit.kind === "replaceLine") {
      nextLines.splice(edit.lineNumber, 1, edit.text);
    }
  }

  return nextLines;
}

function collectOwnedReturnFunctions(rawLines, sanitizedLines, functions, config) {
  const owned = new Set(config.ownedReturnFunctions);

  for (const fn of functions) {
    if (hasAnnotationAbove(rawLines, fn.startLine, "@returns_owned")) {
      owned.add(fn.name);
      continue;
    }

    if (!config.detectOwnedReturnFunctions) continue;
    if (looksLikeOwnedReturnFactory(fn, rawLines, sanitizedLines, config)) {
      owned.add(fn.name);
    }
  }

  return owned;
}

function looksLikeOwnedReturnFactory(fn, rawLines, sanitizedLines, config) {
  const allocatedVars = new Set();
  const returnVars = [];

  for (let i = fn.bodyStartLine; i <= fn.endLine; i++) {
    const creation = parseOwnershipCreationLine(
      rawLines[i],
      sanitizedLines[i],
      config,
      new Set()
    );

    if (creation && creation.cleanupFunction === config.cleanupFunctionName) {
      allocatedVars.add(creation.varName);
    }

    const returnMatch = sanitizedLines[i].match(/^\s*return\s+([A-Za-z_]\w*)\s*;\s*$/);
    if (returnMatch) {
      returnVars.push(returnMatch[1]);
      continue;
    }

    if (/^\s*return\b/.test(sanitizedLines[i])) {
      returnVars.push(null);
    }
  }

  if (returnVars.length !== 1) return false;
  if (!returnVars[0]) return false;
  return allocatedVars.has(returnVars[0]);
}

function parseOwnershipCreationLine(rawLine, sanitizedLine, config, ownedReturnFunctions) {
  const trimmed = sanitizedLine.trim();
  if (!trimmed || !trimmed.endsWith(";")) return null;

  const assignment = matchAssignedCall(trimmed);
  if (!assignment) return null;

  const cleanupFunction = config.cleanupMap[assignment.callee]
    || (ownedReturnFunctions.has(assignment.callee) ? config.cleanupFunctionName : null);

  if (!cleanupFunction) return null;

  return {
    varName: assignment.varName,
    cleanupFunction,
    callee: assignment.callee,
    indent: rawLine.match(/^\s*/)?.[0] ?? ""
  };
}

function matchAssignedCall(trimmedLine) {
  const typedPattern = /^(?:[A-Za-z_]\w*(?:\s+|\s*\*+\s*))+?([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/;
  const plainPattern = /^([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/;
  const match = trimmedLine.match(typedPattern) || trimmedLine.match(plainPattern);

  if (!match) return null;

  return {
    varName: match[1],
    callee: match[2]
  };
}

function parseCleanupCallLine(rawLine) {
  const match = rawLine.match(
    /^\s*([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*\)\s*;\s*(\/\*\s*c-cleanup-scaffold\s*\*\/)?\s*$/
  );

  if (!match) return null;

  return {
    cleanupFunction: match[1],
    varName: match[2],
    markerPresent: Boolean(match[3])
  };
}

function parseManagedScaffoldLine(rawLine) {
  const parsed = parseCleanupCallLine(rawLine);
  if (!parsed || !parsed.markerPresent) return null;

  return {
    cleanupFunction: parsed.cleanupFunction,
    varName: parsed.varName,
    indent: rawLine.match(/^\s*/)?.[0] ?? ""
  };
}

function findCleanupBelow(rawLines, startLine, varName, cleanupFunction, maxLine) {
  for (let i = startLine + 1; i <= maxLine && i < rawLines.length; i++) {
    const cleanup = parseCleanupCallLine(rawLines[i]);
    if (!cleanup) continue;
    if (cleanup.varName !== varName) continue;
    if (cleanup.cleanupFunction !== cleanupFunction) continue;

    return {
      line: i,
      markerPresent: cleanup.markerPresent
    };
  }

  return null;
}

function findDuplicateManagedCleanupEdits(rawLines, firstCleanupLine, varName, cleanupFunction) {
  const edits = [];

  for (let i = firstCleanupLine + 1; i < rawLines.length; i++) {
    const cleanup = parseManagedScaffoldLine(rawLines[i]);
    if (!cleanup) break;
    if (cleanup.varName !== varName || cleanup.cleanupFunction !== cleanupFunction) break;

    edits.push({
      kind: "deleteLine",
      lineNumber: i
    });
  }

  return edits;
}

function resolveTargetLines(scope, lineCount, functions) {
  if (!lineCount) return [];

  if (!scope || scope.kind === "document") {
    return Array.from({ length: lineCount }, (_, index) => index);
  }

  if (scope.kind === "lines" && Array.isArray(scope.lineNumbers)) {
    return [...new Set(scope.lineNumbers.filter((line) => line >= 0 && line < lineCount))].sort((a, b) => a - b);
  }

  if ((scope.kind === "line" || scope.kind === "function") && Number.isInteger(scope.lineNumber)) {
    if (scope.kind === "line") {
      return scope.lineNumber >= 0 && scope.lineNumber < lineCount
        ? [scope.lineNumber]
        : [];
    }

    const fn = findContainingFunction(functions, scope.lineNumber);
    if (!fn) return [];

    return Array.from(
      { length: fn.endLine - fn.startLine + 1 },
      (_, index) => fn.startLine + index
    );
  }

  return [];
}

function findFunctions(rawLines, sanitizedLines) {
  const functions = [];
  let current = null;
  let braceDepth = 0;
  let pendingHeader = null;

  for (let i = 0; i < sanitizedLines.length; i++) {
    const rawLine = rawLines[i];
    const sanitizedLine = sanitizedLines[i];
    const trimmed = sanitizedLine.trim();

    if (current) {
      braceDepth += countChar(sanitizedLine, "{");
      braceDepth -= countChar(sanitizedLine, "}");

      if (braceDepth <= 0) {
        current.endLine = i;
        functions.push(current);
        current = null;
        braceDepth = 0;
      }

      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!pendingHeader) {
      if (!looksLikeFunctionHeaderStart(trimmed)) continue;

      pendingHeader = {
        startLine: i,
        parts: [trimmed],
        parenDepth: countChar(sanitizedLine, "(") - countChar(sanitizedLine, ")")
      };
    } else {
      pendingHeader.parts.push(trimmed);
      pendingHeader.parenDepth += countChar(sanitizedLine, "(") - countChar(sanitizedLine, ")");
    }

    if (trimmed.endsWith(";") && !trimmed.includes("{")) {
      pendingHeader = null;
      continue;
    }

    if (!trimmed.includes("{") || pendingHeader.parenDepth > 0) {
      if (pendingHeader.parts.length > 12) {
        pendingHeader = null;
      }
      continue;
    }

    const headerText = pendingHeader.parts.join(" ").replace(/\s+/g, " ").trim();
    const name = extractFunctionName(headerText);

    if (!name) {
      pendingHeader = null;
      continue;
    }

    current = {
      name,
      startLine: pendingHeader.startLine,
      bodyStartLine: i,
      endLine: i
    };

    braceDepth = countChar(sanitizedLine, "{") - countChar(sanitizedLine, "}");
    pendingHeader = null;

    if (braceDepth <= 0) {
      functions.push(current);
      current = null;
      braceDepth = 0;
    }
  }

  return functions;
}

function looksLikeFunctionHeaderStart(trimmedLine) {
  if (!trimmedLine.includes("(")) return false;
  if (/^(if|for|while|switch|return|sizeof)\b/.test(trimmedLine)) return false;
  if (/^(typedef|struct|enum|union)\b/.test(trimmedLine)) return false;
  return true;
}

function extractFunctionName(headerText) {
  const match = headerText.match(/([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|$)/);
  if (!match) return null;

  const name = match[1];
  if (["if", "for", "while", "switch"].includes(name)) return null;
  return name;
}

function hasAnnotationAbove(rawLines, startLine, annotation) {
  for (let i = startLine - 1; i >= 0 && i >= startLine - 5; i--) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;
    if (trimmed.includes(annotation)) {
      return true;
    }
    if (
      trimmed.startsWith("//")
      || trimmed.startsWith("/*")
      || trimmed.startsWith("*")
      || /^[A-Za-z_]\w*(?:\s+|\s*\*+\s*)*$/.test(trimmed)
      || /^const\b/.test(trimmed)
      || /^static\b/.test(trimmed)
      || /^inline\b/.test(trimmed)
    ) {
      continue;
    }
    if (/[;{}]$/.test(trimmed)) {
      break;
    }
  }

  return false;
}

function sanitizeLines(rawLines) {
  const sanitizedLines = [];
  let inBlockComment = false;

  for (const rawLine of rawLines) {
    let nextLine = "";
    let inString = false;
    let inChar = false;
    let escaping = false;

    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      const next = rawLine[i + 1];

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          nextLine += "  ";
          i++;
          inBlockComment = false;
        } else {
          nextLine += " ";
        }
        continue;
      }

      if (inString) {
        nextLine += " ";
        if (escaping) {
          escaping = false;
        } else if (ch === "\\") {
          escaping = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (inChar) {
        nextLine += " ";
        if (escaping) {
          escaping = false;
        } else if (ch === "\\") {
          escaping = true;
        } else if (ch === "'") {
          inChar = false;
        }
        continue;
      }

      if (ch === "/" && next === "*") {
        nextLine += "  ";
        i++;
        inBlockComment = true;
        continue;
      }

      if (ch === "/" && next === "/") {
        nextLine += " ".repeat(rawLine.length - i);
        break;
      }

      if (ch === "\"") {
        nextLine += " ";
        inString = true;
        continue;
      }

      if (ch === "'") {
        nextLine += " ";
        inChar = true;
        continue;
      }

      nextLine += ch;
    }

    sanitizedLines.push(nextLine);
  }

  return sanitizedLines;
}

function findContainingFunction(functions, lineNumber) {
  return functions.find((fn) => lineNumber >= fn.startLine && lineNumber <= fn.endLine) || null;
}

function formatScaffoldLine(indent, varName, cleanupFunction) {
  return `${formatCleanupLine(indent, varName, cleanupFunction)} ${SCAFFOLD_MARKER}`;
}

function formatCleanupLine(indent, varName, cleanupFunction) {
  return `${indent}${cleanupFunction}(${varName});`;
}

function dedupeEdits(edits) {
  const seen = new Set();
  const result = [];

  for (const edit of edits) {
    let key = edit.kind;

    if (edit.kind === "insert") {
      key += `:${edit.afterLine}:${edit.text}`;
    } else if (edit.kind === "deleteLine") {
      key += `:${edit.lineNumber}`;
    } else if (edit.kind === "replaceLine") {
      key += `:${edit.lineNumber}:${edit.text}`;
    }

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edit);
  }

  return result;
}

function sortEditsDescending(edits) {
  return edits.slice().sort((a, b) => {
    const aLine = editLineNumber(a);
    const bLine = editLineNumber(b);
    if (aLine !== bLine) return bLine - aLine;

    const order = { deleteLine: 0, replaceLine: 1, insert: 2 };
    return order[a.kind] - order[b.kind];
  });
}

function editLineNumber(edit) {
  if (edit.kind === "insert") return edit.afterLine + 1;
  return edit.lineNumber;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function countChar(text, char) {
  let count = 0;

  for (const current of text) {
    if (current === char) count++;
  }

  return count;
}

module.exports = {
  SCAFFOLD_MARKER,
  applyLineEdits,
  collectManagedScaffoldLines,
  findFunctions,
  formatCleanupLine,
  formatScaffoldLine,
  normalizeConfig,
  parseManagedScaffoldLine,
  parseOwnershipCreationLine,
  planFinalizeEdits,
  planScaffoldEdits,
  sanitizeLines
};
