# GitHub issue tracker

Issues, specs, and tickets live in GitHub Issues for [larryboiNEUQ/pi-auto-review](https://github.com/larryboiNEUQ/pi-auto-review). Use the `gh` CLI from this repository. Outside the checkout, pass `--repo larryboiNEUQ/pi-auto-review` to `gh issue` and `gh pr` commands. The `gh api` commands below use fully qualified repository paths and need no repository flag.

## Ticket operations

- Publish a spec or ticket with `gh issue create --title "..." --body "..."`. Use a heredoc for multiline bodies.
- Fetch a ticket and its discussion with `gh issue view <number> --comments`. Fetch structured fields with `gh issue view <number> --json number,title,body,labels,comments`.
- Find tickets with `gh issue list --state open --json number,title,body,labels`. Apply state and label filters for the task.
- Record findings with `gh issue comment <number> --body "..."`.
- Update labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close a completed ticket with `gh issue close <number> --comment "..."`.

## Blocking edges

For tickets with dependencies, use GitHub's native issue dependencies. Obtain the blocker's database ID with `gh api repos/larryboiNEUQ/pi-auto-review/issues/<blocker-number> --jq .id`. Add the edge with `gh api --method POST repos/larryboiNEUQ/pi-auto-review/issues/<ticket-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`.

If native dependencies are unavailable, record `Blocked by: #<number>` at the top of the ticket body. A ticket is ready when all its blockers are closed.

## Pull requests

**PRs as a request surface: no.** External pull requests are not included in the issue triage queue by default.

GitHub shares issue and pull request numbers. For an ambiguous reference, try `gh pr view <number>` and fall back to `gh issue view <number>`. Read the diff with `gh pr diff <number>` when the reference is a pull request.
