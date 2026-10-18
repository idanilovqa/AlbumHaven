"""Pure canonical library selector shared by current private authority."""

def canonical_library_selector_sql() -> str:
    """Return the existing scalar canonical-library selector SQL."""
    return """select library.libraries.id
                         from app.bootstrap_owners as runtime_owner
                         join library.libraries
                           on library.libraries.owner_account_id = runtime_owner.account_id
                         where runtime_owner.owner_key = 'local-bootstrap-owner'
                           and library.libraries.library_kind = 'local'
                         order by library.libraries.id
                         limit 1"""

