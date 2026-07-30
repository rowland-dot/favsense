function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

export function sourceBoardNames(note, config) {
  const explicitNames = Array.isArray(note?.source_boards) ? unique(note.source_boards) : [];
  if (explicitNames.length) return explicitNames;

  const boards = Array.isArray(config?.boards) ? config.boards : [];
  const namesById = new Map(boards.map((board) => [clean(board.id), clean(board.name)]));
  const ids = Array.isArray(note?.source_board_ids) ? unique(note.source_board_ids) : [];
  const mappedNames = unique(ids.map((id) => namesById.get(id)));
  if (mappedNames.length) return mappedNames;

  const fallback = boards.find((board) => clean(board.id) === clean(config?.legacy_source_board_id))
    || boards.find((board) => board.enabled);
  return fallback?.name ? [clean(fallback.name)] : [];
}

function preferredBoard(sourceBoards, config) {
  const configured = Array.isArray(config?.boards) ? config.boards : [];
  const byName = new Map(configured.map((board, index) => [clean(board.name), { board, index }]));
  return sourceBoards
    .map((name, sourceIndex) => {
      const configuredBoard = byName.get(name);
      const board = configuredBoard?.board || { name };
      const priority = Number(board.category_priority);
      return {
        name,
        category: clean(board.category) || name,
        priority: Number.isFinite(priority) ? priority : 0,
        sourceIndex,
        configIndex: configuredBoard?.index ?? Number.MAX_SAFE_INTEGER
      };
    })
    .sort((a, b) => b.priority - a.priority || a.sourceIndex - b.sourceIndex || a.configIndex - b.configIndex)[0] || null;
}

export function resolveCategoryPolicy({ entry, note, config, profile, entryOrigin = "content_rule" }) {
  const strategy = clean(profile?.classification?.category_strategy) || "source-board-first";
  if (!["source-board-first", "content-first"].includes(strategy)) {
    throw new Error(`Unsupported classification.category_strategy: ${strategy}`);
  }

  const sourceBoards = sourceBoardNames(note, config);
  const board = preferredBoard(sourceBoards, config);
  const contentCategory = clean(entry?.category);
  const fallbackCategory = clean(profile?.fallback?.default_category) || "待分类";
  const explicitOverride = entryOrigin === "curation" && entry?.category_override === true && contentCategory;
  const categoryReason = clean(entry?.category_reason);
  if (explicitOverride && entryOrigin === "curation" && !categoryReason) {
    throw new Error("category_reason is required when curation sets category_override: true");
  }

  let category;
  let categorySource;
  if (explicitOverride) {
    category = contentCategory;
    categorySource = entryOrigin;
  } else if (strategy === "source-board-first" && board?.category) {
    category = board.category;
    categorySource = "source_board";
  } else if (contentCategory) {
    category = contentCategory;
    categorySource = entryOrigin;
  } else if (board?.category) {
    category = board.category;
    categorySource = "source_board";
  } else {
    category = fallbackCategory;
    categorySource = "fallback";
  }

  const suggestedCategory = contentCategory && contentCategory !== category ? contentCategory : "";
  const themes = unique(Array.isArray(entry?.themes) ? entry.themes : []).slice(0, 3);
  return {
    category,
    categorySource,
    categoryReason,
    suggestedCategory,
    sourceBoards,
    themes,
    strategy
  };
}
