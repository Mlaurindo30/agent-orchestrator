/**
 * PR-related utilities for */

/**
 * Information about a GitHub PR extracted from its URL.
 */
export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

// GitHub PR URL pattern
const GITHUB_PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
// Fallback: extract PR number from end of URL (e.g., /123)
const GITHUB_PR_NUMBER_REGEX = /\/(\d+)$/;

/**
 * Parse PR information from a GitHub PR URL.
 * Returns null if the URL is not a valid GitHub PR URL.
 */
export function parsePrFromUrl(prUrl: string): PRInfo | null {
  const ghMatch = prUrl.match(GITHUB_PR_URL_REGEX);
  if (ghMatch) {
    const [, owner, repo, prNumber] = ghMatch;
    return {
      owner,
      repo,
      number: parseInt(prNumber, 10),
      url: prUrl,
    };
  }

  // Fallback: try to extract PR number from URL ending (e.g., /pull/123)
  const numMatch = prUrl.match(GITHUB_PR_NUMBER_REGEX);
  if (numMatch) {
    return {
      owner: "",
      repo: "",
      number: parseInt(numMatch[1], 10),
      url: prUrl,
    };
  }

  return null;
}
