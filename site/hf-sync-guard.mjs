export function repositoryIsMissing(error) {
  return /404|not found|repository not found/i.test(String(error?.message || error));
}

export function repositoryWriteConflict(error) {
  const status = Number(error?.statusCode || error?.status || error?.response?.status);
  return status === 409 || status === 412
    || /409|412|conflict|parent commit|revision.*changed/i.test(String(error?.message || error));
}

export function assertPrivateDataset(info) {
  if (info?.private !== true) {
    throw new Error("FavSense private Dataset is not private; cloud sync was stopped");
  }
  if (!/^[a-f0-9]{7,64}$/i.test(String(info.sha || ""))) {
    throw new Error("FavSense private Dataset has no verifiable revision; cloud sync was stopped");
  }
  return info;
}
