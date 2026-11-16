#!/usr/bin/env python3
"""Compare two named source predicates as syntax without importing either module."""
import argparse
import ast
import hashlib
import json
from pathlib import Path


def predicate(path, name):
    raw = Path(path).read_bytes()
    if len(raw) > 1024 * 1024:
        raise ValueError("source exceeds limit")
    source = raw.decode("utf-8")
    matches = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(matches) != 1:
        raise ValueError("exactly one named source predicate required")
    node, body = matches[0], matches[0].body
    if (body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)):
        body = body[1:]
    normalized = ast.dump(ast.Module(body=body, type_ignores=[]), include_attributes=False)
    return normalized, {"file_sha256": hashlib.sha256(raw).hexdigest(),
                        "predicate_source_sha256": hashlib.sha256(ast.get_source_segment(source, node).encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mounted-source", required=True)
    parser.add_argument("--fixture-source", required=True)
    args = parser.parse_args()
    mounted, mounted_hashes = predicate(args.mounted_source, "resolved_invariants")
    fixture, fixture_hashes = predicate(args.fixture_source, "invariants")
    equivalent = mounted == fixture
    print(json.dumps({"body_ast_equivalent": equivalent,
                      "normalized_body_ast_sha256": hashlib.sha256(mounted.encode()).hexdigest(),
                      "mounted": mounted_hashes, "fixture": fixture_hashes}, sort_keys=True))
    raise SystemExit(0 if equivalent else 1)


if __name__ == "__main__":
    main()
