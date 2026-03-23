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

function collectSourceCreations(rawLines, rawConfig = {}) {
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
  const creations = [];

  for (const fn of functions) {
    const statements = collectRelevantStatements(fn, rawLines, sanitizedLines);
    const blockHints = buildFunctionBlockHints(fn, sanitizedLines);
    const creationPlan = collectDesiredCreations(
      fn,
      statements,
      blockHints,
      config,
      ownedReturnFunctions,
      takesOwnershipFunctions,
      { kind: "document" },
      new Set(Array.from({ length: rawLines.length }, (_, index) => index))
    );

    for (const creation of creationPlan.desiredCreations) {
      creations.push({ ...creation, functionName: fn.name, functionStartLine: fn.startLine });
    }
  }

  return creations;
}

function collectBlockHints(rawLines) {
  const sanitizedLines = sanitizeLines(rawLines);
  const functions = findFunctions(rawLines, sanitizedLines);
  const blockHints = new Map();

  for (const fn of functions) {
    const functionHints = buildFunctionBlockHints(fn, sanitizedLines);
    for (const [lineNumber, blockKey] of functionHints.entries()) {
      blockHints.set(lineNumber, blockKey);
    }
  }

  return blockHints;
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
  const statements = collectRelevantStatements(fn, rawLines, sanitizedLines);

  for (const statement of statements) {
    const creation = parseOwnershipCreationStatement(
      statement,
      config,
      new Map()
    );

    if (creation) {
      if (createdVars.has(creation.varName)) {
        return null;
      }

      createdVars.set(creation.varName, creation.cleanupFunction);
    }

    const trimmed = compactSanitizedText(statement.sanitizedText);
    if (/^\s*return\b/.test(trimmed)) {
      if (sawReturn) return null;
      sawReturn = true;

      const returnMatch = trimmed.match(/^\s*return\s+([A-Za-z_]\w*)\s*;\s*$/);
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
    callSignature: assignment.callSignature,
    indent: rawLine.match(/^\s*/)?.[0] ?? ""
  };
}

function parseOwnershipCreationStatement(statement, config, ownedReturnFunctions) {
  const trimmed = compactSanitizedText(statement.sanitizedText);
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
    callSignature: assignment.callSignature,
    indent: rawLinesIndent(statement.rawText)
  };
}

