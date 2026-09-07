export const REVIEW_ARTIFACT_PROVIDERS = ["github", "gitlab"];

const REVIEW_ARTIFACT_KEYS = new Set([
  "provider",
  "url",
  "remoteSha",
  "sourceBranch",
  "targetBranch",
]);

export class ReviewArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReviewArtifactValidationError";
  }
}

function requiredString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ReviewArtifactValidationError(
      `'reviewArtifact.${field}' must contain 1 to ${maxLength} characters`,
    );
  }
  return value.trim();
}

export function normalizeReviewArtifact(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewArtifactValidationError("'reviewArtifact' must be an object or null");
  }
  for (const key of Object.keys(value)) {
    if (!REVIEW_ARTIFACT_KEYS.has(key)) {
      throw new ReviewArtifactValidationError(`Unknown reviewArtifact field '${key}'`);
    }
  }
  if (!REVIEW_ARTIFACT_PROVIDERS.includes(value.provider)) {
    throw new ReviewArtifactValidationError(
      "'reviewArtifact.provider' must be github or gitlab",
    );
  }
  const url = requiredString(value.url, "url", 2_048);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ReviewArtifactValidationError("'reviewArtifact.url' must be a valid HTTPS URL");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new ReviewArtifactValidationError("'reviewArtifact.url' must be a valid HTTPS URL");
  }
  const remoteSha = requiredString(value.remoteSha, "remoteSha", 64).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(remoteSha)) {
    throw new ReviewArtifactValidationError(
      "'reviewArtifact.remoteSha' must be a 40 or 64 character Git SHA",
    );
  }
  const sourceBranch = requiredString(value.sourceBranch, "sourceBranch", 512);
  const targetBranch = requiredString(value.targetBranch, "targetBranch", 512);
  if (sourceBranch === targetBranch) {
    throw new ReviewArtifactValidationError(
      "'reviewArtifact.sourceBranch' must differ from targetBranch",
    );
  }
  return {
    provider: value.provider,
    url,
    remoteSha,
    sourceBranch,
    targetBranch,
  };
}

export function requiresReviewArtifact(status, reviewRequired) {
  return status === "in_review" && reviewRequired;
}
