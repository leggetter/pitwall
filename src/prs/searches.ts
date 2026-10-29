// The searches one fetch runs (W101), and their aliases in the query: fetch.ts builds the query and
// gh's arguments from these, and parse.ts reads each search's answer by its alias.
import type { PullRequestRelation } from '../shared/protocol.js';

/**
 * The searches, one per relation: open PRs on github.com, in repos that aren't archived, sorted by
 * GitHub, newest update first, so that past PRS_MAX the ones left out are the oldest.
 *
 * - `review-requested:@me` finds a request of you or of a team you're on; `user-review-requested:@me`
 *   finds only those of you by name (GitHub's search docs). pitwall uses the first, as GitHub's own
 *   Review requests list does, and tells the two apart from each PR's review requests.
 * - `mentions:@me` leaves out your own PRs (`-author:@me`), so they can't take its PRS_MAX. One that
 *   also asks your review is listed as review requested.
 */
export const PRS_SEARCHES: Readonly<Record<PullRequestRelation, string>> = {
  authored: 'is:pr is:open author:@me archived:false sort:updated-desc',
  'review-requested': 'is:pr is:open review-requested:@me archived:false sort:updated-desc',
  mentioned: 'is:pr is:open mentions:@me -author:@me archived:false sort:updated-desc',
};

/** Each search's alias in the query, and the name of its variable. Its cursor's variable is `<alias>After`. */
export const PRS_ALIASES: Readonly<Record<PullRequestRelation, string>> = {
  authored: 'authored',
  'review-requested': 'reviewRequested',
  mentioned: 'mentioned',
};
