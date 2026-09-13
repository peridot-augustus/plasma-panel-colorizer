#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ARTIFACT_CONTRACT = Object.freeze({
  name: "bumblebit-review-policy",
  schemaVersion: 1,
  profileVersion: "1",
  candidateExecution: "none",
});

const LIMITS = Object.freeze({
  reviews: 500,
  reviewVerdicts: 500,
  reviewThreads: 500,
  workflowRuns: 100,
  protectedPaths: 20,
  validationChecks: 100,
  openPullRequests: 100,
});
const REVIEWER = Object.freeze({
  login: "coderabbitai[bot]",
  id: 136622811,
  type: "Bot",
  requireZeroActionable: true,
});
const ACTIONS_APP = Object.freeze({ id: 15368, slug: "github-actions" });
const PROTECTED_PATHS = Object.freeze([
  ".github/CODEOWNERS",
  ".github/ai-workflow-policy.json",
  ".github/workflows/validate.yml",
  ".github/workflows/review-policy.yml",
  "artifacts/bumblebit-review-policy-v1.mjs",
  "artifacts/bumblebit-review-policy-v1.sha256",
  "artifacts/bumblebit-review-policy-v1.manifest.json",
]);
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;

function safePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOpenPullRequests(data, perPage) {
  if (!Array.isArray(data) || data.length > perPage)
    throw new EvidenceError("invalid-response");
  return data.map((pull) => {
    if (
      !object(pull) ||
      !positiveInteger(pull.number) ||
      pull.state !== "open" ||
      !object(pull.base) ||
      typeof pull.base.repo?.full_name !== "string" ||
      !REPOSITORY.test(pull.base.repo.full_name) ||
      typeof pull.base.ref !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(pull.base.ref) ||
      typeof pull.base.sha !== "string" ||
      !SHA.test(pull.base.sha) ||
      !object(pull.head) ||
      typeof pull.head.sha !== "string" ||
      !SHA.test(pull.head.sha)
    )
      throw new EvidenceError("invalid-response");
    return {
      number: pull.number,
      state: pull.state,
      baseRepository: pull.base.repo.full_name,
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
    };
  });
}

class EvidenceError extends Error {
  constructor(reason, status = null) {
    super("Review-policy evidence could not be established");
    this.reason = reason;
    this.status = status;
  }
}

export function parseArguments(argv) {
  const values = {};
  const accepted = new Set([
    "--repository",
    "--pr",
    "--head",
    "--workflow-run-head",
    "--publication",
    "--producer-app-id",
    "--producer-app-slug",
    "--validation-workflow",
    "--policy-version",
    "--policy",
    "--trusted-default-ref",
    "--trusted-default-sha",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!accepted.has(key) || value === undefined) throw new Error("Unknown or incomplete argument");
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (values[name] !== undefined) throw new Error(`Duplicate argument: ${key}`);
    values[name] = value;
  }
  const number = Number(values.pr);
  const directIdentity = positiveInteger(number) && SHA.test(values.head ?? "");
  const workflowIdentity = SHA.test(values.workflowRunHead ?? "");
  const publication = values.publication;
  const producerAppId = Number(values.producerAppId);
  if (
    !REPOSITORY.test(values.repository ?? "") ||
    directIdentity === workflowIdentity ||
    !safePath(values.validationWorkflow) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(values.trustedDefaultRef ?? "") ||
    !SHA.test(values.trustedDefaultSha ?? "") ||
    !/^[1-9][0-9]*$/.test(values.policyVersion ?? "") ||
    !["shadow", "enforce"].includes(publication) ||
    (publication === "enforce" &&
      (!positiveInteger(producerAppId) || values.producerAppSlug !== "bumblebit-review-gate")) ||
    (publication === "shadow" &&
      (values.producerAppId !== undefined || values.producerAppSlug !== undefined))
  )
    throw new Error(
      "Required arguments: --repository, one exact identity, --publication, --validation-workflow, --policy-version, --trusted-default-ref, --trusted-default-sha",
    );
  if (values.policy !== undefined && !safePath(values.policy))
    throw new Error("--policy must be a repository-relative path");
  return {
    repository: values.repository,
    pullRequestNumber: directIdentity ? number : null,
    expectedHeadSha: directIdentity ? values.head : null,
    workflowRunHead: workflowIdentity ? values.workflowRunHead : null,
    reviewerRequirements: [REVIEWER],
    validationApp: ACTIONS_APP,
    protectedPaths: [...PROTECTED_PATHS],
    publication: {
      mode: publication,
      expectedProducerApp:
        publication === "enforce"
          ? { id: producerAppId, slug: values.producerAppSlug }
          : ACTIONS_APP,
    },
    validationWorkflowPath: values.validationWorkflow,
    expectedPolicyVersion: values.policyVersion,
    policyPath: values.policy ?? ".github/ai-workflow-policy.json",
    trustedDefaultRef: values.trustedDefaultRef,
    trustedDefaultSha: values.trustedDefaultSha,
  };
}

async function readBoundedFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64 * 1024)
      throw new Error("Policy must be one regular file no larger than 64 KiB");
    const bytes = Buffer.alloc(metadata.size);
    for (let offset = 0; offset < bytes.length; ) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("Policy changed while it was read");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size)
      throw new Error("Policy changed while it was read");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function loadPolicy(path, repository) {
  const bytes = await readBoundedFile(resolve(path));
  let policy;
  try {
    policy = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Policy is not valid JSON");
  }
  if (
    !object(policy) ||
    policy.version !== 1 ||
    policy.repository?.toLowerCase() !== repository.toLowerCase() ||
    !object(policy.review) ||
    policy.review.mode !== "advisory" ||
    policy.review.candidate !== "pull-request-head" ||
    policy.review.unresolvedFindings !== "report" ||
    typeof policy.review.policyVersion !== "string"
  )
    throw new Error("Policy does not satisfy the Bumblebit v1 review profile");
  return { policy, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function loadTrustedBase(repository, ref, sha, protectedPaths) {
  const protectedFiles = [];
  for (const path of protectedPaths) {
    const bytes = await readBoundedFile(resolve(path));
    protectedFiles.push({
      path,
      identity: {
        kind: "file",
        sha: createHash("sha1")
          .update(Buffer.from(`blob ${bytes.length}\0`))
          .update(bytes)
          .digest("hex"),
      },
    });
  }
  return { repository, ref, sha, protectedFiles };
}

async function responseJson(response) {
  if (!response.ok) {
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")))
    )
      throw new EvidenceError("rate-limited");
    throw new EvidenceError("request-failed", response.status);
  }
  if (!response.body) throw new EvidenceError("invalid-response");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new EvidenceError("safety-limit");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EvidenceError("invalid-response");
  }
}

