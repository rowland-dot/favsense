export function resourceGroup(resource, radar) {
  const text = [resource.name, resource.type, resource.description, ...(resource.aliases || [])]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
  for (const group of radar?.groups || []) {
    try {
      if (new RegExp(group.pattern, "i").test(text)) return group.label;
    } catch {
      // Invalid optional grouping rules fall through to the configured default.
    }
  }
  return radar?.default_group || "其他";
}

function compareValues(left, right, sort) {
  if (sort.type === "number") {
    const leftValue = Number.isFinite(left[sort.field]) ? left[sort.field] : null;
    const rightValue = Number.isFinite(right[sort.field]) ? right[sort.field] : null;
    if (leftValue === null) return rightValue === null ? left.name.localeCompare(right.name, "zh-CN") : 1;
    if (rightValue === null) return -1;
    return sort.direction === "asc" ? leftValue - rightValue : rightValue - leftValue;
  }
  const result = String(left[sort.field] || "").localeCompare(String(right[sort.field] || ""), "zh-CN");
  return sort.direction === "desc" ? -result : result;
}

export function sortResources(resources, mode, radar) {
  const sorts = radar?.sorts || [];
  const sort = sorts.find((item) => item.id === mode) || sorts[0] || {
    field: "name", type: "text", direction: "asc"
  };
  return [...resources].sort((left, right) => compareValues(left, right, sort));
}

export function resourceSortsForGroup(radar, group = "all") {
  const sorts = radar?.sorts || [];
  const globalSorts = sorts.filter((sort) => sort.applies_to === undefined || (Array.isArray(sort.applies_to) && sort.applies_to.length === 0));
  if (group === "all") return globalSorts;
  const scopedSorts = sorts.filter((sort) => Array.isArray(sort.applies_to) && sort.applies_to.includes(group));
  return [...scopedSorts, ...globalSorts];
}

export function validateResourceIndex(radar) {
  if (!radar || !Array.isArray(radar.sorts) || radar.sorts.length === 0) {
    throw new Error("resource_index.sorts must contain at least one sort option.");
  }
  if (radar.groups !== undefined && !Array.isArray(radar.groups)) {
    throw new Error("resource_index.groups must be an array.");
  }
  if (radar.default_group !== undefined && (typeof radar.default_group !== "string" || !radar.default_group.trim())) {
    throw new Error("resource_index.default_group must be a non-empty string.");
  }
  if (
    radar.fields_by_type !== undefined
    && (
      !radar.fields_by_type
      || typeof radar.fields_by_type !== "object"
      || Array.isArray(radar.fields_by_type)
      || Object.getPrototypeOf(radar.fields_by_type) !== Object.prototype
    )
  ) {
    throw new Error("resource_index.fields_by_type must be an object.");
  }
  for (const [resourceType, fields] of Object.entries(radar.fields_by_type || {})) {
    if (!resourceType.trim() || !Array.isArray(fields)) {
      throw new Error("Every resource_index.fields_by_type entry requires a non-empty type and an array.");
    }
    for (const field of fields) {
      if (
        !field
        || typeof field !== "object"
        || Array.isArray(field)
        || Object.getPrototypeOf(field) !== Object.prototype
        || typeof field.field !== "string"
        || !field.field.trim()
        || typeof field.label !== "string"
        || !field.label.trim()
      ) {
        throw new Error("Every resource_index.fields_by_type descriptor requires non-empty field and label strings.");
      }
    }
  }
  for (const group of radar.groups || []) {
    if (
      !group
      || typeof group !== "object"
      || Array.isArray(group)
      || typeof group.label !== "string"
      || !group.label.trim()
      || typeof group.pattern !== "string"
      || !group.pattern.trim()
    ) {
      throw new Error("Every resource_index group requires string label and pattern fields.");
    }
  }
  const resourceTypes = new Set((radar.groups || []).map((group) => group.label).filter(Boolean));
  if (radar.default_group) resourceTypes.add(radar.default_group);
  let globalSortCount = 0;
  for (const sort of radar.sorts) {
    if (
      !sort
      || typeof sort.id !== "string" || !sort.id.trim()
      || typeof sort.label !== "string" || !sort.label.trim()
      || typeof sort.field !== "string" || !sort.field.trim()
      || typeof sort.type !== "string" || !sort.type.trim()
      || typeof sort.direction !== "string" || !sort.direction.trim()
    ) {
      throw new Error("Every resource_index sort requires id, label, field, type and direction.");
    }
    if (!["text", "number"].includes(sort.type) || !["asc", "desc"].includes(sort.direction)) {
      throw new Error(`resource_index sort ${sort.id} has an unsupported type or direction.`);
    }
    if (sort.applies_to === undefined || (Array.isArray(sort.applies_to) && sort.applies_to.length === 0)) {
      globalSortCount += 1;
      continue;
    }
    if (!Array.isArray(sort.applies_to)) {
      throw new Error(`resource_index sort ${sort.id} applies_to must be an array.`);
    }
    for (const resourceType of sort.applies_to) {
      if (!resourceTypes.has(resourceType)) {
        throw new Error(`resource_index sort ${sort.id} references unknown resource type: ${resourceType}`);
      }
    }
  }
  if (globalSortCount === 0) {
    throw new Error("resource_index requires at least one global sort without applies_to.");
  }
  return radar;
}
