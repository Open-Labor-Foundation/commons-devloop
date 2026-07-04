function getLocalServicePrRecord(serviceState, prNumber) {
  const prs = serviceState?.prs;
  if (!prs || typeof prs !== "object") {
    return null;
  }
  return prs[prNumber] ?? prs[String(prNumber)] ?? null;
}

function localGateForPr(record, headSha) {
  if (!record || record.sha !== headSha) {
    return "pending";
  }
  if (record.result === "success") {
    return "success";
  }
  if (record.result === "failure") {
    return "failure";
  }
  return "pending";
}

function reviewerGateRequired(config) {
  return config.reviewer.enabled !== false;
}

function mergeAllowedForPr(config, pr) {
  if (!config.safety.auto_merge) {
    return false;
  }

  const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => label.name) : [];
  if (config.pr_manager.auto_merge_label && !labels.includes(config.pr_manager.auto_merge_label)) {
    return false;
  }

  return true;
}

function metadataReadinessFromPr(pr) {
  const mergeState = String(pr.mergeStateStatus ?? "").toUpperCase();

  if (pr.isDraft) {
    return { readiness: "blocked", reason: "draft pull request", mergeState };
  }

  // GitHub's merge state can reflect hosted checks or branch protection.
  // Only consume metadata-like states that are required for a local merge decision.
  if (mergeState === "DIRTY") {
    return { readiness: "blocked", reason: "merge conflicts", mergeState };
  }

  if (mergeState === "BEHIND") {
    return { readiness: "update_branch", reason: "branch behind base", mergeState };
  }

  return { readiness: null, reason: null, mergeState };
}

export function normalizePullRequestRecord(pr) {
  if (!pr) {
    return null;
  }

  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid ?? null,
    headRepository: pr.headRepository?.name ?? pr.headRepository ?? null,
    headRepositoryOwner: pr.headRepositoryOwner?.login ?? pr.headRepositoryOwner ?? null,
    isCrossRepository: Boolean(pr.isCrossRepository),
    maintainerCanModify: pr.maintainerCanModify == null ? null : Boolean(pr.maintainerCanModify),
    baseRefName: pr.baseRefName ?? null,
    url: pr.url ?? null,
    isDraft: Boolean(pr.isDraft),
    mergeStateStatus: pr.mergeStateStatus ?? null,
    labels: Array.isArray(pr.labels) ? pr.labels : []
  };
}

export function evaluatePullRequestReadiness(config, pr, validatorState, reviewerState, options = {}) {
  const formatFailureReason = typeof options.formatFailureReason === "function"
    ? options.formatFailureReason
    : (reason) => reason;
  const validatorRecord = getLocalServicePrRecord(validatorState, pr.number);
  const reviewerRecord = getLocalServicePrRecord(reviewerState, pr.number);
  const validateState = localGateForPr(validatorRecord, pr.headRefOid);
  const reviewerStateValue = reviewerGateRequired(config)
    ? localGateForPr(reviewerRecord, pr.headRefOid)
    : "skipped";
  const metadataGate = metadataReadinessFromPr(pr);

  let readiness = "waiting";
  let reason = "waiting for local validation";

  if (metadataGate.readiness) {
    readiness = metadataGate.readiness;
    reason = metadataGate.reason;
  } else if (validateState === "failure") {
    readiness = "blocked";
    reason = formatFailureReason("local validator failed", validatorRecord);
  } else if (reviewerStateValue === "failure") {
    readiness = "blocked";
    reason = formatFailureReason("local reviewer failed", reviewerRecord);
  } else if (validateState !== "success") {
    readiness = "waiting";
    reason = "waiting for local validation";
  } else if (reviewerStateValue !== "success" && reviewerStateValue !== "skipped") {
    readiness = "waiting";
    reason = "waiting for local review";
  } else if (!mergeAllowedForPr(config, pr)) {
    readiness = "blocked";
    reason = config.safety.auto_merge
      ? "missing required merge label"
      : "local merge disabled by repo config";
  } else {
    readiness = "merge";
    reason = "local validator and reviewer are green";
  }

  return {
    readiness,
    reason,
    validateState,
    reviewerState: reviewerStateValue,
    mergeState: metadataGate.mergeState
  };
}
