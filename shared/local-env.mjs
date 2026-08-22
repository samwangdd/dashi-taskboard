import path from "node:path";

export function loadLocalEnv(root) {
  const file = path.join(root, ".env.local");
  try {
    process.loadEnvFile(file);
    return file;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
