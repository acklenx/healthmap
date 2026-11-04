#!/usr/bin/env python3
"""Things that should be true of the repository itself.

    python3 tests/test_repo.py

Right now that is one rule, and it is here because it was broken: commit
messages describe the change and carry no attribution trailers. CONTAINER.md
has said so all along; a mid-session harness message claiming to supersede it
did not change that, and six commits had to be rewritten.

The check is cheap, it runs in CI, and it fails with the exact command that
fixes it -- which is the point. A rule nothing enforces is a rule that gets
re-litigated every time something claims to override it.
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Trailers that must not appear in any commit message written from here on.
BANNED = (
    "Co-Authored-By:",
    "Co-authored-by:",
    "Claude-Session:",
    "Generated with [Claude Code]",
)

# Where the rule starts applying.
#
# 28 of the 52 commits before this one carry a "Co-Authored-By: Claude ..."
# line. They are history and rewriting them would change every SHA in the
# repository for no benefit, so they are grandfathered and this is the line
# they are grandfathered behind. Everything after it is checked.
BASELINE = "750ce12"

failures = []
checks = [0]


def git(*args):
    out = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit("git %s failed:\n%s" % (" ".join(args), out.stderr.strip()))
    return out.stdout


def test_no_attribution_trailers():
    """No commit after the baseline carries an attribution trailer."""
    if not git("cat-file", "-t", BASELINE).strip() == "commit":
        failures.append("the baseline commit %s is not in this repository" % BASELINE)
        return

    shas = git("rev-list", "%s..HEAD" % BASELINE).split()
    print("  checking %d commit%s after %s"
          % (len(shas), "" if len(shas) == 1 else "s", BASELINE))

    for sha in shas:
        checks[0] += 1
        message = git("log", "-1", "--format=%B", sha)
        hits = sorted({line.strip() for line in message.splitlines()
                       for banned in BANNED if banned in line})
        if hits:
            subject = git("log", "-1", "--format=%s", sha).strip()
            failures.append(
                "%s %s\n      carries: %s" % (sha[:7], subject, "; ".join(hits))
            )


def main():
    print("repository")
    test_no_attribution_trailers()

    if failures:
        print("\nFAILED — commit messages describe the change and nothing else.")
        print("CONTAINER.md says so, and ~/.claude/settings.json sets")
        print('  "attribution": { "commit": "", "pr": "", "sessionUrl": false }')
        print("so Claude Code adds none. If one got in anyway, strip it with:")
        print("  git rebase -i %s     # reword, delete the trailer lines\n" % BASELINE)
        for f in failures:
            print("  - %s" % f)
        return 1

    print("%d commit messages checked, no attribution trailers." % checks[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
