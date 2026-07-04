function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(parsed));
}

export function branchUpdateConcurrencyForConfig(config) {
  const mergeConcurrency = asPositiveInteger(config?.pr_manager?.merge_concurrency, 1);
  const lifecycleCap = asPositiveInteger(config?.lifecycle?.max_parallel_prs, mergeConcurrency);
  return asPositiveInteger(
    config?.pr_manager?.update_branch_concurrency,
    Math.max(mergeConcurrency, lifecycleCap)
  );
}

export function selectPrManagerActions(config, evaluatedPrs) {
  const mergeConcurrency = asPositiveInteger(config?.pr_manager?.merge_concurrency, 1);
  const branchUpdateConcurrency = branchUpdateConcurrencyForConfig(config);
  const updatable = evaluatedPrs.filter((pr) => pr.localGate?.readiness === "update_branch");
  const mergeable = evaluatedPrs.filter((pr) => pr.localGate?.readiness === "merge");
  const updateBatch = updatable.slice(0, branchUpdateConcurrency);
  const pauseMergesForUpdates = updateBatch.length > 0;

  return {
    branchUpdateConcurrency,
    mergeConcurrency,
    updatable,
    mergeable,
    updateBatch,
    mergeBatch: pauseMergesForUpdates ? [] : mergeable.slice(0, mergeConcurrency),
    pauseMergesForUpdates
  };
}
