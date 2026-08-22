import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { loadLocalEnv } from "../shared/local-env.mjs";

const TOUCHED = ["TASKBOARD_TEST_FROM_FILE", "TASKBOARD_TEST_FROM_SHELL"];
const directories = [];

afterEach(async () => {
  for (const name of TOUCHED) delete process.env[name];
  while (directories.length > 0) {
    await rm(directories.pop(), { recursive: true, force: true });
  }
});

async function projectRoot(contents) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-env-test-"));
  directories.push(directory);
  if (contents !== undefined) {
    await writeFile(path.join(directory, ".env.local"), contents);
  }
  return directory;
}

test("settings in .env.local reach the process", async () => {
  const root = await projectRoot("TASKBOARD_TEST_FROM_FILE=ou_from_file\n");

  const loaded = loadLocalEnv(root);

  assert.equal(loaded, path.join(root, ".env.local"));
  assert.equal(process.env.TASKBOARD_TEST_FROM_FILE, "ou_from_file");
});

test("an explicit environment value wins over .env.local", async () => {
  const root = await projectRoot("TASKBOARD_TEST_FROM_SHELL=from_file\n");
  process.env.TASKBOARD_TEST_FROM_SHELL = "from_shell";

  loadLocalEnv(root);

  assert.equal(process.env.TASKBOARD_TEST_FROM_SHELL, "from_shell");
});

test("a project without .env.local starts normally", async () => {
  const root = await projectRoot();

  assert.equal(loadLocalEnv(root), null);
});