function matchAssignedCall(trimmedLine) {
  const typedPattern = /^(?:[A-Za-z_]\w*(?:\s+|\s*\*+\s*))+?([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/;
  const plainPattern = /^([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/;
  const match = trimmedLine.match(typedPattern) || trimmedLine.match(plainPattern);

  if (!match) return null;

  const callSignature = extractAssignedCallSignature(trimmedLine);
  if (!callSignature) return null;

  return {
    varName: match[1],
    callee: match[2],
    callSignature
  };
}

function extractAssignedCallSignature(trimmedLine) {
  const equalIndex = trimmedLine.indexOf("=");
  if (equalIndex < 0) return null;

  let rhs = trimmedLine.slice(equalIndex + 1).trim();
  rhs = stripLeadingCast(rhs);

  const calleeMatch = rhs.match(/^([A-Za-z_]\w*)\s*\(/);
  if (!calleeMatch) return null;

  const callee = calleeMatch[1];
  const openParenIndex = rhs.indexOf("(", callee.length - 1);
  if (openParenIndex < 0) return null;

  let depth = 0;
  for (let index = openParenIndex; index < rhs.length; index++) {
    const ch = rhs[index];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;

    if (depth === 0) {
      return compactSanitizedText(rhs.slice(0, index + 1));
    }
  }

  return null;
}

function stripLeadingCast(value) {
  let nextValue = value.trim();

  while (nextValue.startsWith("(")) {
    const castMatch = nextValue.match(/^\(\s*([^()]+)\s*\)\s*(.+)$/);
    if (!castMatch || !looksLikeCastType(castMatch[1])) break;
    nextValue = castMatch[2].trim();
  }

  return nextValue;
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
  const statements = collectRelevantStatements(fn, rawLines, sanitizedLines);
  const blockHints = buildFunctionBlockHints(fn, sanitizedLines);
  const creationPlan = collectDesiredCreations(
    fn,
    statements,
    blockHints,
    config,
    ownedReturnFunctions,
    takesOwnershipFunctions,
    scope,
    targetLineSet
  );
  const desiredCreations = creationPlan.desiredCreations;
  const exactMatches = matchExactManagedScaffolds(rawLines, desiredCreations, managedScaffolds);
  const matchedDesired = new Set(exactMatches.matchedDesired);
  const matchedManaged = new Set(exactMatches.matchedManaged);
  const frozenDesired = new Set(exactMatches.frozenDesired || []);
  const frozenManaged = new Set(exactMatches.frozenManaged || []);
  const repeatedIdentityFreeze = findRepeatedCreationIdentityFreeze(desiredCreations, managedScaffolds);

  for (const index of repeatedIdentityFreeze.frozenDesired) frozenDesired.add(index);
  for (const line of repeatedIdentityFreeze.frozenManaged) frozenManaged.add(line);

  edits.push(...exactMatches.duplicateEdits);
  edits.push(
    ...matchTransferredManagedScaffolds(
      creationPlan.transferredCreations,
      managedScaffolds,
      matchedManaged
    )
  );

  const renamePlan = planSegmentRenameMatches(
    desiredCreations,
    managedScaffolds,
    matchedDesired,
    matchedManaged,
    manualOptOuts
  );

  for (const pair of renamePlan.pairs) {
    edits.push({
      kind: "replaceLine",
      lineNumber: pair.scaffold.line,
      text: formatScaffoldLine(
        pair.scaffold.indent,
        pair.creation.varName,
        pair.creation.cleanupFunction
      )
    });
    matchedDesired.add(pair.creation.index);
    matchedManaged.add(pair.scaffold.line);
  }

  for (const index of renamePlan.frozenDesired) frozenDesired.add(index);
  for (const line of renamePlan.frozenManaged) frozenManaged.add(line);

  for (let desiredIndex = 0; desiredIndex < desiredCreations.length; desiredIndex++) {
    const creation = desiredCreations[desiredIndex];
    if (matchedDesired.has(desiredIndex) || frozenDesired.has(desiredIndex)) continue;
    if (!creation.insertEligible) continue;
    if (manualOptOuts.has(creation.optOutKey)) continue;

    edits.push({
      kind: "insert",
      afterLine: creation.endLine,
      text: formatScaffoldLine(creation.indent, creation.varName, creation.cleanupFunction)
    });
  }

  for (const scaffold of managedScaffolds) {
    if (matchedManaged.has(scaffold.line) || frozenManaged.has(scaffold.line)) continue;
    if (!isConfidentOrphanScaffold(fn, scaffold, statements)) continue;

    edits.push({
      kind: "deleteLine",
      lineNumber: scaffold.line
    });
  }

  return edits;
}

function findRepeatedCreationIdentityFreeze(desiredCreations, managedScaffolds) {
  const indicesByIdentity = new Map();

  for (let index = 0; index < desiredCreations.length; index++) {
    const creation = desiredCreations[index];
    const identity = `${creation.cleanupFunction}:${creation.varName}:${creation.blockKey || "root"}`;
    if (!indicesByIdentity.has(identity)) {
      indicesByIdentity.set(identity, []);
    }
    indicesByIdentity.get(identity).push(index);
  }

  const frozenDesired = new Set();
  const frozenManaged = new Set();

  for (const [identity, indices] of indicesByIdentity.entries()) {
    if (indices.length < 2) continue;

    for (const index of indices) frozenDesired.add(index);

    const [cleanupFunction, varName] = identity.split(":");
    for (const scaffold of managedScaffolds) {
      if (scaffold.cleanupFunction === cleanupFunction && scaffold.varName === varName) {
        frozenManaged.add(scaffold.line);
      }
    }
  }

  return {
    frozenDesired,
    frozenManaged
  };
}

function isStatementEligibleForScope(scope, targetLineSet, startLine, endLine) {
  if (!scope || scope.kind === "document" || scope.kind === "function") {
    return true;
  }

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    if (targetLineSet.has(lineNumber)) {
      return true;
    }
  }

  return false;
}

function collectTakesOwnershipFunctions(rawLines, functions) {
  const takingOwnership = new Set();

  for (const fn of functions) {
    if (!hasAnnotationAbove(rawLines, fn.startLine, "@takes_ownership")) continue;
    takingOwnership.add(fn.name);
  }

  return takingOwnership;
}

function doesCreationTransferOwnership(creation, statements, takesOwnershipFunctions) {
  if (!takesOwnershipFunctions.size) return false;

  for (const statement of statements) {
    if (statement.startLine <= creation.endLine) continue;

    const call = parseCallStatement(statement.sanitizedText);
    if (!call) continue;
    if (!takesOwnershipFunctions.has(call.callee)) continue;

    const argumentsList = splitTopLevelArguments(call.argsText);
    if (!argumentsList.some((argument) => isDirectVariableArgument(argument, creation.varName))) {
      continue;
    }

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

function collectRelevantStatements(fn, rawLines, sanitizedLines) {
  const statements = [];
  let current = null;

  for (let lineNumber = fn.bodyStartLine; lineNumber <= fn.endLine; lineNumber++) {
    const lineParts = getFunctionStatementLineParts(
      fn,
      lineNumber,
      rawLines[lineNumber],
      sanitizedLines[lineNumber]
    );
    const rawLine = lineParts.rawLine;
    const sanitizedLine = lineParts.sanitizedLine;
    const trimmed = sanitizedLine.trim();

    if (!current) {
      if (!looksLikeRelevantStatementStart(trimmed)) continue;

      current = {
        startLine: lineNumber,
        endLine: lineNumber,
        rawParts: [rawLine],
        sanitizedParts: [sanitizedLine],
        parenDepth: countChar(sanitizedLine, "(") - countChar(sanitizedLine, ")")
      };
    } else {
      current.endLine = lineNumber;
      current.rawParts.push(rawLine);
      current.sanitizedParts.push(sanitizedLine);
      current.parenDepth += countChar(sanitizedLine, "(") - countChar(sanitizedLine, ")");
    }

    if (current.parenDepth <= 0 && trimmed.includes(";")) {
      statements.push({
        startLine: current.startLine,
        endLine: current.endLine,
        rawText: current.rawParts.join("\n"),
        sanitizedText: current.sanitizedParts.join(" ")
      });
      current = null;
      continue;
    }

    if (current.rawParts.length > 8) {
      current = null;
    }
  }

  return statements;
}

function getFunctionStatementLineParts(fn, lineNumber, rawLine, sanitizedLine) {
  let nextRawLine = rawLine;
  let nextSanitizedLine = sanitizedLine;

  if (lineNumber === fn.bodyStartLine) {
    const openBraceIndex = nextSanitizedLine.indexOf("{");
    if (openBraceIndex >= 0) {
      nextRawLine = nextRawLine.slice(openBraceIndex + 1);
      nextSanitizedLine = nextSanitizedLine.slice(openBraceIndex + 1);
    }
  }

  if (lineNumber === fn.endLine) {
    const closeBraceIndex = nextSanitizedLine.lastIndexOf("}");
    if (closeBraceIndex >= 0) {
      nextRawLine = nextRawLine.slice(0, closeBraceIndex);
      nextSanitizedLine = nextSanitizedLine.slice(0, closeBraceIndex);
    }
  }

  return {
    rawLine: nextRawLine,
    sanitizedLine: nextSanitizedLine
  };
}

function buildFunctionBlockHints(fn, sanitizedLines) {
  const hints = new Map();
  const blockPath = [];
  const childCounters = [0];

  for (let lineNumber = fn.bodyStartLine; lineNumber <= fn.endLine; lineNumber++) {
    hints.set(lineNumber, blockPath.length ? blockPath.join(".") : "root");

    const { sanitizedLine } = getFunctionStatementLineParts(
      fn,
      lineNumber,
      "",
      sanitizedLines[lineNumber]
    );

    for (const ch of sanitizedLine) {
      if (ch === "{") {
        const nextChild = (childCounters[childCounters.length - 1] || 0) + 1;
        childCounters[childCounters.length - 1] = nextChild;
        blockPath.push(nextChild);
        childCounters.push(0);
      } else if (ch === "}" && blockPath.length) {
        blockPath.pop();
        childCounters.pop();
      }
    }
  }

  return hints;
}

function looksLikeRelevantStatementStart(trimmedLine) {
  if (!trimmedLine) return false;
  if (/^(if|for|while|switch|else|do|case|default)\b/.test(trimmedLine)) return false;
  return trimmedLine.includes("=") || trimmedLine.includes("(") || /^\s*return\b/.test(trimmedLine);
}

function collectDesiredCreations(
  fn,
  statements,
  blockHints,
  config,
  ownedReturnFunctions,
  takesOwnershipFunctions,
  scope,
  targetLineSet
) {
  const desiredCreations = [];
  const transferredCreations = [];
  const ownedReturnInfo = ownedReturnFunctions.get(fn.name) || null;
  const occurrenceCounts = new Map();

  for (const statement of statements) {
    const creation = parseOwnershipCreationStatement(statement, config, ownedReturnFunctions);
    if (!creation) continue;

    if (
      ownedReturnInfo
      && ownedReturnInfo.returnVar === creation.varName
      && ownedReturnInfo.cleanupFunction === creation.cleanupFunction
    ) {
      transferredCreations.push({
        ...creation,
        line: statement.startLine,
        endLine: statement.endLine
      });
      continue;
    }

    const desiredCreation = {
      ...creation,
      line: statement.startLine,
      endLine: statement.endLine,
      blockKey: blockHints.get(statement.startLine) || "root",
      creationKey: buildCreationKey(
        fn,
        {
          ...creation,
          blockKey: blockHints.get(statement.startLine) || "root"
        },
        occurrenceCounts
      ),
      insertEligible: isStatementEligibleForScope(
        scope,
        targetLineSet,
        statement.startLine,
        statement.endLine
      ),
      optOutKey: null
    };
    desiredCreation.optOutKey = desiredCreation.creationKey;

    if (doesCreationTransferOwnership(desiredCreation, statements, takesOwnershipFunctions)) {
      transferredCreations.push(desiredCreation);
      continue;
    }

    desiredCreations.push(desiredCreation);
  }

  return {
    desiredCreations,
    transferredCreations
  };
}

function matchExactManagedScaffolds(rawLines, desiredCreations, managedScaffolds) {
  const desiredGroups = groupByCleanupFunction(
    desiredCreations.map((creation, index) => ({ ...creation, index }))
  );
  const managedGroups = groupByCleanupFunction(managedScaffolds);
  const matchedDesired = new Set();
  const matchedManaged = new Set();
  const duplicateEdits = [];
  const frozenDesired = new Set();
  const frozenManaged = new Set();

  for (const [cleanupFunction, desiredGroup] of desiredGroups.entries()) {
    const managedGroup = managedGroups.get(cleanupFunction) || [];
    if (!managedGroup.length) continue;

    const usedManaged = new Set();

    for (let index = 0; index < desiredGroup.length; index++) {
      const creation = desiredGroup[index];
      const previousCreationLine = desiredGroup[index - 1]?.line ?? -1;
      const nextCreationLine = desiredGroup[index + 1]?.line ?? Number.POSITIVE_INFINITY;
      const candidate = findSegmentExactCandidate(
        creation,
        previousCreationLine,
        nextCreationLine,
        managedGroup,
        usedManaged
      );

      if (candidate.kind === "pair") {
        usedManaged.add(candidate.scaffold.line);
        matchedDesired.add(candidate.creation.index);
        matchedManaged.add(candidate.scaffold.line);

        if (candidate.scaffold.line === candidate.creation.endLine + 1) {
          duplicateEdits.push(
            ...findDuplicateManagedCleanupEdits(
              rawLines,
              candidate.scaffold.line,
              candidate.creation.varName,
              candidate.creation.cleanupFunction
            )
          );
        }

        continue;
      }

      if (candidate.kind === "ambiguous") {
        frozenDesired.add(creation.index);
        for (const scaffold of candidate.scaffolds) {
          frozenManaged.add(scaffold.line);
        }
      }
    }

    const remainingDesired = desiredGroup.filter((creation) => !matchedDesired.has(creation.index));
    const remainingManaged = managedGroup.filter((scaffold) => !matchedManaged.has(scaffold.line));
    const fallbackPairs = findUniqueExactFallbackPairs(remainingDesired, remainingManaged);

    for (const pair of fallbackPairs) {
      matchedDesired.add(pair.creation.index);
      matchedManaged.add(pair.scaffold.line);
    }
  }

  return {
    matchedDesired,
    matchedManaged,
    duplicateEdits,
    frozenDesired,
    frozenManaged
  };
}

function findUniqueExactFallbackPairs(desiredGroup, managedGroup) {
  const desiredByVar = new Map();
  const managedByVar = new Map();
  const pairs = [];

  for (const creation of desiredGroup) {
    if (!desiredByVar.has(creation.varName)) desiredByVar.set(creation.varName, []);
    desiredByVar.get(creation.varName).push(creation);
  }

  for (const scaffold of managedGroup) {
    if (!managedByVar.has(scaffold.varName)) managedByVar.set(scaffold.varName, []);
    managedByVar.get(scaffold.varName).push(scaffold);
  }

  for (const [varName, creations] of desiredByVar.entries()) {
    const scaffolds = managedByVar.get(varName) || [];
    if (creations.length !== 1 || scaffolds.length !== 1) continue;

    const creation = creations[0];
    const scaffold = scaffolds[0];
    if (scaffold.line <= creation.endLine) continue;

    pairs.push({ creation, scaffold });
  }

  return pairs;
}

function findSegmentExactCandidate(
  creation,
  previousCreationLine,
  nextCreationLine,
  managedGroup,
  usedManaged
) {
  const matchingScaffolds = managedGroup.filter(
    (scaffold) => !usedManaged.has(scaffold.line)
      && scaffold.line > creation.endLine
      && scaffold.line > previousCreationLine
      && scaffold.line < nextCreationLine
      && scaffold.varName === creation.varName
  );

  if (matchingScaffolds.length === 1) {
    return {
      kind: "pair",
      creation,
      scaffold: matchingScaffolds[0]
    };
  }

  if (matchingScaffolds.length > 1) {
    if (isConsecutiveManagedDuplicateCluster(matchingScaffolds)) {
      return {
        kind: "pair",
        creation,
        scaffold: matchingScaffolds[0]
      };
    }

    return {
      kind: "ambiguous",
      scaffolds: matchingScaffolds
    };
  }

  return {
    kind: "none"
  };
}

function isConsecutiveManagedDuplicateCluster(scaffolds) {
  for (let index = 1; index < scaffolds.length; index++) {
    if (scaffolds[index].line !== scaffolds[index - 1].line + 1) {
      return false;
    }
  }

  return true;
}

function matchTransferredManagedScaffolds(transferredCreations, managedScaffolds, matchedManaged) {
  const edits = [];

  for (const creation of transferredCreations) {
    const managedScaffold = managedScaffolds.find(
      (scaffold) => !matchedManaged.has(scaffold.line)
        && scaffold.line > creation.endLine
        && scaffold.varName === creation.varName
        && scaffold.cleanupFunction === creation.cleanupFunction
    );

    if (!managedScaffold) continue;

    matchedManaged.add(managedScaffold.line);
    edits.push({
      kind: "deleteLine",
      lineNumber: managedScaffold.line
    });
  }

  return edits;
}

function planSegmentRenameMatches(
  desiredCreations,
  managedScaffolds,
  matchedDesired,
  matchedManaged,
  manualOptOuts
) {
  const desiredGroups = groupByCleanupFunction(
    desiredCreations
      .map((creation, index) => ({ ...creation, index }))
      .filter(
        (creation) => !matchedDesired.has(creation.index)
          && creation.insertEligible
          && !manualOptOuts.has(creation.optOutKey)
      )
  );
  const managedGroups = groupByCleanupFunction(
    managedScaffolds.filter((scaffold) => !matchedManaged.has(scaffold.line))
  );
  const cleanupFunctions = new Set([
    ...desiredGroups.keys(),
    ...managedGroups.keys()
  ]);
  const pairs = [];
  const frozenDesired = new Set();
  const frozenManaged = new Set();

  for (const cleanupFunction of cleanupFunctions) {
    const desiredGroup = desiredGroups.get(cleanupFunction) || [];
    const managedGroup = managedGroups.get(cleanupFunction) || [];

    if (!desiredGroup.length || !managedGroup.length) continue;

    const groupPairs = [];
    const usedManaged = new Set();

    for (let index = 0; index < desiredGroup.length; index++) {
      const creation = desiredGroup[index];
      const nextCreationLine = desiredGroup[index + 1]?.line ?? Number.POSITIVE_INFINITY;
      const candidate = findSegmentRenameCandidate(
        creation,
        nextCreationLine,
        managedGroup,
        usedManaged
      );

      if (candidate.kind === "pair") {
        usedManaged.add(candidate.scaffold.line);
        groupPairs.push(candidate);
        continue;
      }

      if (candidate.kind === "ambiguous") {
        frozenDesired.add(creation.index);
        for (const scaffold of candidate.scaffolds) {
          frozenManaged.add(scaffold.line);
        }
      }
    }

    for (const pair of groupPairs) {
      if (frozenDesired.has(pair.creation.index) || frozenManaged.has(pair.scaffold.line)) {
        continue;
      }

      pairs.push(pair);
    }

    const unresolvedDesired = desiredGroup.filter(
      (creation) => !groupPairs.some((pair) => pair.creation.index === creation.index)
    );
    const unresolvedManaged = managedGroup.filter(
      (scaffold) => !usedManaged.has(scaffold.line)
    );

    if (unresolvedDesired.length === 1 && unresolvedManaged.length === 1) {
      pairs.push({
        creation: unresolvedDesired[0],
        scaffold: unresolvedManaged[0]
      });
      continue;
    }

    if (unresolvedDesired.length && unresolvedManaged.length) {
      for (const creation of unresolvedDesired) {
        frozenDesired.add(creation.index);
      }

      for (const scaffold of unresolvedManaged) {
        frozenManaged.add(scaffold.line);
      }
    }
  }

  return {
    pairs,
    frozenDesired,
    frozenManaged
  };
}

function findSegmentRenameCandidate(creation, nextCreationLine, managedGroup, usedManaged) {
  const segmentCandidates = managedGroup.filter(
    (scaffold) => !usedManaged.has(scaffold.line)
      && scaffold.line > creation.endLine
      && scaffold.line < nextCreationLine
  );

  if (segmentCandidates.length === 1) {
    return {
      kind: "pair",
      creation,
      scaffold: segmentCandidates[0]
    };
  }

  if (segmentCandidates.length > 1) {
    return {
      kind: "ambiguous",
      scaffolds: segmentCandidates
    };
  }

  return {
    kind: "none"
  };
}

function groupByCleanupFunction(entries) {
  const groups = new Map();

  for (const entry of entries) {
    if (!groups.has(entry.cleanupFunction)) {
      groups.set(entry.cleanupFunction, []);
    }

    groups.get(entry.cleanupFunction).push(entry);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.line - b.line);
  }

  return groups;
}

function isConfidentOrphanScaffold(fn, scaffold, statements) {
  return !hasPlausibleVariableAssignment(fn, scaffold.varName, scaffold.line, statements);
}

function hasPlausibleVariableAssignment(fn, varName, scaffoldLine, statements) {
  const escapedVarName = escapeRegExp(varName);
  const typedPattern = new RegExp(
    `^(?:[A-Za-z_]\\w*(?:\\s+|\\s*\\*+\\s*))+?${escapedVarName}\\s*=`
  );
  const plainPattern = new RegExp(`^${escapedVarName}\\s*=`);

  return statements.some((statement) => {
    if (statement.startLine < fn.bodyStartLine || statement.endLine >= scaffoldLine) {
      return false;
    }

    const trimmed = compactSanitizedText(statement.sanitizedText);
    return typedPattern.test(trimmed) || plainPattern.test(trimmed);
  });
}

function parseCallStatement(sanitizedText) {
  const trimmed = compactSanitizedText(sanitizedText);
  if (!trimmed || !trimmed.endsWith(";")) return null;
  if (/^(if|for|while|switch|return|sizeof)\b/.test(trimmed)) return null;

  const match = trimmed.match(/^(?:.+?=\s*)?([A-Za-z_]\w*)\s*\((.*)\)\s*;\s*$/);
  if (!match) return null;

  return {
    callee: match[1],
    argsText: match[2]
  };
}

function splitTopLevelArguments(argsText) {
  const args = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < argsText.length; index++) {
    const ch = argsText[index];

    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);

    if (ch === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(argsText.slice(start, index).trim());
      start = index + 1;
    }
  }

  const finalArg = argsText.slice(start).trim();
  if (finalArg) {
    args.push(finalArg);
  }

  return args;
}

function isDirectVariableArgument(argumentText, varName) {
  let value = argumentText.trim();

  if (!value) return false;

  while (value) {
    const unwrapped = stripWrappingParentheses(value);
    if (unwrapped !== value) {
      value = unwrapped.trim();
      continue;
    }

    const castMatch = value.match(/^\(\s*([^()]+)\s*\)\s*(.+)$/);
    if (!castMatch || !looksLikeCastType(castMatch[1])) {
      break;
    }

    value = castMatch[2].trim();
  }

  return value === varName;
}

function stripWrappingParentheses(value) {
  const trimmed = value.trim();
  if (!hasWrappingParentheses(trimmed)) return trimmed;
  return trimmed.slice(1, -1).trim();
}

function hasWrappingParentheses(value) {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;

  let depth = 0;

  for (let index = 0; index < value.length; index++) {
    const ch = value[index];

    if (ch === "(") depth++;
    if (ch === ")") depth--;

    if (depth === 0 && index < value.length - 1) {
      return false;
    }
  }

  return depth === 0;
}

function looksLikeCastType(typeText) {
  if (/[+\-/%&|!?=,:.]/.test(typeText)) return false;
  return /\*/.test(typeText)
    || /^(?:const|volatile|unsigned|signed|short|long|struct|enum|union)\b/.test(typeText)
    || /\s/.test(typeText);
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

function compactSanitizedText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function rawLinesIndent(rawText) {
  const firstLine = rawText.split("\n", 1)[0] ?? "";
  return firstLine.match(/^\s*/)?.[0] ?? "";
}

function buildCreationKey(fn, creation, occurrenceCounts) {
  const functionName = fn?.name || "<global>";
  const identityBase = [
    functionName,
    creation.blockKey || "root",
    creation.cleanupFunction,
    creation.callee,
    creation.callSignature || creation.varName
  ].join(":");
  const occurrence = (occurrenceCounts.get(identityBase) || 0) + 1;
  occurrenceCounts.set(identityBase, occurrence);
  return `${identityBase}#${occurrence}`;
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
  collectBlockHints,
  collectSourceCreations,
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
