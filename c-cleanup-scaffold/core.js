const SCAFFOLD_MARKER = "/* c-cleanup-scaffold */";

const DEFAULT_CLEANUP_MAP = Object.freeze({
  malloc: "free",
  calloc: "free",
  realloc: "free",
  strdup: "free",
  strndup: "free",
  fopen: "fclose",
  opendir: "closedir",
  socket: "close"
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

function planScaffoldEdits(rawLines, rawConfig = {}, scope = DEFAULT_SCOPE, runtimeState = {}) {
  const config = normalizeConfig(rawConfig);
  const sanitizedLines = sanitizeLines(rawLines);
  const functions = findFunctions(rawLines, sanitizedLines);
  const ownedReturnFunctions = collectOwnedReturnFunctions(
    rawLines,
    sanitizedLines,
    functions,
    config
  );
  const takesOwnershipFunctions = collectTakesOwnershipFunctions(rawLines, functions);
  const targetLines = resolveTargetLines(scope, rawLines.length, functions);
  const targetLineSet = new Set(targetLines);
  const managedScaffoldLines = collectManagedScaffoldLines(rawLines);
  const managedByFunction = groupManagedScaffoldsByFunction(managedScaffoldLines, functions);
  const manualOptOuts = new Set(runtimeState.manualOptOuts || []);
  const edits = [];

  for (const fn of resolveRelevantFunctions(scope, functions, targetLineSet)) {
    edits.push(
      ...planFunctionScaffoldEdits(
        rawLines,
        sanitizedLines,
        fn,
        config,
        ownedReturnFunctions,
        takesOwnershipFunctions,
        targetLineSet,
        scope,
        managedByFunction.get(fn.startLine) || [],
        manualOptOuts
      )
    );
  }

  return {
    edits: dedupeEdits(edits),
    functions,
    managedScaffoldLines,
    ownedReturnFunctions: new Set(ownedReturnFunctions.keys())
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
  const owned = new Map();

  for (const functionName of config.ownedReturnFunctions) {
    owned.set(functionName, {
      cleanupFunction: config.cleanupFunctionName,
      returnVar: null
    });
  }

  for (const fn of functions) {
    const explicitlyOwned = hasAnnotationAbove(rawLines, fn.startLine, "@returns_owned");
    if (!explicitlyOwned && !config.detectOwnedReturnFunctions) continue;

    const analysis = analyzeOwnedReturnFunction(fn, rawLines, sanitizedLines, config);
    if (!analysis) continue;

    owned.set(fn.name, analysis);
  }

  return owned;
}

function analyzeOwnedReturnFunction(fn, rawLines, sanitizedLines, config) {
  const createdVars = new Map();
  let returnVar = null;
  let sawReturn = false;

  for (let i = fn.bodyStartLine; i <= fn.endLine; i++) {
    const creation = parseOwnershipCreationLine(
      rawLines[i],
      sanitizedLines[i],
      config,
      new Map()
    );

    if (creation) {
      if (createdVars.has(creation.varName)) {
        return null;
      }

      createdVars.set(creation.varName, creation.cleanupFunction);
    }

    if (/^\s*return\b/.test(sanitizedLines[i])) {
      if (sawReturn) return null;
      sawReturn = true;

      const returnMatch = sanitizedLines[i].match(/^\s*return\s+([A-Za-z_]\w*)\s*;\s*$/);
      if (!returnMatch) return null;
      returnVar = returnMatch[1];
    }
  }

  if (!returnVar) return null;
  const cleanupFunction = createdVars.get(returnVar);

  if (!cleanupFunction) return null;

  return {
    cleanupFunction,
    returnVar
  };
}

function parseOwnershipCreationLine(rawLine, sanitizedLine, config, ownedReturnFunctions) {
  const trimmed = sanitizedLine.trim();
  if (!trimmed || !trimmed.endsWith(";")) return null;

  const assignment = matchAssignedCall(trimmed);
  if (!assignment) return null;

  const cleanupFunction = config.cleanupMap[assignment.callee]
    || (ownedReturnFunctions instanceof Map ? ownedReturnFunctions.get(assignment.callee)?.cleanupFunction : null)
    || (ownedReturnFunctions instanceof Set && ownedReturnFunctions.has(assignment.callee)
      ? config.cleanupFunctionName
      : null);

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
    const cleanup = parseManagedScaffoldLine(rawLines[i]);
    if (!cleanup) continue;
    if (cleanup.varName !== varName) continue;
    if (cleanup.cleanupFunction !== cleanupFunction) continue;

    return {
      line: i,
      markerPresent: true
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

function resolveRelevantFunctions(scope, functions, targetLineSet) {
  if (!scope || scope.kind === "document") {
    return functions.slice();
  }

  if ((scope.kind === "line" || scope.kind === "function") && Number.isInteger(scope.lineNumber)) {
    const fn = findContainingFunction(functions, scope.lineNumber);
    return fn ? [fn] : [];
  }

  if (scope.kind === "lines") {
    const relevant = new Map();

    for (const lineNumber of targetLineSet) {
      const fn = findContainingFunction(functions, lineNumber);
      if (!fn) continue;
      relevant.set(fn.startLine, fn);
    }

    return [...relevant.values()];
  }

  return [];
}

function planFunctionScaffoldEdits(
  rawLines,
  sanitizedLines,
  fn,
  config,
  ownedReturnFunctions,
  takesOwnershipFunctions,
  targetLineSet,
  scope,
  managedScaffolds,
  manualOptOuts
) {
  const edits = [];
  const desiredCreations = [];
  const ownedReturnInfo = ownedReturnFunctions.get(fn.name) || null;

  for (let i = fn.bodyStartLine; i <= fn.endLine; i++) {
    const creation = parseOwnershipCreationLine(
      rawLines[i],
      sanitizedLines[i],
      config,
      ownedReturnFunctions
    );

    if (!creation) continue;
    if (
      ownedReturnInfo
      && ownedReturnInfo.returnVar === creation.varName
      && ownedReturnInfo.cleanupFunction === creation.cleanupFunction
    ) {
      continue;
    }

    if (doesCreationTransferOwnership(fn, i, creation.varName, sanitizedLines, takesOwnershipFunctions)) {
      continue;
    }

    desiredCreations.push({
      ...creation,
      line: i,
      insertEligible: isInsertEligibleForScope(scope, targetLineSet, i),
      optOutKey: buildManagedOwnershipKey(fn.name, creation.varName, creation.cleanupFunction)
    });
  }

  const matchedDesired = new Set();
  const matchedManaged = new Set();

  for (let desiredIndex = 0; desiredIndex < desiredCreations.length; desiredIndex++) {
    const creation = desiredCreations[desiredIndex];
    const existingCleanup = findManagedCleanupBelow(
      managedScaffolds,
      creation.line,
      creation.varName,
      creation.cleanupFunction
    );

    if (!existingCleanup) continue;

    matchedDesired.add(desiredIndex);
    matchedManaged.add(existingCleanup.line);

    if (existingCleanup.line === creation.line + 1) {
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

  const renameCandidates = desiredCreations
    .map((creation, index) => ({ ...creation, index }))
    .filter(
      (creation) => !matchedDesired.has(creation.index)
        && creation.insertEligible
        && !manualOptOuts.has(creation.optOutKey)
    );
  const unmatchedManaged = managedScaffolds.filter((scaffold) => !matchedManaged.has(scaffold.line));
  const renameGroups = groupRenameCandidates(renameCandidates, unmatchedManaged);

  for (const group of renameGroups) {
    if (!group.scaffold || !group.creation) continue;
    if (group.scaffold.line <= group.creation.line) continue;

    edits.push({
      kind: "replaceLine",
      lineNumber: group.scaffold.line,
      text: formatScaffoldLine(
        group.scaffold.indent,
        group.creation.varName,
        group.creation.cleanupFunction
      )
    });
    matchedDesired.add(group.creation.index);
    matchedManaged.add(group.scaffold.line);
  }

  for (let desiredIndex = 0; desiredIndex < desiredCreations.length; desiredIndex++) {
    const creation = desiredCreations[desiredIndex];
    if (matchedDesired.has(desiredIndex)) continue;
    if (!creation.insertEligible) continue;
    if (manualOptOuts.has(creation.optOutKey)) continue;

    edits.push({
      kind: "insert",
      afterLine: creation.line,
      text: formatScaffoldLine(creation.indent, creation.varName, creation.cleanupFunction)
    });
  }

  for (const scaffold of managedScaffolds) {
    if (matchedManaged.has(scaffold.line)) continue;

    edits.push({
      kind: "deleteLine",
      lineNumber: scaffold.line
    });
  }

  return edits;
}

function groupRenameCandidates(desiredCreations, unmatchedManaged) {
  const allCleanupFunctions = new Set([
    ...desiredCreations.map((creation) => creation.cleanupFunction),
    ...unmatchedManaged.map((scaffold) => scaffold.cleanupFunction)
  ]);
  const groups = [];

  for (const cleanupFunction of allCleanupFunctions) {
    const desiredGroup = desiredCreations.filter((creation) => creation.cleanupFunction === cleanupFunction);
    const managedGroup = unmatchedManaged.filter((scaffold) => scaffold.cleanupFunction === cleanupFunction);

    if (desiredGroup.length !== 1 || managedGroup.length !== 1) continue;

    groups.push({
      creation: desiredGroup[0],
      scaffold: managedGroup[0]
    });
  }

  return groups;
}

function isInsertEligibleForScope(scope, targetLineSet, lineNumber) {
  if (!scope || scope.kind === "document" || scope.kind === "function") {
    return true;
  }

  return targetLineSet.has(lineNumber);
}

function collectTakesOwnershipFunctions(rawLines, functions) {
  const takingOwnership = new Set();

  for (const fn of functions) {
    if (!hasAnnotationAbove(rawLines, fn.startLine, "@takes_ownership")) continue;
    takingOwnership.add(fn.name);
  }

  return takingOwnership;
}

function doesCreationTransferOwnership(fn, creationLine, varName, sanitizedLines, takesOwnershipFunctions) {
  if (!takesOwnershipFunctions.size) return false;

  const varPattern = new RegExp(`\\b${escapeRegExp(varName)}\\b`);

  for (let i = creationLine + 1; i <= fn.endLine; i++) {
    const trimmed = sanitizedLines[i].trim();
    if (!trimmed || !trimmed.endsWith(";")) continue;

    const callMatch = trimmed.match(
      /^(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_]\w*)\s*\((.*)\)\s*;\s*$/
    );
    if (!callMatch) continue;
    if (!takesOwnershipFunctions.has(callMatch[1])) continue;
    if (!varPattern.test(callMatch[2])) continue;

    return true;
  }

  return false;
}

function groupManagedScaffoldsByFunction(managedScaffolds, functions) {
  const grouped = new Map();

  for (const scaffold of managedScaffolds) {
    const fn = findContainingFunction(functions, scaffold.line);
    if (!fn) continue;

    if (!grouped.has(fn.startLine)) {
      grouped.set(fn.startLine, []);
    }

    grouped.get(fn.startLine).push(scaffold);
  }

  return grouped;
}

function findManagedCleanupBelow(managedScaffolds, startLine, varName, cleanupFunction) {
  for (const scaffold of managedScaffolds) {
    if (scaffold.line <= startLine) continue;
    if (scaffold.varName !== varName) continue;
    if (scaffold.cleanupFunction !== cleanupFunction) continue;

    return scaffold;
  }

  return null;
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

function buildManagedOwnershipKey(functionName, varName, cleanupFunction) {
  return `${functionName || "<global>"}:${cleanupFunction}:${varName}`;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  SCAFFOLD_MARKER,
  applyLineEdits,
  buildManagedOwnershipKey,
  collectManagedScaffoldLines,
  findFunctions,
  formatCleanupLine,
  formatScaffoldLine,
  normalizeConfig,
  parseCleanupCallLine,
  parseManagedScaffoldLine,
  parseOwnershipCreationLine,
  planFinalizeEdits,
  planScaffoldEdits,
  sanitizeLines
};
