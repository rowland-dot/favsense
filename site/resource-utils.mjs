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
  const resourceTypes = new Set((radar.groups || []).map((group) => group.label).filter(Boolean));
  if (radar.default_group) resourceTypes.add(radar.default_group);
  let globalSortCount = 0;
  for (const sort of radar.sorts) {
    if (!sort?.id || !sort?.label || !sort?.field || !sort?.type || !sort?.direction) {
      throw new Error("Every resource_index sort requires id, label, field, type and direction.");
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
