"""One pure selector owner, byte-exact SQL and preserved compatibility export."""
import ast
from pathlib import Path

from music_app.services.current_library_selector import canonical_library_selector_sql


def test_selector_retains_exact_canonical_sql():
    assert canonical_library_selector_sql()=="""select library.libraries.id
                         from app.bootstrap_owners as runtime_owner
                         join library.libraries
                           on library.libraries.owner_account_id = runtime_owner.account_id
                         where runtime_owner.owner_key = 'local-bootstrap-owner'
                           and library.libraries.library_kind = 'local'
                         order by library.libraries.id
                         limit 1"""


def test_original_owner_reexports_without_duplicate_sql():
    from music_app.services.current_actor_postgres import canonical_library_selector_sql as original
    assert original is canonical_library_selector_sql
    root=Path(__file__).resolve().parents[2]
    tree=ast.parse((root/'music_app/services/current_actor_postgres.py').read_text())
    assert not any(isinstance(n,ast.FunctionDef) and n.name=='canonical_library_selector_sql' for n in tree.body)


def test_pure_selector_has_no_import_closure():
    source=Path(__file__).resolve().parents[2]/'music_app/services/current_library_selector.py'
    assert not any(isinstance(n,(ast.Import,ast.ImportFrom)) for n in ast.walk(ast.parse(source.read_text())))
