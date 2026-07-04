export function countActiveOpenPullRequests(prs) {
  return Array.isArray(prs)
    ? prs.filter((pr) => !pr?.isDraft).length
    : 0;
}

export function countDraftOpenPullRequests(prs) {
  return Array.isArray(prs)
    ? prs.filter((pr) => Boolean(pr?.isDraft)).length
    : 0;
}

export function summarizeOpenPullRequests(prs) {
  const total = Array.isArray(prs) ? prs.length : 0;
  const drafts = countDraftOpenPullRequests(prs);
  const active = Math.max(0, total - drafts);
  return {
    total,
    active,
    drafts
  };
}
