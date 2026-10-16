"""Provision a fresh, job-local PostgreSQL database for focused Tops contracts.

The workflow owns a disposable PostgreSQL 17 service. This script never resets,
drops or repairs an existing database and never touches a music fixture library.
Application migrations run through the existing runner as a non-superuser.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import secrets
import sys

import psycopg
from psycopg import sql
from psycopg.rows import dict_row


ROOT = Path(__file__).resolve().parents[2]
BASE_ROLES = ("album_haven_migrator", "album_haven_app", "album_haven_readonly")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suffix", required=True)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_OS") != "Linux":
        raise RuntimeError("This bootstrap is restricted to a Linux GitHub Actions job.")
    if not re.fullmatch(r"tops_[0-9]+_[0-9]+", args.suffix) or len(args.suffix) > 35:
        raise ValueError("Invalid isolated job suffix.")
    runner_temp = Path(os.environ["RUNNER_TEMP"])
    if not runner_temp.is_absolute() or not runner_temp.is_dir():
        raise ValueError("A real absolute runner temporary directory is required.")
    database = "album_haven_ci_" + args.suffix
    roles = {base: base + "_" + args.suffix for base in BASE_ROLES}
    passwords = {base: secrets.token_hex(24) for base in BASE_ROLES}
    for value in passwords.values():
        print("::add-mask::" + value, flush=True)
    pgpass = runner_temp / (database + ".pgpass")
    # Exclusive creation refuses stale state. Secrets are never artifact inputs.
    fd = os.open(pgpass, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        for base in BASE_ROLES:
            stream.write(f"127.0.0.1:5432:{database}:{roles[base]}:{passwords[base]}\n")
    os.environ["PGPASSFILE"] = str(pgpass)
    os.environ.pop("PGPASSWORD", None)
    with psycopg.connect(host="127.0.0.1", port=5432, dbname="postgres", user="postgres",
            password=os.environ["CI_POSTGRES_ADMIN_PASSWORD"], autocommit=True,
            row_factory=dict_row) as admin:
        identity = admin.execute("select current_database() as db,current_user as role,"
            "current_setting('server_version_num')::integer as version").fetchone()
        if identity["db"] != "postgres" or identity["role"] != "postgres" or identity["version"] // 10000 != 17:
            raise RuntimeError("Unexpected disposable PostgreSQL service identity.")
        collision = admin.execute("select exists(select 1 from pg_database where datname=%s) "
            "or exists(select 1 from pg_roles where rolname=any(%s)) as present",
            (database, list(roles.values()))).fetchone()
        if collision["present"]:
            raise RuntimeError("Isolated database or role already exists; refusing reuse.")
        with admin.transaction():
            for base in BASE_ROLES:
                existing = admin.execute("select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,"
                    "rolreplication,rolbypassrls from pg_roles where rolname=%s", (base,)).fetchone()
                if existing is None:
                    admin.execute(sql.SQL("create role {} nologin nosuperuser nocreatedb "
                        "nocreaterole noreplication nobypassrls").format(sql.Identifier(base)))
                elif any(existing.values()):
                    raise RuntimeError("Unexpected base role privileges; refusing repair.")
                admin.execute(sql.SQL("create role {} login password {} nosuperuser nocreatedb "
                    "nocreaterole noreplication nobypassrls inherit in role {}").format(
                        sql.Identifier(roles[base]), sql.Literal(passwords[base]), sql.Identifier(base)))
        admin.execute(sql.SQL("create database {} owner {}").format(
            sql.Identifier(database), sql.Identifier(roles["album_haven_migrator"])))
        admin.execute(sql.SQL("revoke all on database {} from public").format(sql.Identifier(database)))
        admin.execute(sql.SQL("grant connect on database {} to album_haven_app,album_haven_readonly").format(
            sql.Identifier(database)))
        admin.execute(sql.SQL("grant temporary on database {} to album_haven_app").format(sql.Identifier(database)))
    setup_url = f"postgresql://{roles['album_haven_migrator']}@127.0.0.1:5432/{database}"
    runtime_url = f"postgresql://{roles['album_haven_app']}@127.0.0.1:5432/{database}"
    sys.path.insert(0, str(ROOT))
    from tests.e2e.support import isolatedPostgres

    isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: setup_url,
        isolatedPostgres.RUNTIME_DATABASE_ENV: runtime_url,
    })
    isolatedPostgres.apply_all_migrations(setup_url)
    with isolatedPostgres._connect(runtime_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.RUNTIME_ROLE)
        actual = connection.execute("select rolsuper,rolcreatedb,rolcreaterole,rolreplication,"
            "rolbypassrls,pg_has_role(current_user,'album_haven_app','USAGE') as inherited "
            "from pg_roles where rolname=current_user").fetchone()
        if actual != dict(rolsuper=False, rolcreatedb=False, rolcreaterole=False,
                rolreplication=False, rolbypassrls=False, inherited=True):
            raise RuntimeError("Runtime identity does not have the required inherited-only privileges.")
    exports = {"PGPASSFILE": str(pgpass), "DATABASE_MIGRATOR_URL": setup_url,
        "DATABASE_APP_URL": runtime_url, "ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL": runtime_url}
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
        for key, value in exports.items():
            if "\n" in value or "\r" in value:
                raise ValueError("Invalid environment value.")
            stream.write(f"{key}={value}\n")
    print("Provisioned isolated PostgreSQL 17 with non-superuser migration and runtime roles.")


if __name__ == "__main__":
    main()
