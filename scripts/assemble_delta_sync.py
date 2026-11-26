#!/usr/bin/env python3
"""Assemble the reviewed delta application SQL into one atomic release.

This utility only reads repository sources and writes SQL/JSON. It has no
database connection, Supabase credentials, deployment, rollout, or activation
capability. Existing private gateways are replaced individually so installed
management wrappers, triggers, policies and capacity/audit behavior survive.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = [
    ("docs/sentlog-delta-v1-schema-prototype.sql", None),
    ("docs/sentlog-delta-semantic-validation-prototype.sql", None),
    ("docs/sentlog-delta-baseline-prototype.sql", None),
    ("docs/sentlog-delta-transport-prototype.sql", None),
    ("docs/sentlog-delta-atomic-groups-prototype.sql", None),
    ("docs/sentlog-delta-archive-compat-prototype.sql", None),
    ("docs/sentlog-delta-projection-prototype.sql", None),
    ("docs/sentlog-delta-metadata-prototype.sql", None),
    ("db/archive_v1.sql", "sentlog_archive_private.gateway"),
    ("db/collaboration_v1.sql", "sentlog_collaboration_private.guard_snapshot"),
    ("docs/sentlog-delta-checkpoint-prototype.sql", None),
    ("db/capacity_v1.sql", "sentlog_archive_private.capacity_gateway"),
    ("docs/sentlog-delta-app-lifecycle.sql", None),
    ("docs/sentlog-delta-activation-performance.sql", None),
]


def statements(sql: str) -> list[str]:
    """Split only top-level semicolons, retaining SQL function bodies verbatim."""
    result, start, i, quote, block = [], 0, 0, None, 0
    while i < len(sql):
        if block:
            if sql.startswith("/*", i):
                block += 1
                i += 2
            elif sql.startswith("*/", i):
                block -= 1
                i += 2
            else:
                i += 1
            continue
        if quote:
            if sql.startswith(quote, i):
                if quote in ("'", '"') and sql.startswith(quote * 2, i):
                    i += 2
                    continue
                i += len(quote)
                quote = None
            else:
                i += 1
            continue
        if sql.startswith("--", i):
            end = sql.find("\n", i)
            i = len(sql) if end < 0 else end + 1
        elif sql.startswith("/*", i):
            block = 1
            i += 2
        elif sql[i] in "'\"":
            quote = sql[i]
            i += 1
        elif sql[i] == "$" and (match := re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])):
            quote = match.group(0)
            i += len(quote)
        elif sql[i] == ";":
            result.append(sql[start : i + 1])
            start = i + 1
            i += 1
        else:
            i += 1
    if quote or block:
        raise ValueError("Unterminated SQL quote or comment")
    if sql[start:].strip():
        result.append(sql[start:])
    return result


def uncomment_start(sql: str) -> str:
    while True:
        before = sql
        sql = re.sub(r"^\s*--[^\n]*(?:\n|$)", "", sql)
        sql = re.sub(r"^\s*/\*.*?\*/", "", sql, flags=re.S)
        if sql == before:
            return sql.strip()


def select_source(path: str, function: str | None) -> tuple[str, dict]:
    raw = (ROOT / path).read_text()
    source = statements(raw)
    if function:
        pattern = re.compile(r"^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+" + re.escape(function) + r"\s*\(", re.I)
        selected = [part for part in source if pattern.search(uncomment_start(part))]
        if len(selected) != 1:
            raise ValueError(f"Expected exactly one definition of {function} in {path}")
        # Existing grants and function OIDs are preserved by CREATE OR REPLACE.
        # Do not replay the old public RPC declaration or trigger/policy DDL.
        body = uncomment_start(selected[0]) + "\n"
    else:
        selected, wrappers = [], []
        for part in source:
            token = uncomment_start(part)
            if re.fullmatch(r"(?:BEGIN|COMMIT)\s*;", token, re.I):
                wrappers.append(token.split(";")[0].upper())
            elif token:
                if re.match(r"^(?:ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION|END)\b", token, re.I):
                    raise ValueError(f"Unsupported top-level transaction command in {path}")
                if re.match(r"^(?:INSERT|UPDATE|DELETE|TRUNCATE|CALL|SELECT)\b", token, re.I):
                    raise ValueError(f"Release fragment performs top-level data mutation/call in {path}")
                selected.append(part.strip())
        if wrappers != ["BEGIN", "COMMIT"]:
            raise ValueError(f"Expected one outer BEGIN/COMMIT in {path}, got {wrappers}")
        body = "\n\n".join(selected) + "\n"
    if not body.strip():
        raise ValueError(f"Empty release component: {path}")
    descriptor = {
        "path": path,
        "selection": function or "transaction body",
        "sourceSha256": hashlib.sha256(raw.encode()).hexdigest(),
        "sqlSha256": hashlib.sha256(body.encode()).hexdigest(),
    }
    return body, descriptor


PREFLIGHT = r"""
DO $sentlog_release_preflight$
DECLARE missing text[];
BEGIN
  SELECT array_agg(name) INTO missing FROM unnest(ARRAY[
    'auth.users','public.sentlog_projects','public.sentlog_devices',
    'public.sentlog_project_snapshots','public.sentlog_assets','public.sentlog_pc_receipts',
    'sentlog_archive_private.jobs','sentlog_archive_private.capacity_ops',
    'sentlog_archive_private.retired_projects','sentlog_archive_private.removed_device_registrations',
    'sentlog_archive_private.audit_v2','realtime.messages']) AS name
  WHERE pg_catalog.to_regclass(name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'DELTA_RELEASE_LEGACY_TABLES_REQUIRED: %',missing USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class
    WHERE oid=pg_catalog.to_regclass('realtime.messages') AND relrowsecurity) THEN
    RAISE EXCEPTION 'DELTA_RELEASE_REALTIME_RLS_REQUIRED' USING ERRCODE='55000';
  END IF;
  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL OR
     pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL OR
     pg_catalog.to_regprocedure('realtime.topic()') IS NULL OR
     pg_catalog.to_regprocedure('sentlog_archive_private.gateway(text,uuid,uuid,jsonb)') IS NULL OR
     pg_catalog.to_regprocedure('sentlog_archive_private.dispatch(text,uuid,uuid,jsonb)') IS NULL OR
     pg_catalog.to_regprocedure('sentlog_archive_private.capacity_gateway(text,uuid,uuid,jsonb)') IS NULL OR
     pg_catalog.to_regprocedure('sentlog_collaboration_private.guard_snapshot()') IS NULL THEN
    RAISE EXCEPTION 'DELTA_RELEASE_LEGACY_PROTOCOLS_REQUIRED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid='public.sentlog_project_snapshots'::regclass AND NOT tgisinternal
      AND tgfoid='sentlog_collaboration_private.guard_snapshot()'::regprocedure
      AND tgenabled IN ('O','A') AND tgqual IS NULL AND (tgtype::integer & 31)=31) THEN
    RAISE EXCEPTION 'DELTA_RELEASE_COLLABORATION_GUARD_REQUIRED' USING ERRCODE='55000';
  END IF;
