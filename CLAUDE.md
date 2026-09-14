# CLAUDE.md

- Workflow
  - No worktrees in this repo: Chrome's "Load unpacked" is bound to this path,
    so create a feature branch and work directly in the main checkout
  - Finish flow: implement -> review (review-all) -> human verification on
    this checkout -> commit & push -> create-pr (PR + CI watch + merge)
- Commit rules
  - Run a review before committing
  - Never commit directly to main; go through a pull request
