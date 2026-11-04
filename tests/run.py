#!/usr/bin/env python3
"""Run every test.

    python3 tests/run.py            everything available
    python3 tests/run.py --quick    skip the browser (what CI runs)

There is no framework here on purpose: the crawler is stdlib-only Python and
the app is a static file, so a test runner that needed installing would be the
heaviest dependency in the repository. Each file below is a program that
prints what it checked and exits non-zero if something is wrong.

    test_repo.py       commit messages carry no attribution trailers
    test_data.py       the published files agree with each other, and with
                       what the app can do with them
    test_parsers.py    the Python and JavaScript parsers read the same pages
                       the same way
    test_endpoints.mjs the Pages Functions, with the edge stubbed
    test_sw.mjs        what the service worker caches, and what it must not
    test_browser.mjs   the app itself, in a real browser (skips without one)
"""

import argparse
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")

SUITES = [
    ("repo", ["python3", "tests/test_repo.py"], False),
    ("data", ["python3", "tests/test_data.py"], False),
    ("parsers", ["python3", "tests/test_parsers.py"], False),
    ("endpoints", ["node", "tests/test_endpoints.mjs"], False),
    ("service worker", ["node", "tests/test_sw.mjs"], False),
    ("browser", ["node", "tests/test_browser.mjs"], True),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip the browser suite")
    ap.add_argument("--only", default="", help="run one suite by name")
    args = ap.parse_args()

    results = []
    for name, cmd, slow in SUITES:
        if args.quick and slow:
            continue
        if args.only and args.only not in name:
            continue

        # flush=True throughout: these go to the same stream as the child
        # processes, and a buffered parent prints all its headings after
        # every suite has already run -- which in a CI log attributes each
        # failure to the wrong suite.
        print("\n" + "=" * 70, flush=True)
        print(name, flush=True)
        print("=" * 70, flush=True)
        started = time.time()
        code = subprocess.run(cmd, cwd=ROOT).returncode
        results.append((name, code, time.time() - started))

    print("\n" + "=" * 70, flush=True)
    for name, code, secs in results:
        print("%-16s %-6s %5.1fs" % (name, "ok" if code == 0 else "FAILED", secs),
              flush=True)

    bad = [n for n, code, _ in results if code != 0]
    if bad:
        print("\nFAILED: %s" % ", ".join(bad))
        return 1
    print("\nEverything passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