END $sentlog_release_preflight$;
"""

READINESS = r"""
DO $sentlog_release_readiness$
DECLARE item record;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class
    WHERE oid=pg_catalog.to_regclass('realtime.messages') AND relrowsecurity) THEN
    RAISE EXCEPTION 'DELTA_RELEASE_REALTIME_RLS_REQUIRED' USING ERRCODE='55000';
  END IF;
  FOR item IN SELECT p.oid,p.proname,p.prosecdef FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'sentlog_delta_%'
  LOOP
    IF item.prosecdef OR pg_catalog.has_function_privilege('anon',item.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'DELTA_RELEASE_RPC_PRIVILEGES: %',item.proname USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('authenticated','public.sentlog_delta_events','INSERT') OR
     pg_catalog.has_table_privilege('authenticated','public.sentlog_delta_events','UPDATE') OR
     pg_catalog.has_table_privilege('authenticated','public.sentlog_delta_events','DELETE') OR
     pg_catalog.has_table_privilege('authenticated','public.sentlog_delta_events','SELECT') OR
     pg_catalog.has_table_privilege('authenticated','sentlog_delta_private.rollouts','UPDATE') OR
     pg_catalog.has_table_privilege('authenticated','sentlog_delta_private.checkpoint_write_authority','INSERT') THEN
    RAISE EXCEPTION 'DELTA_RELEASE_PRIVATE_WRITE_EXPOSED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid='public.sentlog_project_snapshots'::regclass AND NOT tgisinternal
      AND tgfoid='sentlog_delta_private.guard_certified_snapshot()'::regprocedure
      AND tgenabled IN ('O','A') AND tgqual IS NULL AND (tgtype::integer & 31)=31) OR
     pg_catalog.to_regprocedure('public.sentlog_delta_inspect_v1(uuid,uuid)') IS NULL OR
     pg_catalog.to_regprocedure('public.sentlog_delta_activate_baseline_v1(uuid,uuid,uuid,jsonb)') IS NULL OR
     pg_catalog.to_regprocedure('public.sentlog_delta_append_group_v1(uuid,uuid,jsonb)') IS NULL OR
     pg_catalog.to_regprocedure('public.sentlog_delta_publish_checkpoint_v1(uuid,uuid,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'DELTA_RELEASE_INCOMPLETE' USING ERRCODE='55000';
  END IF;
END $sentlog_release_readiness$;
"""


def assemble() -> tuple[str, dict]:
    pieces, manifest = [], []
    for path, selected in PARTS:
        body, descriptor = select_source(path, selected)
        pieces.append("-- Component: " + path + " / " + descriptor["selection"] +
                      "\n-- Source SHA-256: " + descriptor["sourceSha256"] + "\n" + body)
        manifest.append(descriptor)
    header = (
        "-- Sentlog delta application release v1. Generated; edit its source fragments.\n"
        "-- One transaction. Installation does not activate a project or enable owner rollout.\n"
        "-- No project, snapshot, asset, original-photo or PC-backup data is deleted.\n"
        "-- Generate: python3 scripts/assemble_delta_sync.py --output <reviewed-release.sql>\n"
        "BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='5min';\n"
    )
    # PostgREST must discover the added RPC signatures. PostgreSQL delivers
    # NOTIFY only when this entire transaction commits, never on rollback.
    sql = (header + PREFLIGHT + "\n" + "\n".join(pieces) + READINESS +
           "\nNOTIFY pgrst, 'reload schema';\nCOMMIT;\n")
    return sql, {"version": 1, "kind": "sentlog-delta-release", "transactional": True,
                 "activatesProjects": False, "enablesRollout": False,
                 "sha256": hashlib.sha256(sql.encode()).hexdigest(), "components": manifest}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="write assembled SQL to this local path")
    parser.add_argument("--manifest", action="store_true", help="print deterministic source/hash manifest instead of SQL")
    parser.add_argument("--check", action="store_true", help="validate assembly and print its digest without writing a file")
    args = parser.parse_args()
    sql, manifest = assemble()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(sql)
    if args.manifest:
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
    elif args.check:
        print(f"PASS atomic delta release: {len(manifest['components'])} components; sha256={manifest['sha256']}")
    elif not args.output:
        print(sql, end="")


if __name__ == "__main__":
    main()