function parseReviewVerdict(body) {
  if (typeof body !== "string" || !/Actionable comments posted:/i.test(body))
    return { actionableCount: null, verdictStatus: "missing" };
  const match = body.match(/Actionable comments posted:[^0-9]*(\d+)/i);
  return match
    ? { actionableCount: Number(match[1]), verdictStatus: "parsed" }
    : { actionableCount: null, verdictStatus: "unparseable" };
}

function parseCleanCommentHead(body) {
  if (typeof body !== "string" || !/No actionable comments were generated/i.test(body))
    return null;
  const match = body.match(/between\s+[0-9a-f]{40}\s+and\s+([0-9a-f]{40})/i);
  return match
    ? { commitSha: match[1].toLowerCase(), verdictStatus: "parsed" }
    : { commitSha: null, verdictStatus: "unparseable" };
}

export function createGitHub(token, request = fetch, requestTimeoutMs = 30_000) {
  const call = async (path, init = {}) => {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") throw new EvidenceError("request-failed");
    let response;
    try {
      response = await request(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new EvidenceError("request-failed");
    }
    return responseJson(response);
  };
  const route = (repository, suffix) => `/repos/${repository}${suffix}`;
  return {
    async getRepository(repository) {
      const data = await call(route(repository, ""));
      if (
        !object(data) ||
        !REPOSITORY.test(data.full_name ?? "") ||
        data.full_name.toLowerCase() !== repository.toLowerCase() ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(data.default_branch ?? "")
      )
        throw new EvidenceError("invalid-response");
      return { fullName: data.full_name, defaultBranch: data.default_branch };
    },
    async getBranch(repository, branch) {
      const data = await call(route(repository, `/branches/${encodeURIComponent(branch)}`));
      if (
        !object(data) ||
        data.name !== branch ||
        !object(data.commit) ||
        !SHA.test(data.commit.sha ?? "")
      )
        throw new EvidenceError("invalid-response");
      return { name: data.name, sha: data.commit.sha };
    },
    async resolveOpenPullRequest(repository, headSha) {
      const data = await call(route(repository, `/pulls?state=open&per_page=100`));
      const pullRequests = parseOpenPullRequests(data, LIMITS.openPullRequests);
      if (pullRequests.length >= LIMITS.openPullRequests)
        throw new EvidenceError("safety-limit");
      const matches = pullRequests.filter((pull) => pull.headSha === headSha);
      if (matches.length === 0) return null;
      if (matches.length !== 1) throw new EvidenceError("ambiguous");
      return { number: matches[0].number, headSha };
    },
    async listOpenPullRequestsForHead(repository, headSha, perPage) {
      const data = await call(route(repository, `/pulls?state=open&per_page=${perPage}`));
      const pullRequests = parseOpenPullRequests(data, perPage);
      return {
        items: pullRequests.filter((pull) => pull.headSha === headSha),
        hasNextPage: data.length === perPage,
      };
    },
    async getPullRequest(repository, number) {
      const data = await call(route(repository, `/pulls/${number}`));
      if (
        !object(data) ||
        data.number !== number ||
        typeof data.state !== "string" ||
        !object(data.base) ||
        !REPOSITORY.test(data.base.repo?.full_name ?? "") ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(data.base.ref ?? "") ||
        !SHA.test(data.base.sha ?? "") ||
        !object(data.head) ||
        !SHA.test(data.head.sha ?? "")
      )
        throw new EvidenceError("invalid-response");
      return {
        number,
        state: data.state,
        baseRepository: data.base.repo.full_name,
        baseRef: data.base.ref,
        baseSha: data.base.sha,
        headSha: data.head.sha,
      };
    },
    async listReviews(repository, number, page, perPage) {
      const data = await call(
        route(repository, `/pulls/${number}/reviews?per_page=${perPage}&page=${page}`),
      );
      if (!Array.isArray(data)) throw new EvidenceError("invalid-response");
      const items = data.map((review) => {
        if (
          !object(review) ||
          !positiveInteger(review.id) ||
          typeof review.state !== "string" ||
          !(review.commit_id === null || SHA.test(review.commit_id ?? "")) ||
          typeof review.submitted_at !== "string" ||
          !object(review.user) ||
          !positiveInteger(review.user.id) ||
          !LOGIN.test(review.user.login ?? "") ||
          !["Bot", "User"].includes(review.user.type)
        )
          throw new EvidenceError("invalid-response");
        return {
          id: review.id,
          reviewer: review.user.login,
          reviewerId: review.user.id,
          reviewerType: review.user.type,
          state: review.state,
          commitSha: review.commit_id,
          submittedAt: review.submitted_at,
          ...parseReviewVerdict(review.body),
        };
      });
      return { items, hasNextPage: items.length === perPage };
    },
    async listReviewVerdicts(repository, number, page, perPage) {
      const data = await call(
        route(repository, `/issues/${number}/comments?per_page=${perPage}&page=${page}`),
      );
      if (!Array.isArray(data)) throw new EvidenceError("invalid-response");
      const items = [];
      for (const comment of data) {
        if (
          !object(comment) ||
          !positiveInteger(comment.id) ||
          typeof comment.created_at !== "string" ||
          typeof comment.updated_at !== "string" ||
          !object(comment.user) ||
          !positiveInteger(comment.user.id) ||
          !LOGIN.test(comment.user.login ?? "") ||
          !["Bot", "User"].includes(comment.user.type)
        )
          throw new EvidenceError("invalid-response");
        const verdict = parseCleanCommentHead(comment.body);
        if (!verdict) continue;
        items.push({
          id: comment.id,
          source: "issue-comment",
          reviewer: comment.user.login,
          reviewerId: comment.user.id,
          reviewerType: comment.user.type,
          commitSha: verdict.commitSha,
          submittedAt: comment.created_at,
          actionableCount: verdict.verdictStatus === "parsed" ? 0 : null,
          verdictStatus: verdict.verdictStatus,
        });
      }
      return { items, hasNextPage: data.length === perPage };
    },
    async listReviewThreads(repository, number, cursor, first) {
      const [owner, name] = repository.split("/");
      const query = `query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:$first,after:$after){nodes{id isResolved}pageInfo{hasNextPage endCursor}}}}}`;
      const data = await call("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { owner, name, number, first, after: cursor } }),
      });
      const connection = data?.data?.repository?.pullRequest?.reviewThreads;
      if (
        !object(connection) ||
        !Array.isArray(connection.nodes) ||
        !object(connection.pageInfo) ||
        typeof connection.pageInfo.hasNextPage !== "boolean" ||
        !(connection.pageInfo.endCursor === null ||
          typeof connection.pageInfo.endCursor === "string")
      )
        throw new EvidenceError("invalid-response");
      const items = connection.nodes.map((thread) => {
        if (!object(thread) || typeof thread.id !== "string" || typeof thread.isResolved !== "boolean")
          throw new EvidenceError("invalid-response");
        return { id: thread.id, isResolved: thread.isResolved };
      });
      return {
        items,
        hasNextPage: connection.pageInfo.hasNextPage,
        endCursor: connection.pageInfo.endCursor,
      };
    },
    async getWorkflow(repository, path) {
      if (!safePath(path)) throw new EvidenceError("invalid-response");
      const workflowFile = path.slice(path.lastIndexOf("/") + 1);
      const data = await call(
        route(repository, `/actions/workflows/${encodeURIComponent(workflowFile)}`),
      );
      if (
        !object(data) ||
        !positiveInteger(data.id) ||
        !safePath(data.path) ||
        typeof data.state !== "string"
      )
        throw new EvidenceError("invalid-response");
      return { id: data.id, path: data.path, state: data.state };
    },
    async getProtectedFileIdentity(repository, path, ref) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      let data;
      try {
        data = await call(route(repository, `/contents/${encodedPath}?ref=${ref}`));
      } catch (error) {
        if (error instanceof EvidenceError && error.status === 404)
          return { kind: "missing", sha: null };
        throw error;
      }
      if (!object(data) || typeof data.type !== "string")
        throw new EvidenceError("invalid-response");
      if (data.type === "file" && SHA.test(data.sha ?? ""))
        return { kind: "file", sha: data.sha };
      return { kind: "nonfile", sha: SHA.test(data.sha ?? "") ? data.sha : null };
    },
    async listWorkflowRuns(repository, workflowId, headSha, perPage) {
      const data = await call(
        route(
          repository,
          `/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${headSha}&per_page=${perPage}`,
        ),
      );
      if (
        !object(data) ||
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        !Array.isArray(data.workflow_runs) ||
        data.workflow_runs.length > perPage
      )
        throw new EvidenceError("invalid-response");
      const items = data.workflow_runs.map((run) => {
        if (
          !object(run) ||
          !positiveInteger(run.id) ||
          !positiveInteger(run.run_attempt) ||
          !positiveInteger(run.workflow_id) ||
          !positiveInteger(run.check_suite_id) ||
          typeof run.event !== "string" ||
          typeof run.status !== "string" ||
          !(run.conclusion === null || typeof run.conclusion === "string") ||
          !SHA.test(run.head_sha ?? "") ||
          typeof run.html_url !== "string" ||
          !object(run.repository) ||
          !REPOSITORY.test(run.repository.full_name ?? "") ||
          !Array.isArray(run.pull_requests)
        )
          throw new EvidenceError("invalid-response");
        const pullRequests = run.pull_requests.map((pull) => {
          if (
            !object(pull) ||
            !positiveInteger(pull.number) ||
            !object(pull.base) ||
            !SHA.test(pull.base.sha ?? "") ||
            !object(pull.head) ||
            !SHA.test(pull.head.sha ?? "")
          )
            throw new EvidenceError("invalid-response");
          return { number: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha };
        });
        return {
          id: run.id,
          attempt: run.run_attempt,
          workflowId: run.workflow_id,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          headSha: run.head_sha,
          repository: run.repository.full_name,
          url: run.html_url,
          checkSuiteId: run.check_suite_id,
          pullRequests,
          validatedHeadSha: null,
          validationCheckApp: null,
        };
      });
      return { items, totalCount: data.total_count };
    },
    async getValidationCheckReceipt(repository, checkSuiteId, perPage) {
      const data = await call(
        route(
          repository,
          `/check-suites/${checkSuiteId}/check-runs?filter=latest&per_page=${perPage}`,
        ),
      );
      if (
        !object(data) ||
        data.total_count !== 2 ||
        !Array.isArray(data.check_runs) ||
        data.check_runs.length !== 2
      )
        throw new EvidenceError("ambiguous");
      const parse = (name) => {
        const matches = data.check_runs.filter((check) => check?.name === name);
        const check = matches[0];
        if (
          matches.length !== 1 ||
          !object(check) ||
          !SHA.test(check.head_sha ?? "") ||
          typeof check.status !== "string" ||
          !(check.conclusion === null || typeof check.conclusion === "string") ||
          !object(check.app) ||
          !positiveInteger(check.app.id) ||
          typeof check.app.slug !== "string"
        )
          throw new EvidenceError("ambiguous");
        return check;
      };
      const identity = parse("repository-validation-identity");
      const validation = parse("repository-validation");
      if (identity.app.id !== validation.app.id || identity.app.slug !== validation.app.slug)
        throw new EvidenceError("ambiguous");
      return {
        identity: { headSha: identity.head_sha, status: identity.status, conclusion: identity.conclusion },
        validation: { headSha: validation.head_sha, status: validation.status, conclusion: validation.conclusion },
        app: { id: identity.app.id, slug: identity.app.slug },
      };
    },
    async createCheckRun(repository, check) {
      const data = await call(route(repository, "/check-runs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: check.name,
          head_sha: check.headSha,
          status: check.status,
          external_id: check.externalId,
          output: { title: check.title, summary: check.summary },
        }),
      });
      if (
        !object(data) ||
        !positiveInteger(data.id) ||
        typeof data.name !== "string" ||
        !SHA.test(data.head_sha ?? "") ||
        typeof data.status !== "string" ||
        !(data.conclusion === null || typeof data.conclusion === "string") ||
        typeof data.html_url !== "string" ||
        !object(data.app) ||
        !positiveInteger(data.app.id) ||
        typeof data.app.slug !== "string"
      )
        throw new EvidenceError("ambiguous");
      return {
        id: data.id,
        name: data.name,
        headSha: data.head_sha,
        status: data.status,
        conclusion: data.conclusion,
        url: data.html_url,
        app: { id: data.app.id, slug: data.app.slug },
      };
    },
    async updateCheckRun(repository, check) {
      const data = await call(route(repository, `/check-runs/${check.checkRunId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: check.status,
          conclusion: check.conclusion,
          output: { title: check.title, summary: check.summary },
        }),
      });
      if (
        !object(data) ||
        !positiveInteger(data.id) ||
        typeof data.name !== "string" ||
        !SHA.test(data.head_sha ?? "") ||
        typeof data.status !== "string" ||
        !(data.conclusion === null || typeof data.conclusion === "string") ||
        typeof data.html_url !== "string" ||
        !object(data.app) ||
        !positiveInteger(data.app.id) ||
        typeof data.app.slug !== "string"
      )
        throw new EvidenceError("ambiguous");
      return {
        id: data.id,
        name: data.name,
        headSha: data.head_sha,
        status: data.status,
        conclusion: data.conclusion,
        url: data.html_url,
        app: { id: data.app.id, slug: data.app.slug },
      };
    },
    async listCheckRuns(repository, headSha, name, perPage) {
      const data = await call(
        route(
          repository,
          `/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=${perPage}`,
        ),
      );
      if (
        !object(data) ||
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        !Array.isArray(data.check_runs) ||
        data.check_runs.length > perPage
      )
        throw new EvidenceError("invalid-response");
      const items = data.check_runs.map((check) => {
        if (
          !object(check) ||
          !positiveInteger(check.id) ||
          typeof check.name !== "string" ||
          !SHA.test(check.head_sha ?? "") ||
          typeof check.status !== "string" ||
          !(check.conclusion === null || typeof check.conclusion === "string") ||
          typeof check.html_url !== "string" ||
          !object(check.app) ||
          !positiveInteger(check.app.id) ||
          typeof check.app.slug !== "string"
        )
          throw new EvidenceError("invalid-response");
        return {
          id: check.id,
          name: check.name,
          headSha: check.head_sha,
          status: check.status,
          conclusion: check.conclusion,
          url: check.html_url,
          app: { id: check.app.id, slug: check.app.slug },
        };
      });
      return { items, totalCount: data.total_count };
    },
  };
}

export async function collectEvidence(input, github) {
  let requestCount = 0;
  const request = async (operation) => {
    requestCount++;
    return operation();
  };
  const unavailable = (reason, status = "unavailable") => ({
    status,
    reason,
    requestCount,
    limits: LIMITS,
  });
  try {
    if (
      input.protectedPaths.length === 0 ||
      input.protectedPaths.length > LIMITS.protectedPaths ||
      new Set(input.protectedPaths).size !== input.protectedPaths.length ||
      input.trustedBase.protectedFiles.length !== input.protectedPaths.length ||
      new Set(input.trustedBase.protectedFiles.map((file) => file.path)).size !==
        input.trustedBase.protectedFiles.length ||
      input.trustedBase.protectedFiles.some(
        (file) => !input.protectedPaths.includes(file.path) || file.identity.kind !== "file",
      )
    )
      return unavailable("safety-limit");
    const repository = await request(() => github.getRepository(input.repository));
    const defaultBranch = await request(() =>
      github.getBranch(input.repository, repository.defaultBranch),
    );
    const before = await request(() =>
      github.getPullRequest(input.repository, input.pullRequestNumber),
    );
    const openBeforePage = await request(() =>
      github.listOpenPullRequestsForHead(
        input.repository,
        input.expectedHeadSha,
        LIMITS.openPullRequests,
      ),
    );
    if (openBeforePage.hasNextPage) return unavailable("safety-limit");
    const reviews = [];
    for (let page = 1; page <= 5; page++) {
      const result = await request(() =>
        github.listReviews(input.repository, input.pullRequestNumber, page, 100),
      );
      reviews.push(...result.items);
      if (!result.hasNextPage) break;
      if (page === 5) return unavailable("safety-limit");
    }
    const reviewVerdicts = [];
    for (let page = 1; page <= 5; page++) {
      const result = await request(() =>
        github.listReviewVerdicts(input.repository, input.pullRequestNumber, page, 100),
      );
      reviewVerdicts.push(...result.items);
      if (!result.hasNextPage) break;
      if (page === 5) return unavailable("safety-limit");
    }
    const reviewThreads = [];
    let cursor = null;
    for (let page = 1; page <= 5; page++) {
      const result = await request(() =>
        github.listReviewThreads(input.repository, input.pullRequestNumber, cursor, 100),
      );
      reviewThreads.push(...result.items);
      if (!result.hasNextPage) break;
      if (!result.endCursor) return unavailable("ambiguous", "ambiguous");
      cursor = result.endCursor;
      if (page === 5) return unavailable("safety-limit");
    }
    const workflow = await request(() =>
      github.getWorkflow(input.repository, input.validationWorkflowPath),
    );
    const protectedFiles = [];
    for (const path of input.protectedPaths) {
      const trusted = input.trustedBase.protectedFiles.find((file) => file.path === path)?.identity;
      if (!trusted) return unavailable("ambiguous", "ambiguous");
      const base = await request(() =>
        github.getProtectedFileIdentity(input.repository, path, before.baseSha),
      );
      const head = await request(() =>
        github.getProtectedFileIdentity(input.repository, path, before.headSha),
      );
      protectedFiles.push({ path, trusted, base, head });
    }
    const workflowFile = protectedFiles.find(
      (file) => file.path === input.validationWorkflowPath,
    );
    if (!workflowFile) return unavailable("ambiguous", "ambiguous");
    const runPage = await request(() =>
      github.listWorkflowRuns(input.repository, workflow.id, input.expectedHeadSha, 100),
    );
    if (runPage.totalCount > 100) return unavailable("safety-limit");
    const matchingRuns = runPage.items
      .filter(
        (run) =>
          run.workflowId === workflow.id &&
          run.event === "pull_request" &&
          run.status === "completed" &&
          run.conclusion === "success" &&
          run.headSha === input.expectedHeadSha &&
          run.repository.toLowerCase() === input.repository.toLowerCase() &&
          run.pullRequests.some(
            (pull) =>
              pull.number === input.pullRequestNumber &&
              pull.baseSha === input.trustedBase.sha &&
              pull.headSha === input.expectedHeadSha,
          ),
      )
      .sort((left, right) => right.id - left.id || right.attempt - left.attempt);
    const newestRun = matchingRuns[0];
    if (newestRun) {
      const receipt = await request(() =>
        github.getValidationCheckReceipt(
          input.repository,
          newestRun.checkSuiteId,
          100,
        ),
      );
      newestRun.validatedHeadSha =
        receipt.identity.headSha === input.expectedHeadSha &&
        receipt.identity.status === "completed" &&
        receipt.identity.conclusion === "success" &&
        receipt.validation.headSha === input.expectedHeadSha &&
        receipt.validation.status === "completed" &&
        receipt.validation.conclusion === "success"
          ? receipt.identity.headSha
          : null;
      newestRun.validationCheckApp = receipt.app;
    }
    const after = await request(() =>
      github.getPullRequest(input.repository, input.pullRequestNumber),
    );
    const openAfterPage = await request(() =>
      github.listOpenPullRequestsForHead(
        input.repository,
        input.expectedHeadSha,
        LIMITS.openPullRequests,
      ),
    );
    if (openAfterPage.hasNextPage) return unavailable("safety-limit");
    return {
      status: "complete",
      repository,
      defaultBranch,
      pullRequestBefore: before,
      pullRequestAfter: after,
      openPullRequestsBefore: openBeforePage.items,
      openPullRequestsAfter: openAfterPage.items,
      reviews,
      reviewVerdicts,
      reviewThreads,
      workflow,
      baseWorkflowSha: workflowFile.base.sha ?? "",
      headWorkflowSha: workflowFile.head.sha ?? "",
      workflowRuns: runPage.items,
      protectedFiles,
      requestCount,
      limits: LIMITS,
    };
  } catch (error) {
    const reason = error instanceof EvidenceError ? error.reason : "request-failed";
    return unavailable(reason, reason === "ambiguous" ? "ambiguous" : "unavailable");
  }
}

function baseResult(
  input,
  evidence,
  reasonCodes,
  currentHeadReviews = [],
  latestVerdicts = [],
  run = null,
) {
  const complete = evidence.status === "complete";
  return {
    schemaVersion: 1,
    decision: reasonCodes.length === 0 ? "pass" : "block",
    reasonCodes,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadSha: input.expectedHeadSha,
    observedHeadSha: complete ? evidence.pullRequestAfter.headSha : null,
    baseRepository: complete ? evidence.pullRequestAfter.baseRepository : null,
    baseRef: complete ? evidence.pullRequestAfter.baseRef : null,
    baseSha: complete ? evidence.pullRequestAfter.baseSha : null,
    policy: {
      path: input.policyPath,
      sha256: input.policySha256,
      version: input.policy.version,
      reviewPolicyVersion: input.policy.review.policyVersion,
      mode: input.policy.review.mode,
    },
    reviewEvidence: {
      allowedReviewers: input.reviewerRequirements.map((reviewer) => reviewer.login).sort(),
      reviewerRequirements: input.reviewerRequirements,
      currentHeadReviews,
      latestVerdicts,
      unresolvedThreadCount: complete
        ? evidence.reviewThreads.filter((thread) => !thread.isResolved).length
        : null,
    },
    validationEvidence: {
      repository: complete ? evidence.repository : null,
      defaultBranch: complete ? evidence.defaultBranch : null,
      trustedBase: input.trustedBase,
      workflow: complete ? evidence.workflow : null,
      baseWorkflowSha: complete ? evidence.baseWorkflowSha : null,
      headWorkflowSha: complete ? evidence.headWorkflowSha : null,
      definitionMatchesBase: complete
        ? evidence.baseWorkflowSha === evidence.headWorkflowSha
        : null,
      run,
      protectedFiles: complete ? evidence.protectedFiles : [],
    },
    evidence: {
      status: evidence.status,
      reason: complete ? null : evidence.reason,
      requestCount: evidence.requestCount,
      limits: evidence.limits,
    },
    candidateExecution: "none",
  };
}

export function evaluate(input) {
  const evidence = input.evidence;
  if (evidence.status !== "complete")
    return baseResult(input, evidence, [
      evidence.status === "ambiguous" ? "EVIDENCE_AMBIGUOUS" : "EVIDENCE_UNAVAILABLE",
    ]);
  if (
    evidence.pullRequestBefore.number !== input.pullRequestNumber ||
    evidence.pullRequestAfter.number !== input.pullRequestNumber ||
    evidence.pullRequestBefore.headSha !== evidence.pullRequestAfter.headSha ||
    evidence.pullRequestBefore.baseSha !== evidence.pullRequestAfter.baseSha ||
    evidence.pullRequestBefore.baseRef !== evidence.pullRequestAfter.baseRef ||
    evidence.pullRequestBefore.baseRepository.toLowerCase() !==
      evidence.pullRequestAfter.baseRepository.toLowerCase()
  )
    return baseResult(input, evidence, ["HEAD_CHANGED_DURING_EVALUATION"]);
  if (evidence.pullRequestAfter.headSha !== input.expectedHeadSha)
    return baseResult(input, evidence, ["HEAD_MISMATCH"]);
  if (evidence.pullRequestAfter.state !== "open")
    return baseResult(input, evidence, ["PULL_REQUEST_NOT_OPEN"]);
  const matchesRequestedPullRequest = (receipt) =>
    receipt?.number === input.pullRequestNumber &&
    receipt.state === "open" &&
    receipt.headSha === input.expectedHeadSha;
  if (
    evidence.openPullRequestsBefore.length !== 1 ||
    evidence.openPullRequestsAfter.length !== 1 ||
    !matchesRequestedPullRequest(evidence.openPullRequestsBefore[0]) ||
    !matchesRequestedPullRequest(evidence.openPullRequestsAfter[0])
  )
    return baseResult(input, evidence, ["PULL_REQUEST_ASSOCIATION_AMBIGUOUS"]);
  if (input.policy.repository.toLowerCase() !== input.repository.toLowerCase())
    return baseResult(input, evidence, ["POLICY_REPOSITORY_MISMATCH"]);
  if (
    String(input.policy.version) !== input.expectedPolicyVersion ||
    input.policy.review.policyVersion !== input.expectedPolicyVersion
  )
    return baseResult(input, evidence, ["POLICY_VERSION_MISMATCH"]);
  if (
    input.trustedBase.repository.toLowerCase() !== input.repository.toLowerCase() ||
    evidence.repository.fullName.toLowerCase() !== input.repository.toLowerCase() ||
    evidence.repository.defaultBranch !== input.trustedBase.ref ||
    evidence.defaultBranch.name !== input.trustedBase.ref ||
    evidence.defaultBranch.sha !== input.trustedBase.sha
  )
    return baseResult(input, evidence, ["DEFAULT_BRANCH_UNTRUSTED"]);
  if (
    evidence.pullRequestAfter.baseRepository.toLowerCase() !== input.repository.toLowerCase() ||
    evidence.pullRequestAfter.baseRef !== input.trustedBase.ref ||
    evidence.pullRequestAfter.baseSha !== input.trustedBase.sha
  )
    return baseResult(input, evidence, ["PULL_REQUEST_BASE_UNTRUSTED"]);
  const requirements = new Map(
    input.reviewerRequirements.map((reviewer) => [reviewer.login.toLowerCase(), reviewer]),
  );
  const currentHeadReviews = evidence.reviews
    .filter(
      (review) => {
        const requirement = requirements.get(review.reviewer.toLowerCase());
        return (
          requirement?.id === review.reviewerId &&
          requirement.type === review.reviewerType &&
          review.commitSha === input.expectedHeadSha &&
          ["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(review.state)
        );
      },
    )
    .sort((left, right) => left.id - right.id);
  const allVerdicts = [
    ...evidence.reviews.map((review) => ({
      id: review.id,
      source: "review",
      reviewer: review.reviewer,
      reviewerId: review.reviewerId,
      reviewerType: review.reviewerType,
      commitSha: review.commitSha,
      submittedAt: review.submittedAt,
      actionableCount: review.actionableCount,
      verdictStatus: review.verdictStatus,
    })),
    ...evidence.reviewVerdicts,
  ];
  const latestVerdicts = [];
  for (const requirement of input.reviewerRequirements.filter(
    (reviewer) => reviewer.requireZeroActionable,
  )) {
    const latest = allVerdicts
      .filter(
        (verdict) =>
          verdict.reviewer.toLowerCase() === requirement.login.toLowerCase() &&
          verdict.reviewerId === requirement.id &&
          verdict.reviewerType === requirement.type,
      )
      .sort(
        (left, right) =>
          left.submittedAt.localeCompare(right.submittedAt) || left.id - right.id,
      )
      .at(-1);
    if (latest) latestVerdicts.push(latest);
  }
  const run =
    evidence.workflowRuns
      .filter(
        (item) =>
          item.workflowId === evidence.workflow.id &&
          item.event === "pull_request" &&
          item.status === "completed" &&
          item.conclusion === "success" &&
          item.headSha === input.expectedHeadSha &&
          item.repository.toLowerCase() === input.repository.toLowerCase() &&
          item.pullRequests.some(
            (pull) =>
              pull.number === input.pullRequestNumber &&
              pull.baseSha === input.trustedBase.sha &&
              pull.headSha === input.expectedHeadSha,
          ) &&
          item.validatedHeadSha === input.expectedHeadSha &&
          item.validationCheckApp?.id === input.validationApp.id &&
          item.validationCheckApp.slug === input.validationApp.slug,
      )
      .sort((left, right) => right.id - left.id || right.attempt - left.attempt)[0] ?? null;
  const reasons = [];
  if (currentHeadReviews.length === 0) reasons.push("NO_ALLOWED_CURRENT_HEAD_REVIEW");
  if (currentHeadReviews.some((review) => review.state === "CHANGES_REQUESTED"))
    reasons.push("REVIEW_CHANGES_REQUESTED");
  for (const requirement of input.reviewerRequirements.filter(
    (reviewer) => reviewer.requireZeroActionable,
  )) {
    const verdict = latestVerdicts.find(
      (item) => item.reviewer.toLowerCase() === requirement.login.toLowerCase(),
    );
    if (
      !verdict ||
      verdict.commitSha !== input.expectedHeadSha ||
      verdict.verdictStatus !== "parsed" ||
      !Number.isSafeInteger(verdict.actionableCount)
    )
      reasons.push("REVIEW_VERDICT_MISSING");
    else if (verdict.actionableCount !== 0) reasons.push("REVIEW_ACTIONABLE_FINDINGS");
  }
  if (evidence.reviewThreads.some((thread) => !thread.isResolved))
    reasons.push("UNRESOLVED_REVIEW_THREADS");
  if (
    evidence.workflow.path !== input.validationWorkflowPath ||
    evidence.workflow.state !== "active" ||
    evidence.baseWorkflowSha !== evidence.headWorkflowSha
  )
    reasons.push("VALIDATION_WORKFLOW_UNTRUSTED");
  if (
    evidence.protectedFiles.length !== input.protectedPaths.length ||
    evidence.protectedFiles.some(
      (file) =>
        !input.protectedPaths.includes(file.path) ||
        file.base.kind !== "file" ||
        file.head.kind !== "file" ||
        file.trusted.kind !== "file" ||
        file.base.sha !== file.trusted.sha ||
        file.head.sha !== file.trusted.sha,
    )
  )
    reasons.push("TRUST_ROOT_CHANGED");
  if (!run) reasons.push("VALIDATION_RUN_MISSING");
  return baseResult(
    input,
    evidence,
    [...new Set(reasons)],
    currentHeadReviews,
    latestVerdicts,
    run,
  );
}

function publicationFailure(evaluation, publication, code, status = "failed", check = null) {
  return {
    ...evaluation,
    decision: "block",
    reasonCodes: [...new Set([...evaluation.reasonCodes, code])],
    publication: {
      status,
      mode: publication.mode,
      enforcementEligible: false,
      expectedProducerApp: publication.expectedProducerApp,
      check,
    },
  };
}

function checkSummary(evaluation) {
  return [
    `decision=${evaluation.decision}`,
    `head=${evaluation.expectedHeadSha}`,
    `base=${evaluation.baseRepository ?? "unknown"}:${evaluation.baseRef ?? "unknown"}@${evaluation.baseSha ?? "unknown"}`,
    `policyVersion=${evaluation.policy.reviewPolicyVersion}`,
    `reasons=${evaluation.reasonCodes.join(",") || "none"}`,
    `currentHeadReviews=${evaluation.reviewEvidence.currentHeadReviews.length}`,
    `unresolvedThreads=${evaluation.reviewEvidence.unresolvedThreadCount ?? "unknown"}`,
    `validationRun=${evaluation.validationEvidence.run?.id ?? "none"}`,
  ].join("\n");
}

export async function publishEvaluation(
  input,
  evaluation,
  headGitHub,
  checkGitHub,
  publication,
  refreshEvaluation,
) {
  let created = null;
  let currentEvaluation = evaluation;
  const name =
    publication.mode === "enforce"
      ? "Bumblebit Review Policy"
      : "Bumblebit Review Policy Shadow";
  const matchesProducer = (check) =>
    check.name === name &&
    check.headSha === input.expectedHeadSha &&
    check.app.id === publication.expectedProducerApp.id &&
    check.app.slug === publication.expectedProducerApp.slug;
  const matchesPullRequest = (receipt) =>
    receipt.number === input.pullRequestNumber &&
    receipt.state === "open" &&
    receipt.headSha === input.expectedHeadSha &&
    receipt.baseRepository.toLowerCase() === input.repository.toLowerCase() &&
    receipt.baseRef === input.trustedBase.ref &&
    receipt.baseSha === input.trustedBase.sha;
  const hasUniquePullRequestAssociation = (page) => {
    return !page.hasNextPage && page.items.length === 1 && matchesPullRequest(page.items[0]);
  };
  const readPullRequestAssociations = () =>
    headGitHub.listOpenPullRequestsForHead(
      input.repository,
      input.expectedHeadSha,
      LIMITS.openPullRequests,
    );
  const invalidatePending = async (code) => {
    if (!created || !matchesProducer(created))
      return publicationFailure(currentEvaluation, publication, code);
    try {
      const failed = await checkGitHub.updateCheckRun(input.repository, {
        checkRunId: created.id,
        status: "completed",
        conclusion: "failure",
        title: "Exact-head review policy blocked",
        summary: `decision=block\nhead=${input.expectedHeadSha}\nreasons=${code}`,
      });
      if (
        matchesProducer(failed) &&
        failed.id === created.id &&
        failed.status === "completed" &&
        failed.conclusion === "failure"
      )
        return publicationFailure(currentEvaluation, publication, code, "invalidated", failed);
      return publicationFailure(currentEvaluation, publication, code, "unknown", failed);
    } catch {
      return publicationFailure(currentEvaluation, publication, code, "unknown", created);
    }
  };
  try {
    const before = await headGitHub.getPullRequest(input.repository, input.pullRequestNumber);
    if (!matchesPullRequest(before))
      return publicationFailure(
        currentEvaluation,
        publication,
        "HEAD_CHANGED_BEFORE_PUBLICATION",
      );
    const associationsBefore = await readPullRequestAssociations();
    const request = {
      name,
      headSha: input.expectedHeadSha,
      status: "in_progress",
      externalId: `bumblebit-review-policy:v1:${input.pullRequestNumber}:${input.expectedHeadSha}`,
      title: "Exact-head review policy verification in progress",
      summary: `decision=pending\nhead=${input.expectedHeadSha}\npolicyVersion=${evaluation.policy.reviewPolicyVersion}`,
    };
    try {
      created = await checkGitHub.createCheckRun(input.repository, request);
    } catch {
      return publicationFailure(
        currentEvaluation,
        publication,
        "CHECK_PUBLICATION_FAILED",
        "unknown",
      );
    }
    if (
      !matchesProducer(created) ||
      created.status !== request.status ||
      created.conclusion !== null
    )
      return publicationFailure(
        currentEvaluation,
        publication,
        "CHECK_PUBLICATION_INVALID",
        "unknown",
        created,
      );
    if (!hasUniquePullRequestAssociation(associationsBefore))
      return invalidatePending("PULL_REQUEST_ASSOCIATION_AMBIGUOUS");
    const after = await headGitHub.getPullRequest(input.repository, input.pullRequestNumber);
    if (!matchesPullRequest(after)) return invalidatePending("HEAD_CHANGED_AFTER_PUBLICATION");
    if (!hasUniquePullRequestAssociation(await readPullRequestAssociations()))
      return invalidatePending("PULL_REQUEST_ASSOCIATION_AMBIGUOUS");
    currentEvaluation = await refreshEvaluation();
    if (
      currentEvaluation.repository.toLowerCase() !== input.repository.toLowerCase() ||
      currentEvaluation.pullRequestNumber !== input.pullRequestNumber ||
      currentEvaluation.expectedHeadSha !== input.expectedHeadSha ||
      currentEvaluation.observedHeadSha !== input.expectedHeadSha
    )
      return invalidatePending("HEAD_CHANGED_DURING_EVALUATION");
    if (!hasUniquePullRequestAssociation(await readPullRequestAssociations()))
      return invalidatePending("PULL_REQUEST_ASSOCIATION_AMBIGUOUS");
    const beforeCompletion = await headGitHub.getPullRequest(
      input.repository,
      input.pullRequestNumber,
    );
    if (!matchesPullRequest(beforeCompletion))
      return invalidatePending("HEAD_CHANGED_BEFORE_PUBLICATION");
    if (!hasUniquePullRequestAssociation(await readPullRequestAssociations()))
      return invalidatePending("PULL_REQUEST_ASSOCIATION_AMBIGUOUS");
    const checks = await checkGitHub.listCheckRuns(
      input.repository,
      input.expectedHeadSha,
      request.name,
      100,
    );
    if (checks.totalCount > 100) return invalidatePending("CHECK_SUPERSEDED");
    const latest = checks.items
      .filter(matchesProducer)
      .sort((left, right) => right.id - left.id)[0];
    if (
      !latest ||
      latest.id !== created.id ||
      latest.status !== "in_progress" ||
      latest.conclusion !== null
    )
      return invalidatePending("CHECK_SUPERSEDED");
    const desiredConclusion = currentEvaluation.decision === "pass" ? "success" : "failure";
    let completed;
    try {
      completed = await checkGitHub.updateCheckRun(input.repository, {
        checkRunId: created.id,
        status: "completed",
        conclusion: desiredConclusion,
        title:
          currentEvaluation.decision === "pass"
            ? "Exact-head review policy passed"
            : "Exact-head review policy blocked",
        summary: checkSummary(currentEvaluation),
      });
    } catch {
      return publicationFailure(
        currentEvaluation,
        publication,
        "CHECK_PUBLICATION_FAILED",
        "unknown",
        created,
      );
    }
    if (
      !matchesProducer(completed) ||
      completed.id !== created.id ||
      completed.status !== "completed" ||
      completed.conclusion !== desiredConclusion
    )
      return publicationFailure(
        currentEvaluation,
        publication,
        "CHECK_PUBLICATION_INVALID",
        "unknown",
        completed,
      );
    return {
      ...currentEvaluation,
      publication: {
        status: "published",
        mode: publication.mode,
        enforcementEligible: publication.mode === "enforce",
        expectedProducerApp: publication.expectedProducerApp,
        check: completed,
      },
    };
  } catch {
    return invalidatePending("CHECK_PUBLICATION_FAILED");
  }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  let options;
  try {
    options = parseArguments(argv);
    if (!environment.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
    if (options.publication.mode === "enforce" && !environment.BUMBLEBIT_APP_TOKEN)
      throw new Error("BUMBLEBIT_APP_TOKEN is required for enforce publication");
    const loaded = await loadPolicy(options.policyPath, options.repository);
    options.trustedBase = await loadTrustedBase(
      options.repository,
      options.trustedDefaultRef,
      options.trustedDefaultSha,
      options.protectedPaths,
    );
    const evidenceGitHub = createGitHub(environment.GITHUB_TOKEN);
    if (options.workflowRunHead) {
      const resolvedPullRequest = await evidenceGitHub.resolveOpenPullRequest(
        options.repository,
        options.workflowRunHead,
      );
      if (!resolvedPullRequest) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schemaVersion: 1,
              decision: "skip",
              reasonCodes: ["NO_ASSOCIATED_OPEN_PULL_REQUEST"],
              repository: options.repository,
              workflowRunHead: options.workflowRunHead,
              publication: {
                status: "not-attempted",
                mode: options.publication.mode,
                enforcementEligible: false,
                expectedProducerApp: options.publication.expectedProducerApp,
                check: null,
              },
              candidateExecution: "none",
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      options.pullRequestNumber = resolvedPullRequest.number;
      options.expectedHeadSha = resolvedPullRequest.headSha;
    }
    const evidence = await collectEvidence(options, evidenceGitHub);
    const evaluationInput = {
      ...options,
      policy: loaded.policy,
      policySha256: loaded.sha256,
      evidence,
    };
    const evaluation = evaluate(evaluationInput);
    const publicationGitHub = createGitHub(
      options.publication.mode === "enforce"
        ? environment.BUMBLEBIT_APP_TOKEN
        : environment.GITHUB_TOKEN,
    );
    const result = await publishEvaluation(
      evaluationInput,
      evaluation,
      evidenceGitHub,
      publicationGitHub,
      options.publication,
      async () =>
        evaluate({
          ...evaluationInput,
          evidence: await collectEvidence(options, evidenceGitHub),
        }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.decision === "pass" ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `Bumblebit review policy failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await main();
