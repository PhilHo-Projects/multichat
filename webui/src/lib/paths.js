export function normalizeBasePath(value) {
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue || normalizedValue === "/") {
    return "/";
  }

  return `/${normalizedValue.replace(/^\/+|\/+$/g, "")}/`;
}

export function apiPath(path) {
  const basePath = normalizeBasePath(import.meta.env.BASE_URL);
  const normalizedPath = String(path ?? "").replace(/^\/+/, "");

  return `${basePath}${normalizedPath}`;
}
