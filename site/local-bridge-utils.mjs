export function validateLocalBridgeConfig(value) {
  if (!value || typeof value !== "object") throw new Error("本机同步配置不可用");

  let url;
  try {
    url = new URL(value.baseUrl);
  } catch {
    throw new Error("本机同步地址无效");
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) throw new Error("本机同步地址必须使用带端口的回环地址");

  return { baseUrl: url.origin, token: "" };
}

export function validateLocalBridgeSession(value) {
  if (!value || value.ok !== true || value.protocol_version !== 4) throw new Error("本机同步服务版本不匹配");
  if (typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("本机同步会话无效");
  return value.token;
}
