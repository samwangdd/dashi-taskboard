import path from "node:path";

// Machine-local settings that should not be typed on every `npm run dev`, such as
// TASKBOARD_LARK_USER_ID. Node leaves variables that are already set alone, so an
// explicit `FOO=bar npm run dev` still wins over the file.
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
